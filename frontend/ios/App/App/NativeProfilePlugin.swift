import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生住民主页（/users/:id）。
///
/// open({ id, userId, theme, labels, loading, profile, selfLevels, widgetOptions }) -> { id, action: back|openPlace, values }
/// update({ id, profile? , error? }) -> {}：页面先滑入显示加载中，网页读到主页数据（或失败原因）后补上
/// respond({ id, requestId, ok, message, profile }) -> {}
/// close({ id }) -> {}
/// 事件 profileEvent：{ id, type: setTasteLevel|saveWidgets|setBlocked|reload, requestId, values }
///
/// 网页取 profile、执行屏蔽 / 偏好 / 小组件请求，并把六轴、小组件与文案整理成可直接显示的快照；
/// 原生只显示与收集输入，不访问后端、不持有凭证。
@objc(NativeProfilePlugin)
public class NativeProfilePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeProfilePlugin"
    public let jsName = "NativeProfile"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]

    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var model: NativeProfileModel?
    private var activeFinish: (action: String, values: [String: Any])?
    private var presenting = false
    private var queuedFinish: (action: String, values: [String: Any], animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    private let screenPresenter = NativeContainedScreenPresenter()

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "back", animated: false) }
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
            let model = NativeProfileModel(call: call) { [weak self] payload in
                guard let self, self.requestID == id else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("profileEvent", data: data)
            }
            model.onFinish = { [weak self] action, values in
                guard let self, self.requestID == id else { return }
                self.finish(action: action, values: values)
            }
            let host = UIHostingController(rootView: NativeProfileView(model: model))
            host.overrideUserInterfaceStyle = model.dark ? .dark : .light
            host.view.backgroundColor = FM.UI.bgBase
            host.view.accessibilityViewIsModal = true
            self.screenPresenter.onEdgeBack = { [weak self] in
                guard let self, !self.presenting, self.activeFinish == nil else { return false }
                self.finish(action: "back")
                return true
            }
            self.model = model
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            self.screenPresenter.present(host, from: presenter) { [weak self, weak host] in
                guard let self, let host, self.host === host else { return }
                self.presenting = false
                if let queued = self.queuedFinish {
                    self.queuedFinish = nil
                    self.finish(action: queued.action, values: queued.values, animated: queued.animated)
                }
            }
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("id") == self.requestID else { call.resolve(); return }
            self.finish(action: "back", animated: false) { call.resolve() }
        }
    }

    /// 打开时还没有主页数据：网页读到后补上，读取失败时给出原因（页面显示“重试”）
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard call.getString("id") == self.requestID, let model = self.model else { return }
            if let profile = call.getObject("profile") {
                model.applyProfile(profile)
            } else {
                model.applyLoadError(String((call.getString("error") ?? "").prefix(200)))
            }
        }
    }

    /// 网页处理完偏好 / 小组件 / 屏蔽请求后回传最新视图模型
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            self.model?.finish(requestId: requestId, ok: call.getBool("ok", false),
                               message: String((call.getString("message") ?? "").prefix(200)),
                               profile: call.getObject("profile") ?? [:])
        }
    }

    private func finish(action: String, values: [String: Any] = [:], animated: Bool = true, completion: (() -> Void)? = nil) {
        guard let host else { completion?(); return }
        if let completion { closeCompletions.append(completion) }
        guard activeFinish == nil else { return }
        if presenting {
            queuedFinish = (action, values, animated)
            return
        }
        activeFinish = (action, values)
        screenPresenter.dismiss(host, animated: animated) { [weak self, weak host] in
            guard let host else { return }
            self?.completeDismissal(host)
        }
    }

    private func completeDismissal(_ host: UIViewController) {
        guard self.host === host, host.parent == nil else { return }
        let result = activeFinish ?? (action: "back", values: [:])
        let call = pending
        let id = requestID
        model?.cancelPending()
        self.host = nil
        pending = nil
        requestID = nil
        model = nil
        activeFinish = nil
        presenting = false
        queuedFinish = nil
        let completions = closeCompletions
        closeCompletions.removeAll()
        call?.resolve(["id": id ?? "", "action": result.action, "values": result.values])
        completions.forEach { $0() }
    }
}

// MARK: - 状态

final class NativeProfileModel: ObservableObject {
    struct ProfileAxis: Identifiable {
        let key: String
        let label: String
        let accessible: String
        let description: String
        let value: Double?
        let selfLevel: Int?
        var id: String { key }
    }

    struct ProfilePlaceRow: Identifiable {
        let id: String
        let name: String
        let image: String
        let meta: String
    }

    struct WidgetGroup: Identifiable {
        let id: String
        let title: String
        let rows: [ProfilePlaceRow]
    }

    struct WidgetSection: Identifiable {
        let id: String
        let kind: String
        let title: String
        let empty: String
        let groups: [WidgetGroup]
    }

    struct LevelOption: Identifiable {
        let id: Int
        let label: String
    }

    struct WidgetOption: Identifiable {
        let id: String
        let title: String
    }

    struct ProfileView {
        let name: String
        let avatarURL: URL?
        let city: String
        let canEditTaste: Bool
        let canEditWidgets: Bool
        let canOpenCommunity: Bool
        let canOpenFavorites: Bool
        let canOpenLocations: Bool
        let canUseAccountActions: Bool
        let rejectedPlaceCount: Int
        let collectionVisibility: Bool?
        let canBlock: Bool
        let blocked: Bool
        let widgets: [String]
        let hiddenWidgets: Set<String>
        let sections: [WidgetSection]
        let axes: [ProfileAxis]
        let labels: [String: String]
        let levelOptions: [LevelOption]
        let widgetOptions: [WidgetOption]
    }

    @Published private(set) var view: ProfileView
    @Published var selectedAxis: String?
    @Published var editingHiddenWidgets: Set<String>?
    @Published private(set) var busy = false
    @Published var alertMessage: String?
    @Published var confirmBlock = false
    /// 主页数据还没到（页面已经滑入）
    @Published private(set) var loading: Bool
    /// 读取失败的原因：显示在页面里，可以重试
    @Published private(set) var loadError: String? = nil

    let dark: Bool
    let tint: Color
    /// 住民设置的辅色（标签、次要强调）
    let secondary: Color
    var onFinish: ((String, [String: Any]) -> Void)?

    private let selfLevels: [LevelOption]
    private let widgetOptions: [WidgetOption]
    private let baseLabels: [String: String]
    private let send: ([String: Any]) -> Void
    private var pendingRequest: (id: String, type: String, blocked: Bool, work: DispatchWorkItem)?

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        let theme = call.getObject("theme") ?? [:]
        dark = (theme["dark"] as? Bool) ?? call.getBool("dark", false)
        let colors = NativeThemeColors(primary: theme["primary"] as? String, secondary: theme["secondary"] as? String)
        tint = colors.primary
        secondary = colors.secondary
        baseLabels = Self.strings(call.getObject("labels"))
        let autoLabel = Self.text(baseLabels, "auto", "按评价自动推断")
        selfLevels = (call.getArray("selfLevels", JSObject.self) ?? []).compactMap { item -> LevelOption? in
            guard let id = (item["id"] as? NSNumber)?.intValue, (1...4).contains(id) else { return nil }
            return LevelOption(id: id, label: item["label"] as? String ?? "\(id)")
        } + [LevelOption(id: 0, label: autoLabel)]
        widgetOptions = (call.getArray("widgetOptions", JSObject.self) ?? []).compactMap { item -> WidgetOption? in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return WidgetOption(id: String(id.prefix(32)), title: item["title"] as? String ?? id)
        }
        let profile = call.getObject("profile") ?? [:]
        let labels = baseLabels.merging(Self.strings(profile["labels"] as? JSObject)) { _, new in new }
        view = Self.parse(profile, labels: labels, selfLevels: selfLevels, widgetOptions: widgetOptions)
        loading = call.getBool("loading", false)
    }

    func applyProfile(_ profile: JSObject) {
        let labels = baseLabels.merging(Self.strings(profile["labels"] as? JSObject)) { _, new in new }
        withAnimation(.easeOut(duration: 0.2)) {
            view = Self.parse(profile, labels: labels, selfLevels: selfLevels, widgetOptions: widgetOptions)
            loading = false
            loadError = nil
        }
    }

    func applyLoadError(_ message: String) {
        withAnimation(.easeOut(duration: 0.2)) {
            loading = false
            loadError = message.isEmpty ? text("loadFailed", "住民主页加载失败") : message
        }
    }

    /// 读取失败后重试：网页重新读取，结果仍经 update 回来
    func reload() {
        loadError = nil
        loading = true
        send(["type": "reload", "requestId": UUID().uuidString, "values": [String: Any]()])
    }

    private static func strings(_ object: JSObject?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in object ?? [:] {
            if let text = value as? String { out[key] = text }
        }
        return out
    }

    private static func text(_ labels: [String: String], _ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    private static func parse(_ object: JSObject, labels: [String: String],
                              selfLevels: [LevelOption], widgetOptions: [WidgetOption]) -> ProfileView {
        let axes = (object["axes"] as? JSArray ?? []).compactMap { entry -> ProfileAxis? in
            guard let item = entry as? JSObject,
                  let key = item["key"] as? String, !key.isEmpty else { return nil }
            let value = (item["value"] as? NSNumber)?.doubleValue
            let level = (item["selfLevel"] as? NSNumber)?.intValue
            return ProfileAxis(
                key: key,
                label: item["label"] as? String ?? key,
                accessible: item["accessible"] as? String ?? (item["label"] as? String ?? key),
                description: item["description"] as? String ?? "",
                value: value,
                selfLevel: level.flatMap { (1...4).contains($0) ? $0 : nil }
            )
        }
        let sections = (object["sections"] as? JSArray ?? []).enumerated().compactMap { (index, entry) -> WidgetSection? in
            guard let item = entry as? JSObject,
                  let kind = item["kind"] as? String, !kind.isEmpty else { return nil }
            let groups = (item["groups"] as? JSArray ?? []).compactMap { raw -> WidgetGroup? in
                guard let group = raw as? JSObject,
                      let id = group["id"] as? String else { return nil }
                let rows = (group["rows"] as? JSArray ?? []).compactMap { rawRow -> ProfilePlaceRow? in
                    guard let row = rawRow as? JSObject,
                          let id = row["id"] as? String, !id.isEmpty,
                          let name = row["name"] as? String, !name.isEmpty else { return nil }
                    return ProfilePlaceRow(id: id, name: name,
                                           image: row["image"] as? String ?? "",
                                           meta: row["meta"] as? String ?? "")
                }
                return WidgetGroup(id: id, title: group["title"] as? String ?? "", rows: rows)
            }
            return WidgetSection(id: "\(index)-\(kind)", kind: kind,
                                 title: item["title"] as? String ?? "",
                                 empty: item["empty"] as? String ?? "",
                                 groups: groups)
        }
        let avatar = object["avatarURL"] as? String ?? ""
        return ProfileView(
            name: object["name"] as? String ?? "住民",
            avatarURL: URL(string: avatar).flatMap { $0.scheme == "https" ? $0 : nil },
            city: object["city"] as? String ?? "",
            canEditTaste: (object["canEditTaste"] as? Bool) ?? false,
            canEditWidgets: (object["canEditWidgets"] as? Bool) ?? false,
            canOpenCommunity: (object["canOpenCommunity"] as? Bool) ?? false,
            canOpenFavorites: (object["canOpenFavorites"] as? Bool) ?? false,
            canOpenLocations: (object["canOpenLocations"] as? Bool) ?? false,
            canUseAccountActions: (object["canUseAccountActions"] as? Bool) ?? false,
            rejectedPlaceCount: max(0, (object["rejectedPlaceCount"] as? NSNumber)?.intValue ?? 0),
            collectionVisibility: object["collectionVisibility"] as? Bool,
            canBlock: (object["canBlock"] as? Bool) ?? false,
            blocked: (object["blocked"] as? Bool) ?? false,
            widgets: (object["widgets"] as? JSArray ?? []).compactMap { $0 as? String },
            hiddenWidgets: Set((object["hiddenWidgets"] as? JSArray ?? []).compactMap { $0 as? String }),
            sections: sections,
            axes: axes,
            labels: labels,
            levelOptions: selfLevels,
            widgetOptions: widgetOptions
        )
    }

    func text(_ key: String, _ fallback: String) -> String {
        Self.text(view.labels, key, fallback)
    }

    var selectedAxisValue: ProfileAxis? {
        guard let selectedAxis else { return nil }
        return view.axes.first { $0.key == selectedAxis }
    }

    func toggleAxis(_ key: String) {
        selectedAxis = selectedAxis == key ? nil : key
    }

    func setWidgetVisible(_ kind: String, isVisible: Bool) {
        guard var hidden = editingHiddenWidgets else { return }
        if isVisible {
            hidden.remove(kind)
        } else {
            hidden.insert(kind)
        }
        editingHiddenWidgets = hidden
    }

    func beginEditingWidgets() {
        editingHiddenWidgets = view.hiddenWidgets
    }

    // MARK: 请求

    private func start(_ type: String, values: [String: Any], blocked: Bool = false, timeout seconds: Double = 20) {
        guard !busy else { return }
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.pendingRequest?.id == requestId else { return }
            self.pendingRequest = nil
            self.busy = false
            self.alertMessage = self.text("tasteSaveFailed", "保存失败，请稍后重试")
        }
        pendingRequest = (requestId, type, blocked, work)
        busy = true
        send(["type": type, "requestId": requestId, "values": values])
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func setTasteLevel(_ key: String, _ level: Int?) {
        var values: [String: Any] = ["key": key]
        values["level"] = level.map { $0 as Any } ?? NSNull()
        start("setTasteLevel", values: values)
    }

    func saveWidgets() {
        guard let hidden = editingHiddenWidgets else { return }
        let widgets = view.widgets.isEmpty ? widgetOptions.prefix(1).map(\.id) : view.widgets
        let hiddenWidgets = widgetOptions.map(\.id).filter { hidden.contains($0) }
        start("saveWidgets", values: ["widgets": widgets, "hiddenWidgets": hiddenWidgets])
    }

    func setBlocked(_ blocked: Bool) {
        start("setBlocked", values: ["blocked": blocked], blocked: blocked)
    }

    func setCollectionVisibility(_ isPublic: Bool) {
        start("setCollectionVisibility", values: ["isPublic": isPublic])
    }

    func openCommunity() {
        onFinish?("openCommunity", [:])
    }

    func openFavorites() {
        onFinish?("openFavorites", [:])
    }

    func openLocations() {
        onFinish?("my-locations", [:])
    }

    func openSettings() {
        onFinish?("settings", [:])
    }

    func openCompanion() {
        onFinish?("companion", [:])
    }

    func logout() {
        onFinish?("logout", [:])
    }

    func openPlace(_ id: String) {
        onFinish?("openPlace", ["placeId": id])
    }

    func requestClose() {
        onFinish?("back", [:])
    }

    func finish(requestId: String, ok: Bool, message: String, profile: JSObject) {
        guard let entry = pendingRequest, entry.id == requestId else { return }
        entry.work.cancel()
        pendingRequest = nil
        busy = false
        guard ok else {
            alertMessage = message.isEmpty ? text("tasteSaveFailed", "保存失败，请稍后重试") : message
            return
        }
        if !profile.isEmpty {
            let labels = view.labels.merging(Self.strings(profile["labels"] as? JSObject)) { _, new in new }
            view = Self.parse(profile, labels: labels, selfLevels: selfLevels, widgetOptions: widgetOptions)
        }
        if entry.type == "saveWidgets" { editingHiddenWidgets = nil }
        // 屏蔽成功后网页已打开举报入口：收起主页，让举报表显示在地图页上。
        if entry.type == "setBlocked" && entry.blocked {
            onFinish?("back", [:])
        }
    }

    func cancelPending() {
        pendingRequest?.work.cancel()
        pendingRequest = nil
        busy = false
    }
}

// MARK: - 页面

private struct NativeProfileView: View {
    @ObservedObject var model: NativeProfileModel

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if model.loading {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 240)
                            .accessibilityLabel(Text(model.text("loading", "加载中")))
                    } else if let error = model.loadError {
                        NativePageCard(padding: 16) {
                            VStack(spacing: 12) {
                                Text(error)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                Button(model.text("retry", "重试")) { model.reload() }
                                    .buttonStyle(.bordered)
                            }
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        loadedContent
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .scrollDismissesKeyboard(.interactively)
            .nativePageBackground()
            .navigationTitle(model.text("title", "住民主页"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        model.requestClose()
                    } label: {
                        Image(systemName: "chevron.backward")
                            .font(.headline)
                    }
                    .tint(model.tint.fmReadableText)
                    .accessibilityLabel(Text(model.text("back", "返回")))
                }
            }
            .sheet(isPresented: Binding(get: { model.editingHiddenWidgets != nil }, set: { if !$0 { model.editingHiddenWidgets = nil } })) {
                widgetEditor
                    .presentationDetents([.medium, .large])
            }
        }
        .preferredColorScheme(model.dark ? .dark : .light)
        .nativeThemeColors(primary: model.tint, secondary: model.secondary)
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
        .alert(model.text("blockAndReport", "屏蔽并举报"), isPresented: $model.confirmBlock) {
            Button(model.text("blockAndReport", "屏蔽并举报"), role: .destructive) { model.setBlocked(true) }
            Button(model.text("cancel", "取消"), role: .cancel) {}
        } message: {
            Text(model.text("blockConfirm", "屏蔽后，TA 创建的地点、公开日记和同好名片都不会再显示给你，可以随时解除。"))
        }
    }

    @ViewBuilder
    private var loadedContent: some View {
        headerCard
        if model.view.blocked {
            NativePageCard(padding: 16) {
                Text(model.text("blockedNote", "你已屏蔽这位住民，TA 的地点和收藏不会显示给你。"))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        } else {
            radarCard
            axisEditor
            widgets
            if model.view.canUseAccountActions {
                accountActions
            }
        }
    }

    private var headerCard: some View {
        NativePageCard(padding: 16) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 14) {
                    AvatarImage(url: model.view.avatarURL)
                        .frame(width: 64, height: 64)
                        .clipShape(Circle())
                    VStack(alignment: .leading, spacing: 5) {
                        Text(model.view.name)
                            .font(.title3.weight(.semibold))
                            .lineLimit(1)
                        HStack(spacing: 4) {
                            Image(systemName: "location.fill")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(model.view.city)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if model.view.canOpenCommunity {
                        Button {
                            model.openCommunity()
                        } label: {
                            Text(model.text("community", "同好"))
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(model.tint.fmReadableText)
                                .padding(.horizontal, 12)
                                .frame(minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .fixedSize()
                    }
                }
                if model.view.canBlock {
                    Button {
                        if model.view.blocked {
                            model.setBlocked(false)
                        } else {
                            model.confirmBlock = true
                        }
                    } label: {
                        Text(model.view.blocked
                             ? model.text("unblock", "解除屏蔽")
                             : model.text("blockAndReport", "屏蔽并举报"))
                            .font(.subheadline.weight(.medium))
                            // 文字色要设在 nativeChip 里层，否则会被它的默认文字色盖住
                            .foregroundStyle(model.view.blocked ? Color.primary : FM.dangerText)
                            .frame(maxWidth: .infinity, minHeight: 38)
                            .nativeChip(selected: false)
                    }
                    .buttonStyle(.plain)
                    .disabled(model.busy)
                }
            }
        }
    }

    private var radarCard: some View {
        NativePageCard(padding: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(model.text("tasteTitle", "餐饮偏好"))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    if model.view.canEditTaste {
                        Text(model.text("tasteHint", "点类别名选择喜好"))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                NativeTasteRadar(
                    axes: model.view.axes,
                    selected: model.selectedAxis,
                    accent: model.tint
                ) { key in
                    model.toggleAxis(key)
                }
                .frame(height: 240)
                .padding(.top, 2)
            }
        }
    }

    @ViewBuilder
    private var axisEditor: some View {
        if let axis = model.selectedAxisValue {
            NativePageCard(padding: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(axis.label)
                        .font(.subheadline.weight(.semibold))
                    Text(axis.description)
                        .font(.subheadline)
                    if model.view.canEditTaste {
                    Text(model.text("selfTitle", "自己填"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    NativeFlowLayout(spacing: 8, lineSpacing: 8) {
                        ForEach(model.view.levelOptions) { option in
                            let selected = (option.id == 0 && axis.selfLevel == nil)
                                || (option.id != 0 && axis.selfLevel == option.id)
                            Button {
                                let level: Int? = option.id == 0 ? nil : option.id
                                model.setTasteLevel(axis.key, level)
                            } label: {
                                Text(option.label)
                                    .font(.caption)
                                    .nativeChip(selected: selected, tint: model.tint)
                            }
                            .buttonStyle(.plain)
                            .disabled(model.busy)
                        }
                    }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var widgets: some View {
        ForEach(model.view.sections) { section in
            NativePageCard(padding: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        let hasRejectedPlaces = section.kind == "recent" && model.view.rejectedPlaceCount > 0
                        Text(section.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityLabel(Text(hasRejectedPlaces ? model.text("rejectedPlaces", section.title) : section.title))
                        if hasRejectedPlaces {
                            Circle()
                                .fill(FM.danger)
                                .frame(width: 7, height: 7)
                                .accessibilityHidden(true)
                        }
                        Spacer(minLength: 0)
                        if section.kind == "collection", let isPublic = model.view.collectionVisibility {
                            Toggle(model.text("collectionPublic", "公开"), isOn: Binding(
                                get: { model.view.collectionVisibility ?? isPublic },
                                set: { model.setCollectionVisibility($0) }
                            ))
                            .font(.caption)
                            .tint(model.tint)
                            .fixedSize()
                            .disabled(model.busy)
                        }
                    }
                    if !section.empty.isEmpty && section.groups.isEmpty {
                        Text(section.empty)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(section.groups) { group in
                        if !group.title.isEmpty {
                            Text(group.title)
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .padding(.top, 2)
                        }
                        ForEach(group.rows) { row in
                            placeRow(row)
                        }
                    }
                    if section.kind == "collection", model.view.canOpenFavorites {
                        sectionLink(model.text("viewAllFavorites", "查看全部"), action: model.openFavorites)
                    } else if section.kind == "recent", model.view.canOpenLocations {
                        sectionLink(model.text("viewAllLocations", "查看全部"), action: model.openLocations)
                    }
                }
            }
        }
        // 与 iOS 主屏幕“编辑小组件”相同的位置：所有小组件下面居中一枚胶囊按钮
        if model.view.canEditWidgets {
            Button {
                model.beginEditingWidgets()
            } label: {
                Label(model.text("widgetsEdit", "调整小组件"), systemImage: "square.grid.2x2")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .nativeGlassSurface(cornerRadius: FM.Radius.full)
            }
            .buttonStyle(.plain)
            .foregroundStyle(model.tint)
            .frame(maxWidth: .infinity)
            .padding(.top, 4)
        }
    }

    private func sectionLink(_ title: String, action: @escaping () -> Void) -> some View {
        HStack {
            Spacer(minLength: 0)
            Button(action: action) {
                Text(title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(model.tint.fmReadableText)
                    .padding(.leading, 10)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private var accountActions: some View {
        NativePageCard(padding: 14) {
            VStack(spacing: 0) {
                accountRow(model.text("settings", "住民与地图设置"), symbol: "gearshape", action: model.openSettings)
                Divider()
                accountRow(model.text("companion", "角色观察屋"), symbol: "figure.stand", action: model.openCompanion)
                Divider()
                accountRow(model.text("logout", "暂离幻想乡"), symbol: "rectangle.portrait.and.arrow.right",
                           role: .destructive, action: model.logout)
            }
        }
    }

    private func accountRow(_ title: String, symbol: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            HStack {
                Label(title, systemImage: symbol)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(role == .destructive ? FM.dangerText : Color.primary)
                Spacer(minLength: 8)
                if role != .destructive {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// 调整小组件：独立切换各卡片；左上保存，右上关闭。
    private var widgetEditor: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(model.view.widgetOptions) { option in
                        Toggle(option.title, isOn: Binding(
                            get: { !(model.editingHiddenWidgets?.contains(option.id) ?? false) },
                            set: { model.setWidgetVisible(option.id, isVisible: $0) }
                        ))
                        .tint(model.tint)
                        .disabled(model.busy)
                    }
                }
                .listRowBackground(FM.bgSurface)
            }
            .nativePageBackground()
            .navigationTitle(model.text("widgetsEdit", "调整小组件"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                NativeCloseToolbarItem(label: model.text("cancel", "取消")) {
                    model.editingHiddenWidgets = nil
                }
                ToolbarItem(placement: .topBarLeading) {
                    if model.busy {
                        ProgressView()
                    } else {
                        Button(model.text("save", "保存")) { model.saveWidgets() }
                            .tint(model.tint.fmReadableText)
                            .font(.body.weight(.semibold))
                    }
                }
            }
        }
        .nativeThemeColors(primary: model.tint, secondary: model.secondary)
        .preferredColorScheme(model.dark ? .dark : .light)
    }

    private func placeRow(_ row: NativeProfileModel.ProfilePlaceRow) -> some View {
        Button {
            model.openPlace(row.id)
        } label: {
            HStack(spacing: 10) {
                Group {
                    if let url = URL(string: row.image), url.scheme == "https" {
                        AsyncImage(url: url) { image in
                            image.resizable().scaledToFill()
                        } placeholder: {
                            Image(systemName: "fork.knife")
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Image(systemName: "fork.knife")
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 42, height: 42)
                .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: FM.Radius.sm, style: .continuous))
                .clipShape(RoundedRectangle(cornerRadius: FM.Radius.sm, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.name)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    if !row.meta.isEmpty {
                        Text(row.meta)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// 网络头像：未设置或加载失败时显示默认图标（与设置页一致）
private struct AvatarImage: View {
    let url: URL?

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image.resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle.fill")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// 六轴餐饮偏好雷达：有依据的轴画点，相邻已知轴连线并填色；未知轴不画点。
/// 与网页 TasteRadar 的几何一致（画布 300，半径 80，轴名半径 102，上下各裁 18）。
private struct NativeTasteRadar: View {
    let axes: [NativeProfileModel.ProfileAxis]
    let selected: String?
    let accent: Color
    let onSelect: (String) -> Void

    private let designSize: CGFloat = 300
    private let crop: CGFloat = 18
    private let radius: CGFloat = 80
    private let labelRadius: CGFloat = 102

    var body: some View {
        GeometryReader { proxy in
            let scale = min(proxy.size.width / designSize, proxy.size.height / (designSize - crop * 2))
            let size = CGSize(width: designSize * scale, height: (designSize - crop * 2) * scale)
            let center = CGPoint(x: size.width / 2, y: (designSize / 2 - crop) * scale)
            ZStack(alignment: .topLeading) {
                Canvas { context, canvasSize in
                    draw(context: &context, size: canvasSize, center: center, scale: scale)
                }
                ForEach(Array(axes.enumerated()), id: \.element.id) { index, axis in
                    let angle = -Double.pi / 2 + Double(index) * 2 * Double.pi / 6
                    let x = center.x + CGFloat(cos(angle)) * labelRadius * scale
                    let y = center.y + CGFloat(sin(angle)) * labelRadius * scale - 4
                    Button {
                        onSelect(axis.key)
                    } label: {
                        Text(axis.label)
                            .font(.footnote.weight(selected == axis.key ? .bold : .medium))
                            .foregroundStyle(selected == axis.key ? accent.fmReadableText : Color.primary)
                            .fixedSize()
                    }
                    .buttonStyle(.plain)
                    .position(x: x, y: y)
                    .accessibilityLabel(Text(axis.accessible))
                }
            }
            .frame(width: size.width, height: size.height)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func point(_ index: Int, _ ratio: CGFloat, center: CGPoint, scale: CGFloat) -> CGPoint {
        let angle = -Double.pi / 2 + Double(index) * 2 * Double.pi / 6
        return CGPoint(
            x: center.x + CGFloat(cos(angle)) * radius * ratio * scale,
            y: center.y + CGFloat(sin(angle)) * radius * ratio * scale
        )
    }

    private func draw(context: inout GraphicsContext, size: CGSize, center: CGPoint, scale: CGFloat) {
        guard axes.count == 6 else { return }
        // 背景环
        for (ringIndex, ratio) in [0.25, 0.5, 0.75, 1.0].enumerated() {
            var path = Path()
            for index in 0..<6 {
                let position = point(index, CGFloat(ratio), center: center, scale: scale)
                if index == 0 { path.move(to: position) } else { path.addLine(to: position) }
            }
            path.closeSubpath()
            let dashed = ringIndex == 1
            context.stroke(
                path,
                with: .color(Color.secondary.opacity(dashed ? 0.45 : 0.28)),
                style: StrokeStyle(lineWidth: dashed ? 1.2 : 0.8, dash: dashed ? [3, 3] : [])
            )
        }
        // 相邻两轴都有值时连线并填色
        for index in 0..<6 {
            let axis = axes[index]
            let next = axes[(index + 1) % 6]
            guard let first = axis.value, let second = next.value else { continue }
            let firstPoint = point(index, CGFloat(first), center: center, scale: scale)
            let secondPoint = point((index + 1) % 6, CGFloat(second), center: center, scale: scale)
            var triangle = Path()
            triangle.move(to: center)
            triangle.addLine(to: firstPoint)
            triangle.addLine(to: secondPoint)
            triangle.closeSubpath()
            context.fill(triangle, with: .color(accent.opacity(0.2)))
            var line = Path()
            line.move(to: firstPoint)
            line.addLine(to: secondPoint)
            context.stroke(line, with: .color(accent.opacity(0.65)), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
        }
        // 所有已知轴使用相同样式
        for (index, axis) in axes.enumerated() {
            guard let value = axis.value else { continue }
            let position = point(index, CGFloat(value), center: center, scale: scale)
            let rect = CGRect(x: position.x - 3.5 * scale, y: position.y - 3.5 * scale,
                              width: 7 * scale, height: 7 * scale)
            let path = Path(ellipseIn: rect)
            context.fill(path, with: .color(accent))
            context.stroke(path, with: .color(accent), lineWidth: 2 * scale)
        }
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
