import Capacitor
import PhotosUI
import SwiftUI
import UIKit

/// 添加 / 修改地点的原生 SwiftUI 表单（iOS）：店名、分类、简介、人均、创建时的评价、外观与菜单图片都在原生里填写。
/// 新增地点时面板先停在屏幕下方三分之一（地图上能看到选中位置的标记，地图不变暗），用户自己往上拉开；修改地点时直接全屏。
/// 图片用系统相册（PhotosPicker，可多选）或相机，摆正、缩到 2560 内编码为 JPEG 后逐张经 placeFormEvent 交给网页上传，
/// 网页按 requestId 用 respond 回传图片地址。凭证与请求不离开网页层：提交、删除同样交给网页，结果按 requestId 回传。
/// open 结束时返回 { id, action: 'submitted' | 'deleted' | 'cancel' | 'pickPosition', values }：
/// values 是当时填写的内容（取消时网页存为草稿；pickPosition 时网页打开全屏地图选点，选好后重新打开表单）。
/// 分类目录、评价档位、上限与全部文案都由网页下发（文案走网页 i18n）。
@objc(NativePlaceFormPlugin)
public class NativePlaceFormPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativePlaceFormPlugin"
    public let jsName = "NativePlaceForm"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]
    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativePlaceFormModel?
    private var finishing = false
    private var presenting = false
    private var queuedFinish: (action: String, animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    private let sheetDelegate = PlaceFormSheetDelegate()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "cancel", animated: false) }
        }
        // 下滑关闭：修改地点且有改动时先确认（isModalInPresentation 拦下后走 attempt）；新增地点的内容由网页存成草稿，直接结束
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
            let model = NativePlaceFormModel(call: call) { [weak self] payload in
                guard let self, let id = self.requestID else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("placeFormEvent", data: data)
            }
            model.onFinish = { [weak self] action in self?.finish(action: action) }
            let host = UIHostingController(rootView: NativePlaceFormView(model: model))
            host.modalPresentationStyle = .pageSheet
            host.overrideUserInterfaceStyle = model.dark ? .dark : .light
            if let sheet = host.sheetPresentationController {
                if model.isCreate {
                    // 先停在下方三分之一，地图不变暗、仍能看到选中位置的标记；用户往上拉到全屏
                    let third = UISheetPresentationController.Detent.Identifier("third")
                    sheet.detents = [.custom(identifier: third) { context in context.maximumDetentValue / 3 }, .large()]
                    sheet.selectedDetentIdentifier = third
                    sheet.largestUndimmedDetentIdentifier = third
                } else {
                    sheet.detents = [.large()]
                }
                sheet.prefersGrabberVisible = true
                sheet.prefersScrollingExpandsWhenScrolledToEdge = true
            }
            host.presentationController?.delegate = self.sheetDelegate
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

    /// 网页处理完上传 / 提交 / 删除后回传结果（按 requestId 对应，过期的回执忽略）
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            self.model?.finishRequest(requestId: requestId, ok: call.getBool("ok", false),
                                      message: String((call.getString("message") ?? "").prefix(200)),
                                      url: call.getString("url"))
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
        let values = model?.values ?? [:]
        model?.cancelPending()
        let complete = { [weak self] in
            self?.host = nil
            self?.pending = nil
            self?.requestID = nil
            self?.model = nil
            self?.finishing = false
            call?.resolve(["id": id ?? "", "action": action, "values": values])
            let completions = self?.closeCompletions ?? []
            self?.closeCompletions.removeAll()
            completions.forEach { $0() }
        }
        if let presenter = host.presentingViewController {
            presenter.dismiss(animated: animated && !UIAccessibility.isReduceMotionEnabled, completion: complete)
        } else {
            complete()
        }
    }
}

private final class PlaceFormSheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
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

final class NativePlaceFormModel: ObservableObject {
    enum ImageGroup: String, Identifiable, CaseIterable {
        case exterior, menu
        var id: String { rawValue }
    }

    enum ImageState: Equatable {
        case done, queued, uploading, failed
    }

    struct FormImage: Identifiable, Equatable {
        let id = UUID()
        var url: String?
        var thumbnail: String?
        var preview: UIImage?
        var jpeg: Data?
        var state: ImageState

        static func == (lhs: FormImage, rhs: FormImage) -> Bool {
            lhs.id == rhs.id && lhs.url == rhs.url && lhs.state == rhs.state
        }
    }

    struct CategoryOption: Identifiable, Hashable {
        var id: String { name }
        let name: String
        let common: Bool
    }

    struct Tier: Identifiable, Hashable {
        let id: Int
        let title: String
        let hint: String
        /// 网页按当前主题取好的颜色（与网页评价选项一致）；没有时按档位用系统色
        let color: UIColor?
    }

    @Published var name: String
    @Published var categories: [String]
    @Published var description: String
    @Published var cost: String
    @Published var rating: Int?
    /// 提交时还没选评价：评价选项标红
    @Published var ratingMissing = false
    @Published var exterior: [FormImage]
    @Published var menu: [FormImage]
    @Published private(set) var submitting = false
    @Published var loadingImages = false
    @Published var alertMessage: String?
    @Published var confirmDiscard = false
    @Published var confirmDelete = false

    let isCreate: Bool
    let dark: Bool
    let tint: Color
    let categoryOptions: [CategoryOption]
    let tiers: [Tier]
    let canDirect: Bool
    let canDelete: Bool
    let canPickPosition: Bool
    let addressText: String
    let positionText: String
    let maxDescription: Int
    let maxImages: Int
    var onFinish: ((String) -> Void)?
    var onLockChange: ((Bool) -> Void)?
    private let labels: [String: String]
    private let send: ([String: Any]) -> Void
    /// 打开时的内容（修改地点时判断有没有改动）
    private var initialKey = ""
    private var pendingRequest: (id: String, kind: String, timeout: DispatchWorkItem)?
    private var uploadInFlight: (requestId: String, imageId: UUID, timeout: DispatchWorkItem)?

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        isCreate = call.getString("mode") != "edit"
        dark = call.getBool("dark", false)
        tint = Color(uiColor: UIColor(cssHex: call.getString("primary") ?? "") ?? .systemPink)
        canDirect = call.getBool("canDirect", true)
        canDelete = call.getBool("canDelete", false)
        canPickPosition = call.getBool("canPickPosition", false)
        addressText = String((call.getString("address") ?? "").prefix(250))
        positionText = String((call.getString("position") ?? "").prefix(80))
        let limits = call.getObject("limits") ?? [:]
        maxDescription = max(1, (limits["descriptionLength"] as? NSNumber)?.intValue ?? 1000)
        maxImages = max(1, (limits["images"] as? NSNumber)?.intValue ?? 20)
        categoryOptions = (call.getArray("categories", JSObject.self) ?? []).compactMap { item -> CategoryOption? in
            guard let name = item["name"] as? String, !name.isEmpty else { return nil }
            return CategoryOption(name: String(name.prefix(32)), common: (item["common"] as? Bool) ?? false)
        }
        tiers = (call.getArray("tiers", JSObject.self) ?? []).compactMap { item -> Tier? in
            guard let score = (item["score"] as? NSNumber)?.intValue, (1...4).contains(score) else { return nil }
            return Tier(id: score, title: item["title"] as? String ?? String(score), hint: item["hint"] as? String ?? "",
                        color: (item["color"] as? String).flatMap { UIColor(cssHex: $0) })
        }
        var labels: [String: String] = [:]
        for (key, value) in call.getObject("labels") ?? [:] {
            if let text = value as? String { labels[key] = text }
        }
        self.labels = labels
        let values = call.getObject("values") ?? [:]
        name = String((values["name"] as? String ?? "").prefix(120))
        categories = (values["category"] as? String ?? "")
            .split(whereSeparator: { $0 == "," || $0 == "，" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        description = String((values["description"] as? String ?? "").prefix(1000))
        cost = String((values["perPersonCost"] as? String ?? "").filter(\.isNumber).prefix(6))
        let rawRating = (values["rating"] as? NSNumber)?.intValue
        rating = rawRating.flatMap { (1...4).contains($0) ? $0 : nil }
        let images = { (key: String) -> [FormImage] in
            ((values[key] as? JSArray) ?? []).compactMap { raw -> FormImage? in
                guard let item = raw as? JSObject, let url = item["url"] as? String, url.hasPrefix("http") else { return nil }
                return FormImage(url: url, thumbnail: item["thumb"] as? String, preview: nil, jpeg: nil, state: .done)
            }
        }
        exterior = images("exteriorImages")
        menu = images("menuImages")
        initialKey = contentKey
    }

    /// 网页下发的文案；缺失时用中文兜底
    func text(_ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    // MARK: 内容

    private var contentKey: String {
        [name, categories.joined(separator: ","), description, cost, String(rating ?? 0),
         (exterior + menu).compactMap(\.url).joined(separator: "|")].joined(separator: "\u{1}")
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var uploading: Bool { (exterior + menu).contains { $0.state == .queued || $0.state == .uploading } }
    var canSubmit: Bool { !trimmedName.isEmpty && !submitting && !uploading && !loadingImages }
    var hasChanges: Bool { contentKey != initialKey || (exterior + menu).contains { $0.state != .done } }
    /// 修改地点有改动或正在提交时不能直接下滑关掉；新增地点的内容会存成草稿，可以直接关
    var isLocked: Bool { submitting || (!isCreate && hasChanges) }
    /// 评价选项的颜色：强烈推荐绿、均线之上主题色、均线之下橙、强烈拒绝红
    func color(for tier: Tier) -> Color {
        if let color = tier.color { return Color(uiColor: color) }
        switch tier.id {
        case 4: return .green
        case 2: return .orange
        case 1: return .red
        default: return tint
        }
    }

    /// 交给网页的填写内容（提交、取消存草稿、去地图选点）
    var values: [String: Any] {
        var result: [String: Any] = [
            "name": trimmedName,
            "category": categories.joined(separator: ", "),
            "description": description.trimmingCharacters(in: .whitespacesAndNewlines),
            "perPersonCost": cost,
            "exteriorImages": exterior.compactMap { $0.state == .done ? $0.url : nil },
            "menuImages": menu.compactMap { $0.state == .done ? $0.url : nil }
        ]
        if isCreate {
            if let rating { result["rating"] = rating } else { result["rating"] = NSNull() }
        }
        return result
    }

    // MARK: 分类

    /// 分类名：纯文本、不含逗号，最多 8 个汉字或 16 个英文字符（与后端一致）
    static func validCategory(_ value: String) -> Bool {
        let name = value.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, !name.contains(","), !name.contains("，"), !name.contains("<") else { return false }
        let width = name.unicodeScalars.reduce(0) { $0 + ($1.value > 0x7f ? 2 : 1) }
        return width <= 16
    }

    func toggleCategory(_ name: String) {
        if let index = categories.firstIndex(of: name) {
            categories.remove(at: index)
        } else {
            categories.append(name)
        }
    }

    // MARK: 图片

    func images(_ group: ImageGroup) -> [FormImage] {
        group == .exterior ? exterior : menu
    }

    func remaining(_ group: ImageGroup) -> Int {
        max(0, maxImages - images(group).count)
    }

    private func update(_ id: UUID, _ change: (inout FormImage) -> Void) {
        if let index = exterior.firstIndex(where: { $0.id == id }) {
            change(&exterior[index])
        } else if let index = menu.firstIndex(where: { $0.id == id }) {
            change(&menu[index])
        }
    }

    /// 摆正方向、长边缩到 2560 以内并编码为 JPEG（地点图片公开展示，画质比反馈截图高一些）
    static func prepare(_ image: UIImage, maxSide: CGFloat = 2560) -> (preview: UIImage, jpeg: Data)? {
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
        guard let jpeg = rendered.jpegData(compressionQuality: 0.88) else { return nil }
        let thumbRatio = min(1, 240 / max(target.width, target.height))
        let preview = rendered.preparingThumbnail(of: CGSize(width: target.width * thumbRatio, height: target.height * thumbRatio)) ?? rendered
        return (preview, jpeg)
    }

    func addImages(_ picked: [UIImage], to group: ImageGroup) {
        var failed = false
        for image in picked {
            guard remaining(group) > 0 else { break }
            guard let prepared = Self.prepare(image) else { failed = true; continue }
            let item = FormImage(url: nil, thumbnail: nil, preview: prepared.preview, jpeg: prepared.jpeg, state: .queued)
            if group == .exterior { exterior.append(item) } else { menu.append(item) }
        }
        if failed { alertMessage = text("imageUnreadable", "图片无法读取") }
        pumpUploads()
    }

    func removeImage(_ id: UUID) {
        if uploadInFlight?.imageId == id {
            uploadInFlight?.timeout.cancel()
            uploadInFlight = nil
        }
        exterior.removeAll { $0.id == id }
        menu.removeAll { $0.id == id }
        pumpUploads()
    }

    func retryImage(_ id: UUID) {
        update(id) { $0.state = .queued }
        pumpUploads()
    }

    /// 一次只传一张：网页上传完回执后再传下一张
    private func pumpUploads() {
        guard uploadInFlight == nil,
              let next = (exterior + menu).first(where: { $0.state == .queued }), let jpeg = next.jpeg else { return }
        let requestId = UUID().uuidString
        let imageId = next.id
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.uploadInFlight?.requestId == requestId else { return }
            self.uploadInFlight = nil
            self.update(imageId) { $0.state = .failed }
            self.pumpUploads()
        }
        uploadInFlight = (requestId, imageId, work)
        update(imageId) { $0.state = .uploading }
        send(["type": "upload", "requestId": requestId, "image": jpeg.base64EncodedString()])
        DispatchQueue.main.asyncAfter(deadline: .now() + 120, execute: work)
    }

    // MARK: 提交 / 删除

    private func startRequest(kind: String, payload: [String: Any]) {
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pendingRequest?.id == requestId else { return }
            self.pendingRequest = nil
            self.submitting = false
            self.alertMessage = self.text("timeout", "请求超时，请稍后重试")
        }
        pendingRequest = (requestId, kind, work)
        submitting = true
        var data = payload
        data["type"] = kind
        data["requestId"] = requestId
        send(data)
        DispatchQueue.main.asyncAfter(deadline: .now() + 90, execute: work)
    }

    func submit() {
        guard canSubmit else {
            if trimmedName.isEmpty { alertMessage = text("nameRequired", "请填写店名") }
            return
        }
        // 新增地点必须自己选评价，不预选
        if isCreate && rating == nil {
            ratingMissing = true
            alertMessage = text("ratingRequired", "请选择你的评价")
            return
        }
        var values = self.values
        if isCreate {
            values["rating_input_kind"] = "explicit"
        }
        startRequest(kind: "submit", payload: ["values": values])
    }

    func delete() {
        guard !submitting else { return }
        startRequest(kind: "delete", payload: [:])
    }

    func finishRequest(requestId: String, ok: Bool, message: String, url: String?) {
        if let upload = uploadInFlight, upload.requestId == requestId {
            upload.timeout.cancel()
            uploadInFlight = nil
            if ok, let url, url.hasPrefix("http") {
                update(upload.imageId) {
                    $0.url = url
                    $0.jpeg = nil
                    $0.state = .done
                }
            } else {
                update(upload.imageId) { $0.state = .failed }
                if !message.isEmpty { alertMessage = message }
            }
            pumpUploads()
            return
        }
        guard let entry = pendingRequest, entry.id == requestId else { return }
        entry.timeout.cancel()
        pendingRequest = nil
        submitting = false
        if ok {
            onFinish?(entry.kind == "delete" ? "deleted" : "submitted")
        } else {
            alertMessage = message.isEmpty ? text("failed", "提交失败，请稍后重试") : message
        }
    }

    func cancelPending() {
        pendingRequest?.timeout.cancel()
        pendingRequest = nil
        uploadInFlight?.timeout.cancel()
        uploadInFlight = nil
    }

    /// 取消：修改地点有改动时先确认放弃，提交中不能取消；新增地点直接结束（网页存草稿）
    func requestCancel() {
        guard !submitting else { return }
        if !isCreate && hasChanges { confirmDiscard = true } else { onFinish?("cancel") }
    }

    func pickPosition() {
        guard !submitting, !uploading else { return }
        onFinish?("pickPosition")
    }
}

// MARK: - 页面

private struct NativePlaceFormView: View {
    @ObservedObject var model: NativePlaceFormModel
    @State private var exteriorItems: [PhotosPickerItem] = []
    @State private var menuItems: [PhotosPickerItem] = []
    @State private var cameraGroup: NativePlaceFormModel.ImageGroup?

    private let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        NavigationStack {
            Form {
                if !model.addressText.isEmpty || !model.positionText.isEmpty {
                    Section {
                        if !model.addressText.isEmpty {
                            LabeledContent(model.text("address", "地址"), value: model.addressText)
                        }
                        if !model.positionText.isEmpty {
                            LabeledContent(model.text("position", "位置"), value: model.positionText)
                        }
                        if model.canPickPosition {
                            Button {
                                model.pickPosition()
                            } label: {
                                Label(model.text("pickPosition", "在地图上修改位置"), systemImage: "mappin.and.ellipse")
                            }
                        }
                    }
                }
                Section {
                    TextField(model.text("namePlaceholder", "店名"), text: $model.name)
                } header: {
                    Text(model.text("name", "店名"))
                }
                Section {
                    NavigationLink {
                        NativePlaceCategoryPicker(model: model)
                    } label: {
                        HStack {
                            Text(model.text("category", "分类"))
                            Spacer(minLength: 12)
                            Text(model.categories.isEmpty ? model.text("categoryNone", "未选择") : model.categories.joined(separator: "、"))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
                Section {
                    TextField(model.text("descriptionPlaceholder", "简介"), text: $model.description, axis: .vertical)
                        .lineLimit(4...12)
                } header: {
                    Text(model.text("description", "简介"))
                } footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.text("markdownHint", "支持基础 Markdown"))
                        HStack {
                            Spacer()
                            Text("\(model.description.count) / \(model.maxDescription)").monospacedDigit()
                        }
                    }
                }
                Section {
                    TextField(model.text("costPlaceholder", "人均（元，选填）"), text: $model.cost)
                        .keyboardType(.numberPad)
                } header: {
                    Text(model.text("cost", "人均"))
                }
                if model.isCreate && !model.tiers.isEmpty {
                    Section {
                        HStack(spacing: 8) {
                            ForEach(model.tiers) { tier in
                                ratingOption(tier)
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                    } header: {
                        Text(model.text("rating", "我的评价"))
                    } footer: {
                        if let tier = model.tiers.first(where: { $0.id == model.rating }) {
                            Text(tier.hint)
                        } else if model.ratingMissing {
                            Text(model.text("ratingRequired", "请选择你的评价")).foregroundStyle(Color.red)
                        }
                    }
                }
                imagesSection(.exterior, items: $exteriorItems)
                imagesSection(.menu, items: $menuItems)
                if !model.isCreate && !model.canDirect {
                    Section {
                        Text(model.text("needsReview", "你不是创建者，修改会提交给管理员审核"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                if model.canDelete {
                    Section {
                        Button(role: .destructive) {
                            model.confirmDelete = true
                        } label: {
                            Text(model.text("delete", "删除地点"))
                        }
                    }
                }
            }
            .disabled(model.submitting)
            .navigationTitle(model.text("title", model.isCreate ? "添加地点" : "修改地点"))
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
                        Button(model.text("submit", "提交")) { model.submit() }
                            .font(.body.weight(.semibold))
                            .disabled(model.trimmedName.isEmpty || model.uploading || model.loadingImages)
                    }
                }
            }
        }
        .tint(model.tint)
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
        .confirmationDialog(model.text("discardTitle", "放弃这次修改？"), isPresented: $model.confirmDiscard, titleVisibility: .visible) {
            Button(model.text("discard", "放弃"), role: .destructive) { model.onFinish?("cancel") }
            Button(model.text("keepEditing", "继续编辑"), role: .cancel) {}
        }
        .confirmationDialog(model.text("deleteTitle", "删除这个地点？"), isPresented: $model.confirmDelete, titleVisibility: .visible) {
            Button(model.text("delete", "删除地点"), role: .destructive) { model.delete() }
            Button(model.text("cancel", "取消"), role: .cancel) {}
        }
        .fullScreenCover(item: $cameraGroup) { group in
            PlaceFormCameraPicker { image in
                cameraGroup = nil
                if let image { model.addImages([image], to: group) }
            }
            .ignoresSafeArea()
        }
        .onChange(of: model.description) { _, value in
            if value.count > model.maxDescription { model.description = String(value.prefix(model.maxDescription)) }
        }
        .onChange(of: model.cost) { _, value in
            // 人均只要正整数
            var digits = String(value.filter(\.isNumber).prefix(6))
            while digits.hasPrefix("0") { digits.removeFirst() }
            if digits != value { model.cost = digits }
        }
        .onChange(of: model.isLocked) { _, locked in
            model.onLockChange?(locked)
        }
        .onChange(of: exteriorItems) { _, items in load(items, into: .exterior) }
        .onChange(of: menuItems) { _, items in load(items, into: .menu) }
    }

    /// 评价的一档：四档各有颜色，选中时加粗、描边、底色加深。同一行有四个按钮，用 borderless 才能分别点
    private func ratingOption(_ tier: NativePlaceFormModel.Tier) -> some View {
        let selected = model.rating == tier.id
        let color = model.color(for: tier)
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        return Button {
            model.rating = tier.id
            model.ratingMissing = false
        } label: {
            Text(tier.title)
                .font(.subheadline.weight(selected ? .bold : .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(color)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(shape.fill(color.opacity(selected ? 0.18 : 0.07)))
                .overlay(shape.strokeBorder(selected ? color : (model.ratingMissing ? Color.red : color.opacity(0.35)), lineWidth: selected ? 2 : 1))
                .contentShape(shape)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(tier.hint.isEmpty ? tier.title : "\(tier.title)：\(tier.hint)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func load(_ items: [PhotosPickerItem], into group: NativePlaceFormModel.ImageGroup) {
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
                if group == .exterior { exteriorItems = [] } else { menuItems = [] }
                model.loadingImages = false
                model.addImages(loaded, to: group)
                if failed { model.alertMessage = model.text("imageUnreadable", "图片无法读取") }
            }
        }
    }

    private func imagesSection(_ group: NativePlaceFormModel.ImageGroup, items: Binding<[PhotosPickerItem]>) -> some View {
        let images = model.images(group)
        return Section {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(images) { image in
                            imageTile(image)
                        }
                    }
                    // 留出删除钮扩大后伸出图片右上角的点按范围
                    .padding(.vertical, 8)
                    .padding(.trailing, 8)
                }
            }
            if model.remaining(group) > 0 {
                PhotosPicker(selection: items, maxSelectionCount: model.remaining(group), selectionBehavior: .ordered, matching: .images) {
                    Label(model.text("chooseFromAlbum", "从相册选择（可多选）"), systemImage: "photo.on.rectangle")
                }
                .disabled(model.loadingImages)
                if cameraAvailable {
                    Button {
                        cameraGroup = group
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
            Text(group == .exterior ? model.text("exteriorImages", "外观图片") : model.text("menuImages", "菜单图片"))
        }
    }

    private func imageTile(_ image: NativePlaceFormModel.FormImage) -> some View {
        ZStack {
            if let preview = image.preview {
                Image(uiImage: preview).resizable().scaledToFill()
            } else if let url = URL(string: image.thumbnail ?? image.url ?? "") {
                AsyncImage(url: url) { loaded in
                    loaded.resizable().scaledToFill()
                } placeholder: {
                    ProgressView()
                }
            }
            if image.state == .queued || image.state == .uploading {
                Color.black.opacity(0.35)
                ProgressView().tint(.white)
                    .accessibilityLabel(Text(model.text("uploading", "上传中")))
            }
            if image.state == .failed {
                Color.black.opacity(0.45)
                Button {
                    model.retryImage(image.id)
                } label: {
                    Image(systemName: "arrow.clockwise.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text(model.text("retryUpload", "重试上传")))
            }
        }
        .frame(width: 76, height: 76)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .topTrailing) {
            // 图标仍是 20pt、位置不变（中心距右上角 14pt），点按范围扩大到 44×44
            Button {
                model.removeImage(image.id)
            } label: {
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

/// 分类选择：常用在前，可搜索；搜不到时可以添加新分类（保存地点时后端登记到分类目录）
private struct NativePlaceCategoryPicker: View {
    @ObservedObject var model: NativePlaceFormModel
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    private var visible: [NativePlaceFormModel.CategoryOption] {
        let options = model.categoryOptions
        guard !trimmedQuery.isEmpty else { return options }
        return options.filter { $0.name.localizedCaseInsensitiveContains(trimmedQuery) }
    }

    var body: some View {
        List {
            Section {
                searchField
            }
            // 已选但不在目录里的（新分类、旧数据）也要能取消
            let extra = model.categories.filter { name in !model.categoryOptions.contains { $0.name == name } }
            if !extra.isEmpty {
                Section {
                    ForEach(extra, id: \.self) { name in
                        row(name)
                    }
                }
            }
            if !trimmedQuery.isEmpty && !model.categoryOptions.contains(where: { $0.name == trimmedQuery }) && !model.categories.contains(trimmedQuery) {
                Section {
                    Button {
                        if NativePlaceFormModel.validCategory(trimmedQuery) {
                            model.toggleCategory(trimmedQuery)
                            query = ""
                        } else {
                            model.alertMessage = model.text("categoryInvalid", "分类不能超过 8 个汉字或 16 个英文字符，且不能包含逗号")
                        }
                    } label: {
                        // 文案（含冒号）由网页下发，后面接输入的分类名
                        Label(model.text("categoryAdd", "添加新分类：") + trimmedQuery, systemImage: "plus.circle")
                    }
                }
            }
            Section {
                ForEach(visible) { option in
                    row(option.name)
                }
            }
        }
        .navigationTitle(model.text("category", "分类"))
        .navigationBarTitleDisplayMode(.inline)
    }

    /// 搜索框占满一整行、至少 44pt 高，点这一行任何位置都能开始输入
    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField(model.text("categorySearch", "搜索或添加分类"), text: $query)
                .focused($searchFocused)
                .submitLabel(.search)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !query.isEmpty {
                Button {
                    query = ""
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text(model.text("clearSearch", "清空")))
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        .onTapGesture { searchFocused = true }
    }

    private func row(_ name: String) -> some View {
        Button {
            model.toggleCategory(name)
        } label: {
            HStack {
                Text(name).foregroundStyle(Color.primary)
                Spacer()
                if model.categories.contains(name) {
                    Image(systemName: "checkmark").foregroundStyle(model.tint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(model.categories.contains(name) ? .isSelected : [])
    }
}

/// 系统相机（PhotosPicker 不能拍照）
private struct PlaceFormCameraPicker: UIViewControllerRepresentable {
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
