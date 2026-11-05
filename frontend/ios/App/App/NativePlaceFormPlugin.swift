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
            let host = MapChromeHostingController(rootView: NativePlaceFormView(model: model), dark: model.dark)
            host.modalPresentationStyle = .pageSheet
            // iOS 26 的 pageSheet 本身是 Liquid Glass：宿主与表单都不铺底色（与地点卡片一致，全屏时由系统过渡为不透明）；
            // 更早的系统继续用不透明分组底色，避免深色地图上的内容被浅色系统面板洗白。
            if #available(iOS 26.0, *) {
                host.view.backgroundColor = .clear
            } else {
                host.view.backgroundColor = FM.UI.bgBase
            }
            if let sheet = host.sheetPresentationController {
                if model.isCreate {
                    // 与地点详情一致：先停在半屏，上滑交给面板本身展开到全屏；半屏时不滚动内容
                    let compact = UISheetPresentationController.Detent.Identifier("placeForm.compact")
                    sheet.detents = [.custom(identifier: compact) { context in context.maximumDetentValue * 0.45 }, .large()]
                    sheet.selectedDetentIdentifier = compact
                    sheet.largestUndimmedDetentIdentifier = compact
                    self.sheetDelegate.onDetent = { [weak model] large in
                        guard let model else { return }
                        withAnimation(.easeOut(duration: 0.2)) { model.expanded = large }
                    }
                } else {
                    sheet.detents = [.large()]
                    model.expanded = true
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

private final class PlaceFormSheetDelegate: NSObject, UISheetPresentationControllerDelegate {
    var onAttemptDismiss: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onDetent: ((Bool) -> Void)?

    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
        onAttemptDismiss?()
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }

    func sheetPresentationControllerDidChangeSelectedDetentIdentifier(_ sheetPresentationController: UISheetPresentationController) {
        onDetent?(sheetPresentationController.selectedDetentIdentifier == .large)
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
    @Published var noExperience: Bool
    /// 提交时还没选评价：评价选项标红
    @Published var ratingMissing = false
    @Published var exterior: [FormImage]
    @Published var menu: [FormImage]
    @Published private(set) var submitting = false
    @Published var loadingImages = false
    @Published var alertMessage: String?
    @Published var confirmDiscard = false
    @Published var confirmDelete = false
    /// 新建时先停在半屏；上滑到全屏后才允许滚动，和地点卡片的展开方式一致。
    @Published var expanded = false

    let isCreate: Bool
    let needsEditRating: Bool
    private let original: JSObject
    private let originalPosition: String
    let dark: Bool
    let tint: Color
    /// 住民设置的辅色（分类标签、次要强调）
    let secondary: Color
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
        needsEditRating = call.getBool("ratingRequired", false)
        original = call.getObject("original") ?? [:]
        originalPosition = call.getString("originalPosition") ?? ""
        expanded = call.getString("mode") == "edit"
        dark = call.getBool("dark", false)
        let colors = NativeThemeColors(primary: call.getString("primary"), secondary: call.getString("secondary"))
        tint = colors.primary
        secondary = colors.secondary
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
        noExperience = (values["noExperience"] as? Bool) ?? false
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
        [name, categories.joined(separator: ","), description, cost, String(rating ?? 0), String(noExperience),
         (exterior + menu).compactMap(\.url).joined(separator: "|")].joined(separator: "\u{1}")
    }

    var trimmedName: String { name.trimmingCharacters(in: .whitespacesAndNewlines) }
    var uploading: Bool { (exterior + menu).contains { $0.state == .queued || $0.state == .uploading } }
    var canSubmit: Bool { !trimmedName.isEmpty && !submitting && !uploading && !loadingImages }
    var hasChanges: Bool { contentKey != initialKey || (exterior + menu).contains { $0.state != .done } }
    /// 修改地点有改动或正在提交时不能直接下滑关掉；新增地点的内容会存成草稿，可以直接关
    var isLocked: Bool { submitting || (!isCreate && hasChanges) }
    /// 评价选项的颜色（与网页 rating.js 相同）：强烈推荐成功色、均线之上主题色、均线之下警告色、强烈拒绝危险色
    func color(for tier: Tier) -> Color {
        if let color = tier.color { return Color(uiColor: color) }
        switch tier.id {
        case 4: return FM.success
        case 2: return FM.warning
        case 1: return FM.danger
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
        if let rating, !noExperience { result["rating"] = rating } else { result["rating"] = NSNull() }
        result["noExperience"] = noExperience
        return result
    }

    var editPreview: String {
        func old(_ key: String) -> String {
            guard let value = original[key], !(value is NSNull) else { return "" }
            return String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let fields = [(text("name", "店名"), old("name"), trimmedName),
                      (text("category", "分类"), old("category").replacingOccurrences(of: ", ", with: ","), categories.joined(separator: ",")),
                      (text("description", "描述"), old("description"), description.trimmingCharacters(in: .whitespacesAndNewlines)),
                      (text("cost", "人均"), old("per_person_cost"), cost)]
        var lines = fields.filter { $0.1 != $0.2 }.map { "\($0.0)：\($0.1.isEmpty ? "（空）" : $0.1) → \($0.2.isEmpty ? "（空）" : $0.2)" }
        if !originalPosition.isEmpty && originalPosition != positionText { lines.append("\(text("position", "位置"))：\(originalPosition) → \(positionText)") }
        func oldImages(_ key: String) -> [String] {
            if let list = original[key] as? [String] { return list }
            if let value = original[key] as? String, let data = value.data(using: .utf8), let list = try? JSONSerialization.jsonObject(with: data) as? [String] { return list }
            return []
        }
        if oldImages("exterior_images") != exterior.compactMap({ $0.url }) { lines.append("\(text("exteriorImages", "门面图片"))：已更新") }
        if oldImages("menu_images") != menu.compactMap({ $0.url }) { lines.append("\(text("menuImages", "菜单图片"))：已更新") }
        return lines.isEmpty ? text("noChanges", "暂无修改") : lines.joined(separator: "\n")
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
        if (isCreate || (needsEditRating && !noExperience)) && rating == nil {
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

/// 添加 / 修改地点表单。与地点卡片同一种做法：不套 NavigationStack、不铺底色，面板底色完全交给系统
/// （iOS 26 半屏是 Liquid Glass，拉到全屏由系统过渡为不透明）；顶部是与收藏面板一致的标题行
/// （左提交、居中标题、右关闭），各栏是 tertiarySystemFill 的圆角分组，与收藏面板的分组底色、透明度相同。
private struct NativePlaceFormView: View {
    @ObservedObject var model: NativePlaceFormModel
    /// 相册选图：点“添加图片”菜单里的“从相册选择”后弹出系统相册，选好的图放进 pickerTarget 这一组
    @State private var pickerShown = false
    @State private var pickerTarget: NativePlaceFormModel.ImageGroup?
    @State private var pickedItems: [PhotosPickerItem] = []
    @State private var cameraGroup: NativePlaceFormModel.ImageGroup?
    @State private var categoryQuery = ""
    @FocusState private var categoryFocused: Bool

    private let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    locationSection
                    formSection(model.text("name", "店名")) {
                        row {
                            TextField(model.text("namePlaceholder", "店名"), text: $model.name)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                        }
                    }
                    categorySection
                    formSection(model.text("cost", "人均")) {
                        row {
                            HStack(spacing: 6) {
                                TextField(model.text("costPlaceholder", "人均价格（元，可选）"), text: $model.cost)
                                    .keyboardType(.numberPad)
                                if !model.cost.isEmpty {
                                    Text(model.text("costUnit", "元")).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    descriptionSection
                    if !model.isCreate && model.needsEditRating {
                        Toggle(model.text("noExperience", "仅纠错，没有实际体验"), isOn: $model.noExperience)
                            .onChange(of: model.noExperience) { _, value in if value { model.rating = nil } }
                    }
                    if (model.isCreate || (model.needsEditRating && !model.noExperience)) && !model.tiers.isEmpty {
                        ratingSection
                    }
                    if !model.isCreate {
                        formSection(model.text("editPreview", "修改记录预览")) {
                            Text(model.text("editNotice", "修改生效后，将以你的名义保存修改记录，仅管理员可查看。")).font(.caption).foregroundStyle(.secondary)
                            Text(model.editPreview).font(.callout).frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    imagesSection(.exterior)
                    imagesSection(.menu)
                    if !model.isCreate && !model.canDirect {
                        Label(model.text("needsReview", "你不是创建者，修改会提交给管理员审核"), systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                    }
                    if model.canDelete {
                        formSection(nil) {
                            Button(role: .destructive) {
                                model.confirmDelete = true
                            } label: {
                                row {
                                    Text(model.text("delete", "删除地点"))
                                        .frame(maxWidth: .infinity)
                                        .foregroundStyle(FM.dangerText)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            // 与地点卡片一致：半屏时内容不滚动，上滑由面板本身展开到全屏
            .scrollDisabled(!model.expanded)
            .scrollBounceBehavior(.basedOnSize)
            .disabled(model.submitting)
        }
        // 同步整个呈现（含系统面板），不只覆盖文字的 environment。
        .preferredColorScheme(model.dark ? .dark : .light)
        .nativeThemeColors(primary: model.tint, secondary: model.secondary)
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
        .photosPicker(
            isPresented: $pickerShown,
            selection: $pickedItems,
            maxSelectionCount: max(1, pickerTarget.map { model.remaining($0) } ?? 1),
            selectionBehavior: .ordered,
            matching: .images
        )
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
        .onChange(of: pickedItems) { _, items in
            guard !items.isEmpty, let group = pickerTarget else { return }
            pickedItems = []
            load(items, into: group)
        }
    }

    // MARK: 标题行

    /// 与收藏面板的标题行一致：左边提交、居中标题、右边统一关闭钮
    private var header: some View {
        NativeSheetHeader(title: model.text("title", model.isCreate ? "添加地点" : "修改地点"),
                          closeLabel: model.text("cancel", "取消"),
                          closeDisabled: model.submitting,
                          onClose: { model.requestCancel() }) {
            if model.submitting {
                ProgressView()
                    .accessibilityLabel(Text(model.text("submitting", "提交中...")))
            } else {
                let enabled = !(model.trimmedName.isEmpty || model.uploading || model.loadingImages)
                Button(model.text("submit", "提交")) { model.submit() }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(model.tint.fmReadableText)
                    .frame(minHeight: 44)
                    .buttonStyle(.plain)
                    .disabled(!enabled)
                    .opacity(enabled ? 1 : 0.45)
            }
        }
    }

    // MARK: 分组

    /// 一栏与一行：见 NativeGlassComponents.swift 的 NativeSheetGroup / NativeSheetRow
    private func formSection<Content: View>(_ title: String?, trailing: String? = nil,
                                            footer: String? = nil, footerColor: Color = .secondary,
                                            @ViewBuilder content: () -> Content) -> some View {
        NativeSheetGroup(title, trailing: trailing, footer: footer, footerColor: footerColor, content: content)
    }

    private func row<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        NativeSheetRow(content)
    }

    private var divider: some View {
        Divider().padding(.leading, 16)
    }

    @ViewBuilder
    private var locationSection: some View {
        if !model.addressText.isEmpty || !model.positionText.isEmpty {
            formSection(nil) {
                if !model.addressText.isEmpty {
                    row { LabeledContent(model.text("address", "地址"), value: model.addressText) }
                }
                if !model.positionText.isEmpty {
                    if !model.addressText.isEmpty { divider }
                    row {
                        LabeledContent(model.text("position", "位置")) {
                            Text(model.positionText).monospacedDigit()
                        }
                    }
                }
                if model.canPickPosition {
                    divider
                    Button {
                        model.pickPosition()
                    } label: {
                        row { Label(model.text("pickPosition", "在地图上修改位置"), systemImage: "mappin.and.ellipse") }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(model.tint)
                }
            }
        }
    }

    // MARK: 分类（与网页的分类输入一致）

    private var trimmedCategoryQuery: String { categoryQuery.trimmingCharacters(in: .whitespaces) }

    /// 没输入时是常用分类，输入时是匹配的分类（开头匹配在前）
    private var categorySuggestions: [String] {
        let query = trimmedCategoryQuery
        if query.isEmpty {
            return model.categoryOptions.filter(\.common).map(\.name)
        }
        let matches = model.categoryOptions.map(\.name).filter { $0.localizedCaseInsensitiveContains(query) }
        let prefix = matches.filter { $0.lowercased().hasPrefix(query.lowercased()) }
        return Array((prefix + matches.filter { !prefix.contains($0) }).prefix(30))
    }

    /// 回车或点“添加新分类”：已有的直接选中，新的检查长度与逗号后加入（保存地点时后端登记到分类目录）
    private func addTypedCategory() {
        let query = trimmedCategoryQuery
        guard !query.isEmpty else { return }
        if model.categories.contains(query) {
            categoryQuery = ""
            return
        }
        guard NativePlaceFormModel.validCategory(query) else {
            model.alertMessage = model.text("categoryInvalid", "分类不能超过 8 个汉字或 16 个英文字符，且不能包含逗号")
            return
        }
        model.toggleCategory(query)
        categoryQuery = ""
    }

    /// 网页同款：已选分类是可点掉的标签，后面紧跟输入框；聚焦或输入时下面列出常用 / 匹配的分类，回车添加新分类
    private var categorySection: some View {
        let query = trimmedCategoryQuery
        let suggestions = categorySuggestions
        let canAdd = !query.isEmpty && !model.categoryOptions.contains(where: { $0.name == query }) && !model.categories.contains(query)
        let showSuggestions = categoryFocused || !query.isEmpty
        return formSection(model.text("category", "分类")) {
            NativeFlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(model.categories, id: \.self) { name in
                    NativeTagChip(title: name, selected: true, symbol: "xmark") {
                        model.toggleCategory(name)
                    }
                }
                TextField(model.text("categorySearch", "搜索或添加分类"), text: $categoryQuery)
                    .focused($categoryFocused)
                    .submitLabel(.done)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit(addTypedCategory)
                    .frame(minWidth: 140, minHeight: 34)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .onTapGesture { categoryFocused = true }
            if showSuggestions {
                divider
                VStack(alignment: .leading, spacing: 8) {
                    Text(query.isEmpty ? model.text("categoryFrequent", "常用分类") : model.text("categoryMatching", "匹配分类"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if suggestions.isEmpty && !canAdd {
                        Text(model.text("categoryNoMatch", "没有匹配的分类，按回车创建"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    NativeFlowLayout(spacing: 6, lineSpacing: 6) {
                        if canAdd {
                            NativeTagChip(title: model.text("categoryAdd", "添加新分类：") + query, symbol: "plus") {
                                addTypedCategory()
                            }
                        }
                        ForEach(suggestions, id: \.self) { name in
                            NativeTagChip(title: name, selected: model.categories.contains(name)) {
                                model.toggleCategory(name)
                                categoryQuery = ""
                            }
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.15), value: showSuggestions)
    }

    private var descriptionSection: some View {
        formSection(model.text("description", "简介"),
                    trailing: "\(model.description.count) / \(model.maxDescription)",
                    footer: model.text("markdownHint", "支持基础 Markdown")) {
            row {
                TextField(model.text("descriptionPlaceholder", "简介"), text: $model.description, axis: .vertical)
                    .lineLimit(4...12)
            }
        }
    }

    // MARK: 评价

    private var ratingSection: some View {
        let selectedTier = model.tiers.first(where: { $0.id == model.rating })
        return formSection(model.text("rating", "我的评价"),
                           footer: selectedTier?.hint ?? (model.ratingMissing ? model.text("ratingRequired", "请选择你的评价") : nil),
                           footerColor: selectedTier == nil && model.ratingMissing ? FM.dangerText : .secondary) {
            HStack(spacing: 8) {
                ForEach(model.tiers) { tier in
                    ratingOption(tier)
                }
            }
            .padding(10)
        }
    }

    /// 评价的一档：四个按钮同一种圆角与边框粗细，只用颜色深浅区分选中；没选时提交，四个一起描红
    private func ratingOption(_ tier: NativePlaceFormModel.Tier) -> some View {
        let selected = model.rating == tier.id
        let color = model.color(for: tier)
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        let border: Color = selected ? color : (model.ratingMissing ? FM.danger.opacity(0.6) : color.opacity(0.35))
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
                .background(shape.fill(color.opacity(selected ? 0.2 : 0.06)))
                .overlay(shape.strokeBorder(border, lineWidth: 1.5))
                .contentShape(shape)
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(tier.hint.isEmpty ? tier.title : "\(tier.title)：\(tier.hint)"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    // MARK: 图片

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
                model.loadingImages = false
                model.addImages(loaded, to: group)
                if failed { model.alertMessage = model.text("imageUnreadable", "图片无法读取") }
            }
        }
    }

    /// 图片一组：已选图片横向排成一行；下面一个“添加图片”，点开小菜单选“从相册选择”或“拍照”
    private func imagesSection(_ group: NativePlaceFormModel.ImageGroup) -> some View {
        let images = model.images(group)
        return formSection(group == .exterior ? model.text("exteriorImages", "外观图片") : model.text("menuImages", "菜单图片")) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(images) { image in
                            imageTile(image)
                        }
                    }
                    // 留出删除钮扩大后伸出图片右上角的点按范围
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                }
                if model.remaining(group) > 0 || model.loadingImages { divider }
            }
            if model.remaining(group) > 0 {
                Menu {
                    Button {
                        pickerTarget = group
                        pickerShown = true
                    } label: {
                        Label(model.text("chooseFromAlbum", "从相册选择"), systemImage: "photo.on.rectangle")
                    }
                    if cameraAvailable {
                        Button {
                            cameraGroup = group
                        } label: {
                            Label(model.text("takePhoto", "拍照"), systemImage: "camera")
                        }
                    }
                } label: {
                    row {
                        Label(model.text("addImage", "添加图片"), systemImage: "plus.circle.fill")
                            .foregroundStyle(model.tint)
                    }
                    .contentShape(Rectangle())
                }
                .disabled(model.loadingImages)
            }
            if model.loadingImages {
                row {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                }
            }
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
        .clipShape(RoundedRectangle(cornerRadius: FM.Radius.md, style: .continuous))
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
