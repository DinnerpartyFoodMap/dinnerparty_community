import Capacitor
import PhotosUI
import SwiftUI
import UIKit
import WebKit

/// 意见反馈的原生 SwiftUI 页：反馈类型、内容、最多 4 张图片（相册 / 拍照）都在原生里填写。
/// 凭证与请求不离开网页层：点提交时经 feedbackEvent 把输入交给网页（图片已摆正、缩到 2048 内并编码为 JPEG），
/// 网页发出请求后按 requestId 用 respond 回传结果。成功后收起并以 submitted 结束 open；
/// 取消（按钮、下滑、网页重新加载）以 cancel 结束。类型、上限与文案都由网页下发（文案走网页 i18n）；
/// 可选的 prefill { type, content } 是预填的类型与内容开头（地点举报）。
@objc(NativeFeedbackPlugin)
public class NativeFeedbackPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeFeedbackPlugin"
    public let jsName = "NativeFeedback"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]
    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativeFeedbackModel?
    private var finishing = false
    private var presenting = false
    private var queuedFinish: (action: String, animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    private let sheetDelegate = FeedbackSheetDelegate()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "cancel", animated: false) }
        }
        // 下滑关闭：有草稿时先确认（isModalInPresentation 拦下后走 attempt），没有草稿直接结束
        sheetDelegate.onAttemptDismiss = { [weak self] in self?.model?.requestCancel() }
        sheetDelegate.onDismiss = { [weak self] in self?.finish(action: "cancel") }
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
            let model = NativeFeedbackModel(call: call) { [weak self] payload in
                guard let self, let id = self.requestID else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("feedbackEvent", data: data)
            }
            model.onFinish = { [weak self] action in self?.finish(action: action) }
            let host = UIHostingController(rootView: NativeFeedbackView(model: model))
            host.modalPresentationStyle = .pageSheet
            host.overrideUserInterfaceStyle = model.dark ? .dark : .light
            host.presentationController?.delegate = self.sheetDelegate
            // 填了内容或正在提交时不能直接下滑关掉
            model.onLockChange = { [weak host] locked in host?.isModalInPresentation = locked }
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                guard let self else { return }
                self.presenting = false
                if let queued = self.queuedFinish {
                    self.queuedFinish = nil
                    self.finish(action: queued.action, animated: queued.animated)
                }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("id") == self.requestID else { call.resolve(); return }
            self.finish(action: "cancel", animated: false) { call.resolve() }
        }
    }

    /// 网页提交完成后回传结果（按 requestId 对应，过期的回执忽略）
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            self.model?.finishRequest(requestId: requestId, ok: call.getBool("ok", false),
                                      message: String((call.getString("message") ?? "").prefix(200)))
        }
    }

    private func finish(action: String, animated: Bool = true, completion: (() -> Void)? = nil) {
        guard let host else { completion?(); return }
        if let completion { closeCompletions.append(completion) }
        guard !finishing else { return }
        if presenting { queuedFinish = (action, animated); return }
        finishing = true
        let call = pending
        let id = requestID
        model?.cancelPending()
        let complete = { [weak self] in
            self?.host = nil
            self?.pending = nil
            self?.requestID = nil
            self?.model = nil
            self?.finishing = false
            call?.resolve(["id": id ?? "", "action": action])
            let completions = self?.closeCompletions ?? []
            self?.closeCompletions.removeAll()
            completions.forEach { $0() }
        }
        // 从父控制器关闭：确认框或相机还在上面时一并收起，不留下孤立的反馈页；用户已下滑关闭时直接结束
        if let presenter = host.presentingViewController {
            presenter.dismiss(animated: animated && !UIAccessibility.isReduceMotionEnabled, completion: complete)
        } else {
            complete()
        }
    }
}

/// 反馈页的下滑关闭事件（插件是公开类，委托放在这里，不把委托方法暴露成公开接口）
private final class FeedbackSheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
    var onAttemptDismiss: (() -> Void)?
    var onDismiss: (() -> Void)?

    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
        onAttemptDismiss?()
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }
}

// MARK: - 状态

/// 反馈页状态：填写内容、已选图片与发给网页的提交请求。
final class NativeFeedbackModel: ObservableObject {
    struct TypeOption: Identifiable, Hashable {
        let id: String
        let title: String
        let hint: String
        let symbol: String
    }

    struct PickedImage: Identifiable {
        let id = UUID()
        let preview: UIImage
        let jpeg: Data
    }

    @Published var type = ""
    @Published var content = ""
    @Published private(set) var images: [PickedImage] = []
    @Published private(set) var submitting = false
    @Published var loadingImages = false
    @Published var alertMessage: String?
    @Published var confirmDiscard = false

    let dark: Bool
    let tint: Color
    let types: [TypeOption]
    let maxLength: Int
    let maxImages: Int
    var onFinish: ((String) -> Void)?
    var onLockChange: ((Bool) -> Void)?
    /// 预填的类型与内容：只有预填时不算草稿（下滑直接关闭），也不能提交（总要写点原因）
    private let prefillType: String
    private let prefillContent: String
    private let labels: [String: String]
    private let send: ([String: Any]) -> Void
    private var pendingRequest: (id: String, timeout: DispatchWorkItem)?

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        dark = call.getBool("dark", false)
        tint = Color(uiColor: UIColor(cssHex: call.getString("primary") ?? "") ?? .systemPink)
        let types = (call.getArray("types", JSObject.self) ?? []).compactMap { item -> TypeOption? in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return TypeOption(id: id, title: item["title"] as? String ?? id, hint: item["hint"] as? String ?? "",
                              symbol: item["symbol"] as? String ?? "bubble.left")
        }
        self.types = types
        let limits = call.getObject("limits") ?? [:]
        let maxLength = max(1, (limits["contentLength"] as? NSNumber)?.intValue ?? 2000)
        self.maxLength = maxLength
        maxImages = max(0, (limits["images"] as? NSNumber)?.intValue ?? 4)
        // 预填类型须在下发的类型里，否则整份预填作废
        let prefill = call.getObject("prefill") ?? [:]
        let prefillType = prefill["type"] as? String ?? ""
        let validPrefill = types.contains { $0.id == prefillType }
        self.prefillType = validPrefill ? prefillType : ""
        prefillContent = validPrefill ? String((prefill["content"] as? String ?? "").prefix(maxLength)) : ""
        var labels: [String: String] = [:]
        for (key, value) in call.getObject("labels") ?? [:] {
            if let text = value as? String { labels[key] = text }
        }
        self.labels = labels
        type = self.prefillType
        content = prefillContent
    }

    /// 网页下发的文案；缺失时用中文兜底
    func text(_ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    var trimmedContent: String { content.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var onlyPrefill: Bool { trimmedContent == prefillContent.trimmingCharacters(in: .whitespacesAndNewlines) }
    var selectedType: TypeOption? { types.first { $0.id == type } }
    var remainingImages: Int { max(0, maxImages - images.count) }
    var canSubmit: Bool { !type.isEmpty && !trimmedContent.isEmpty && !onlyPrefill && !submitting && !loadingImages }
    var hasDraft: Bool { type != prefillType || !onlyPrefill || !images.isEmpty }
    var isLocked: Bool { hasDraft || submitting }

    // MARK: 图片

    /// 摆正方向、长边缩到 maxSide 以内并编码为 JPEG；列表里显示缩略图，避免几张大图常驻内存
    static func prepare(_ image: UIImage, maxSide: CGFloat = 2048) -> PickedImage? {
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let ratio = min(1, maxSide / longest)
        let target = CGSize(width: max(1, (image.size.width * ratio).rounded()), height: max(1, (image.size.height * ratio).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: target, format: format).image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: target))
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.85) else { return nil }
        let thumbRatio = min(1, 240 / max(target.width, target.height))
        let preview = rendered.preparingThumbnail(of: CGSize(width: target.width * thumbRatio, height: target.height * thumbRatio)) ?? rendered
        return PickedImage(preview: preview, jpeg: jpeg)
    }

    func addImages(_ picked: [UIImage]) {
        var failed = false
        for image in picked {
            guard images.count < maxImages else { break }
            if let prepared = Self.prepare(image) { images.append(prepared) } else { failed = true }
        }
        if failed { alertMessage = text("imageUnreadable", "图片无法读取") }
    }

    func removeImage(_ id: UUID) {
        images.removeAll { $0.id == id }
    }

    // MARK: 提交

    /// 把填写内容交给网页提交；网页没有回应（页面重新加载等）时超时，不能一直转圈
    func submit() {
        guard canSubmit else { return }
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pendingRequest?.id == requestId else { return }
            self.pendingRequest = nil
            self.submitting = false
            self.alertMessage = self.text("timeout", "请求超时，请稍后重试")
        }
        pendingRequest = (id: requestId, timeout: work)
        submitting = true
        send(["type": "submit", "requestId": requestId, "values": [
            "type": type,
            "content": trimmedContent,
            "images": images.map { $0.jpeg.base64EncodedString() }
        ]])
        DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: work)
    }

    func finishRequest(requestId: String, ok: Bool, message: String) {
        guard let entry = pendingRequest, entry.id == requestId else { return }
        entry.timeout.cancel()
        pendingRequest = nil
        submitting = false
        if ok {
            onFinish?("submitted")
        } else {
            alertMessage = message.isEmpty ? text("failed", "提交失败，请稍后重试") : message
        }
    }

    func cancelPending() {
        pendingRequest?.timeout.cancel()
        pendingRequest = nil
    }

    /// 取消：有草稿时先确认放弃，提交中不能取消
    func requestCancel() {
        guard !submitting else { return }
        if hasDraft { confirmDiscard = true } else { onFinish?("cancel") }
    }

    func discard() {
        onFinish?("cancel")
    }
}

// MARK: - 页面

private struct NativeFeedbackView: View {
    @ObservedObject var model: NativeFeedbackModel
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showCamera = false

    private let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text(model.text("intro", "遇到问题或者有新想法？告诉我们吧。"))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Section {
                    // 下拉菜单：还没选时放一个占位项（选中任一类型后不再出现），避免选中值没有对应的 tag
                    Picker(selection: $model.type) {
                        if model.type.isEmpty {
                            Text(model.text("typePlaceholder", "请选择反馈类型")).tag("")
                        }
                        ForEach(model.types) { option in
                            Label(option.title, systemImage: option.symbol).tag(option.id)
                        }
                    } label: {
                        Text(model.text("typeLabel", "反馈类型"))
                    }
                    .pickerStyle(.menu)
                }
                Section {
                    TextField(model.selectedType?.hint ?? model.text("contentPlaceholder", "请先选择反馈类型，再描述具体情况"),
                              text: $model.content, axis: .vertical)
                        .lineLimit(6, reservesSpace: true)
                } header: {
                    Text(model.text("contentLabel", "反馈内容"))
                } footer: {
                    HStack {
                        Spacer()
                        Text("\(model.content.count) / \(model.maxLength)").monospacedDigit()
                    }
                }
                imagesSection
            }
            .disabled(model.submitting)
            .navigationTitle(model.text("title", "意见反馈"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.text("cancel", "取消")) { model.requestCancel() }
                        .disabled(model.submitting)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.submitting {
                        ProgressView()
                            .accessibilityLabel(Text(model.text("submitting", "提交中...")))
                    } else {
                        Button(model.text("submit", "提交反馈")) { model.submit() }
                            .font(.body.weight(.semibold))
                            .disabled(!model.canSubmit)
                    }
                }
            }
        }
        .tint(model.tint)
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
        .confirmationDialog(model.text("discardTitle", "放弃这条反馈？"), isPresented: $model.confirmDiscard, titleVisibility: .visible) {
            Button(model.text("discard", "放弃"), role: .destructive) { model.discard() }
            Button(model.text("keepEditing", "继续填写"), role: .cancel) {}
        } message: {
            Text(model.text("discardMessage", "已填写的内容不会保存。"))
        }
        .fullScreenCover(isPresented: $showCamera) {
            FeedbackCameraPicker { image in
                showCamera = false
                if let image { model.addImages([image]) }
            }
            .ignoresSafeArea()
        }
        .onChange(of: model.content) { _, value in
            if value.count > model.maxLength { model.content = String(value.prefix(model.maxLength)) }
        }
        .onChange(of: model.isLocked) { _, locked in
            model.onLockChange?(locked)
        }
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            model.loadingImages = true
            Task {
                var loaded: [UIImage] = []
                var failed = false
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        loaded.append(image)
                    } else {
                        failed = true
                    }
                }
                await MainActor.run {
                    pickerItems = []
                    model.loadingImages = false
                    model.addImages(loaded)
                    if failed { model.alertMessage = model.text("imageUnreadable", "图片无法读取") }
                }
            }
        }
    }

    private var imagesSection: some View {
        Section {
            if !model.images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(model.images) { image in
                            Image(uiImage: image.preview)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 76, height: 76)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                                .overlay(alignment: .topTrailing) {
                                    // 图标仍是 20pt、位置不变，点按范围 44×44
                                    Button { model.removeImage(image.id) } label: {
                                        Image(systemName: "xmark.circle.fill")
                                            .font(.system(size: 20))
                                            .symbolRenderingMode(.palette)
                                            .foregroundStyle(Color.white, Color.black.opacity(0.6))
                                            .frame(width: 44, height: 44)
                                            .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.borderless)
                                    .offset(x: 8, y: -8)
                                    .accessibilityLabel(Text(model.text("removeImage", "移除图片")))
                                }
                        }
                    }
                    // 留出删除钮扩大后伸出图片右上角的点按范围
                    .padding(.vertical, 8)
                    .padding(.trailing, 8)
                }
            }
            if model.remainingImages > 0 {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: model.remainingImages, selectionBehavior: .ordered, matching: .images) {
                    Label(model.text("chooseFromAlbum", "从相册选择"), systemImage: "photo.on.rectangle")
                }
                .disabled(model.loadingImages)
                if cameraAvailable {
                    Button {
                        showCamera = true
                    } label: {
                        Label(model.text("takePhoto", "拍照"), systemImage: "camera")
                    }
                    .disabled(model.loadingImages)
                }
            }
            if model.loadingImages {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
            }
        } header: {
            Text(model.text("imagesLabel", "图片（选填）"))
        } footer: {
            Text(model.text("imagesHint", "最多 4 张，仅管理员可见。"))
        }
    }
}

/// 系统相机（PhotosPicker 不能拍照）
private struct FeedbackCameraPicker: UIViewControllerRepresentable {
    let onPick: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onPick: onPick) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onPick: (UIImage?) -> Void

        init(onPick: @escaping (UIImage?) -> Void) {
            self.onPick = onPick
        }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            onPick(info[.originalImage] as? UIImage)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onPick(nil)
        }
    }
}
