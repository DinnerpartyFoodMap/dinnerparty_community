import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生管理后台（NativeAdminPlugin.swift）。
///
/// open({ id, dashboard, theme }) -> { id, action: close }
/// respond({ id, requestId, ok, message, error, page?, form?, imageId?, imageData? }) -> {}
/// close({ id }) -> {}
/// 事件 adminEvent：{ id, type: action|filter|submit|back|loadImage, requestId, ... }
///
/// 网页负责权限、请求与页面模型；原生只渲染玻璃页面、收集输入并回传动作。
@objc(NativeAdminPlugin)
public class NativeAdminPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeAdminPlugin"
    public let jsName = "NativeAdmin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]

    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativePageModel?
    private var finishing = false
    private var presenting = false
    private var lastSeq = 0
    private var loadingObservation: NSKeyValueObservation?
    private let screenPresenter = NativeScreenPresenter()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "close", animated: false) }
        }
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
            let dashboard = NativePageParser.spec(call.getObject("dashboard"))
            let model = NativePageModel(spec: dashboard, onEvent: { [weak self] type, payload in
                self?.emit(type, payload)
            }, onLoadImage: { [weak self] imageId in
                self?.emit("loadImage", ["imageId": imageId])
            })
            let theme = call.getObject("theme") ?? [:]
            let dark = (theme["dark"] as? Bool) ?? call.getBool("dark", false)
            let host = MapChromeHostingController(rootView: NativePageView(model: model), dark: dark)
            // 与住民设置一致：整页不透明底色，保留地图在下方等待滑回；玻璃卡片负责层次。
            host.view.backgroundColor = .systemGroupedBackground
            self.screenPresenter.onEdgeBack = { [weak self] in
                guard let self, let model = self.model else { return }
                if model.spec.canGoBack {
                    model.back()
                } else {
                    self.finish(action: "close")
                }
            }
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            self.screenPresenter.present(host, from: presenter) { [weak self] in
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
                  let requestId = call.getString("requestId") else { return }
            guard let model = self.model else { return }
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
            _ = requestId
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
        notifyListeners("adminEvent", data: data)
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
