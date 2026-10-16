import UIKit
import WebKit
import Capacitor

/// 本地 Capacitor 插件：网页与原生地图控件之间的桥接协议（protocolVersion 6）。
///
/// capabilities() -> { protocolVersion, supportsGlass, accessibility }
/// attach({ sessionId, ownerId }) -> { ready }
/// setState({ sessionId, ownerId, revision, items, theme, floatingGap, search, sheet, drawer }) -> { appliedRevision }
///   search: { expanded, placeholder, busy, text, textVersion, focusToken, focus }
///   sheet: null | { id, token, title, subtitle?, message?, messageTone?, size: fit|list|card, leading?: row, detail?, caption?,
///                   actions?: [row], sections: [{ id, title?, footer?, style?, rows: [row] }], gallery?: [{ id, title?, images: [https], thumbnails?: [https] }] }
///   drawer: null | { sections: [section] }
///   row: { id, title, subtitle?, symbol?, tone?, disabled?, keepsOpen?, expands? }
/// ackAction({ sessionId, eventId, outcome, overlayOpened, revision })
/// suspend({ sessionId, reason }) -> { hidden }
/// resume({ sessionId, revision }) -> { visible }
/// heartbeat({ sessionId }) / dispose({ sessionId })
///
/// 事件：action / search / sheet / drawer / layout / sessionLost / accessibilityChanged / availabilityChanged
///   search: { sessionId, ownerId, type: input|submit|focus|close, text?, focused? }
///   sheet: { sessionId, ownerId, type: select|dismiss, sheetId, token, rowId? }
///   drawer: { sessionId, ownerId, type: select, rowId }
///
/// - v3：搜索展开后工具栏变为原生输入框，文本、提交、焦点与退出经 search 事件交给网页处理。
/// - v4：更多 / 住民 / 收藏面板改为系统 sheet（iOS 26 Liquid Glass）；行内容由网页下发，选择交回网页执行。
/// - v5：地点卡片也改为系统 sheet：地图保持可操作，操作按钮（keepsOpen）不收起面板，网页浮层打开期间面板暂时让位。
/// - v6：去掉“更多”按钮，改为工具栏上滑展开（drawer）；地点卡片改为两段停靠（摘要 / 上滑全屏详情），
///   左上角收藏圆钮、等宽操作按钮、正文与图片；面板改由 UIKit 呈现，宿主被系统界面（分享等）占用时等待而不是顶掉它。
/// - 动作使用固定白名单；原生不执行任意 JavaScript。旧 session、过期 owner 的调用被拒绝。
/// - 原生按钮触发会打开浮层的动作时先本地收起，再发事件；网页回执“没有打开浮层”或超时未回执时恢复。
/// - 本地会话健康超时：前台持续收不到心跳时先收起并禁用原生层，并通知网页重新握手，
///   避免网页已经失效时原生控件永远停在屏幕上，也避免网页仅凭超时就同时启用两组控件。
@objc(NativeMapChromePlugin)
public class NativeMapChromePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMapChromePlugin"
    public let jsName = "NativeMapChrome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "ackAction", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "suspend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "heartbeat", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dispose", returnType: CAPPluginReturnPromise)
    ]

    static let protocolVersion = 6
    static let allowedActions: Set<String> = ["more", "favorites", "journey", "add", "search", "alongRoute", "account", "locate"]
    static let allowedSheets: Set<String> = ["account", "favorites", "place"]
    /// 单个面板最多的行数（收藏列表）
    static let sheetRowLimit = 300
    /// 心跳超时（秒）；网页每 1.5 秒发一次
    static let healthTimeout: TimeInterval = 5
    /// 等待动作回执的最长时间（秒）
    static let ackTimeout: TimeInterval = 3

    /// 由 FoodMapBridgeViewController 注入
    var model: MapChromeModel?
    /// 返回 (宿主视图, WebView)，用于把控件位置换算为网页 CSS 像素
    var geometryProvider: (() -> (UIView, WKWebView)?)?

    private var healthTimer: Timer?
    private var lastHeartbeat = Date()
    private var appActive = true
    private var eventSeq = 0
    private var pendingAction: (eventId: String, deadline: Date)?
    private var layoutWorkItem: DispatchWorkItem?
    private var statusBarDark: Bool?
    private var observers: [NSObjectProtocol] = []

    override public func load() {
        let center = NotificationCenter.default
        let accessibilityNames: [Notification.Name] = [
            UIAccessibility.voiceOverStatusDidChangeNotification,
            UIAccessibility.reduceMotionStatusDidChangeNotification,
            UIAccessibility.reduceTransparencyStatusDidChangeNotification,
            UIAccessibility.darkerSystemColorsStatusDidChangeNotification,
            UIContentSizeCategory.didChangeNotification
        ]
        for name in accessibilityNames {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.notifyListeners("accessibilityChanged", data: self.accessibilitySnapshot())
            })
        }
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appActive = false
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            // 回到前台：给网页一个完整的心跳周期，而不是立刻判定失效
            self?.appActive = true
            self?.lastHeartbeat = Date()
        })
    }

    deinit {
        healthTimer?.invalidate()
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - 协议方法

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var supportsGlass = false
            if #available(iOS 26.0, *) {
                supportsGlass = self.model?.hostReady == true
            }
            call.resolve([
                "protocolVersion": NativeMapChromePlugin.protocolVersion,
                "supportsGlass": supportsGlass,
                "systemVersion": UIDevice.current.systemVersion,
                "accessibility": self.accessibilitySnapshot()
            ])
        }
    }

    @objc func attach(_ call: CAPPluginCall) {
        guard let sessionId = call.getString("sessionId"), !sessionId.isEmpty,
              let ownerId = call.getString("ownerId"), !ownerId.isEmpty else {
            call.reject("sessionId 与 ownerId 必填", "INVALID_ARGUMENT")
            return
        }
        DispatchQueue.main.async {
            guard let model = self.model, model.hostReady else {
                call.reject("原生控件不可用", "UNAVAILABLE")
                return
            }
            // 新会话替换旧会话：旧控件先收起
            model.reset(session: sessionId, owner: ownerId)
            model.onTap = { [weak self] item in self?.handleTap(item) }
            model.onSearchEvent = { [weak self] type, data in self?.emit("search", type, data) }
            model.onSheetEvent = { [weak self] type, data in self?.emit("sheet", type, data) }
            model.onDrawerEvent = { [weak self] type, data in self?.emit("drawer", type, data) }
            model.onFramesChanged = { [weak self] in self?.scheduleLayout() }
            self.pendingAction = nil
            self.lastHeartbeat = Date()
            self.startHealthTimer()
            call.resolve(["ready": true, "sessionId": sessionId])
            self.scheduleLayout()
        }
    }

    @objc func setState(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        let ownerId = call.getString("ownerId")
        let revision = call.getInt("revision") ?? 0
        let rawItems = call.getArray("items", JSObject.self) ?? []
        let rawTheme = call.getObject("theme") ?? [:]
        let floatingGap = call.getDouble("floatingGap")
        let search = NativeMapChromePlugin.parseSearch(call.getObject("search"))
        let sheet = NativeMapChromePlugin.parseSheet(call.getObject("sheet"))
        let drawer = NativeMapChromePlugin.parseDrawer(call.getObject("drawer"))
        DispatchQueue.main.async {
            guard let model = self.model, self.isCurrent(sessionId, ownerId) else {
                call.reject("会话已失效", "STALE_SESSION")
                return
            }
            guard revision >= model.revision else {
                call.resolve(["appliedRevision": model.revision, "ignored": true])
                return
            }
            let items = rawItems.compactMap(NativeMapChromePlugin.parseItem)
            var theme = MapChromeTheme()
            if let primary = rawTheme["primary"] as? String, let color = UIColor(cssHex: primary) { theme.primary = color }
            if let onPrimary = rawTheme["onPrimary"] as? String, let color = UIColor(cssHex: onPrimary) { theme.onPrimary = color }
            theme.dark = (rawTheme["dark"] as? Bool) ?? false
            // 底图延伸到状态栏下方：状态栏文字按应用主题（而不是系统外观）取色，深色地图上用浅色文字
            if self.statusBarDark != theme.dark {
                self.statusBarDark = theme.dark
                self.bridge?.statusBarStyle = theme.dark ? .lightContent : .darkContent
            }
            model.revision = revision
            model.apply(items: items, theme: theme, floatingGap: floatingGap.map { CGFloat($0) }, search: search, sheet: sheet, drawer: drawer)
            self.lastHeartbeat = Date()
            call.resolve(["appliedRevision": revision])
            // 占位尺寸不变时 SwiftUI 不会再回调几何变化，握手所需的首个布局由这里主动发出
            self.scheduleLayout()
        }
    }

    @objc func ackAction(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        let eventId = call.getString("eventId")
        let overlayOpened = call.getBool("overlayOpened") ?? false
        DispatchQueue.main.async {
            guard let model = self.model, self.isCurrent(sessionId, nil) else {
                call.reject("会话已失效", "STALE_SESSION")
                return
            }
            if let pending = self.pendingAction, pending.eventId == eventId {
                self.pendingAction = nil
                // 动作被拒绝或实际没有打开浮层：立即按最新快照恢复控件
                if !overlayOpened {
                    model.suspended = false
                    self.scheduleLayout()
                }
            }
            call.resolve(["revision": model.revision])
        }
    }

    @objc func suspend(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        DispatchQueue.main.async {
            guard let model = self.model, self.isCurrent(sessionId, nil) else {
                call.reject("会话已失效", "STALE_SESSION")
                return
            }
            self.pendingAction = nil
            model.suspended = true
            call.resolve(["hidden": true])
            self.scheduleLayout()
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        DispatchQueue.main.async {
            guard let model = self.model, self.isCurrent(sessionId, nil) else {
                call.reject("会话已失效", "STALE_SESSION")
                return
            }
            model.visible = true
            model.suspended = false
            self.lastHeartbeat = Date()
            call.resolve(["visible": true])
            // 显示状态变化后回传占用区域（地图安全区依赖它）
            self.scheduleLayout()
        }
    }

    @objc func heartbeat(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        DispatchQueue.main.async {
            guard self.isCurrent(sessionId, nil) else {
                call.reject("会话已失效", "STALE_SESSION")
                return
            }
            self.lastHeartbeat = Date()
            call.resolve(["alive": true])
        }
    }

    @objc func dispose(_ call: CAPPluginCall) {
        let sessionId = call.getString("sessionId")
        DispatchQueue.main.async {
            if self.isCurrent(sessionId, nil) { self.tearDown() }
            call.resolve(["disposed": true])
        }
    }

    // MARK: - 内部

    /// WebView 尺寸变化（键盘插件按键盘高度缩小 WebView）后重新回传占用区域：
    /// 控件宿主不随 WebView 缩放，但换算到网页视口的底部占用高度会变。
    func handleWebViewResize() {
        DispatchQueue.main.async {
            if self.model?.sessionId != nil { self.scheduleLayout() }
        }
    }

    /// WebView 重新加载（导航或会话重置）时主动销毁旧控件
    func handleWebViewReload() {
        DispatchQueue.main.async {
            if self.model?.sessionId != nil { self.tearDown() }
        }
    }

    private func tearDown() {
        healthTimer?.invalidate()
        healthTimer = nil
        pendingAction = nil
        layoutWorkItem?.cancel()
        model?.onTap = nil
        model?.onSearchEvent = nil
        model?.onSheetEvent = nil
        model?.onDrawerEvent = nil
        model?.reset(session: nil, owner: nil)
    }

    private func isCurrent(_ sessionId: String?, _ ownerId: String?) -> Bool {
        guard let model = model, let current = model.sessionId, current == sessionId else { return false }
        if let ownerId = ownerId, ownerId != model.ownerId { return false }
        return true
    }

    private static func parseItem(_ raw: JSObject) -> MapChromeItem? {
        guard let id = raw["id"] as? String, allowedActions.contains(id) else { return nil }
        return MapChromeItem(
            id: id,
            title: (raw["title"] as? String) ?? id,
            symbol: (raw["symbol"] as? String) ?? "circle",
            selected: (raw["selected"] as? Bool) ?? false,
            disabled: (raw["disabled"] as? Bool) ?? false,
            busy: (raw["busy"] as? Bool) ?? false,
            badge: raw["badge"] as? String,
            avatarURL: raw["avatarURL"] as? String,
            placement: id == "account" ? "account" : ((raw["placement"] as? String) == "floating" ? "floating" : "toolbar"),
            tone: raw["tone"] as? String,
            opensOverlay: (raw["opensOverlay"] as? Bool) ?? false
        )
    }

    private static func parseSearch(_ raw: JSObject?) -> MapChromeSearch? {
        guard let raw else { return nil }
        var search = MapChromeSearch()
        search.expanded = (raw["expanded"] as? Bool) ?? false
        search.placeholder = String(((raw["placeholder"] as? String) ?? "搜索").prefix(40))
        search.busy = (raw["busy"] as? Bool) ?? false
        search.text = String(((raw["text"] as? String) ?? "").prefix(MapChromeModel.searchTextLimit))
        search.textVersion = (raw["textVersion"] as? Int) ?? 0
        search.focusToken = (raw["focusToken"] as? Int) ?? 0
        search.focus = (raw["focus"] as? Bool) ?? false
        return search
    }

    /// 面板快照：只接受白名单面板，文本截断、行数封顶；原生只展示，不解释行的含义
    private static func parseSheet(_ raw: JSObject?) -> MapChromeSheet? {
        guard let raw, let sheetId = raw["id"] as? String, allowedSheets.contains(sheetId),
              let token = raw["token"] as? Int else { return nil }
        var budget = sheetRowLimit
        let sections = parseSections(raw["sections"], budget: &budget)
        var actionBudget = 6
        var leadingBudget = 1
        let leadingRaw: JSArray? = (raw["leading"] as? JSObject).map { [$0] }
        let style = (raw["size"] as? String).flatMap { ["fit", "list", "card"].contains($0) ? $0 : nil } ?? "fit"
        return MapChromeSheet(
            sheetId: sheetId,
            token: token,
            title: clip(raw["title"], 60) ?? "",
            subtitle: clip(raw["subtitle"], 80),
            message: clip(raw["message"], 120),
            messageTone: raw["messageTone"] as? String,
            style: style,
            leading: parseRows(leadingRaw, budget: &leadingBudget).first,
            detail: clip(raw["detail"], 2000),
            caption: clip(raw["caption"], 200),
            actions: parseRows(raw["actions"], budget: &actionBudget),
            sections: sections,
            gallery: parseGallery(raw["gallery"])
        )
    }

    /// 更多功能：与面板相同的分组行
    private static func parseDrawer(_ raw: JSObject?) -> MapChromeDrawer? {
        guard let raw else { return nil }
        var budget = 40
        let drawer = MapChromeDrawer(sections: parseSections(raw["sections"], budget: &budget))
        return drawer.isEmpty ? nil : drawer
    }

    private static func parseSections(_ raw: JSValue?, budget: inout Int) -> [MapChromeSheetSection] {
        var sections: [MapChromeSheetSection] = []
        let rawSections = ((raw as? JSArray) ?? []).compactMap { $0 as? JSObject }
        for (index, rawSection) in rawSections.prefix(8).enumerated() {
            sections.append(MapChromeSheetSection(
                id: clip(rawSection["id"], 32) ?? "section-\(index)",
                title: clip(rawSection["title"], 40),
                footer: clip(rawSection["footer"], 120),
                footnote: (rawSection["style"] as? String) == "footnote",
                rows: parseRows(rawSection["rows"], budget: &budget)
            ))
        }
        return sections
    }

    private static func parseRows(_ raw: JSValue?, budget: inout Int) -> [MapChromeSheetRow] {
        var rows: [MapChromeSheetRow] = []
        var seen = Set<String>()
        for rawRow in ((raw as? JSArray) ?? []).compactMap({ $0 as? JSObject }) {
            guard budget > 0, let rowId = clip(rawRow["id"], 64), seen.insert(rowId).inserted else { continue }
            budget -= 1
            rows.append(MapChromeSheetRow(
                id: rowId,
                title: clip(rawRow["title"], 60) ?? rowId,
                subtitle: clip(rawRow["subtitle"], 80),
                symbol: clip(rawRow["symbol"], 64),
                tone: rawRow["tone"] as? String,
                disabled: (rawRow["disabled"] as? Bool) ?? false,
                keepsOpen: (rawRow["keepsOpen"] as? Bool) ?? false,
                expands: (rawRow["expands"] as? Bool) ?? false
            ))
        }
        return rows
    }

    /// 图片只接受 https（App 内网页资源均为公网 HTTPS），每组最多 12 张、最多 4 组。
    /// thumbnails 可选，与 images 逐项对应；缺失或无效的项回退为原图
    private static func parseGallery(_ raw: JSValue?) -> [MapChromeSheetGallery] {
        var groups: [MapChromeSheetGallery] = []
        let rawGroups = ((raw as? JSArray) ?? []).compactMap { $0 as? JSObject }
        for (index, rawGroup) in rawGroups.prefix(4).enumerated() {
            let rawThumbnails = (rawGroup["thumbnails"] as? JSArray) ?? []
            var images: [URL] = []
            var thumbnails: [URL] = []
            for (position, value) in ((rawGroup["images"] as? JSArray) ?? []).enumerated() {
                guard images.count < 12, let image = httpsURL(value) else { continue }
                images.append(image)
                thumbnails.append(position < rawThumbnails.count ? (httpsURL(rawThumbnails[position]) ?? image) : image)
            }
            guard !images.isEmpty else { continue }
            groups.append(MapChromeSheetGallery(
                id: clip(rawGroup["id"], 32) ?? "gallery-\(index)",
                title: clip(rawGroup["title"], 40),
                images: images,
                thumbnails: thumbnails
            ))
        }
        return groups
    }

    private static func httpsURL(_ value: JSValue?) -> URL? {
        guard let text = value as? String, text.count <= 2048, let url = URL(string: text),
              url.scheme?.lowercased() == "https", url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }

    private static func clip(_ value: JSValue?, _ limit: Int) -> String? {
        guard let text = value as? String, !text.isEmpty else { return nil }
        return String(text.prefix(limit))
    }

    private func emit(_ event: String, _ type: String, _ data: [String: Any]) {
        guard let model = model, let sessionId = model.sessionId else { return }
        var payload = data
        payload["sessionId"] = sessionId
        payload["ownerId"] = model.ownerId ?? ""
        payload["type"] = type
        notifyListeners(event, data: payload)
    }

    private func handleTap(_ item: MapChromeItem) {
        guard let model = model, let sessionId = model.sessionId, NativeMapChromePlugin.allowedActions.contains(item.id) else { return }
        eventSeq += 1
        let eventId = "\(sessionId)-\(eventSeq)"
        if item.opensOverlay {
            // 先本地收起，避免原生控件盖住即将打开的网页浮层
            model.suspended = true
            pendingAction = (eventId, Date().addingTimeInterval(NativeMapChromePlugin.ackTimeout))
            scheduleLayout()
        }
        notifyListeners("action", data: [
            "sessionId": sessionId,
            "ownerId": model.ownerId ?? "",
            "revision": model.revision,
            "eventId": eventId,
            "actionId": item.id
        ])
    }

    private func startHealthTimer() {
        healthTimer?.invalidate()
        let timer = Timer(timeInterval: 1, repeats: true) { [weak self] _ in
            self?.checkHealth()
        }
        RunLoop.main.add(timer, forMode: .common)
        healthTimer = timer
    }

    private func checkHealth() {
        guard let model = model, let sessionId = model.sessionId else { return }
        let now = Date()
        if let pending = pendingAction, now > pending.deadline {
            // 超时未收到回执：恢复控件（若网页确实打开了浮层，会随后再次 suspend）
            pendingAction = nil
            model.suspended = false
            scheduleLayout()
        }
        guard appActive, UIApplication.shared.applicationState == .active else { return }
        if now.timeIntervalSince(lastHeartbeat) > NativeMapChromePlugin.healthTimeout {
            // 网页失去响应：先收起并禁用原生层，再通知网页恢复后重新握手
            tearDown()
            notifyListeners("sessionLost", data: ["sessionId": sessionId, "reason": "heartbeat-timeout"])
        }
    }

    private func scheduleLayout() {
        layoutWorkItem?.cancel()
        let work = DispatchWorkItem { [weak self] in self?.emitLayout() }
        layoutWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: work)
    }

    /// 回传占用区域：坐标换算为 WebView 视口的 CSS 像素（原生点 → WebView 坐标 → 除以缩放）
    private func emitLayout() {
        guard let model = model, let sessionId = model.sessionId, let geometry = geometryProvider?() else { return }
        let (host, webView) = geometry
        let zoom = max(webView.scrollView.zoomScale, 0.01)
        func css(_ rect: CGRect) -> [String: Any] {
            let converted = host.convert(rect, to: webView)
            return [
                "x": Double(converted.minX / zoom),
                "y": Double(converted.minY / zoom),
                "width": Double(converted.width / zoom),
                "height": Double(converted.height / zoom)
            ]
        }
        let viewportHeight = webView.bounds.height / zoom
        var bottomOccupied: Double = 0
        if let toolbar = model.frames["toolbar"] {
            let top = host.convert(toolbar, to: webView).minY / zoom
            bottomOccupied = Double(max(0, viewportHeight - top))
        }
        var slots: [[String: Any]] = []
        for (id, rect) in model.frames {
            var entry = css(rect)
            entry["id"] = id
            slots.append(entry)
        }
        let insets = webView.safeAreaInsets
        notifyListeners("layout", data: [
            "sessionId": sessionId,
            "coordinateSpace": "webview-css",
            "showing": model.isShowing,
            "occupiedRects": model.interactiveRects.map(css),
            "slots": slots,
            "bottomOccupied": bottomOccupied,
            "viewport": ["width": Double(webView.bounds.width / zoom), "height": Double(viewportHeight)],
            "safeArea": [
                "top": Double(insets.top / zoom),
                "right": Double(insets.right / zoom),
                "bottom": Double(insets.bottom / zoom),
                "left": Double(insets.left / zoom)
            ]
        ])
    }

    private func accessibilitySnapshot() -> [String: Any] {
        return [
            "voiceOver": UIAccessibility.isVoiceOverRunning,
            "reduceMotion": UIAccessibility.isReduceMotionEnabled,
            "reduceTransparency": UIAccessibility.isReduceTransparencyEnabled,
            "increaseContrast": UIAccessibility.isDarkerSystemColorsEnabled,
            "contentSize": UIApplication.shared.preferredContentSizeCategory.rawValue
        ]
    }
}
