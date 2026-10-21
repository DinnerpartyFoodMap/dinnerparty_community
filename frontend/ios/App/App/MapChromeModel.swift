import UIKit
import SwiftUI
import Combine

/// 原生地图控件的一个按钮快照（由网页按白名单下发，原生不执行任意脚本）。
struct MapChromeItem: Identifiable, Equatable {
    /// 动作 id，必须属于 NativeMapChromePlugin.allowedActions
    let id: String
    var title: String
    var symbol: String
    var selected: Bool
    var disabled: Bool
    var busy: Bool
    var badge: String?
    var avatarURL: String?
    /// "toolbar"（底部工具栏）、"floating"（定位）或 "account"（右下独立头像）
    var placement: String
    /// "accent" / "danger" / nil
    var tone: String?
    /// 点击后会打开网页浮层：原生先本地收起，等待网页回执
    var opensOverlay: Bool
    /// 皮肤图标（v8）：有时代替 SF Symbol，加载不到时仍显示 symbol
    var image: String? = nil
    /// 皮肤图标按单色处理（跟随前景色，浅色 / 深色模式自动适配）
    var imageTemplate = false
}

/// 底部搜索栏状态（网页下发）。展开后工具栏变为原生输入框。
/// 输入文本以原生为准：用户输入立即生效并回传网页；网页只在 textVersion 变化时覆盖（选中建议、清空等），
/// 避免回声打断输入法组字。
struct MapChromeSearch: Equatable {
    var expanded = false
    var placeholder = "搜索"
    var hint = "输入和回车搜索已收录地点。查找未收录地点请使用结果列表中的按钮。"
    var busyLabel = "正在搜索"
    var busy = false
    var text = ""
    var textVersion = 0
    /// 焦点请求：每个 token 只执行一次
    var focusToken = 0
    var focus = false
}

/// 原生面板（系统 sheet）的一行：只做展示，点按后把 id 交给网页处理
struct MapChromeSheetRow: Identifiable, Equatable {
    let id: String
    var title: String
    var subtitle: String?
    var symbol: String?
    /// "danger" / "muted" / "warning" / "accent" / nil
    var tone: String?
    var disabled: Bool
    /// 点按后面板不收起（地点卡片的操作按钮：网页浮层打开期间面板暂时让位，关闭后回来）
    var keepsOpen: Bool
    /// 点按只在原生侧展开 / 收起地点卡片（“详情”），不回传网页
    var expands: Bool
    /// 皮肤图标（v8，地点卡片的操作按钮、评价表情、更多功能）
    var image: String? = nil
    var imageTemplate = false
}

struct MapChromeSheetSection: Identifiable, Equatable {
    let id: String
    var title: String?
    var footer: String?
    /// 脚注样式（备案链接等次要信息）
    var footnote: Bool
    var rows: [MapChromeSheetRow]
}

/// 地点卡片展开后的一组图片（外观、菜单）。thumbnails 与 images 逐项对应：方块用缩略图，大图用原图
struct MapChromeSheetGallery: Identifiable, Equatable {
    let id: String
    var title: String?
    var images: [URL]
    var thumbnails: [URL]
}

/// 卡片全屏详情里的一段正文（展会简介、展会信息）
struct MapChromeSheetParagraph: Identifiable, Equatable {
    let id: String
    var title: String?
    var text: String
}

/// 网页下发的面板快照。token 每次打开递增：用户关闭后，同一 token 的旧快照不会再弹出。
struct MapChromeSheet: Identifiable, Equatable {
    let sheetId: String
    let token: Int
    var title: String
    var subtitle: String?
    /// 加载中 / 出错 / 空列表时的提示
    var message: String?
    /// "loading" / "danger" / nil
    var messageTone: String?
    /// "fit"：菜单，"list"：列表（二者都是工具栏上方的玻璃面板，按内容高度，超出时滚动）；
    /// "card"：地点卡片，两段停靠（摘要 / 全屏详情），摘要高度时地图仍可拖动、点选
    var style: String
    /// 卡片左上角的圆钮（分享）
    var leading: MapChromeSheetRow?
    /// 正文（地点简介，展开后完整显示）
    var detail: String?
    /// 正文下方的次要信息（地址）
    var caption: String?
    /// 标题左侧的图标（展会图标，https）；有 leading 圆钮时不显示
    var image: URL?
    /// 分段正文：有内容时代替 detail 的“简介”一段（展会）
    var paragraphs: [MapChromeSheetParagraph]
    /// 横排操作按钮（地点卡片：导航、收藏、编辑……），等宽
    var actions: [MapChromeSheetRow]
    var sections: [MapChromeSheetSection]
    var gallery: [MapChromeSheetGallery]
    /// 地点卡片右上角关闭钮的皮肤图标（v8）
    var closeImage: String? = nil
    var closeImageTemplate = false

    var id: String { "\(sheetId)#\(token)" }
    var isCard: Bool { style == "card" }
}

/// 底部工具栏上滑展开的“更多功能”（网页下发；点按回传行 id）
struct MapChromeDrawer: Equatable {
    var sections: [MapChromeSheetSection]

    var isEmpty: Bool { sections.allSatisfy { $0.rows.isEmpty } }
}

struct MapChromeTheme: Equatable {
    var primary: UIColor = UIColor(red: 0.886, green: 0.471, blue: 0.624, alpha: 1)
    var onPrimary: UIColor = .white
    var dark: Bool = false
}

/// 皮肤装饰图片（v8）：工具栏两端装饰（以工具栏左上 / 右上角为原点，x 向内、y 向下）、选中底座（y 为相对按钮中心的下移）、
/// 头像框（比头像大 scale 倍）。尺寸单位为点。
struct MapChromeSkinDecor: Equatable {
    var image: String
    var width: CGFloat = 40
    var height: CGFloat = 40
    var x: CGFloat = 0
    var y: CGFloat = 0
    var scale: CGFloat = 1.3
}

/// 网页下发的皮肤（已按当前浅色 / 深色模式取值，切换时随下一次快照更新）。
/// 只有图标与装饰：液态玻璃的底色、底纹与边框始终是系统材质，保持通透。
struct MapChromeSkin: Equatable {
    var avatarFrame: MapChromeSkinDecor?
    var ornamentStart: MapChromeSkinDecor?
    var ornamentEnd: MapChromeSkinDecor?
    var pedestal: MapChromeSkinDecor?
    /// 工具栏选中按钮的图标与文字颜色；nil 时与其他按钮相同（主文字色）
    var selectedColor: UIColor?
}

/// 网页、插件与 SwiftUI 共享的状态。只在主线程读写。
final class MapChromeModel: ObservableObject {
    @Published private(set) var items: [MapChromeItem] = []
    @Published private(set) var theme = MapChromeTheme() {
        didSet { onPresentationChange?() }
    }
    /// 主题皮肤的装饰（头像框、两端装饰、选中底座、选中色）；图标在各按钮 / 行自己的 image 里
    @Published private(set) var skin = MapChromeSkin()
    /// 网页请求显示（attach 后默认隐藏，resume 后显示）
    @Published var visible = false {
        didSet {
            if !visible { drawerExpanded = false }
            onPresentationChange?()
        }
    }
    /// 网页浮层接管或等待动作回执时收起并禁用
    @Published var suspended = false {
        didSet {
            if suspended { drawerExpanded = false }
            onPresentationChange?()
        }
    }
    /// 浮动按钮组底边与工具栏顶边的间距（pt）
    @Published var floatingGap: CGFloat = 14
    @Published private(set) var search = MapChromeSearch()
    /// 输入框当前文本
    @Published private(set) var searchText = ""
    /// 已执行的焦点请求；控件因浮层收起后重新出现时不会再次弹出键盘
    var appliedFocusToken = 0
    private var appliedTextVersion: Int?
    private var focusBaselinePending = true

    static let searchTextLimit = 100

    /// 网页当前要求显示的面板（nil 表示关闭）
    @Published private(set) var sheet: MapChromeSheet? {
        didSet { onPresentationChange?() }
    }
    /// 最近一次的面板内容：关闭动画期间保持显示，不会闪成空白
    @Published private(set) var sheetContent: MapChromeSheet?
    /// 用户已在原生侧关闭（选择或下滑）的面板 token
    @Published private(set) var dismissedSheetToken: Int? {
        didSet { onPresentationChange?() }
    }
    /// 地点卡片摘要（标题 + 操作按钮）的高度：决定卡片第一段的停靠高度
    private(set) var cardSummaryHeight: CGFloat = 200
    /// 地点卡片当前停在全屏详情（由面板呈现器按系统停靠位置同步）
    @Published var cardExpanded = false

    /// 底部工具栏上滑后的“更多功能”
    @Published private(set) var drawer: MapChromeDrawer?
    @Published private(set) var drawerExpanded = false {
        didSet { if drawerExpanded != oldValue { onFramesChanged?() } }
    }

    var sessionId: String? {
        didSet { onPresentationChange?() }
    }
    var ownerId: String?
    var revision = 0
    var hostReady = false

    /// 控件在宿主视图坐标系中的位置，用于点击穿透与回传占用区域
    private(set) var frames: [String: CGRect] = [:]

    var onTap: ((MapChromeItem) -> Void)?
    /// 搜索输入事件：type 为 input / submit / focus / close
    var onSearchEvent: ((String, [String: Any]) -> Void)?
    /// 面板事件：type 为 select / dismiss
    var onSheetEvent: ((String, [String: Any]) -> Void)?
    /// 更多功能事件：type 为 select
    var onDrawerEvent: ((String, [String: Any]) -> Void)?
    var onFramesChanged: (() -> Void)?
    /// 面板是否应当显示可能变化：由 FoodMapBridgeViewController 的面板呈现器对账（与会话无关，reset 不清空）
    var onPresentationChange: (() -> Void)?
    /// 卡片摘要高度变化：重新计算第一段停靠高度
    var onSheetMetricsChange: (() -> Void)?

    var isShowing: Bool { sessionId != nil && visible && !suspended }

    var toolbarItems: [MapChromeItem] { items.filter { $0.placement == "toolbar" } }
    var floatingItems: [MapChromeItem] { items.filter { $0.placement == "floating" } }
    var accountItem: MapChromeItem? { items.first { $0.placement == "account" } }
    var searchExpanded: Bool { search.expanded && !toolbarItems.isEmpty }
    /// 网页刚请求聚焦、视图尚未执行：展开的第一帧就按输入中布局，不先闪出返回圆钮
    var hasPendingFocusRequest: Bool { search.focus && search.focusToken != appliedFocusToken }

    /// 应当弹出的面板：网页要求显示、且这一次没有被用户关闭。
    /// 网页浮层打开时（控件收起）面板也暂时让位，否则会盖住网页浮层；浮层关闭后重新出现。
    var presentedSheet: MapChromeSheet? {
        guard isShowing, let sheet, sheet.token != dismissedSheetToken else { return nil }
        return sheet
    }

    /// 地点卡片：由 MapChromeSheetPresenter 以 UIKit 系统面板呈现（两段停靠、全屏详情）
    var presentedCard: MapChromeSheet? {
        guard let sheet = presentedSheet, sheet.isCard else { return nil }
        return sheet
    }

    /// 住民菜单、我的收藏：在工具栏同一层画的玻璃面板（与工具栏同一种 Liquid Glass），浮在工具栏上方；搜索时让位
    var presentedPanel: MapChromeSheet? {
        guard !searchExpanded, let sheet = presentedSheet, !sheet.isCard else { return nil }
        return sheet
    }

    /// 可以上滑展开更多功能：有内容、未在搜索、没有面板盖住工具栏
    var drawerAvailable: Bool {
        guard isShowing, !searchExpanded, presentedSheet == nil, let drawer else { return false }
        return !drawer.isEmpty
    }

    var drawerOpen: Bool { drawerExpanded && drawerAvailable }

    func reset(session: String?, owner: String?) {
        sessionId = session
        ownerId = owner
        revision = 0
        visible = false
        suspended = false
        items = []
        search = MapChromeSearch()
        searchText = ""
        appliedTextVersion = nil
        appliedFocusToken = 0
        focusBaselinePending = true
        sheet = nil
        dismissedSheetToken = nil
        cardExpanded = false
        drawer = nil
        drawerExpanded = false
        skin = MapChromeSkin()
        // frames 是占位视图的几何信息，与会话无关，不清空：
        // 占位位置不变时 SwiftUI 不会再次回调，清空后新会话就拿不到工具栏位置（浮动按钮的过期位置由 apply 按 id 剔除）
        onFramesChanged?()
    }

    func apply(items next: [MapChromeItem], theme nextTheme: MapChromeTheme, floatingGap gap: CGFloat?,
               search nextSearch: MapChromeSearch?, sheet nextSheet: MapChromeSheet?, drawer nextDrawer: MapChromeDrawer?,
               skin nextSkin: MapChromeSkin) {
        if items != next { items = next }
        if skin != nextSkin { skin = nextSkin }
        if sheet?.id != nextSheet?.id { cardExpanded = false }
        if sheet != nextSheet { sheet = nextSheet }
        if let nextSheet, sheetContent != nextSheet { sheetContent = nextSheet }
        if theme != nextTheme { theme = nextTheme }
        if let gap, gap != floatingGap { floatingGap = gap }
        if drawer != nextDrawer { drawer = nextDrawer }
        if let nextSearch {
            // 新会话的首个状态只记录基线，不执行握手前遗留的焦点请求
            if focusBaselinePending {
                appliedFocusToken = nextSearch.focusToken
                focusBaselinePending = false
            }
            if appliedTextVersion != nextSearch.textVersion {
                appliedTextVersion = nextSearch.textVersion
                if searchText != nextSearch.text { searchText = nextSearch.text }
            }
            if search != nextSearch { search = nextSearch }
        }
        if drawerExpanded && !drawerAvailable { drawerExpanded = false }
        let ids = Set(next.map(\.id)).union(["toolbar", "floating", "drawer", "panel"])
        let pruned = frames.filter { ids.contains($0.key) }
        if pruned.count != frames.count {
            frames = pruned
            onFramesChanged?()
        }
    }

    func setFrame(_ id: String, _ rect: CGRect) {
        if frames[id] == rect { return }
        frames[id] = rect
        // 更多功能、菜单面板展开或拖动时每帧都在变，但不影响回传网页的占用区域
        if id != "drawer" && id != "panel" { onFramesChanged?() }
    }

    func clearFrame(_ id: String) {
        if frames.removeValue(forKey: id) != nil { onFramesChanged?() }
    }

    /// 回传网页的占用区域（地图安全区依据）：可见控件的实际外框（禁用按钮同样占用，消费触摸而不执行动作）。
    /// 展开的更多功能、菜单面板只是临时浮层，不改变地图安全区。
    var interactiveRects: [CGRect] {
        guard isShowing else { return [] }
        var rects: [CGRect] = []
        if !toolbarItems.isEmpty, let toolbar = frames["toolbar"] { rects.append(toolbar) }
        // 搜索展开或菜单面板打开时浮动按钮让位，不再占用；更多功能展开时浮动按钮停在抽屉上方，仍可点按
        if !searchExpanded && presentedPanel == nil {
            for item in floatingItems {
                if let rect = frames[item.id] { rects.append(rect) }
            }
        }
        return rects
    }

    /// 宿主视图实际拦截触摸的区域：占用区域加上展开的更多功能与菜单面板
    var touchRects: [CGRect] {
        var rects = interactiveRects
        if drawerOpen, let drawer = frames["drawer"] { rects.append(drawer) }
        if presentedPanel != nil, let panel = frames["panel"] { rects.append(panel) }
        return rects
    }

    func tap(_ item: MapChromeItem) {
        guard isShowing, !item.disabled else { return }
        drawerExpanded = false
        onTap?(item)
    }

    // MARK: - 更多功能（工具栏上滑）

    func setDrawerExpanded(_ expanded: Bool) {
        let next = expanded && drawerAvailable
        if drawerExpanded != next { drawerExpanded = next }
    }

    func selectDrawerRow(_ row: MapChromeSheetRow) {
        guard drawerOpen, !row.disabled else { return }
        drawerExpanded = false
        onDrawerEvent?("select", ["rowId": row.id])
    }

    // MARK: - 面板

    /// 点按一行：先在本地收起面板（keepsOpen 的操作除外），再把选择交给网页
    func selectSheetRow(_ row: MapChromeSheetRow) {
        guard let sheet = presentedSheet, !row.disabled, !row.expands else { return }
        if !row.keepsOpen { dismissedSheetToken = sheet.token }
        onSheetEvent?("select", ["sheetId": sheet.sheetId, "token": sheet.token, "rowId": row.id])
    }

    /// 用户下滑、点遮罩或关闭按钮
    func dismissSheet() {
        guard let sheet = presentedSheet else { return }
        dismissedSheetToken = sheet.token
        onSheetEvent?("dismiss", ["sheetId": sheet.sheetId, "token": sheet.token])
    }

    func setCardSummaryHeight(_ height: CGFloat) {
        let rounded = height.rounded()
        guard rounded > 0, abs(rounded - cardSummaryHeight) >= 1 else { return }
        cardSummaryHeight = rounded
        onSheetMetricsChange?()
    }

    // MARK: - 搜索输入

    func updateSearchText(_ value: String) {
        let next = String(value.prefix(Self.searchTextLimit))
        guard next != searchText else { return }
        searchText = next
        sendSearch("input", ["text": next])
    }

    func submitSearch() {
        guard !search.busy, !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // Only submit the local search. External POIs require the explicit Web result-list action.
        sendSearch("submit", ["text": searchText])
    }

    func closeSearch() {
        sendSearch("close", [:])
    }

    /// 焦点变化在控件收起时也要回传（输入框随浮层移出层级时会失去焦点）
    func searchFocusChanged(_ focused: Bool) {
        guard sessionId != nil else { return }
        onSearchEvent?("focus", ["focused": focused, "text": searchText])
    }

    private func sendSearch(_ type: String, _ data: [String: Any]) {
        guard isShowing, searchExpanded else { return }
        onSearchEvent?(type, data)
    }
}

/// 网页下发的图片地址（皮肤图标与装饰、默认头像）。
/// - App 包里的网页资源（capacitor://localhost/assets/…，Vite 打包在 public/assets；URLSession 读不了 capacitor://）
///   与 base64 data URL（PNG 等位图小图被 Vite 内联）同步读取并缓存；
/// - 开发时的 http(s) 地址交给 AsyncImage。
enum MapChromeSkinImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func local(_ source: String) -> UIImage? {
        let key = source as NSString
        if let cached = cache.object(forKey: key) { return cached }
        var image: UIImage?
        if source.hasPrefix("data:image/"), let comma = source.firstIndex(of: ","),
           source[..<comma].hasSuffix(";base64"),
           let data = Data(base64Encoded: String(source[source.index(after: comma)...])) {
            image = UIImage(data: data, scale: 3)
        } else if let url = URL(string: source), url.scheme == "capacitor", url.path.hasPrefix("/assets/"),
                  !url.pathComponents.contains(".."), let root = Bundle.main.resourceURL {
            image = UIImage(contentsOfFile: root.appendingPathComponent("public" + url.path).path)
        }
        if let image { cache.setObject(image, forKey: key) }
        return image
    }

    static func remote(_ source: String) -> URL? {
        guard let url = URL(string: source), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return nil }
        return url
    }
}

/// 皮肤图片：有图时显示图片，没有或读不到时显示 fallback（原来的 SF Symbol），缺图、坏图都回到默认样式。
/// template 为真时按单色图标渲染（跟随 foregroundStyle，浅色 / 深色模式自动取色）；否则保持原色。
struct MapChromeSkinImage<Fallback: View>: View {
    let source: String?
    var template = false
    var width: CGFloat? = nil
    var height: CGFloat? = nil
    var alignment: Alignment = .center
    @ViewBuilder var fallback: () -> Fallback

    var body: some View {
        if let source, let image = MapChromeSkinImages.local(source) {
            styled(Image(uiImage: image))
        } else if let source, let url = MapChromeSkinImages.remote(source) {
            AsyncImage(url: url) { phase in
                if let image = phase.image {
                    styled(image)
                } else {
                    fallback()
                }
            }
        } else {
            fallback()
        }
    }

    private func styled(_ image: Image) -> some View {
        image
            .renderingMode(template ? .template : .original)
            .resizable()
            .scaledToFit()
            .frame(width: width, height: height, alignment: alignment)
            .accessibilityHidden(true)
    }
}

extension UIColor {
    /// 解析 #RGB / #RRGGBB / #RRGGBBAA；失败返回 nil
    convenience init?(cssHex: String) {
        var text = cssHex.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#") { text.removeFirst() }
        if text.count == 3 { text = text.map { "\($0)\($0)" }.joined() }
        guard text.count == 6 || text.count == 8, let value = UInt64(text, radix: 16) else { return nil }
        let hasAlpha = text.count == 8
        let r = CGFloat((value >> (hasAlpha ? 24 : 16)) & 0xff) / 255
        let g = CGFloat((value >> (hasAlpha ? 16 : 8)) & 0xff) / 255
        let b = CGFloat((value >> (hasAlpha ? 8 : 0)) & 0xff) / 255
        let a = hasAlpha ? CGFloat(value & 0xff) / 255 : 1
        self.init(red: r, green: g, blue: b, alpha: a)
    }
}
