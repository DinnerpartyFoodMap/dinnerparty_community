import Capacitor
import PhotosUI
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
/// 呈现：从下方弹出的系统面板，入口（图文生成 / 日历 / 同好）停在半屏；进入子功能时展开到全屏，回到入口时收回半屏。
/// 图文生成与日历是自绘页面（NativeJourneyScreens，按网页同名页面的操作逻辑），其余页面用通用列表。
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
    private var queuedFinish: (action: String, animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    private let sheetDelegate = JourneySheetDelegate()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "close", animated: false) }
        }
        // 用户下滑关闭面板
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
            model.colors = NativeThemeColors(primary: theme["primary"] as? String, secondary: theme["secondary"] as? String,
                                             onPrimary: theme["onPrimary"] as? String, primaryText: theme["primaryText"] as? String)
            model.presentation = "sheet"
            model.customRenderer = { spec, model in NativeJourneyScreens.view(for: spec, model: model) }
            let host = MapChromeHostingController(rootView: NativePageView(model: model), dark: dark)
            host.modalPresentationStyle = .pageSheet
            // iOS 26 的面板本身是 Liquid Glass：宿主不铺底色（入口透出玻璃、全屏由系统过渡为不透明，与地点卡片一致）
            if #available(iOS 26.0, *) {
                host.view.backgroundColor = .clear
            } else {
                host.view.backgroundColor = FM.UI.bgBase
            }
            if let sheet = host.sheetPresentationController {
                let entry = UISheetPresentationController.Detent.Identifier("journey.entry")
                // 入口三行加标题：约 340pt；屏幕更矮时不超过一半
                let entryDetents: [UISheetPresentationController.Detent] = [
                    .custom(identifier: entry) { context in min(340, context.maximumDetentValue * 0.55) },
                    .large()
                ]
                sheet.detents = entryDetents
                sheet.selectedDetentIdentifier = entry
                sheet.largestUndimmedDetentIdentifier = entry
                sheet.prefersGrabberVisible = true
                sheet.prefersScrollingExpandsWhenScrolledToEdge = true
                // 进入子功能展开到全屏、回到入口收回半屏；子页上不能下滑关掉（防止丢失正在写的内容）。
                // 子页只保留全屏一档：否则列表滚到顶时继续下拉，系统面板会和列表抢手势（日历上表现为抖动、拉不动）
                model.onDepthChange = { [weak sheet, weak host] depth in
                    host?.isModalInPresentation = depth > 0
                    guard let sheet else { return }
                    let sub = depth > 0
                    let target: UISheetPresentationController.Detent.Identifier = sub ? .large : entry
                    let detentsChanged = sheet.detents.count != (sub ? 1 : entryDetents.count)
                    guard detentsChanged || sheet.selectedDetentIdentifier != target else { return }
                    sheet.animateChanges {
                        if sub {
                            sheet.selectedDetentIdentifier = .large
                            sheet.largestUndimmedDetentIdentifier = nil
                            sheet.detents = [.large()]
                        } else {
                            sheet.detents = entryDetents
                            sheet.selectedDetentIdentifier = entry
                            sheet.largestUndimmedDetentIdentifier = entry
                        }
                        sheet.prefersScrollingExpandsWhenScrolledToEdge = !sub
                    }
                }
            }
            host.presentationController?.delegate = self.sheetDelegate
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            // 序号随会话重新开始：网页每次打开都从 1 计数，沿用上一次的序号会把新会话的回执全部当成过期丢掉
            self.lastSeq = 0
            self.presenting = true
            presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled) { [weak self] in
                guard let self else { return }
                self.presenting = false
                // 滑入途中收到的关闭（网页离开 / 重新打开）等转场结束后执行，不留下没有会话的页面
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
            self.finish(action: "close", animated: false) { call.resolve() }
        }
    }

    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let model = self.model else { return }
            if call.getBool("silent", false) { return }
            // 受保护图片的回执只带图片，不影响页面与加载状态
            if let imageId = call.getString("imageId") {
                model.setImage(imageId, call.getString("imageData").flatMap { NativePageImage.decode($0) })
                return
            }
            let error = call.getString("error") ?? ""
            if let page = call.getObject("page") {
                let seq = call.getInt("seq", 0)
                if seq > 0 {
                    guard seq >= self.lastSeq else { return }
                    self.lastSeq = seq
                }
                model.apply(NativePageParser.spec(page))
            } else if let form = call.getObject("form").flatMap({ NativePageParser.form($0) }) {
                model.presentForm(form)
            } else {
                model.finishWithoutPage(error: !error.isEmpty)
            }
            if !error.isEmpty {
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
        if let completion { closeCompletions.append(completion) }
        guard !finishing else { return }
        if presenting {
            queuedFinish = (action, animated)
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
            self?.queuedFinish = nil
            call?.resolve(["id": id ?? "", "action": action])
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

/// 日记 · 同好面板的系统面板代理：用户下滑关闭时结束会话
private final class JourneySheetDelegate: NSObject, UIAdaptivePresentationControllerDelegate {
    var onDismiss: (() -> Void)?

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        onDismiss?()
    }
}

// MARK: - 自绘页面（按网页 JourneyComposer / JourneyCalendar 的操作逻辑）

/// spec.custom 的读取工具：网页下发的字段都是 JSValue
private struct JourneyData {
    let raw: JSObject

    func string(_ key: String, _ fallback: String = "") -> String { raw[key] as? String ?? fallback }
    func bool(_ key: String) -> Bool { raw[key] as? Bool ?? false }
    func int(_ key: String, _ fallback: Int = 0) -> Int { (raw[key] as? NSNumber)?.intValue ?? fallback }
    func objects(_ key: String) -> [JSObject] { (raw[key] as? JSArray ?? []).compactMap { $0 as? JSObject } }
    func strings(_ key: String) -> [String] { (raw[key] as? JSArray ?? []).compactMap { $0 as? String } }
    var labels: JourneyData { JourneyData(raw: raw["labels"] as? JSObject ?? [:]) }
    func label(_ key: String, _ fallback: String) -> String {
        let text = labels.string(key)
        return text.isEmpty ? fallback : text
    }
}

enum NativeJourneyScreens {
    /// 有对应自绘视图的页面返回它；其余页面用通用列表
    static func view(for spec: NativePageSpec, model: NativePageModel) -> AnyView? {
        guard let custom = spec.custom, let type = custom["type"] as? String else { return nil }
        let data = JourneyData(raw: custom)
        switch type {
        case "composer": return AnyView(NativeJourneyComposerView(model: model, data: data))
        case "calendar": return AnyView(NativeJourneyCalendarView(model: model, data: data))
        default: return nil
        }
    }

    static let dayFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    static func date(_ text: String) -> Date? { dayFormatter.date(from: text) }
    static func text(_ date: Date) -> String { dayFormatter.string(from: date) }
}

/// 页面里的提示条（网页 Notice）：文字 + 行内操作
private struct JourneyNotice: View {
    let notice: JourneyData
    let onAction: (String, String) -> Void
    @Environment(\.nativeSecondaryTint) private var secondaryTint

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(notice.string("text"), systemImage: notice.string("tone") == "warning" ? "exclamationmark.triangle" : "info.circle")
                .font(.subheadline)
                .foregroundStyle(notice.string("tone") == "warning" ? AnyShapeStyle(secondaryTint) : AnyShapeStyle(.primary))
            let actions = notice.objects("actions")
            if !actions.isEmpty {
                HStack(spacing: 16) {
                    ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                        Button((action["title"] as? String) ?? "") {
                            onAction((action["id"] as? String) ?? "", (action["title"] as? String) ?? "")
                        }
                        .font(.subheadline.weight(.semibold))
                        .buttonStyle(.borderless)
                    }
                }
            }
        }
        .padding(.vertical, 2)
    }
}

/// 页面末尾的操作区（网页 jw-footer）：说明 + 主按钮 + 次按钮；放在列表最后一段，跟着内容滚动（不固定在底部）
private struct JourneyFooter: View {
    let note: String
    let buttons: [JourneyData]
    let enabled: (JourneyData) -> Bool
    let busy: Bool
    let onTap: (JourneyData) -> Void

    var body: some View {
        VStack(spacing: 8) {
            if !note.isEmpty {
                Text(note)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            ForEach(Array(buttons.enumerated()), id: \.offset) { _, button in
                let style = button.string("style")
                Button {
                    onTap(button)
                } label: {
                    HStack(spacing: 8) {
                        if busy && style == "primary" { ProgressView().tint(.white) }
                        Text(button.string("title")).fontWeight(style == "primary" ? .semibold : .regular)
                    }
                    .frame(maxWidth: .infinity, minHeight: style == "link" ? 32 : 48)
                }
                .modifier(JourneyButtonStyle(style: style))
                .disabled(busy || !enabled(button))
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 12)
    }
}

private extension View {
    /// 操作区所在的列表段：不铺行底色、不留行边距
    func journeyFooterRow() -> some View {
        self
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
            .listRowSeparator(.hidden)
    }
}

private struct JourneyButtonStyle: ViewModifier {
    let style: String

    func body(content: Content) -> some View {
        switch style {
        case "primary":
            content.buttonStyle(.borderedProminent).buttonBorderShape(.capsule)
        case "link":
            content.buttonStyle(.borderless)
        default:
            content.buttonStyle(.bordered).buttonBorderShape(.capsule)
        }
    }
}

/// 图文生成（网页 JourneyComposer）：照片 → 描述 → 地址 → 日期（可多日）→ 可见性，底部生成 / 手动记录，右上角存草稿。
/// 输入随时（防抖）同步给网页，离开、上传照片、生成时网页都拿到最新内容。
private struct NativeJourneyComposerView: View {
    @Environment(\.nativePrimaryText) private var primaryText
    @ObservedObject var model: NativePageModel
    let data: JourneyData
    @Environment(\.nativePrimaryTint) private var primaryTint
    @State private var key = ""
    @State private var text = ""
    @State private var start = Date()
    @State private var end = Date()
    @State private var multiDay = false
    @State private var visibility = "public"
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var uploadQueue: [String] = []
    @State private var preparing = false
    @State private var syncWork: DispatchWorkItem?
    /// 描述是多行输入，回车是换行：键盘上方的“完成”收起键盘
    @FocusState private var textFocused: Bool

    private var maxDate: Date { NativeJourneyScreens.date(data.string("maxDate")) ?? Date() }
    private var photos: [JourneyData] { data.objects("photos").map { JourneyData(raw: $0) } }
    private var hasContent: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !photos.isEmpty }
    private var blocker: String {
        if !data.string("closed").isEmpty { return data.string("closed") }
        if preparing || !uploadQueue.isEmpty { return data.label("uploading", "照片上传中…") }
        return hasContent ? "" : data.label("blockerEmpty", "先添加照片或写几句描述")
    }

    var body: some View {
        List {
            ForEach(Array(data.objects("notices").enumerated()), id: \.offset) { _, notice in
                Section {
                    JourneyNotice(notice: JourneyData(raw: notice)) { id, title in
                        model.custom(id, values: values(), push: id == "viewAll" || id == "goReview" ? title : nil)
                    }
                }
                .listRowBackground(FM.bgSurface)
            }
            photosSection
            Section {
                TextField(data.label("textPlaceholder", "写下这一顿或这一天"), text: $text, axis: .vertical)
                    .lineLimit(5...14)
                    .focused($textFocused)
            } header: {
                Text(data.label("text", "描述"))
            } footer: {
                let limit = data.int("textLimit", 12000)
                Text(data.label("textHint", "") + (text.count > limit - 1000 ? "  \(text.count) / \(limit)" : ""))
            }
            .listRowBackground(FM.bgSurface)
            Section {
                Button {
                    model.custom("address", values: values(), push: data.label("address", "地址"))
                } label: {
                    HStack {
                        LabeledContent(data.label("address", "地址"), value: data.string("center").isEmpty ? data.label("addressUnset", "未设置") : data.string("center"))
                            .foregroundStyle(Color.primary)
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
            } footer: {
                Text(data.label("addressHint", ""))
            }
            .listRowBackground(FM.bgSurface)
            Section {
                DatePicker(multiDay ? data.label("dateStart", "开始日期") : data.label("dateSingle", "日期"),
                           selection: $start, in: ...maxDate, displayedComponents: .date)
                Toggle(data.label("multiDay", "跨多天"), isOn: $multiDay)
                if multiDay {
                    DatePicker(data.label("dateEnd", "结束日期"), selection: $end, in: start...max(start, maxDate), displayedComponents: .date)
                }
            } header: {
                Text(data.label("date", "日期"))
            }
            .listRowBackground(FM.bgSurface)
            Section {
                Picker(data.label("visibility", "可见性"), selection: $visibility) {
                    Text(data.label("public", "公开")).tag("public")
                    Text(data.label("private", "私密")).tag("private")
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            } header: {
                Text(data.label("visibility", "可见性"))
            } footer: {
                Text(data.label("privacyNote", ""))
            }
            if !data.string("note").isEmpty {
                Section {
                } footer: {
                    Text(data.string("note"))
                }
                .listRowBackground(FM.bgSurface)
            }
            Section {
                JourneyFooter(note: blocker, buttons: data.objects("buttons").map { JourneyData(raw: $0) },
                              enabled: { button in
                                  blocker.isEmpty && (!button.bool("needsText") || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                      && !(button.bool("blockedWhileGenerating") && data.bool("generating"))
                              },
                              busy: model.loading) { button in
                    syncWork?.cancel()
                    textFocused = false
                    model.custom(button.string("id"), values: values())
                }
                .journeyFooterRow()
            }
        }
        .listStyle(.insetGrouped)
        .nativePageBackground()
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(data.label("saveDraft", "存草稿")) {
                    syncWork?.cancel()
                    textFocused = false
                    model.custom("save", values: values())
                }
                .disabled(model.loading)
                // 工具栏文字按钮用加深的主色（浅色模式下主色当文字不够清楚，设计参考 1.1）
                .tint(primaryText)
            }
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(data.label("keyboardDone", "完成")) {
                    textFocused = false
                }
                .fontWeight(.semibold)
            }
        }
        .onAppear(perform: reset)
        .onChange(of: data.string("key")) { _, _ in reset() }
        .onChange(of: text) { _, _ in scheduleSync() }
        .onChange(of: start) { _, value in
            if end < value { end = value }
            scheduleSync()
        }
        .onChange(of: end) { _, _ in scheduleSync() }
        .onChange(of: multiDay) { _, on in
            if !on { end = start }
            scheduleSync()
        }
        .onChange(of: visibility) { _, _ in scheduleSync() }
        .onChange(of: pickerItems) { _, items in load(items) }
        .onChange(of: model.loading) { _, loading in
            if !loading { uploadNext() }
        }
    }

    // MARK: 照片

    private var photosSection: some View {
        let maxPhotos = data.int("maxPhotos", 12)
        return Section {
            if !photos.isEmpty {
                // 列表行里不用 Lazy 网格：懒加载的高度在滚动中反复变化，会让列表跳动
                let columns = 4
                let rows = stride(from: 0, to: photos.count, by: columns).map { Array(photos[$0..<min($0 + columns, photos.count)]) }
                VStack(spacing: 8) {
                    ForEach(rows.indices, id: \.self) { row in
                        HStack(spacing: 8) {
                            ForEach(rows[row].indices, id: \.self) { column in
                                photoTile(rows[row][column])
                            }
                            ForEach(rows[row].count..<columns, id: \.self) { _ in
                                Color.clear.frame(maxWidth: .infinity, maxHeight: 84)
                            }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
            if photos.count + uploadQueue.count < maxPhotos {
                PhotosPicker(selection: $pickerItems, maxSelectionCount: max(1, maxPhotos - photos.count - uploadQueue.count),
                             selectionBehavior: .ordered, matching: .images) {
                    Label(data.label("addPhoto", "添加照片"), systemImage: "photo.badge.plus")
                }
                .disabled(preparing)
            }
            if preparing || !uploadQueue.isEmpty {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(data.label("uploading", "照片上传中…")).foregroundStyle(.secondary)
                }
            }
        } header: {
            Text("\(data.label("photos", "照片")) \(photos.count)/\(maxPhotos)")
        }
        .listRowBackground(FM.bgSurface)
    }

    private func photoTile(_ photo: JourneyData) -> some View {
        let imageId = photo.string("image")
        return ZStack(alignment: .topTrailing) {
            Group {
                if let image = model.images[imageId] {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Color.primary.opacity(0.06)
                        .overlay(ProgressView())
                        .onAppear { model.loadImage(imageId) }
                }
            }
            .frame(height: 84)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: FM.Radius.md, style: .continuous))
            Button {
                syncWork?.cancel()
                model.custom("removePhoto", values: values(), extra: ["mediaId": photo.string("id")])
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 20))
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(Color.white, Color.black.opacity(0.6))
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(data.label("removePhoto", "移除照片")))
        }
    }

    /// 选好的照片先在本机压缩，再一张一张交给网页上传（每张上传完页面刷新后发下一张）
    private func load(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        preparing = true
        Task {
            var encoded: [String] = []
            for item in items {
                if let data = try? await item.loadTransferable(type: Data.self),
                   let image = UIImage(data: data),
                   let base64 = NativePageImage.encode(image) {
                    encoded.append(base64)
                }
            }
            await MainActor.run {
                pickerItems = []
                preparing = false
                uploadQueue.append(contentsOf: encoded)
                uploadNext()
            }
        }
    }

    private func uploadNext() {
        guard !model.loading, let next = uploadQueue.first else { return }
        uploadQueue.removeFirst()
        syncWork?.cancel()
        model.custom("addPhoto", values: values(), extra: ["image": next])
    }

    // MARK: 内容

    private func reset() {
        let next = data.string("key")
        guard key != next else { return }
        key = next
        text = data.string("text")
        start = NativeJourneyScreens.date(data.string("startDate")) ?? Date()
        end = NativeJourneyScreens.date(data.string("endDate")) ?? start
        multiDay = end > start
        visibility = data.string("visibility") == "private" ? "private" : "public"
    }

    private func values() -> [String: Any] {
        let startText = NativeJourneyScreens.text(start)
        return [
            "text": text,
            "start_date": startText,
            "end_date": multiDay ? NativeJourneyScreens.text(max(end, start)) : startText,
            "visibility": visibility
        ]
    }

    private func scheduleSync() {
        guard !key.isEmpty else { return }
        syncWork?.cancel()
        let snapshot = values()
        let target = model
        let work = DispatchWorkItem { [weak target] in target?.custom("sync", values: snapshot, silent: true) }
        syncWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }
}

/// 日历（网页 JourneyCalendar）：未完成入口 → 搜索与公开状态筛选 → 月份切换 → 月历（每天的篇数 / 草稿）→
/// 选中日期（或本月 / 搜索结果）的日记列表；右上角“管理”多选删除，选两篇可预览合并；底部图文生成 / 手动新建。
private struct NativeJourneyCalendarView: View {
    @Environment(\.nativePrimaryText) private var primaryText
    @Environment(\.nativeOnPrimary) private var onPrimary
    @ObservedObject var model: NativePageModel
    let data: JourneyData
    @Environment(\.nativePrimaryTint) private var primaryTint
    @Environment(\.nativeSecondaryTint) private var secondaryTint
    @State private var query = ""
    @State private var queryKey = ""
    @State private var manage = false
    @State private var selected: [String] = []
    @State private var confirmDelete = false
    @State private var searchWork: DispatchWorkItem?

    private var entries: [JourneyData] { data.objects("entries").map { JourneyData(raw: $0) } }
    private var searching: Bool { data.bool("searching") }

    var body: some View {
        List {
            Section {
                Button {
                    model.custom("unfinished", push: data.string("unfinishedTitle"))
                } label: {
                    HStack {
                        Label(data.string("unfinishedTitle"), systemImage: "tray.full")
                            .foregroundStyle(Color.primary)
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
            }
            .listRowBackground(FM.bgSurface)
            Section {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField(data.label("searchPlaceholder", "搜索店名、城市或关键词"), text: $query)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .onSubmit { search(now: true) }
                    if !query.isEmpty {
                        Button {
                            query = ""
                            search(now: true)
                        } label: {
                            Image(systemName: "xmark.circle.fill").foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.borderless)
                    }
                }
                Picker(data.label("filter", "筛选"), selection: Binding(
                    get: { data.string("filter") },
                    set: { value in
                        selected = []
                        model.custom("filter", extra: ["value": value])
                    }
                )) {
                    ForEach(Array(data.objects("filters").enumerated()), id: \.offset) { _, option in
                        Text((option["title"] as? String) ?? "").tag((option["id"] as? String) ?? "")
                    }
                }
                .pickerStyle(.segmented)
            }
            .listRowBackground(FM.bgSurface)
            if !searching {
                Section {
                    monthHeader
                    monthGrid
                }
                .listRowBackground(FM.bgSurface)
            }
            entriesSection
            if manage {
                manageSection
            } else {
                Section {
                    JourneyFooter(note: "", buttons: [
                        JourneyData(raw: ["id": "composer", "title": data.label("generate", "图文生成"), "style": "primary"]),
                        JourneyData(raw: ["id": "manual", "title": data.label("createManually", "手动新建"), "style": "secondary"])
                    ], enabled: { _ in true }, busy: model.loading) { button in
                        let id = button.string("id")
                        model.custom(id, push: button.string("title"))
                    }
                    .journeyFooterRow()
                }
            }
        }
        .listStyle(.insetGrouped)
        .nativePageBackground()
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button(manage ? data.label("done", "完成") : data.label("manage", "管理")) {
                    manage.toggle()
                    selected = []
                }
                .tint(primaryText)
            }
        }
        .alert(data.label("deleteTitle", "删除日记"), isPresented: $confirmDelete) {
            Button(data.label("delete", "删除"), role: .destructive) {
                let ids = selected
                selected = []
                model.custom("delete", extra: ["ids": ids])
            }
            Button(data.label("cancel", "取消"), role: .cancel) {}
        } message: {
            let publicCount = entries.filter { selected.contains($0.string("id")) && $0.bool("isPublic") }.count
            Text(String(format: data.label("deleteMessage", "删除选中的 %d 篇日记？"), selected.count)
                 + (publicCount > 0 ? data.label("deletePublicNote", "") : ""))
        }
        .onAppear(perform: syncQuery)
        .onChange(of: data.string("query")) { _, _ in syncQuery() }
        .onChange(of: query) { _, value in
            guard value != queryKey else { return }
            search(now: false)
        }
    }

    private var monthHeader: some View {
        HStack {
            Button {
                model.custom("month", extra: ["delta": -1])
            } label: {
                Image(systemName: "chevron.left").frame(width: 36, height: 36)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(data.label("prevMonth", "上个月")))
            Spacer()
            Text(data.string("monthTitle")).font(.headline)
            Spacer()
            Button {
                model.custom("month", extra: ["delta": 1])
            } label: {
                Image(systemName: "chevron.right").frame(width: 36, height: 36)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(Text(data.label("nextMonth", "下个月")))
        }
    }

    /// 月历：固定的周行（不用 LazyVGrid——列表行里的懒加载网格高度会在滚动中变化，部分机型上表现为抖动、拉不动）
    private var monthGrid: some View {
        let lead = max(0, min(6, data.int("lead")))
        let days = data.objects("days").map { JourneyData(raw: $0) }
        // nil 为月初前 / 月末后的空格
        let cells: [JourneyData?] = Array(repeating: nil, count: lead) + days.map { Optional($0) }
        let padded = cells + Array(repeating: nil, count: (7 - cells.count % 7) % 7)
        let weeks = stride(from: 0, to: padded.count, by: 7).map { Array(padded[$0..<$0 + 7]) }
        return VStack(spacing: 4) {
            HStack(spacing: 2) {
                ForEach(Array(data.strings("weekdays").enumerated()), id: \.offset) { _, weekday in
                    Text(weekday).font(.caption2).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }
            }
            ForEach(weeks.indices, id: \.self) { week in
                HStack(spacing: 2) {
                    ForEach(0..<7, id: \.self) { column in
                        if let day = weeks[week][column] {
                            dayCell(day)
                        } else {
                            Color.clear.frame(maxWidth: .infinity, minHeight: 46)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func dayCell(_ day: JourneyData) -> some View {
        let selectedDay = data.string("selectedDay")
        let date = day.string("date")
        let isSelected = date == selectedDay
        let isToday = day.bool("today")
        let count = day.int("count")
        return Button {
            model.custom("day", extra: ["date": isSelected ? "" : date])
        } label: {
            VStack(spacing: 2) {
                Text("\(day.int("day"))")
                    .font(.subheadline.weight(isToday || isSelected ? .bold : .regular))
                    .foregroundStyle(isSelected ? onPrimary : (isToday ? primaryText : Color.primary))
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(isSelected ? primaryTint : Color.clear))
                if count > 0 {
                    Text(String(format: data.label("dayCount", "%d篇"), count))
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(primaryText)
                } else if day.bool("draft") {
                    Text(data.label("draft", "草稿"))
                        .font(.caption2.weight(.semibold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .foregroundStyle(secondaryTint)
                } else {
                    Text(" ").font(.caption2)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 46)
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(Text(day.string("accessibility")))
    }

    @ViewBuilder
    private var entriesSection: some View {
        Section {
            ForEach(entries.indices, id: \.self) { index in
                entryRow(entries[index])
            }
            if entries.isEmpty {
                VStack(spacing: 6) {
                    Text(data.string("emptyTitle")).font(.subheadline.weight(.semibold))
                    if !data.string("emptyHint").isEmpty {
                        Text(data.string("emptyHint")).font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }
        } header: {
            Text(data.string("listTitle"))
        } footer: {
            if manage {
                Text(data.label("manageHint", "勾选日记后可删除；选两篇可预览合并"))
            }
        }
        .listRowBackground(FM.bgSurface)
    }

    private func entryRow(_ entry: JourneyData) -> some View {
        let id = entry.string("id")
        let checked = selected.contains(id)
        return Button {
            if manage {
                if checked { selected.removeAll { $0 == id } } else { selected.append(id) }
            } else {
                model.custom("open", extra: ["id": id], push: entry.string("title"))
            }
        } label: {
            HStack(spacing: 12) {
                if manage {
                    Image(systemName: checked ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(checked ? primaryTint : Color.secondary)
                }
                cover(entry.string("cover"))
                VStack(alignment: .leading, spacing: 3) {
                    Text(entry.string("title")).font(.body).foregroundStyle(Color.primary).lineLimit(2)
                    Text(entry.string("meta")).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 4)
                if !entry.string("badge").isEmpty {
                    Text(entry.string("badge"))
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background((entry.bool("isPublic") ? primaryTint : Color.secondary).opacity(0.14), in: Capsule())
                        .foregroundStyle(entry.bool("isPublic") ? primaryTint : Color.secondary)
                }
                if !manage {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(model.loading)
    }

    @ViewBuilder
    private func cover(_ imageId: String) -> some View {
        // 与网页日记入口的封面相同（网页那里是卡片 20 − 内边距 10 的同心圆角）
        let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
        if !imageId.isEmpty, let image = model.images[imageId] {
            Image(uiImage: image).resizable().scaledToFill().frame(width: 48, height: 48).clipShape(shape)
        } else {
            shape.fill(secondaryTint.opacity(0.14))
                .frame(width: 48, height: 48)
                .overlay(Image(systemName: "sparkles").foregroundStyle(secondaryTint))
                .onAppear { if !imageId.isEmpty { model.loadImage(imageId) } }
        }
    }

    private var manageSection: some View {
        Section {
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Text(String(format: data.label("deleteSelected", "删除选中的 %d 篇"), selected.count))
                    .frame(maxWidth: .infinity)
            }
            .disabled(selected.isEmpty || model.loading)
            if selected.count == 2 {
                Button {
                    model.custom("merge", extra: ["ids": selected], push: data.label("mergePreview", "预览合并"))
                } label: {
                    Text(data.label("mergePreview", "预览合并")).frame(maxWidth: .infinity)
                }
                .disabled(model.loading)
            }
            Button {
                model.custom("media", push: data.label("privateImages", "私人图片"))
            } label: {
                HStack {
                    Text(data.label("privateImages", "私人图片")).foregroundStyle(Color.primary)
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
        }
        .listRowBackground(FM.bgSurface)
    }

    private func syncQuery() {
        let value = data.string("query")
        queryKey = value
        if query != value { query = value }
    }

    /// 输入停顿 0.4 秒后再搜索（网页 300ms 防抖）；回车或清除立即搜索
    private func search(now: Bool) {
        searchWork?.cancel()
        let value = query.trimmingCharacters(in: .whitespaces)
        let target = model
        let work = DispatchWorkItem { [weak target] in
            queryKey = value
            selected = []
            target?.custom("search", extra: ["query": value])
        }
        searchWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + (now ? 0 : 0.4), execute: work)
    }
}
