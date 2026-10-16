import Capacitor
import PhotosUI
import SwiftUI
import UIKit
import WebKit

/// 住民设置整套由 SwiftUI 呈现：首页与头像、住民名、通行密码、个性化主题、个性化地图五个二级页。
/// 编辑都在原生里完成，但凭证和账号请求不离开现有业务层：二级页把用户输入经 settingsEvent 交给网页，
/// 网页发出请求后按 requestId 用 respond 回传结果（附带住民名、头像、明暗、主题色等需要刷新的状态）。
/// 退出全部设备、除名仍以白名单动作交回网页执行。动效开关是本机偏好，切换后立即通知网页。
@objc(NativeSettingsPlugin)
public class NativeSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeSettingsPlugin"
    public let jsName = "NativeSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "respond", returnType: CAPPluginReturnPromise)
    ]
    private var host: UIViewController?
    private var pending: CAPPluginCall?
    private var requestID: String?
    private var finishing = false
    private var presenting = false
    private var queuedFinish: (action: String, animated: Bool)?
    private var closeCompletions: [() -> Void] = []
    private var loadingObservation: NSKeyValueObservation?
    /// 本次呈现的设置状态（二级页共用）
    private var store: NativeSettingsStore?
    /// 左边缘侧滑关闭整个设置；推入二级页时停用，让系统侧滑返回上一级
    private weak var edgeGesture: UIScreenEdgePanGestureRecognizer?

    public override func load() {
        loadingObservation = bridge?.webView?.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
            if view.isLoading { self?.finish(action: "cancel", animated: false) }
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
            let store = NativeSettingsStore(call: call) { [weak self] payload in
                guard let self, let id = self.requestID else { return }
                var data = payload
                data["id"] = id
                self.notifyListeners("settingsEvent", data: data)
            }
            store.onPageShownChange = { [weak self] shown in
                self?.edgeGesture?.isEnabled = !shown
            }
            self.store = store
            let root = NativeSettingsView(store: store) { [weak self] action in
                self?.finish(action: action)
            }
            let host = UIHostingController(rootView: root)
            host.modalPresentationStyle = .fullScreen
            host.overrideUserInterfaceStyle = store.dark ? .dark : .light
            // 在“个性化主题”里切换暗黑模式：设置页本身立即跟着切换
            store.onDarkChange = { [weak host] dark in
                host?.overrideUserInterfaceStyle = dark ? .dark : .light
            }
            self.host = host
            self.pending = call
            self.requestID = id
            self.presenting = true
            let back = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(self.edgeBack(_:)))
            back.edges = .left
            host.view.addGestureRecognizer(back)
            self.edgeGesture = back
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

    /// 网页处理完二级页的请求后回传结果（按 requestId 对应，过期的回执忽略）
    @objc func respond(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            defer { call.resolve() }
            guard let id = call.getString("id"), id == self.requestID,
                  let requestId = call.getString("requestId") else { return }
            self.store?.finish(requestId: requestId, ok: call.getBool("ok", false),
                               message: String((call.getString("message") ?? "").prefix(200)),
                               state: call.getObject("state") ?? [:])
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
        let complete = { [weak self] in
            self?.host = nil
            self?.pending = nil
            self?.requestID = nil
            self?.store = nil
            self?.finishing = false
            call?.resolve(["id": id ?? "", "action": action])
            let completions = self?.closeCompletions ?? []
            self?.closeCompletions.removeAll()
            completions.forEach { $0() }
        }
        // 从父控制器关闭整个设置页；账号确认 alert 尚在退场时，不能只关闭 alert 留下孤立的设置页。
        if let presenter = host.presentingViewController {
            presenter.dismiss(animated: animated && !UIAccessibility.isReduceMotionEnabled, completion: complete)
        } else {
            complete()
        }
    }

    @objc private func edgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, let view = gesture.view else { return }
        let distance = gesture.translation(in: view).x
        if distance > view.bounds.width * 0.3 || (distance > 24 && gesture.velocity(in: view).x > 600) {
            finish(action: "back")
        }
    }
}

// MARK: - 共享状态

/// 设置页状态：首页显示的住民名 / 头像，主题与地图偏好，以及二级页发给网页的请求。
/// 初值与二级页文案由网页在打开设置时下发（文案走网页 i18n）；缺失时二级页退回网页页面。
final class NativeSettingsStore: ObservableObject {
    struct MotionItem: Identifiable {
        let key: String
        let label: String
        let hint: String
        var id: String { key }
    }

    struct StyleOption: Identifiable, Hashable {
        let id: String
        let name: String
    }

    // 首页
    @Published private(set) var username: String
    @Published private(set) var avatarURL: URL?
    // 个性化主题
    @Published private(set) var dark: Bool
    @Published private(set) var primaryHex: String
    @Published private(set) var secondaryHex: String
    @Published private(set) var darkStyle: String
    @Published private(set) var lightStyle: String
    // 个性化地图
    @Published var lat: String
    @Published var lng: String
    @Published var zoom: String
    @Published private(set) var motion: [String: Bool]
    // 请求与提示
    /// 正在等待网页回执的请求类型（对应页面显示进度、禁用输入）
    @Published private(set) var busy: Set<String> = []
    /// 请求失败或超时的提示（弹窗）
    @Published var alertMessage: String?
    /// 保存成功后首页底部的短暂提示
    @Published private(set) var toast: String?

    /// 网页是否下发了二级页数据（旧版网页包没有时退回网页页面）
    let pagesAvailable: Bool
    let mapPageAvailable: Bool
    let mapStyle: String
    let motionItems: [MotionItem]
    let darkStyleOptions: [StyleOption]
    let lightStyleOptions: [StyleOption]
    private let labels: [String: String]
    private let mapLabels: [String: String]
    private let send: ([String: Any]) -> Void
    private var pending: [String: (type: String, timeout: DispatchWorkItem, completion: (Bool) -> Void)] = [:]
    private var toastToken = 0
    private var shownPages = 0
    var onPageShownChange: ((Bool) -> Void)?
    var onDarkChange: ((Bool) -> Void)?

    init(call: CAPPluginCall, send: @escaping ([String: Any]) -> Void) {
        self.send = send
        username = String((call.getString("username") ?? "").prefix(80))
        avatarURL = Self.safeURL(call.getString("avatarURL"))

        let labels = Self.strings(call.getObject("labels"))
        self.labels = labels
        pagesAvailable = !labels.isEmpty

        let themes = call.getObject("themes") ?? [:]
        dark = (themes["dark"] as? Bool) ?? call.getBool("dark", false)
        primaryHex = themes["primary"] as? String ?? "#E2789F"
        secondaryHex = themes["secondary"] as? String ?? "#8C6BB1"
        darkStyle = themes["darkStyle"] as? String ?? "amap://styles/dark"
        lightStyle = themes["lightStyle"] as? String ?? "amap://styles/normal"
        let options = themes["styleOptions"] as? JSObject ?? [:]
        darkStyleOptions = Self.styleOptions(options["dark"])
        lightStyleOptions = Self.styleOptions(options["light"])

        let mapPage = call.getObject("mapPage")
        mapPageAvailable = mapPage != nil
        let values = mapPage?["values"] as? JSObject ?? [:]
        mapStyle = (values["style"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "standard"
        lat = String((values["lat"] as? String ?? "").prefix(32))
        lng = String((values["lng"] as? String ?? "").prefix(32))
        zoom = String((values["zoom"] as? String ?? "").prefix(32))
        var motion: [String: Bool] = [:]
        for (key, value) in mapPage?["motion"] as? JSObject ?? [:] {
            if let flag = value as? Bool { motion[key] = flag }
        }
        self.motion = motion
        motionItems = (mapPage?["motionItems"] as? JSArray ?? []).compactMap { entry -> MotionItem? in
            guard let item = entry as? JSObject, let key = item["key"] as? String, !key.isEmpty else { return nil }
            return MotionItem(key: key, label: item["label"] as? String ?? key, hint: item["hint"] as? String ?? "")
        }
        mapLabels = Self.strings(mapPage?["labels"] as? JSObject)
    }

    private static func strings(_ object: JSObject?) -> [String: String] {
        var out: [String: String] = [:]
        for (key, value) in object ?? [:] {
            if let text = value as? String { out[key] = text }
        }
        return out
    }

    private static func styleOptions(_ value: JSValue?) -> [StyleOption] {
        (value as? JSArray ?? []).compactMap { entry -> StyleOption? in
            guard let item = entry as? JSObject, let id = item["id"] as? String, !id.isEmpty else { return nil }
            return StyleOption(id: id, name: item["name"] as? String ?? id)
        }
    }

    static func safeURL(_ value: String?) -> URL? {
        guard let value, let url = URL(string: value), url.scheme == "https", url.user == nil, url.password == nil else { return nil }
        return url
    }

    /// 网页下发的文案；缺失时用中文兜底
    func text(_ key: String, _ fallback: String) -> String {
        guard let value = labels[key], !value.isEmpty else { return fallback }
        return value
    }

    /// “个性化地图”页的文案
    func mapText(_ key: String, _ fallback: String) -> String {
        guard let value = mapLabels[key], !value.isEmpty else { return fallback }
        return value
    }

    var primaryColor: Color { Color(uiColor: UIColor(cssHex: primaryHex) ?? .systemPink) }
    var secondaryColor: Color { Color(uiColor: UIColor(cssHex: secondaryHex) ?? .systemPurple) }
    var currentStyle: String { dark ? darkStyle : lightStyle }
    var currentStyleOptions: [StyleOption] { dark ? darkStyleOptions : lightStyleOptions }

    func isBusy(_ type: String) -> Bool { busy.contains(type) }
    func isOn(_ key: String) -> Bool { motion[key] ?? false }

    /// 二级页出现 / 消失：推入二级页时停用“侧滑关闭整个设置”
    func setPageShown(_ shown: Bool) {
        shownPages = max(0, shownPages + (shown ? 1 : -1))
        onPageShownChange?(shownPages > 0)
    }

    // MARK: 请求

    /// 把一次编辑交给网页；同类请求进行中时忽略。网页没有回应（页面重新加载等）时超时，不能一直转圈
    private func request(_ type: String, _ values: [String: Any], timeout seconds: Double = 20,
                         completion: @escaping (Bool) -> Void = { _ in }) {
        guard !busy.contains(type) else { return }
        let requestId = UUID().uuidString
        let work = DispatchWorkItem { [weak self] in
            guard let self, let entry = self.pending.removeValue(forKey: requestId) else { return }
            self.busy.remove(entry.type)
            self.alertMessage = "请求超时，请稍后重试"
            entry.completion(false)
        }
        pending[requestId] = (type: type, timeout: work, completion: completion)
        busy.insert(type)
        send(["type": type, "requestId": requestId, "values": values])
        DispatchQueue.main.asyncAfter(deadline: .now() + seconds, execute: work)
    }

    func finish(requestId: String, ok: Bool, message: String, state: JSObject) {
        guard let entry = pending.removeValue(forKey: requestId) else { return }
        entry.timeout.cancel()
        busy.remove(entry.type)
        apply(state)
        if ok {
            if !message.isEmpty { showToast(message) }
        } else {
            alertMessage = message.isEmpty ? "保存失败" : message
        }
        entry.completion(ok)
    }

    /// 网页回传的最新状态
    private func apply(_ state: JSObject) {
        if let name = state["username"] as? String, !name.isEmpty { username = String(name.prefix(80)) }
        if let url = Self.safeURL(state["avatarURL"] as? String) { avatarURL = url }
        if let value = state["dark"] as? Bool, value != dark {
            dark = value
            onDarkChange?(value)
        }
        if let value = state["primary"] as? String, !value.isEmpty { primaryHex = value }
        if let value = state["secondary"] as? String, !value.isEmpty { secondaryHex = value }
        if let value = state["darkStyle"] as? String, !value.isEmpty { darkStyle = value }
        if let value = state["lightStyle"] as? String, !value.isEmpty { lightStyle = value }
    }

    private func showToast(_ message: String) {
        toastToken += 1
        let token = toastToken
        toast = message
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2) { [weak self] in
            guard let self, self.toastToken == token else { return }
            self.toast = nil
        }
    }

    func saveMap(completion: @escaping (Bool) -> Void) {
        request("saveMap", ["style": mapStyle, "lat": lat, "lng": lng, "zoom": zoom], completion: completion)
    }

    func saveUsername(_ name: String, completion: @escaping (Bool) -> Void) {
        request("saveUsername", ["username": name], completion: completion)
    }

    func savePassword(current: String, next: String, confirm: String, completion: @escaping (Bool) -> Void) {
        request("savePassword", ["current": current, "next": next, "confirm": confirm], completion: completion)
    }

    func uploadAvatar(_ jpeg: Data, completion: @escaping (Bool) -> Void) {
        request("uploadAvatar", ["image": jpeg.base64EncodedString()], timeout: 40, completion: completion)
    }

    /// 暗黑模式：与网页主题页一致，先立即切换再保存
    func setDarkMode(_ value: Bool) {
        guard value != dark else { return }
        dark = value
        onDarkChange?(value)
        request("setDarkMode", ["value": value])
    }

    func saveThemeColors(primary: String, secondary: String) {
        request("saveThemeColors", ["primary": primary, "secondary": secondary])
    }

    func setMapStyle(_ value: String) {
        let which = dark ? "map_style_dark" : "map_style_light"
        if dark { darkStyle = value } else { lightStyle = value }
        request("setMapStyle", ["which": which, "value": value])
    }

    /// 动效开关：本机偏好，立即交给网页生效（不等回执）
    func setMotion(_ key: String, _ value: Bool) {
        motion[key] = value
        send(["type": "motion", "key": key, "value": value])
    }
}

// MARK: - 首页

private struct NativeSettingsView: View {
    @ObservedObject var store: NativeSettingsStore
    let select: (String) -> Void
    @State private var confirmation: AccountAction?
    @State private var leaving = false

    private enum AccountAction: String, Identifiable {
        case logoutAll, deleteAccount
        var id: String { rawValue }
    }

    private func perform(_ action: String) {
        guard !leaving else { return }
        leaving = true
        select(action)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    page("头像", symbol: "person.crop.circle", action: "avatar", destination: NativeAvatarView(store: store)) {
                        AvatarImage(url: store.avatarURL)
                            .frame(width: 36, height: 36)
                            .clipShape(Circle())
                    }
                    page("住民名", symbol: "person.text.rectangle", action: "username", destination: NativeUsernameView(store: store)) {
                        Text(store.username).foregroundStyle(.secondary).lineLimit(1)
                    }
                    page("修改通行密码", symbol: "key.fill", action: "password", destination: NativePasswordView(store: store)) { EmptyView() }
                }
                Section {
                    page("个性化主题", symbol: "paintpalette.fill", action: "themes", destination: NativeThemesView(store: store)) { EmptyView() }
                    page("个性化地图", symbol: "map.fill", action: "personalize", available: store.mapPageAvailable,
                         destination: NativeMapSettingsView(store: store)) { EmptyView() }
                }
                Section {
                    Button { confirmation = .logoutAll } label: {
                        settingLabel("退出全部设备", symbol: "rectangle.portrait.and.arrow.right", color: .brown)
                    }
                } footer: {
                    Text("网页与手机可同时登录；退出后，所有设备都需要重新登录。")
                }
                Section {
                    Button(role: .destructive) { confirmation = .deleteAccount } label: {
                        settingLabel("从幻想乡名册除名", symbol: "person.crop.circle.badge.minus", color: .red)
                    }
                } footer: {
                    Text("此操作不可恢复，会删除部分个人信息并取消住民身份的访问权限。")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("住民设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { perform("back") } label: {
                        Image(systemName: "chevron.backward").font(.headline)
                    }
                    .accessibilityLabel("返回地图")
                }
            }
            .disabled(leaving)
            .alert(item: $confirmation) { action in
                switch action {
                case .logoutAll:
                    return Alert(title: Text("退出全部设备？"), message: Text("包括本设备在内都需要重新登录。"),
                                 primaryButton: .destructive(Text("全部退出")) { perform("logoutAll") }, secondaryButton: .cancel(Text("取消")))
                case .deleteAccount:
                    return Alert(title: Text("确认从幻想乡名册除名？"), message: Text("此操作不可恢复，所有个人数据可能被删除或无法恢复。"),
                                 primaryButton: .destructive(Text("确认除名")) { perform("deleteAccount") }, secondaryButton: .cancel(Text("取消")))
                }
            }
        }
        .tint(store.primaryColor)
        // 二级页请求失败或超时的提示（任何一页都显示在这里）
        .alert(store.alertMessage ?? "", isPresented: Binding(get: { store.alertMessage != nil }, set: { if !$0 { store.alertMessage = nil } })) {
            Button("好", role: .cancel) {}
        }
        // 二级页保存成功后回到首页，底部短暂提示
        .overlay(alignment: .bottom) {
            if let toast = store.toast {
                Text(toast)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .padding(.bottom, 28)
                    .transition(.opacity)
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .animation(.easeOut(duration: 0.2), value: store.toast)
    }

    private func settingLabel(_ title: String, symbol: String, color: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 18)).foregroundStyle(.white)
                .frame(width: 30, height: 30).background(color, in: RoundedRectangle(cornerRadius: 7))
            Text(title).foregroundStyle(color == .red ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }

    /// 二级页入口：网页下发了二级页数据时在原生里推入，否则退回网页页面
    @ViewBuilder
    private func page<Destination: View, Accessory: View>(_ title: String, symbol: String, action: String, available: Bool? = nil,
                                                          destination: Destination,
                                                          @ViewBuilder accessory: () -> Accessory) -> some View {
        if available ?? store.pagesAvailable {
            NavigationLink(destination: destination) {
                HStack(spacing: 10) {
                    settingLabel(title, symbol: symbol, color: .brown)
                    accessory()
                }
            }
        } else {
            Button { perform(action) } label: {
                HStack(spacing: 10) {
                    settingLabel(title, symbol: symbol, color: .brown)
                    accessory()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
        }
    }
}

/// 头像：网络图片，未设置或加载失败时显示默认图标
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

/// 二级页通用：右上角保存（进行中显示转圈），出现 / 消失时通知侧滑手势
private struct SettingsPageChrome: ViewModifier {
    @ObservedObject var store: NativeSettingsStore
    let title: String
    let busyType: String
    let saveTitle: String?
    let canSave: Bool
    let save: () -> Void

    func body(content: Content) -> some View {
        content
            .disabled(store.isBusy(busyType))
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    if let saveTitle {
                        if store.isBusy(busyType) {
                            ProgressView()
                                .accessibilityLabel(Text(store.text("saving", "保存中...")))
                        } else {
                            Button(saveTitle, action: save)
                                .font(.body.weight(.semibold))
                                .disabled(!canSave)
                        }
                    }
                }
            }
            .onAppear { store.setPageShown(true) }
            .onDisappear { store.setPageShown(false) }
    }
}

private extension View {
    func settingsPage(_ store: NativeSettingsStore, title: String, busyType: String, saveTitle: String? = nil,
                      canSave: Bool = true, save: @escaping () -> Void = {}) -> some View {
        modifier(SettingsPageChrome(store: store, title: title, busyType: busyType, saveTitle: saveTitle, canSave: canSave, save: save))
    }
}

private func labeledField<Field: View>(_ label: String, @ViewBuilder field: () -> Field) -> some View {
    VStack(alignment: .leading, spacing: 4) {
        Text(label)
            .font(.footnote)
            .foregroundStyle(.secondary)
        field()
    }
    .padding(.vertical, 2)
}

// MARK: - 住民名

private struct NativeUsernameView: View {
    @ObservedObject var store: NativeSettingsStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                labeledField(store.text("usernameLabel", "住民名")) {
                    TextField(store.text("usernameLabel", "住民名"), text: $name)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.done)
                        .onSubmit(save)
                }
            }
        }
        .settingsPage(store, title: store.text("usernameTitle", "修改住民名"), busyType: "saveUsername",
                      saveTitle: store.text("save", "保存"),
                      canSave: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, save: save)
        .onAppear {
            guard !loaded else { return }
            loaded = true
            name = store.username
        }
    }

    private func save() {
        store.saveUsername(name) { ok in
            if ok { dismiss() }
        }
    }
}

// MARK: - 通行密码

private struct NativePasswordView: View {
    @ObservedObject var store: NativeSettingsStore
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var next = ""
    @State private var confirm = ""

    var body: some View {
        Form {
            Section {
                labeledField(store.text("passwordCurrent", "当前通行密码")) {
                    SecureField(store.text("passwordCurrent", "当前通行密码"), text: $current)
                        .textContentType(.password)
                }
                labeledField(store.text("passwordNew", "新通行密码")) {
                    SecureField(store.text("passwordNew", "新通行密码"), text: $next)
                        .textContentType(.newPassword)
                }
                labeledField(store.text("passwordConfirm", "确认新通行密码")) {
                    SecureField(store.text("passwordConfirm", "确认新通行密码"), text: $confirm)
                        .textContentType(.newPassword)
                }
            }
        }
        .settingsPage(store, title: store.text("passwordTitle", "修改通行密码"), busyType: "savePassword",
                      saveTitle: store.text("save", "保存"),
                      canSave: !current.isEmpty && !next.isEmpty && !confirm.isEmpty) {
            // 校验（长度、两次一致）在网页层统一处理，提示与网页版一致
            store.savePassword(current: current, next: next, confirm: confirm) { ok in
                guard ok else { return }
                current = ""; next = ""; confirm = ""
                dismiss()
            }
        }
    }
}

// MARK: - 头像

private struct NativeAvatarView: View {
    @ObservedObject var store: NativeSettingsStore
    @Environment(\.dismiss) private var dismiss
    @State private var pickerItem: PhotosPickerItem?
    @State private var picked: UIImage?
    @State private var zoom: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var showCamera = false
    @State private var loadingImage = false

    private let cameraAvailable = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width - 32, 340)
            ScrollView {
                VStack(spacing: 20) {
                    if let picked {
                        AvatarCropper(image: picked, side: side, zoom: $zoom, offset: $offset)
                        HStack(spacing: 12) {
                            Image(systemName: "minus.magnifyingglass").foregroundStyle(.secondary)
                            Slider(value: $zoom, in: 1...4)
                                .accessibilityLabel(Text(store.text("avatarZoom", "缩放")))
                            Image(systemName: "plus.magnifyingglass").foregroundStyle(.secondary)
                        }
                        .frame(width: side)
                    } else {
                        AvatarImage(url: store.avatarURL)
                            .frame(width: 160, height: 160)
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.secondary.opacity(0.3), lineWidth: 1))
                            .padding(.top, 24)
                    }
                    if loadingImage {
                        ProgressView()
                    }
                    HStack(spacing: 12) {
                        PhotosPicker(selection: $pickerItem, matching: .images) {
                            Label(store.text("chooseFromAlbum", "从相册选择"), systemImage: "photo.on.rectangle")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        if cameraAvailable {
                            Button {
                                showCamera = true
                            } label: {
                                Label(store.text("takePhoto", "拍照"), systemImage: "camera")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .controlSize(.large)
                    .frame(width: side)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
            }
            .settingsPage(store, title: store.text("avatarTitle", "修改头像"), busyType: "uploadAvatar",
                          saveTitle: store.text("avatarSave", "保存更改"), canSave: picked != nil) {
                upload(side: side)
            }
        }
        .onChange(of: pickerItem) { _, item in
            guard let item else { return }
            loadingImage = true
            Task {
                let data = try? await item.loadTransferable(type: Data.self)
                await MainActor.run {
                    loadingImage = false
                    pickerItem = nil
                    if let data, let image = UIImage(data: data) {
                        use(image)
                    } else {
                        store.alertMessage = store.text("avatarUnreadable", "图片无法读取")
                    }
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image { use(image) }
            }
            .ignoresSafeArea()
        }
    }

    private func use(_ image: UIImage) {
        picked = image.normalizedForAvatar()
        zoom = 1
        offset = .zero
    }

    private func upload(side: CGFloat) {
        guard let picked, let jpeg = AvatarCropper.render(image: picked, side: side, zoom: zoom, offset: offset) else { return }
        store.uploadAvatar(jpeg) { ok in
            if ok { dismiss() }
        }
    }
}

/// 圆形取景框：拖动移动、双指或滑块缩放；图片始终铺满取景框
private struct AvatarCropper: View {
    let image: UIImage
    let side: CGFloat
    @Binding var zoom: CGFloat
    @Binding var offset: CGSize
    @State private var dragStart: CGSize?
    @State private var zoomStart: CGFloat?

    /// 图片在取景框里的显示尺寸（缩放 1 时短边正好铺满）
    static func displaySize(image: UIImage, side: CGFloat, zoom: CGFloat) -> CGSize {
        let base = max(side / max(image.size.width, 1), side / max(image.size.height, 1))
        return CGSize(width: image.size.width * base * zoom, height: image.size.height * base * zoom)
    }

    /// 位移不能露出取景框外的空白
    static func clamp(_ offset: CGSize, image: UIImage, side: CGFloat, zoom: CGFloat) -> CGSize {
        let size = displaySize(image: image, side: side, zoom: zoom)
        let maxX = max(0, (size.width - side) / 2)
        let maxY = max(0, (size.height - side) / 2)
        return CGSize(width: min(max(offset.width, -maxX), maxX), height: min(max(offset.height, -maxY), maxY))
    }

    /// 按取景框裁出 512×512 JPEG（后端再统一转为 200×200 WebP）
    static func render(image: UIImage, side: CGFloat, zoom: CGFloat, offset: CGSize, output: CGFloat = 512) -> Data? {
        guard side > 0 else { return nil }
        let size = displaySize(image: image, side: side, zoom: zoom)
        let origin = CGPoint(x: (side - size.width) / 2 + offset.width, y: (side - size.height) / 2 + offset.height)
        let k = output / side
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: output, height: output), format: format).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: output, height: output))
            image.draw(in: CGRect(x: origin.x * k, y: origin.y * k, width: size.width * k, height: size.height * k))
        }
        return rendered.jpegData(compressionQuality: 0.9)
    }

    var body: some View {
        let size = Self.displaySize(image: image, side: side, zoom: zoom)
        Image(uiImage: image)
            .resizable()
            .frame(width: size.width, height: size.height)
            .offset(offset)
            .frame(width: side, height: side)
            .clipped()
            .overlay {
                // 圆外压暗，圆内是最终头像
                Path { path in
                    path.addRect(CGRect(x: 0, y: 0, width: side, height: side))
                    path.addEllipse(in: CGRect(x: 0, y: 0, width: side, height: side))
                }
                .fill(Color.black.opacity(0.45), style: FillStyle(eoFill: true))
                .allowsHitTesting(false)
                Circle()
                    .stroke(Color.white.opacity(0.85), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
            .gesture(drag.simultaneously(with: magnify))
            .onChange(of: zoom) { _, value in
                offset = Self.clamp(offset, image: image, side: side, zoom: value)
            }
            .accessibilityHidden(true)
    }

    private var drag: some Gesture {
        DragGesture()
            .onChanged { value in
                let start = dragStart ?? offset
                if dragStart == nil { dragStart = offset }
                offset = Self.clamp(CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height),
                                    image: image, side: side, zoom: zoom)
            }
            .onEnded { _ in dragStart = nil }
    }

    private var magnify: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = zoomStart ?? zoom
                if zoomStart == nil { zoomStart = zoom }
                zoom = min(max(start * value.magnification, 1), 4)
            }
            .onEnded { _ in zoomStart = nil }
    }
}

/// 系统相机（PhotosPicker 不能拍照）
private struct CameraPicker: UIViewControllerRepresentable {
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

private extension UIImage {
    /// 摆正方向并把长边限制在 maxSide 以内：裁剪与上传都基于这张图，避免超大照片占用内存
    func normalizedForAvatar(maxSide: CGFloat = 2048) -> UIImage {
        let longest = max(size.width, size.height)
        let ratio = longest > maxSide ? maxSide / longest : 1
        let target = CGSize(width: max(1, (size.width * ratio).rounded()), height: max(1, (size.height * ratio).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

// MARK: - 个性化主题

private struct NativeThemesView: View {
    @ObservedObject var store: NativeSettingsStore
    @State private var primary: Color = .pink
    @State private var secondary: Color = .purple
    @State private var loaded = false

    var body: some View {
        Form {
            Section {
                Toggle(isOn: Binding(get: { store.dark }, set: { store.setDarkMode($0) })) {
                    Text(store.text("darkMode", "暗黑模式"))
                }
                .disabled(store.isBusy("setDarkMode"))
            } footer: {
                Text(store.text("darkModeHint", "开启后界面将使用“冥界·夜樱”暗色主题"))
            }
            Section {
                ColorPicker(store.text("themeColor", "主题颜色"), selection: $primary, supportsOpacity: false)
                ColorPicker(store.text("secondaryColor", "辅色"), selection: $secondary, supportsOpacity: false)
                Button {
                    store.saveThemeColors(primary: primary.cssHex, secondary: secondary.cssHex)
                } label: {
                    HStack {
                        Text(store.text("save", "保存"))
                        if store.isBusy("saveThemeColors") {
                            Spacer()
                            ProgressView()
                        }
                    }
                }
                .disabled(store.isBusy("saveThemeColors"))
            } header: {
                Text(store.text("themeColor", "主题颜色"))
            } footer: {
                Text(store.text("themeColorHint", "自定义页面主色（用于核心按钮、选中状态与头像外圈）") + "\n"
                     + store.text("secondaryColorHint", "自定义辅色（用于标签、次要操作与强调图标）"))
            }
            if !store.currentStyleOptions.isEmpty {
                Section {
                    Picker(store.dark ? store.text("darkStyleCurrent", "暗色样式（当前）") : store.text("lightStyleCurrent", "亮色样式（当前）"),
                           selection: Binding(get: { store.currentStyle }, set: { store.setMapStyle($0) })) {
                        ForEach(store.currentStyleOptions) { option in
                            Text(option.name).tag(option.id)
                        }
                    }
                    .disabled(store.isBusy("setMapStyle"))
                } header: {
                    Text(store.text("mapStyleTitle", "地图样式"))
                } footer: {
                    Text(store.text("mapStyleHint", "为当前主题选择地图样式（选择后将保存到服务器或本地）。"))
                }
            }
        }
        .settingsPage(store, title: store.text("themesTitle", "个性化主题"), busyType: "")
        .onAppear {
            guard !loaded else { return }
            loaded = true
            primary = store.primaryColor
            secondary = store.secondaryColor
        }
        // 切换明暗后默认主题色会变（未自定义时）：跟随网页回传的颜色
        .onChange(of: store.primaryHex) { _, _ in primary = store.primaryColor }
        .onChange(of: store.secondaryHex) { _, _ in secondary = store.secondaryColor }
    }
}

private extension Color {
    /// #RRGGBB（sRGB）
    var cssHex: String {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        guard UIColor(self).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "#E2789F" }
        let clamp = { (value: CGFloat) -> Int in Int((min(max(value, 0), 1) * 255).rounded()) }
        return String(format: "#%02X%02X%02X", clamp(red), clamp(green), clamp(blue))
    }
}

// MARK: - 个性化地图

private struct NativeMapSettingsView: View {
    @ObservedObject var store: NativeSettingsStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Form {
            Section {
                LabeledContent(store.mapText("mapStyle", "地图样式"), value: store.mapText("styleStandard", "标准"))
            }
            Section {
                labeledField(store.mapText("centerLat", "默认中心纬度 (lat)")) {
                    TextField("23.016485", text: $store.lat).coordinateInput()
                }
                labeledField(store.mapText("centerLng", "默认中心经度 (lng)")) {
                    TextField("113.394405", text: $store.lng).coordinateInput()
                }
                labeledField(store.mapText("zoom", "默认缩放等级")) {
                    TextField("24", text: $store.zoom)
                        .keyboardType(.numberPad)
                }
            }
            if !store.motionItems.isEmpty {
                Section {
                    ForEach(store.motionItems) { item in
                        Toggle(isOn: Binding(get: { store.isOn(item.key) }, set: { store.setMotion(item.key, $0) })) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(item.label)
                                if !item.hint.isEmpty {
                                    Text(item.hint)
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                                if item.key == "nativeGlass", store.isOn("nativeGlass") {
                                    Text(store.mapText("nativeGlassStatus", ""))
                                        .font(.footnote)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } header: {
                    Text(store.mapText("motionTitle", "动效"))
                } footer: {
                    Text(store.mapText("motionFooter", "仅保存在本设备。"))
                }
            }
        }
        .settingsPage(store, title: store.mapText("title", "个性化地图"), busyType: "saveMap",
                      saveTitle: store.mapText("save", "保存")) {
            store.saveMap { ok in
                if ok { dismiss() }
            }
        }
    }
}

private extension View {
    /// 经纬度输入：需要小数点与负号
    func coordinateInput() -> some View {
        keyboardType(.numbersAndPunctuation)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
    }
}
