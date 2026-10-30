import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生日记 · 同好（NativeJourneyPlugin.swift）。
///
/// open({ id, page, theme }) -> { id, action: close }
/// respond({ id, requestId, ok, message, error, page?, form?, imageId?, imageData? }) -> {}
/// update({ id, page }) -> {}
/// close({ id }) -> {}
/// 事件 journeyEvent：{ id, type: action|filter|submit|back|loadImage, requestId, ... }
///
/// 网页负责草稿、生成、公开与同好请求；原生只渲染页面模型、收集输入并回传动作。
/// 地图选点与分享画布仍由网页工具页完成。
@objc(NativeJourneyPlugin)
public class NativeJourneyPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeJourneyPlugin"
    public let jsName = "NativeJourney"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativePageModel?
    private var finishing = false
    private var presenting = false
    private var lastSeq = 0
    private var loadingObservation: NSKeyValueObservation?
    private let sheetDelegate = JourneySheetDelegate()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "close", animated: false) }
        }
        sheetDelegate.onDismiss = { [weak self] in self?.finish(action: "close") }
    }

    @objc func open(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let id = call.getString("id"), !id.isEmpty else {
                call.reject("Missing request id", "INVALID_ARGUMENT"); return
            }
            guard self.host == nil, let presenter = self.bridge?.viewController,
                  presenter.viewIfLoaded?.window != nil, presenter.presentedViewController == nil else {
                call.reject("Another screen is being presented", "BUSY"); return
            }
            let spec = NativePageParser.spec(call.getObject("page"))
            let model = NativePageModel(spec: spec, onEvent: { [weak self] type, payload in
                self?.emit(type, payload)
            }, onLoadImage: { [weak self] imageId in
                self?.emit("loadImage", ["imageId": imageId])
            })
            let theme = call.getObject("theme") ?? [:]
            let dark = (theme["dark"] as? Bool) ?? call.getBool("dark", false)
            let host = MapChromeHostingController(rootView: NativePageView(model: model), dark: dark)
            host.modalPresentationStyle = .pageSheet
            if #available(iOS 26.0, *) {
                host.view.backgroundColor = .clear
            } else {
                host.view.backgroundColor = .systemGroupedBackground
            }
            if let sheet = host.sheetPresentationController {
                sheet.detents = [.large()]
                sheet.prefersGrabberVisible = true
                sheet.prefersScrollingExpandsWhenScrolledToEdge = true
            }
            host.presentationController?.delegate = self.sheetDelegate
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                self?.presenting = false
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("id") == self.requestID else { call.resolve(); return }
            self.finish(action: "close", animated: false) { call.resolve() }
        }
    }

    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let model = self.model else { return }
            if let page = call.getObject("page") {
                let seq = call.getInt("seq", 0)
                if seq > 0 {
                    guard seq >= self.lastSeq else { return }
                    self.lastSeq = seq
                }
                model.apply(NativePageParser.spec(page))
            }
            if let imageId = call.getString("imageId"), let data = call.getString("imageData") {
                model.setImage(imageId, NativePageImage.decode(data))
            }
            if let form = call.getObject("form") {
                model.form = NativePageParser.form(form)
            }
            if let error = call.getString("error"), !error.isEmpty {
                model.alertMessage = error
            } else if let message = call.getString("message"), !message.isEmpty {
                model.showToast(message)
            }
            if call.getBool("close", false) {
                self.finish(action: "close")
            }
            _ = call.getString("requestId")
        }
    }

    /// 网页主动推送进度（生成任务完成等）
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard call.getString("id") == self.requestID, let model = self.model,
                  let page = call.getObject("page") else { return }
            let seq = call.getInt("seq", 0)
            if seq > 0 {
                guard seq >= self.lastSeq else { return }
                self.lastSeq = seq
            }
            model.apply(NativePageParser.spec(page))
        }
    }

    private func emit(_ type: String, _ payload: [String: Any]) {
        guard let id = requestID else { return }
        if type == "close" {
            finish(action: "close")
            return
        }
        var data = payload
        data["id"] = id
        data["type"] = type
        data["requestId"] = UUID().uuidString
        notifyListeners("journeyEvent", data: data)
    }

    private func finish(action: String, animated: Bool = true, completion: (() -> Void)? = nil) {
        guard let host else { completion?(); return }
        guard !finishing else { return }
        if presenting {
            completion?()
            return
        }
        finishing = true
        let call = pending
        let id = requestID
        let complete = { [weak self] in
            self?.host = nil
            self?.pending = nil
            self?.requestID = nil
            self?.model = nil
            self?.finishing = false
            call?.resolve(["id": id ?? "", "action": action])
            completion?()
        }
        if let presenter = host.presentingViewController {
            presenter.dismiss(animated: animated && !UIAccessibility.isReduceMotionEnabled, completion: complete)
        } else {
            complete()
        }
    }
}

private final class JourneySheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
    var onDismiss: (() -> Void)?

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }
}
