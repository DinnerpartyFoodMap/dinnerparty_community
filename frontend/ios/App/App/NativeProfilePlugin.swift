import Capacitor
import SwiftUI
import UIKit

/// 本地 Capacitor 插件：iOS 原生住民主页（/users/:id）。
///
/// open({ id, userId, theme, labels, loading, profile, selfLevels, widgetOptions }) -> { id, action, values }
/// update({ id, profile?, error?, theme?, companion? }) -> {}：页面先滑入显示加载中，网页读到主页数据（或失败原因）后补上；
///   打开期间改了明暗 / 主题色（theme）或小伙伴状态（companion）也经这里推来
/// respond({ id, requestId, ok, message, profile?, community?, companion? }) -> {}
/// close({ id }) -> {}
/// 事件 profileEvent：{ id, type, requestId, values }
///   主页：setTasteLevel | saveWidgets | setBlocked | setCollectionVisibility | reload | openSettings
///   页面栈：loadProfile（同好里点开的住民） | loadCommunity | loadCommunitySettings | saveCommunitySettings | clearInteractions
///          | loadCompanion | setCompanionEnabled | chooseCompanion
///
/// 主页自带页面栈（NavigationStack）：同好、角色观察屋和同好里点开的其他住民主页都推入在主页之上，
/// 返回时系统侧滑就能看到下面的主页；住民设置由网页在主页之上打开（NativeSettingsPlugin），主页不关闭。
/// 网页取数据、执行请求，并把六轴、小组件、同好与小伙伴整理成可直接显示的快照；原生只显示与收集输入，不访问后端、不持有凭证。
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
    private var session: NativeProfileSession?
    private var navigator: NativeProfileNavigator?
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
            let session = NativeProfileSession(call: call) { [weak self] payload in
                guard let self, self.requestID == id else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("profileEvent", data: data)
            }
            session.onFinish = { [weak self] action, values in
                guard let self, self.requestID == id else { return }
                self.finish(action: action, values: values)
            }
            let root = NativeProfileModel(session: session, userId: nil,
                                          profile: call.getObject("profile") ?? [:],
                                          loading: call.getBool("loading", false))
            let navigator = NativeProfileNavigator(session: session, root: root)
            // 推入二级页后，左边缘交给系统的跟手返回（回到主页）；只有主页本身时才由整页侧滑关闭
            navigator.onDepthChange = { [weak self] depth in
                self?.screenPresenter.edgeEnabled = depth == 0
            }
            let host = UIHostingController(rootView: NativeProfileRootView(navigator: navigator, session: session))
            host.overrideUserInterfaceStyle = session.dark ? .dark : .light
            host.view.backgroundColor = FM.UI.bgBase
            host.view.accessibilityViewIsModal = true
            session.onDarkChange = { [weak host] dark in
                host?.overrideUserInterfaceStyle = dark ? .dark : .light
            }
            self.screenPresenter.edgeEnabled = true
            self.screenPresenter.onEdgeBack = { [weak self] in
                guard let self, !self.presenting, self.activeFinish == nil else { return false }
                self.finish(action: "back")
                return true
            }
            self.session = session
            self.navigator = navigator
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

    /// 打开时还没有主页数据：网页读到后补上，读取失败时给出原因（页面显示“重试”）。
    /// 打开期间的主题、小伙伴变化也从这里来。
    @objc func update(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard call.getString("id") == self.requestID, let session = self.session, let navigator = self.navigator else { return }
            if let theme = call.getObject("theme") {
                session.applyTheme(theme)
            }
            if let companion = call.getObject("companion") {
                navigator.loadedCompanion?.apply(companion)
            }
            if let profile = call.getObject("profile") {
                navigator.root.applyProfile(profile)
            } else if let error = call.getString("error") {
                navigator.root.applyLoadError(String(error.prefix(200)))
            }
        }
    }

    /// 网页处理完请求后回传最新视图模型（主页 / 同好 / 小伙伴）
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            var payload: JSObject = [:]
            for key in ["profile", "community", "companion"] {
                if let object = call.getObject(key) { payload[key] = object }
            }
            self.session?.finish(requestId: requestId, ok: call.getBool("ok", false),
                                 message: String((call.getString("message") ?? "").prefix(200)),
                                 payload: payload)
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
        session?.cancelAll()
        self.host = nil
        pending = nil
        requestID = nil
        session = nil
        navigator = nil
        activeFinish = nil
        presenting = false
        queuedFinish = nil
        let completions = closeCompletions
        closeCompletions.removeAll()
        call?.resolve(["id": id ?? "", "action": result.action, "values": result.values])
        completions.forEach { $0() }
    }
}

// MARK: - 会话（主题、文案与请求）

struct NativeProfileLevelOption: Identifiable {
    let id: Int
    let label: String
}

struct NativeProfileWidgetOption: Identifiable {
    let id: String
    let title: String
}

/// 一次打开的主页会话：页面栈里的每一页共用主题、基础文案和到网页的请求通道。
/// 请求按 requestId 等网页 respond，超时按失败处理；关闭时全部作废。
final class NativeProfileSession: ObservableObject {
    @Published private(set) var dark: Bool
    @Published private(set) var tint: Color
    /// 住民设置的辅色（标签、次要强调）
    @Published private(set) var secondary: Color
    let baseLabels: [String: String]
    let selfLevels: [NativeProfileLevelOption]
    let widgetOptions: [NativeProfileWidgetOption]
    var onFinish: ((String, [String: Any]) -> Void)?
    var onDarkChange: ((Bool) -> Void)?

    private let send: ([String: Any]) -> Void
    private var pending: [String: (work: DispatchWorkItem, completion: (Bool, String, JSObject) -> Void)] = [:]

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        let theme = call.getObject("theme") ?? [:]
        dark = (theme["dark"] as? Bool) ?? call.getBool("dark", false)
        let colors = NativeThemeColors(primary: theme["primary"] as? String, secondary: theme["secondary"] as? String)
        tint = colors.primary
        secondary = colors.secondary
        let labels = Self.strings(call.getObject("labels"))
        baseLabels = labels
        let autoLabel = Self.text(labels, "auto", "按评价自动推断")
        selfLevels = (call.getArray("selfLevels", JSObject.self) ?? []).compactMap { item -> NativeProfileLevelOption? in
            guard let id = (item["id"] as? NSNumber)?.intValue, (1...4).contains(id) else { return nil }
            return NativeProfileLevelOption(id: id, label: item["label"] as? String ?? "\(id)")
        } + [NativeProfileLevelOption(id: 0, label: autoLabel)]
        widgetOptions = (call.getArray("widgetOptions", JSObject.self) ?? []).compactMap { item -> NativeProfileWidgetOption? in
            guard let id = item["id"] as? String, !id.isEmpty else { return nil }
            return NativeProfileWidgetOption(id: String(id.prefix(32)), title: item["title"] as? String ?? id)
        }
    }

    static func strings(_ object: JSObject?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in object ?? [:] {
            if let text = value as? String { out[key] = text }
        }
        return out
    }

    static func text(_ labels: [String: String], _ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    /// 住民设置里改了明暗或主题色（设置页叠在主页上，返回时主页已是新的样子）
    func applyTheme(_ theme: JSObject) {
        let colors = NativeThemeColors(primary: theme["primary"] as? String, secondary: theme["secondary"] as? String)
        tint = colors.primary
        secondary = colors.secondary
        if let next = theme["dark"] as? Bool, next != dark {
            dark = next
            onDarkChange?(next)
        }
    }

    /// 发给网页一个请求；completion(ok, message, payload) 在主线程回调，超时视为失败（message 为空）
    @discardableResult
    func request(_ type: String, values: [String: Any] = [:], timeout seconds: Double = 20,
                 completion: @escaping (Bool, String, JSObject) -> Void) -> String {
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, let entry = self.pending.removeValue(forKey: requestId) else { return }
            entry.completion(false, "", [:])
        }
        pending[requestId] = (work, completion)
        send(["type": type, "requestId": requestId, "values": values])
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
        return requestId
    }

    func finish(requestId: String, ok: Bool, message: String, payload: JSObject) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        entry.work.cancel()
        entry.completion(ok, message, payload)
    }

    func cancelAll() {
        pending.values.forEach { $0.work.cancel() }
        pending.removeAll()
    }

    /// 结束整个主页（打开地点、退出登录、返回地图等）
    func close(_ action: String, _ values: [String: Any] = [:]) {
        onFinish?(action, values)
    }
}

// MARK: - 页面栈

enum NativeProfileRoute: Hashable {
    case community
    case companion
    /// 同好里点开的住民主页
    case profile(String)
}

final class NativeProfileNavigator: ObservableObject {
    @Published var path: [NativeProfileRoute] = [] {
        didSet {
            if path.count != oldValue.count { onDepthChange?(path.count) }
        }
    }
    let root: NativeProfileModel
    var onDepthChange: ((Int) -> Void)?

    private let session: NativeProfileSession
    private var profiles: [String: NativeProfileModel] = [:]
    private var communityModel: NativeCommunityModel?
    private var companionModel: NativeCompanionModel?

    init(session: NativeProfileSession, root: NativeProfileModel) {
        self.session = session
        self.root = root
        root.navigator = self
    }

    func open(_ route: NativeProfileRoute) {
        guard path.last != route else { return }
        path.append(route)
    }

    var community: NativeCommunityModel {
        if let communityModel { return communityModel }
        let model = NativeCommunityModel(session: session)
        model.navigator = self
        communityModel = model
        return model
    }

    var companion: NativeCompanionModel {
        if let companionModel { return companionModel }
        let model = NativeCompanionModel(session: session)
        companionModel = model
        return model
    }

    /// 观察屋打开过才需要接收推来的小伙伴状态
    var loadedCompanion: NativeCompanionModel? { companionModel }

    func profile(_ userId: String) -> NativeProfileModel {
        if let model = profiles[userId] { return model }
        let model = NativeProfileModel(session: session, userId: userId, profile: [:], loading: true)
        model.navigator = self
        profiles[userId] = model
        return model
    }
}

// MARK: - 主页状态

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
        let levelOptions: [NativeProfileLevelOption]
        let widgetOptions: [NativeProfileWidgetOption]
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

    /// nil：会话打开的那位住民（根页）；否则是同好里点开、推入页面栈的住民
    let userId: String?
    weak var navigator: NativeProfileNavigator?
    let session: NativeProfileSession
    private var requested = false

    var isRoot: Bool { userId == nil }

    init(session: NativeProfileSession, userId: String?, profile: JSObject, loading: Bool) {
        self.session = session
        self.userId = userId
        let labels = session.baseLabels.merging(NativeProfileSession.strings(profile["labels"] as? JSObject)) { _, new in new }
        view = Self.parse(profile, labels: labels, selfLevels: session.selfLevels, widgetOptions: session.widgetOptions)
        self.loading = loading
    }

    func applyProfile(_ profile: JSObject) {
        let labels = session.baseLabels.merging(NativeProfileSession.strings(profile["labels"] as? JSObject)) { _, new in new }
        withAnimation(.easeOut(duration: 0.2)) {
            view = Self.parse(profile, labels: labels, selfLevels: session.selfLevels, widgetOptions: session.widgetOptions)
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

    /// 推入页面栈的住民：第一次出现时读取
    func loadIfNeeded() {
        guard userId != nil, !requested else { return }
        requested = true
        reload()
    }

    /// 读取失败后重试：根页由网页重新读取、结果经 update 回来；页面栈里的住民直接读取
    func reload() {
        loadError = nil
        loading = true
        guard let userId else {
            session.request("reload") { _, _, _ in }
            return
        }
        session.request("loadProfile", values: ["userId": userId]) { [weak self] ok, message, payload in
            guard let self else { return }
            if ok, let profile = payload["profile"] as? JSObject {
                self.applyProfile(profile)
            } else {
                self.applyLoadError(message)
            }
        }
    }

    private static func parse(_ object: JSObject, labels: [String: String],
                              selfLevels: [NativeProfileLevelOption], widgetOptions: [NativeProfileWidgetOption]) -> ProfileView {
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
            avatarURL: NativeProfileImage.httpsURL(avatar),
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
        NativeProfileSession.text(view.labels, key, fallback)
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
        busy = true
        var values = values
        if let userId, type == "setBlocked" { values["userId"] = userId }
        session.request(type, values: values, timeout: seconds) { [weak self] ok, message, payload in
            self?.complete(type: type, blocked: blocked, ok: ok, message: message, payload: payload)
        }
    }

    private func complete(type: String, blocked: Bool, ok: Bool, message: String, payload: JSObject) {
        busy = false
        guard ok else {
            alertMessage = message.isEmpty ? text("tasteSaveFailed", "保存失败，请稍后重试") : message
            return
        }
        if let profile = payload["profile"] as? JSObject, !profile.isEmpty {
            let labels = view.labels.merging(NativeProfileSession.strings(profile["labels"] as? JSObject)) { _, new in new }
            view = Self.parse(profile, labels: labels, selfLevels: session.selfLevels, widgetOptions: session.widgetOptions)
        }
        if type == "saveWidgets" { editingHiddenWidgets = nil }
        // 屏蔽成功后网页已打开举报入口：收起主页，让举报表显示在地图页上。
        if type == "setBlocked" && blocked {
            session.close("back")
        }
    }

    func setTasteLevel(_ key: String, _ level: Int?) {
        var values: [String: Any] = ["key": key]
        values["level"] = level.map { $0 as Any } ?? NSNull()
        start("setTasteLevel", values: values)
    }

    func saveWidgets() {
        guard let hidden = editingHiddenWidgets else { return }
        let widgets = view.widgets.isEmpty ? Array(view.widgetOptions.prefix(1).map(\.id)) : view.widgets
        let hiddenWidgets = view.widgetOptions.map(\.id).filter { hidden.contains($0) }
        start("saveWidgets", values: ["widgets": widgets, "hiddenWidgets": hiddenWidgets])
    }

    func setBlocked(_ blocked: Bool) {
        start("setBlocked", values: ["blocked": blocked], blocked: blocked)
    }

    func setCollectionVisibility(_ isPublic: Bool) {
        start("setCollectionVisibility", values: ["isPublic": isPublic])
    }

    /// 同好、角色观察屋：推入页面栈，主页留在下面
    func openCommunity() {
        navigator?.open(.community)
    }

    func openCompanion() {
        navigator?.open(.companion)
    }

    /// 住民设置：网页在主页之上打开原生设置；网页处理不了时退回旧流程（收起主页后打开设置）
    func openSettings() {
        session.request("openSettings", timeout: 15) { [weak self] ok, _, _ in
            if !ok { self?.session.close("settings") }
        }
    }

    private var ownerValues: [String: Any] {
        guard let userId else { return [:] }
        return ["userId": userId]
    }

    func openFavorites() {
        session.close("openFavorites", ownerValues)
    }

    func openLocations() {
        session.close("my-locations", ownerValues)
    }

    func logout() {
        session.close("logout")
    }

    func openPlace(_ id: String) {
        session.close("openPlace", ["placeId": id])
    }

    func requestClose() {
        session.close("back")
    }
}

// MARK: - 同好状态

final class NativeCommunityModel: ObservableObject {
    enum Tab: Hashable { case neighbors, settings }
    enum ViewMode: Hashable { case list, map }

    struct Person: Identifiable {
        let id: String
        let name: String
        let avatarURL: URL?
        let meta: String
        /// 星图坐标：以我为中心，越相似离中心越近（-1…1）
        let x: CGFloat
        let y: CGFloat
        let accessible: String
    }

    struct EmptyState {
        let title: String
        let hint: String
        let opensSettings: Bool
        let actionLabel: String
    }

    @Published var tab: Tab = .neighbors {
        didSet { if tab == .settings { loadSettingsIfNeeded() } }
    }
    @Published var viewMode: ViewMode = .list
    @Published private(set) var loading = false
    @Published private(set) var loaded = false
    @Published private(set) var loadError: String?
    @Published private(set) var people: [Person] = []
    @Published private(set) var empty: EmptyState?
    @Published private(set) var meAvatar: URL?
    @Published private(set) var labels: [String: String] = [:]

    // 发现设置（可编辑的副本，保存时整份交给网页）
    @Published var discovery = true
    @Published var feedback = true {
        didSet { if !feedback { research = false } }
    }
    @Published var research = true
    @Published var tags = ""
    @Published var researchChoice = false
    @Published private(set) var settingsHint = ""
    @Published private(set) var retention = ""
    @Published private(set) var settingsLoaded = false
    @Published private(set) var settingsLoading = false
    @Published private(set) var settingsError: String?
    @Published private(set) var busy = false
    /// 保存成功、清除完成或失败原因（弹出提示）
    @Published var notice: String?

    weak var navigator: NativeProfileNavigator?
    private let session: NativeProfileSession

    init(session: NativeProfileSession) {
        self.session = session
    }

    func text(_ key: String, _ fallback: String) -> String {
        NativeProfileSession.text(labels, key, fallback)
    }

    func loadIfNeeded() {
        guard !loaded, !loading else { return }
        load()
    }

    func load() {
        loading = true
        loadError = nil
        session.request("loadCommunity") { [weak self] ok, message, payload in
            guard let self else { return }
            self.loading = false
            guard ok, let community = payload["community"] as? JSObject else {
                self.loadError = message.isEmpty ? self.text("loadFailed", "同好加载失败，请稍后重试") : message
                return
            }
            self.apply(community)
            self.loaded = true
        }
    }

    func apply(_ object: JSObject) {
        if let labels = object["labels"] as? JSObject {
            self.labels.merge(NativeProfileSession.strings(labels)) { _, new in new }
        }
        if let me = object["me"] as? JSObject {
            meAvatar = NativeProfileImage.httpsURL(me["avatarURL"] as? String ?? "")
        }
        if let neighbors = object["neighbors"] as? JSObject {
            if (neighbors["status"] as? String) == "error" {
                let message = neighbors["error"] as? String ?? ""
                loadError = message.isEmpty ? text("loadFailed", "同好加载失败，请稍后重试") : message
                people = []
                empty = nil
            } else {
                loadError = nil
                people = (neighbors["people"] as? JSArray ?? []).prefix(20).compactMap { raw -> Person? in
                    guard let item = raw as? JSObject,
                          let id = item["id"] as? String, !id.isEmpty else { return nil }
                    let name = item["name"] as? String ?? ""
                    let clamp = { (value: Any?) -> CGFloat in
                        CGFloat(max(-1, min(1, (value as? NSNumber)?.doubleValue ?? 0)))
                    }
                    return Person(id: id, name: name,
                                  avatarURL: NativeProfileImage.httpsURL(item["avatarURL"] as? String ?? ""),
                                  meta: item["meta"] as? String ?? "",
                                  x: clamp(item["x"]), y: clamp(item["y"]),
                                  accessible: item["accessible"] as? String ?? name)
                }
                if let state = neighbors["empty"] as? JSObject {
                    empty = EmptyState(title: state["title"] as? String ?? "",
                                       hint: state["hint"] as? String ?? "",
                                       opensSettings: (state["action"] as? String) == "settings",
                                       actionLabel: state["actionLabel"] as? String ?? "")
                } else {
                    empty = nil
                }
            }
        }
        if let settings = object["settings"] as? JSObject {
            discovery = (settings["discovery"] as? Bool) ?? discovery
            feedback = (settings["feedback"] as? Bool) ?? feedback
            research = feedback && ((settings["research"] as? Bool) ?? research)
            tags = settings["tags"] as? String ?? tags
            settingsHint = settings["hint"] as? String ?? settingsHint
            retention = settings["retention"] as? String ?? retention
            researchChoice = false
            settingsLoaded = true
            settingsError = nil
        }
        if let notice = object["notice"] as? String, !notice.isEmpty {
            self.notice = notice
        }
    }

    func loadSettingsIfNeeded() {
        guard !settingsLoaded, !settingsLoading else { return }
        loadSettings()
    }

    func loadSettings() {
        settingsLoading = true
        settingsError = nil
        session.request("loadCommunitySettings") { [weak self] ok, message, payload in
            guard let self else { return }
            self.settingsLoading = false
            guard ok, let community = payload["community"] as? JSObject else {
                self.settingsError = message.isEmpty ? self.text("settingsFailed", "发现设置加载失败，请稍后重试") : message
                return
            }
            self.apply(community)
        }
    }

    func saveSettings() {
        guard !busy else { return }
        busy = true
        let values: [String: Any] = [
            "discovery": discovery,
            "feedback": feedback,
            "research": feedback && research,
            "tags": String(tags.prefix(500)),
            "researchChoice": researchChoice
        ]
        session.request("saveCommunitySettings", values: values) { [weak self] ok, message, payload in
            self?.finishWrite(ok: ok, message: message, payload: payload)
        }
    }

    func clearInteractions() {
        guard !busy else { return }
        busy = true
        session.request("clearInteractions") { [weak self] ok, message, payload in
            self?.finishWrite(ok: ok, message: message, payload: payload)
        }
    }

    private func finishWrite(ok: Bool, message: String, payload: JSObject) {
        busy = false
        guard ok, let community = payload["community"] as? JSObject else {
            notice = message.isEmpty ? text("saveFailed", "保存失败，请稍后重试") : message
            return
        }
        apply(community)
    }

    func showSettings() {
        withAnimation(.snappy) { tab = .settings }
    }

    func openProfile(_ id: String) {
        navigator?.open(.profile(id))
    }
}

// MARK: - 角色观察屋状态

final class NativeCompanionModel: ObservableObject {
    struct Role: Identifiable, Equatable {
        let id: String
        let name: String
    }

    @Published private(set) var loaded = false
    @Published private(set) var loading = false
    @Published private(set) var loadError: String?
    @Published private(set) var enabled = true
    @Published private(set) var roles: [Role] = []
    @Published private(set) var activeId = ""
    @Published private(set) var name = ""
    @Published private(set) var satiety = ""
    @Published private(set) var hint = ""
    /// 内置角色的静态预览（安装包里的网页资源）；额外角色没有预览时用图标
    @Published private(set) var preview: UIImage?
    @Published private(set) var busy = false
    /// 饱食度上涨一次加一：页面上冒一颗爱心
    @Published private(set) var fedPulse = 0
    @Published var alertMessage: String?
    @Published private(set) var labels: [String: String] = [:]

    private var satietyCount = 0
    private var previewPath = ""
    private let session: NativeProfileSession

    init(session: NativeProfileSession) {
        self.session = session
    }

    func text(_ key: String, _ fallback: String) -> String {
        NativeProfileSession.text(labels, key, fallback)
    }

    /// 每次进入都读一次最新状态（切换角色、投喂可能发生在别处）
    func load() {
        guard !loading else { return }
        loading = true
        if !loaded { loadError = nil }
        session.request("loadCompanion") { [weak self] ok, message, payload in
            guard let self else { return }
            self.loading = false
            if ok, let companion = payload["companion"] as? JSObject {
                self.apply(companion)
            } else if !self.loaded {
                self.loadError = message.isEmpty ? self.text("loadFailed", "角色观察屋加载失败，请稍后重试") : message
            }
        }
    }

    func apply(_ object: JSObject) {
        if let labels = object["labels"] as? JSObject {
            self.labels.merge(NativeProfileSession.strings(labels)) { _, new in new }
        }
        enabled = (object["enabled"] as? Bool) ?? enabled
        roles = (object["roles"] as? JSArray ?? []).compactMap { raw -> Role? in
            guard let item = raw as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return Role(id: id, name: item["name"] as? String ?? id)
        }
        activeId = object["active"] as? String ?? activeId
        name = object["name"] as? String ?? name
        satiety = object["satiety"] as? String ?? satiety
        hint = object["hint"] as? String ?? ""
        let count = (object["satietyCount"] as? NSNumber)?.intValue ?? satietyCount
        if loaded && count > satietyCount { fedPulse += 1 }
        satietyCount = count
        let path = object["preview"] as? String ?? ""
        if path != previewPath {
            previewPath = path
            preview = NativeProfileImage.bundled(path)
        }
        loaded = true
        loadError = nil
    }

    func setEnabled(_ value: Bool) {
        guard !busy, value != enabled else { return }
        busy = true
        let previous = enabled
        enabled = value
        session.request("setCompanionEnabled", values: ["enabled": value]) { [weak self] ok, message, payload in
            guard let self else { return }
            self.busy = false
            if ok, let companion = payload["companion"] as? JSObject {
                self.apply(companion)
            } else {
                self.enabled = previous
                self.alertMessage = message.isEmpty ? self.text("saveFailed", "保存失败，请稍后重试") : message
            }
        }
    }

    func choose(_ id: String) {
        guard !busy, id != activeId else { return }
        busy = true
        session.request("chooseCompanion", values: ["id": id]) { [weak self] ok, message, payload in
            guard let self else { return }
            self.busy = false
            if ok, let companion = payload["companion"] as? JSObject {
                self.apply(companion)
            } else {
                self.alertMessage = message.isEmpty ? self.text("switchFailed", "切换角色失败，请重试") : message
            }
        }
    }
}

/// 图片地址：网络图片只接受 https；内置角色预览从安装包的网页资源（public/）读取
enum NativeProfileImage {
    static func httpsURL(_ value: String) -> URL? {
        URL(string: value).flatMap { $0.scheme == "https" ? $0 : nil }
    }

    static func bundled(_ path: String) -> UIImage? {
        guard !path.isEmpty, !path.contains(".."), !path.hasPrefix("/"),
              path.range(of: "^[A-Za-z0-9_./-]+$", options: .regularExpression) != nil else { return nil }
        let url = Bundle.main.bundleURL.appendingPathComponent("public").appendingPathComponent(path)
        return UIImage(contentsOfFile: url.path)
    }
}

// MARK: - 页面

/// 主页和它的二级页共用一个 NavigationStack：推入时主页留在下面，系统侧滑返回时露出主页。
private struct NativeProfileRootView: View {
    @ObservedObject var navigator: NativeProfileNavigator
    @ObservedObject var session: NativeProfileSession

    var body: some View {
        NavigationStack(path: $navigator.path) {
            NativeProfilePage(model: navigator.root, session: session)
                .navigationDestination(for: NativeProfileRoute.self) { route in
                    destination(route)
                }
        }
        .preferredColorScheme(session.dark ? .dark : .light)
        .nativeThemeColors(primary: session.tint, secondary: session.secondary)
    }

    @ViewBuilder
    private func destination(_ route: NativeProfileRoute) -> some View {
        switch route {
        case .community:
            NativeCommunityView(model: navigator.community, session: session)
        case .companion:
            NativeCompanionView(model: navigator.companion, session: session)
        case .profile(let userId):
            NativeProfilePage(model: navigator.profile(userId), session: session)
        }
    }
}

private struct NativeProfilePage: View {
    @ObservedObject var model: NativeProfileModel
    @ObservedObject var session: NativeProfileSession

    var body: some View {
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
            // 根页没有上一页：左上返回关闭整个主页。推入的住民主页用系统返回（可侧滑），回到同好
            if model.isRoot {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        model.requestClose()
                    } label: {
                        Image(systemName: "chevron.backward")
                            .font(.headline)
                    }
                    .tint(session.tint.fmReadableText)
                    .accessibilityLabel(Text(model.text("back", "返回")))
                }
            }
        }
        .onAppear { model.loadIfNeeded() }
        .sheet(isPresented: Binding(get: { model.editingHiddenWidgets != nil }, set: { if !$0 { model.editingHiddenWidgets = nil } })) {
            widgetEditor
                .presentationDetents([.medium, .large])
        }
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
                                .foregroundStyle(session.tint.fmReadableText)
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
                    accent: session.tint
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
                                        .nativeChip(selected: selected, tint: session.tint)
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
                            .tint(session.tint)
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
        // 与 iOS 主屏幕“编辑小组件”相同的位置：所有小组件下面居中一枚胶囊按钮。
        // “我创建的地点”始终显示，只有“最喜欢”可以关闭（网页只下发可关闭的选项）
        if model.view.canEditWidgets && !model.view.widgetOptions.isEmpty {
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
            .foregroundStyle(session.tint)
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
                    .foregroundStyle(session.tint.fmReadableText)
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
                        .tint(session.tint)
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
                            .tint(session.tint.fmReadableText)
                            .font(.body.weight(.semibold))
                    }
                }
            }
        }
        .nativeThemeColors(primary: session.tint, secondary: session.secondary)
        .preferredColorScheme(session.dark ? .dark : .light)
    }

    private func placeRow(_ row: NativeProfileModel.ProfilePlaceRow) -> some View {
        Button {
            model.openPlace(row.id)
        } label: {
            HStack(spacing: 10) {
                Group {
                    if let url = NativeProfileImage.httpsURL(row.image) {
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

// MARK: 同好页

/// 同好：导航栏中间是系统分段控件（iOS 26 为可拖动的液态玻璃），下面两页可以左右滑动切换。
private struct NativeCommunityView: View {
    @ObservedObject var model: NativeCommunityModel
    @ObservedObject var session: NativeProfileSession

    var body: some View {
        TabView(selection: $model.tab) {
            neighborsPage
                .tag(NativeCommunityModel.Tab.neighbors)
            settingsPage
                .tag(NativeCommunityModel.Tab.settings)
        }
        .tabViewStyle(.page(indexDisplayMode: .never))
        .background(FM.bgBase.ignoresSafeArea())
        .navigationTitle(model.text("title", "同好"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker(model.text("tabsLabel", "同好页面"), selection: $model.tab.animation(.snappy)) {
                    Text(model.text("tabNeighbors", "同好")).tag(NativeCommunityModel.Tab.neighbors)
                    Text(model.text("tabSettings", "发现设置")).tag(NativeCommunityModel.Tab.settings)
                }
                .pickerStyle(.segmented)
                .frame(width: 220)
            }
        }
        .onAppear { model.loadIfNeeded() }
        .alert(model.notice ?? "", isPresented: Binding(get: { model.notice != nil }, set: { if !$0 { model.notice = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
    }

    private var neighborsPage: some View {
        ScrollView {
            VStack(spacing: 14) {
                if model.loading && !model.loaded {
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
                            Button(model.text("retry", "重试")) { model.load() }
                                .buttonStyle(.bordered)
                                .disabled(model.loading)
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else if let empty = model.empty {
                    NativePageCard(padding: 16) {
                        VStack(spacing: 8) {
                            Text(empty.title)
                                .font(.subheadline.weight(.semibold))
                            Text(empty.hint)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                            if empty.opensSettings {
                                Button(empty.actionLabel) { model.showSettings() }
                                    .buttonStyle(.borderedProminent)
                                    .padding(.top, 4)
                            }
                        }
                        .frame(maxWidth: .infinity)
                    }
                } else if model.loaded {
                    Picker(model.text("viewModeLabel", "显示方式"), selection: $model.viewMode.animation(.snappy)) {
                        Text(model.text("viewList", "列表")).tag(NativeCommunityModel.ViewMode.list)
                        Text(model.text("viewMap", "星图")).tag(NativeCommunityModel.ViewMode.map)
                    }
                    .pickerStyle(.segmented)
                    if model.viewMode == .map {
                        NativeCommunityStarMap(
                            people: model.people,
                            me: model.meAvatar,
                            meLabel: model.text("me", "我"),
                            label: model.text("mapLabel", "以我为中心的偏好星图"),
                            accent: session.tint,
                            secondary: session.secondary,
                            onOpen: model.openProfile
                        )
                        .padding(.top, 4)
                    } else {
                        neighborList
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
    }

    /// 与后台用户管理相同的排版：左侧头像，右边上方住民名、下方相似度
    private var neighborList: some View {
        NativePageCard(padding: 0) {
            VStack(spacing: 0) {
                ForEach(Array(model.people.enumerated()), id: \.element.id) { index, person in
                    if index > 0 {
                        Divider().padding(.leading, 66)
                    }
                    Button {
                        model.openProfile(person.id)
                    } label: {
                        HStack(spacing: 12) {
                            AvatarImage(url: person.avatarURL)
                                .frame(width: 40, height: 40)
                                .clipShape(Circle())
                            VStack(alignment: .leading, spacing: 3) {
                                Text(person.name)
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                Text(person.meta)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .frame(minHeight: 60)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .combine)
                    .accessibilityHint(Text(person.accessible))
                }
            }
        }
    }

    private var settingsPage: some View {
        Form {
            if model.settingsLoading && !model.settingsLoaded {
                Section {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 120)
                }
                .listRowBackground(FM.bgSurface)
            } else if let error = model.settingsError, !model.settingsLoaded {
                Section {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Button(model.text("retry", "重试")) { model.loadSettings() }
                }
                .listRowBackground(FM.bgSurface)
            } else if model.settingsLoaded {
                Section {
                    TextField(model.text("tagsLabel", "兴趣标签（逗号分隔，最多 20 个）"), text: $model.tags, axis: .vertical)
                        .lineLimit(1...4)
                } header: {
                    Text(model.text("tagsLabel", "兴趣标签（逗号分隔，最多 20 个）"))
                }
                .listRowBackground(FM.bgSurface)
                Section {
                    Toggle(isOn: $model.discovery) {
                        Text(model.text("discovery", "允许使用我的用户向量匹配同好，并向其他住民展示住民名和共同标签"))
                            .font(.subheadline)
                    }
                    Toggle(isOn: $model.feedback) {
                        Text(model.text("feedback", "记录搜索、可见结果、点选、收藏、纠错及定位推断的到访；定位采样仅在前台进行"))
                            .font(.subheadline)
                    }
                    Toggle(isOn: Binding(get: { model.research }, set: { model.research = $0; model.researchChoice = true })) {
                        Text(model.text("research", "允许将这些交互记录用于改进用户体验"))
                            .font(.subheadline)
                    }
                    .disabled(!model.feedback)
                } footer: {
                    Text([model.settingsHint, model.retention].filter { !$0.isEmpty }.joined(separator: "\n"))
                }
                .listRowBackground(FM.bgSurface)
                Section {
                    Button {
                        model.saveSettings()
                    } label: {
                        HStack {
                            Spacer()
                            if model.busy {
                                ProgressView()
                            } else {
                                Text(model.text("saveSettings", "保存设置"))
                                    .font(.body.weight(.semibold))
                            }
                            Spacer()
                        }
                    }
                    .disabled(model.busy)
                    Button {
                        model.clearInteractions()
                    } label: {
                        Text(model.text("clearInteractions", "清除交互记录"))
                            .frame(maxWidth: .infinity)
                    }
                    .disabled(model.busy)
                }
                .listRowBackground(FM.bgSurface)
            }
        }
        .tint(session.tint)
        .nativePageBackground()
        .onAppear { if model.tab == .settings { model.loadSettingsIfNeeded() } }
    }
}

/// 以我为中心的偏好星图：越相似离中心越近，每位同好显示头像（辅色描边），点按进入主页。全部同好一次显示，不分页。
/// 坐标与网页星图相同：画布 [-1.2, 1.2]，同好在半径 0.95 的圆内。
private struct NativeCommunityStarMap: View {
    let people: [NativeCommunityModel.Person]
    let me: URL?
    let meLabel: String
    let label: String
    let accent: Color
    let secondary: Color
    let onOpen: (String) -> Void

    private let extent: CGFloat = 1.2
    private let rings: [CGFloat] = [0.35, 0.65, 0.95]

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            let unit = side / (extent * 2)
            let center = CGPoint(x: proxy.size.width / 2, y: proxy.size.height / 2)
            let diameter = max(30, unit * 0.2)
            ZStack {
                Circle()
                    .fill(FM.bgSurface)
                    .overlay(Circle().strokeBorder(FM.border, lineWidth: 1))
                    .frame(width: side, height: side)
                    .position(center)
                ForEach(rings, id: \.self) { ring in
                    Circle()
                        .stroke(Color.primary.opacity(0.15), lineWidth: 1)
                        .frame(width: ring * 2 * unit, height: ring * 2 * unit)
                        .position(center)
                }
                ForEach(people) { person in
                    Button {
                        onOpen(person.id)
                    } label: {
                        AvatarImage(url: person.avatarURL)
                            .frame(width: diameter, height: diameter)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(secondary, lineWidth: 2))
                            .frame(width: max(44, diameter), height: max(44, diameter))
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .position(x: center.x + person.x * unit, y: center.y + person.y * unit)
                    .accessibilityLabel(Text(person.accessible))
                }
                // 我画在最上层：同好挨得近时也不会盖住中心
                VStack(spacing: 2) {
                    AvatarImage(url: me)
                        .frame(width: diameter * 1.25, height: diameter * 1.25)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(accent, lineWidth: 2.5))
                    Text(meLabel)
                        .font(.caption2.weight(.semibold))
                        .padding(.horizontal, 4)
                        .background(FM.bgSurface.opacity(0.85), in: Capsule())
                }
                .position(x: center.x, y: center.y + 8)
                .allowsHitTesting(false)
                .accessibilityElement(children: .combine)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(label))
    }
}

// MARK: 角色观察屋

/// 原生角色观察屋：开关、当前角色（内置角色用静态预览）、饱食度与切换角色。
/// Live2D 动画只在网页与地图底栏；iOS 不提供兑换码（App Store 3.1.1），这里没有兑换表单。
private struct NativeCompanionView: View {
    @ObservedObject var model: NativeCompanionModel
    @ObservedObject var session: NativeProfileSession
    @State private var heart = false

    var body: some View {
        ScrollView {
            VStack(spacing: 14) {
                if !model.loaded {
                    if let error = model.loadError {
                        NativePageCard(padding: 16) {
                            VStack(spacing: 12) {
                                Text(error)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.center)
                                Button(model.text("retry", "重试")) { model.load() }
                                    .buttonStyle(.bordered)
                            }
                            .frame(maxWidth: .infinity)
                        }
                    } else {
                        ProgressView()
                            .controlSize(.large)
                            .frame(maxWidth: .infinity, minHeight: 240)
                            .accessibilityLabel(Text(model.text("loading", "加载中")))
                    }
                } else {
                    NativePageCard(padding: 14) {
                        Toggle(isOn: Binding(get: { model.enabled }, set: { model.setEnabled($0) })) {
                            Text(model.text("enabled", "开启角色观察屋"))
                                .font(.subheadline.weight(.medium))
                        }
                        .tint(session.tint)
                        .disabled(model.busy)
                    }
                    if model.enabled {
                        room
                        if model.roles.count > 1 {
                            roleChoices
                        }
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 32)
        }
        .nativePageBackground()
        .navigationTitle(model.text("title", "角色观察屋"))
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { model.load() }
        .onChange(of: model.fedPulse) { _, _ in
            withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) { heart = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                withAnimation(.easeOut(duration: 0.3)) { heart = false }
            }
        }
        .alert(model.alertMessage ?? "", isPresented: Binding(get: { model.alertMessage != nil }, set: { if !$0 { model.alertMessage = nil } })) {
            Button(model.text("ok", "好"), role: .cancel) {}
        }
    }

    private var room: some View {
        NativePageCard(padding: 16) {
            VStack(spacing: 10) {
                ZStack(alignment: .topTrailing) {
                    Circle()
                        .fill(session.secondary.opacity(0.14))
                        .frame(width: 188, height: 188)
                    Group {
                        if let image = model.preview {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                        } else {
                            Image(systemName: "pawprint.fill")
                                .font(.system(size: 56))
                                .foregroundStyle(session.secondary)
                        }
                    }
                    .frame(width: 172, height: 172)
                    .frame(width: 188, height: 188)
                    if heart {
                        Image(systemName: "heart.fill")
                            .font(.title)
                            .foregroundStyle(FM.danger)
                            .transition(.scale.combined(with: .opacity))
                            .accessibilityLabel(Text(model.text("fed", "吃饱了一点！")))
                    }
                }
                .accessibilityHidden(model.preview == nil)
                Text(model.name)
                    .font(.headline)
                Label(model.satiety, systemImage: "fork.knife")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.updatesFrequently)
                if !model.hint.isEmpty {
                    Text(model.hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .frame(maxWidth: .infinity)
        }
    }

    private var roleChoices: some View {
        NativePageCard(padding: 14) {
            VStack(alignment: .leading, spacing: 10) {
                Text(model.text("role", "角色"))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityAddTraits(.isHeader)
                NativeFlowLayout(spacing: 8, lineSpacing: 8) {
                    ForEach(model.roles) { role in
                        let selected = role.id == model.activeId
                        Button {
                            model.choose(role.id)
                        } label: {
                            Text(role.name)
                                .font(.subheadline)
                                .nativeChip(selected: selected, tint: session.tint)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.busy)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                    }
                }
            }
        }
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
