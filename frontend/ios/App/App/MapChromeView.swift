import SwiftUI
import UIKit
import Combine

/// SwiftUI 的 colorScheme 只覆盖内容；Liquid Glass 和系统 sheet 的底色还读取 UIKit traits。
/// 两类地图控件共用这个宿主，在加载视图前绑定地图主题，并在呈现容器创建后、首帧绘制前同步。
@available(iOS 26.0, *)
final class MapChromeHostingController<Content: View>: UIHostingController<Content> {
    private var mapInterfaceStyle: UIUserInterfaceStyle = .light
    private var themeObservation: AnyCancellable?

    init(rootView: Content, model: MapChromeModel) {
        super.init(rootView: rootView)
        // @Published 在赋值前发出事件，使用传入值，不能在这里重新读取 model.theme。
        themeObservation = model.$theme.map(\.dark).removeDuplicates().sink { [weak self] dark in
            self?.mapInterfaceStyle = dark ? .dark : .light
            self?.applyInterfaceStyle()
        }
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        applyInterfaceStyle()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applyInterfaceStyle()
    }

    override func viewWillLayoutSubviews() {
        // pageSheet 容器可能晚于 viewWillAppear 创建，布局时仍要赶在转场的第一帧前设置。
        applyInterfaceStyle()
        super.viewWillLayoutSubviews()
    }

    private func applyInterfaceStyle() {
        if overrideUserInterfaceStyle != mapInterfaceStyle {
            overrideUserInterfaceStyle = mapInterfaceStyle
        }
        if let view = viewIfLoaded, view.overrideUserInterfaceStyle != mapInterfaceStyle {
            view.overrideUserInterfaceStyle = mapInterfaceStyle
        }
        // 玻璃底和全屏底色属于 UIKit 容器。只设置 view/controller 的 override，避免呈现控制器的 traitOverrides。
        if let container = presentationController?.containerView, container.overrideUserInterfaceStyle != mapInterfaceStyle {
            container.overrideUserInterfaceStyle = mapInterfaceStyle
        }
    }
}

/// iOS 26 地图浮动按钮组与底部工具栏（系统 Liquid Glass）。
/// - 工具栏是一块整体玻璃（按钮与头像都在里面，内部不再叠加玻璃）；顶部拖动条上滑展开“更多功能”，下滑或点地图收起。
/// - 浮动按钮共用一块竖向玻璃，打开独立面板时缩小隐去，关闭后恢复。
/// - 点“搜索”后工具栏形变为输入框：搜索按钮的高亮拉长成输入框底色。
///   输入时右侧头像位置变为关闭搜索按钮；收起键盘后头像回来，左侧分出一个返回圆钮用于退出搜索。
/// - 按压反馈、形变与布局留在原生线程；网页只下发按钮快照并接收动作与输入事件。
/// - 控件位置由始终参与布局的透明占位决定：即使控件尚未显示，网页也能先拿到占用区域完成握手。
/// - 住民菜单、我的收藏、随机美食是工具栏上方独立淡入淡出的玻璃面板（MapChromeMenuPanel）；
///   地点卡片仍由 MapChromeSheetPresenter 以 UIKit 系统面板呈现，见 MapChromeSheets.swift。
@available(iOS 26.0, *)
struct MapChromeView: View {
    @ObservedObject var model: MapChromeModel
    @Namespace private var glassNamespace
    @Namespace private var morphNamespace
    @FocusState private var searchFocused: Bool
    /// 已收到聚焦请求、等待输入框插入层级后真正获得焦点（避免展开时先闪出返回圆钮）
    @State private var focusPending = false
    /// 拖动工具栏时手指的竖直位移（向上为正）；松手后随展开/收起动画归零
    @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.42, dampingFraction: 0.86)))
    private var drawerDrag: CGFloat = 0
    /// 更多功能内容的自然高度
    @State private var drawerContentHeight: CGFloat = 0
    /// 工具栏占位的顶边（根坐标系）：菜单面板的高度上限由它决定
    @State private var toolbarTop: CGFloat = 0
    /// 操作指引“更多功能”一步：工具栏自动露出的一截更多功能（示意上滑），与手指示意同一节拍
    @State private var tourPeek: CGFloat = 0
    @State private var tourHintCycle = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let coordinateSpaceName = "mapChromeRoot"
    /// 工具栏收起时的高度：拖动条 14 + 按钮行 58
    static let dockHeight: CGFloat = 72
    static let grabberHeight: CGFloat = 14
    /// 上滑示意露出的高度；指引挖空区域在工具栏上方多留的高度（容纳露出的一截与往上划的手指）
    static let tourPeekHeight: CGFloat = 52
    static let tourHintRise: CGFloat = 72
    /// 操作指引中不是当前目标的控件内容的不透明度
    static let tourDimOpacity: Double = 0.3

    private var accent: Color { Color(uiColor: model.theme.primary) }

    private var animation: Animation {
        reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.38, dampingFraction: 0.86)
    }

    /// 搜索展开/收起比普通出现稍慢，让按钮拉长与玻璃分离看得清
    private var searchAnimation: Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.46, dampingFraction: 0.84)
    }

    private var drawerAnimation: Animation {
        reduceMotion ? .easeOut(duration: 0.15) : .spring(response: 0.42, dampingFraction: 0.86)
    }

    /// 操作指引正在示意上滑展开更多功能
    private var swipeHinting: Bool { model.tour?.swipeHint == true }

    /// 更多功能当前露出的高度：展开时为内容高度，拖动时跟手，超出范围时带阻尼；指引示意时露出一截
    private var drawerRevealed: CGFloat {
        guard model.drawerAvailable, drawerContentHeight > 0 else { return 0 }
        let value = (model.drawerOpen ? drawerContentHeight : 0) + drawerDrag + tourPeek
        if value <= 0 { return 0 }
        if value > drawerContentHeight { return drawerContentHeight + min(40, (value - drawerContentHeight) * 0.2) }
        return value
    }

    var body: some View {
        let showing = model.isShowing
        let searching = model.searchExpanded
        // 输入中：头像位置变为关闭搜索按钮，输入框占满左侧
        let editing = searching && model.accountItem != nil && (searchFocused || focusPending || model.hasPendingFocusRequest)
        let revealed = drawerRevealed
        let panel = showing ? model.presentedPanel : nil
        VStack(spacing: 0) {
            Spacer(minLength: 0)
            // 融合距离小于控件间距：静止时各自独立，返回圆钮从胶囊分离的过程中呈液滴状断开
            GlassEffectContainer(spacing: 8) {
                VStack(alignment: .trailing, spacing: model.floatingGap) {
                    if !model.floatingItems.isEmpty {
                        // v12：列表 / 地图切换、筛选与定位共用一个竖向圆角矩形（只有一个按钮时就是圆形）。
                        // 占位逐个记录位置（地图安全区、操作指引都按按钮算），玻璃画在整组上
                        VStack(spacing: 0) {
                            ForEach(model.floatingItems) { item in
                                Color.clear
                                    .frame(width: 50, height: 50)
                                    .onGeometryChange(for: CGRect.self, of: { proxy in
                                        proxy.frame(in: .named(Self.coordinateSpaceName))
                                    }, action: { rect in
                                        model.setFrame(item.id, rect)
                                    })
                            }
                        }
                        .overlay {
                            // 搜索展开时让位给网页搜索结果
                            if showing && !searching && panel == nil {
                                VStack(spacing: 0) {
                                    ForEach(model.floatingItems) { item in
                                        floatingButton(item)
                                    }
                                }
                                .glassEffect(Glass.regular.interactive(), in: RoundedRectangle(cornerRadius: 25, style: .continuous))
                                // 不参与工具栏或弹窗的玻璃匹配，整组只缩小并淡出。
                                .glassEffectTransition(.identity)
                                .transition(.scale(scale: reduceMotion ? 1 : 0.82, anchor: .bottom).combined(with: .opacity))
                            }
                        }
                        // 上滑更多功能时随抽屉顶边一起上移，始终停在抽屉上方。
                        // 不靠淡出让位：GlassEffectContainer 里的玻璃淡出并不可靠，残留的玻璃会叠在抽屉上。
                        .padding(.bottom, revealed)
                    }
                    // 工具栏占位始终参与布局：App 启动后即知道它的位置，握手不依赖按钮下发后的几何回调。
                    // 更多功能从占位向上展开（溢出占位），不改变占位与网页的底部占用高度。
                    Color.clear
                        .frame(height: Self.dockHeight)
                        .frame(maxWidth: 624)
                        .onGeometryChange(for: CGRect.self, of: { proxy in
                            proxy.frame(in: .named(Self.coordinateSpaceName))
                        }, action: { rect in
                            model.setFrame("toolbar", rect)
                            toolbarTop = rect.minY
                        })
                        .background(alignment: .bottom) {
                            if swipeHinting {
                                // 上滑示意的指引位置取占位（不随露出的一截跳动），向上多留出露出部分与手指的高度
                                Color.clear
                                    .frame(height: Self.dockHeight + Self.tourHintRise)
                                    .onGeometryChange(for: CGRect.self, of: { proxy in
                                        proxy.frame(in: .named(Self.coordinateSpaceName))
                                    }, action: { rect in
                                        model.setFrame("tour", rect)
                                    })
                            }
                        }
                        .overlay(alignment: .bottom) {
                            if showing && !model.toolbarItems.isEmpty {
                                if searching {
                                    searchBar(showBack: !editing, editing: editing)
                                } else {
                                    dock(revealed: revealed)
                                }
                            }
                        }
                        .overlay(alignment: .top) {
                            if showing && swipeHinting && !searching {
                                MapChromeSwipeHint(color: accent, cycle: tourHintCycle, animated: !reduceMotion)
                            }
                        }
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let panel {
                // 独立于工具栏的 GlassEffectContainer，防止系统把浮动按钮匹配为放大的弹窗。
                GlassEffectContainer(spacing: 0) {
                    MapChromeMenuPanel(model: model, sheet: panel, maxHeight: panelMaxHeight)
                }
                .id(panel.id)
                .frame(maxWidth: 624)
                .padding(.bottom, Self.dockHeight + model.floatingGap)
                .transition(.opacity)
                .zIndex(1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        // 占位本身不接收触摸；可见控件由 PassThroughHostView 按区域放行。
        // 操作指引期间读屏只读网页的指引卡片（原生控件仍显示，但不可操作）
        .accessibilityHidden(!showing || model.tour != nil)
        .coordinateSpace(.named(Self.coordinateSpaceName))
        .environment(\.colorScheme, model.theme.dark ? .dark : .light)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .animation(animation, value: showing)
        .animation(animation, value: model.items)
        .animation(searchAnimation, value: searching)
        .animation(searchAnimation, value: editing)
        .animation(drawerAnimation, value: model.drawerExpanded)
        .animation(drawerAnimation, value: model.tour)
        .animation(.easeInOut(duration: reduceMotion ? 0.12 : 0.2), value: panel?.id)
        .task(id: swipeHinting && !reduceMotion) {
            await playSwipeHint()
        }
        // 焦点监听放在常驻根视图：输入框随浮层移出层级时失焦也能回传
        .onChange(of: searchFocused) { _, focused in
            model.searchFocusChanged(focused)
        }
        .onChange(of: model.search.focusToken) {
            applyFocusRequest()
        }
    }

    /// 操作指引“更多功能”一步的上滑示意：手指从拖动条往上划，工具栏随之露出一截更多功能再落回，循环到这一步结束。
    /// 减弱动态效果时不播放（手指静止显示）。
    private func playSwipeHint() async {
        guard swipeHinting, !reduceMotion else {
            if tourPeek != 0 { withAnimation(drawerAnimation) { tourPeek = 0 } }
            return
        }
        // 等网页的说明卡片移到位再开始
        try? await Task.sleep(for: .milliseconds(450))
        while !Task.isCancelled {
            tourHintCycle += 1
            withAnimation(.spring(response: 0.5, dampingFraction: 0.8).delay(0.2)) { tourPeek = Self.tourPeekHeight }
            try? await Task.sleep(for: .milliseconds(1400))
            if Task.isCancelled { break }
            withAnimation(.spring(response: 0.5, dampingFraction: 0.9)) { tourPeek = 0 }
            try? await Task.sleep(for: .milliseconds(1100))
        }
    }

    /// 操作指引进行中、且不是当前目标：内容变暗。只调内容的不透明度，玻璃本身不淡出（原因见浮动按钮的说明）
    private func tourDim(_ isTarget: Bool) -> Double {
        model.tour == nil || isTarget ? 1 : Self.tourDimOpacity
    }

    /// 菜单面板的高度上限：扣掉面板与工具栏的间距、状态栏与灵动岛，最多约占工具栏上方空间的四分之三
    private var panelMaxHeight: CGFloat {
        guard toolbarTop > 0 else { return 420 }
        let available = toolbarTop - model.floatingGap
        return max(220, min(available - 80, available * 0.75))
    }

    // MARK: - 底部工具栏（可上滑展开更多功能）

    private func dock(revealed: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: 32, style: .continuous)
        let open = model.drawerOpen
        return VStack(spacing: 0) {
            grabber
            dockRow
                .frame(height: Self.dockHeight - Self.grabberHeight)
            drawerContent
                .fixedSize(horizontal: false, vertical: true)
                .onGeometryChange(for: CGFloat.self, of: { proxy in
                    proxy.size.height
                }, action: { height in
                    drawerContentHeight = height
                })
                .frame(height: revealed, alignment: .top)
                .clipped()
                .opacity(drawerContentHeight > 0 ? min(1, revealed / max(drawerContentHeight * 0.6, 1)) : 0)
                .allowsHitTesting(open)
                .accessibilityHidden(!open)
        }
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity)
        .glassEffect(revealed > 0 ? Glass.regular : Glass.regular.interactive(), in: shape)
        .glassEffectID("toolbar", in: glassNamespace)
        // 操作指引“更多功能”一步：整条工具栏就是要往上拖的东西，高亮圈随露出的一截一起移动
        .overlay {
            if swipeHinting {
                MapChromeTourRing(shape: shape, color: accent)
            }
        }
        // 皮肤的两端装饰画在玻璃之上（不是玻璃的一部分、不叠底纹），随工具栏上沿移动，不接收触摸
        .overlay(alignment: .topLeading) { ornament(model.skin.ornamentStart, leading: true) }
        .overlay(alignment: .topTrailing) { ornament(model.skin.ornamentEnd, leading: false) }
        .onGeometryChange(for: CGRect.self, of: { proxy in
            proxy.frame(in: .named(Self.coordinateSpaceName))
        }, action: { rect in
            model.setFrame("drawer", rect)
        })
        .highPriorityGesture(drawerGesture, including: model.drawerAvailable ? .all : .subviews)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(model.text("mainActions", "地图主要操作")))
    }

    /// 皮肤装饰：以工具栏左上 / 右上角为原点，x 向内、y 向下；图片贴着装饰框的底边与外侧
    @ViewBuilder
    private func ornament(_ decor: MapChromeSkinDecor?, leading: Bool) -> some View {
        if let decor {
            MapChromeSkinImage(source: decor.image, width: decor.width, height: decor.height,
                               alignment: leading ? .bottomLeading : .bottomTrailing) { EmptyView() }
                .offset(x: leading ? decor.x : -decor.x, y: decor.y)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        }
    }

    /// 拖动条：上滑展开、下滑收起；点按切换（读屏也可用）。操作指引示意上滑时换成主题色并加宽
    private var grabber: some View {
        let available = model.drawerAvailable
        let hinting = swipeHinting
        return Button {
            withAnimation(drawerAnimation) {
                model.setDrawerExpanded(!model.drawerOpen)
            }
        } label: {
            Capsule()
                .fill(hinting ? AnyShapeStyle(accent) : AnyShapeStyle(.secondary))
                .frame(width: hinting ? 48 : 36, height: 5)
                .opacity(available ? (hinting ? 1 : 0.55) : 0)
                .frame(maxWidth: .infinity)
                .frame(height: Self.grabberHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!available)
        .accessibilityLabel(Text(model.drawerOpen ? model.text("collapseDrawer", "收起更多功能") : model.text("expandDrawer", "展开更多功能")))
        .accessibilityHidden(!available)
    }

    private var drawerGesture: some Gesture {
        DragGesture(minimumDistance: 10, coordinateSpace: .global)
            .updating($drawerDrag) { value, state, _ in
                state = -value.translation.height
            }
            .onEnded { value in
                guard drawerContentHeight > 0 else { return }
                // 按松手时的惯性预测落点决定展开或收起
                let projected = (model.drawerOpen ? drawerContentHeight : 0) - value.predictedEndTranslation.height
                withAnimation(drawerAnimation) {
                    model.setDrawerExpanded(projected > drawerContentHeight / 2)
                }
            }
    }

    private var dockRow: some View {
        GeometryReader { proxy in
            let count = model.toolbarItems.count + (model.accountItem == nil ? 0 : 1)
            let width = max(0, proxy.size.width - CGFloat(max(0, count - 1)) * 4) / CGFloat(max(1, count))
            HStack(spacing: 4) {
                ForEach(model.toolbarItems) { item in
                    toolbarButton(item).frame(width: width)
                }
                if let item = model.accountItem {
                    dockAvatar(item).frame(width: width)
                }
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.bottom, 4)
    }

    private var drawerContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(model.drawer?.sections ?? []) { section in
                if section.footnote {
                    footnoteSection(section)
                } else {
                    tileSection(section)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 8)
        .padding(.bottom, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// 主要功能：每行四个圆形图标
    private func tileSection(_ section: MapChromeSheetSection) -> some View {
        let groups = stride(from: 0, to: section.rows.count, by: 4).map { start in
            Array(section.rows[start..<min(start + 4, section.rows.count)])
        }
        return VStack(alignment: .leading, spacing: 12) {
            if let title = section.title {
                Text(title)
                    .font(.title3.weight(.bold))
                    .padding(.horizontal, 4)
                    .opacity(model.tour == nil ? 1 : 0.6)
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                HStack(alignment: .top, spacing: 8) {
                    ForEach(group) { row in
                        drawerTile(row)
                    }
                    ForEach(0..<(4 - group.count), id: \.self) { _ in
                        Color.clear
                            .frame(height: 1)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
        }
    }

    private func drawerTile(_ row: MapChromeSheetRow) -> some View {
        Button {
            withAnimation(drawerAnimation) {
                model.selectDrawerRow(row)
            }
        } label: {
            VStack(spacing: 6) {
                MapChromeSkinImage(source: row.image, template: row.imageTemplate, width: 28, height: 28) {
                    Image(systemName: row.symbol ?? "circle")
                        .font(.system(size: 22, weight: .semibold))
                }
                .foregroundStyle(row.tone == "danger" ? Color.red : accent)
                .frame(width: 56, height: 56)
                .background(Circle().fill(accent.opacity(0.14)))
                Text(row.title)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
            .opacity((row.disabled ? 0.45 : 1) * tourDim(model.isTourTarget(row: row.id)))
            .tourMark(model.isTourTarget(row: row.id), shape: RoundedRectangle(cornerRadius: 18, style: .continuous),
                      color: accent, inset: -3, model: model)
        }
        .buttonStyle(.plain)
        .disabled(row.disabled)
        .accessibilityLabel(Text(row.title))
    }

    /// 备案链接与版本号
    private func footnoteSection(_ section: MapChromeSheetSection) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(section.rows) { row in
                Button {
                    withAnimation(drawerAnimation) {
                        model.selectDrawerRow(row)
                    }
                } label: {
                    Label(row.title, systemImage: row.symbol ?? "link")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(row.disabled)
            }
            if let footer = section.footer {
                Text(footer)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 4)
        .opacity(tourDim(false))
    }

    private func toolbarButton(_ item: MapChromeItem) -> some View {
        Button {
            model.tap(item)
        } label: {
            VStack(spacing: 2) {
                ZStack {
                    if item.busy {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        toolbarIcon(item)
                    }
                }
                .frame(height: 26)
                .overlay(alignment: .topTrailing) {
                    if let badge = item.badge, !badge.isEmpty {
                        Text(badge)
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 4)
                            .background(Capsule().fill(accent))
                            .foregroundStyle(Color(uiColor: model.theme.onPrimary))
                            .offset(x: 10, y: -6)
                    }
                }
                Text(item.title)
                    .font(.caption2.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity, minHeight: 52)
            .contentShape(Rectangle())
            // 工具栏按钮统一用主文字色（深色模式为白色），选中只靠高亮底与实心图标区分；皮肤可指定选中色
            .foregroundStyle(item.selected ? skinSelectedColor : Color.primary)
            .background { toolbarHighlight(item) }
            .opacity((item.disabled ? 0.45 : 1) * tourDim(model.isTourTarget(item: item.id)))
            .tourMark(model.isTourTarget(item: item.id), shape: RoundedRectangle(cornerRadius: 18, style: .continuous),
                      color: accent, inset: -2, model: model)
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    /// 皮肤的选中色（网页已按浅色 / 深色模式取好）；没有时用主文字色
    private var skinSelectedColor: Color {
        model.skin.selectedColor.map { Color(uiColor: $0) } ?? Color.primary
    }

    @ViewBuilder
    private func toolbarIcon(_ item: MapChromeItem) -> some View {
        let image = MapChromeSkinImage(source: item.image, template: item.imageTemplate, width: 24, height: 24) {
            Image(systemName: item.symbol)
                .font(.system(size: 21, weight: .semibold))
                .symbolRenderingMode(.hierarchical)
        }
        if item.id == "search" {
            // 展开时图标滑到输入框左侧
            image.matchedGeometryEffect(id: "searchIcon", in: morphNamespace)
        } else {
            image
        }
    }

    @ViewBuilder
    private func toolbarHighlight(_ item: MapChromeItem) -> some View {
        if item.id == "search" {
            // 展开时这块高亮从按钮处拉长成输入框底色（“按钮变长”）
            Capsule()
                .fill(accent.opacity(item.selected ? 0.16 : 0))
                .matchedGeometryEffect(id: "searchHighlight", in: morphNamespace)
        } else if item.selected {
            if let pedestal = model.skin.pedestal {
                // 皮肤的选中底座：画在图标后面，选中时亮起（图片读不到时退回原来的高亮）
                MapChromeSkinImage(source: pedestal.image, width: pedestal.width, height: pedestal.height) {
                    Capsule().fill(Color.primary.opacity(0.12))
                }
                .offset(y: pedestal.y)
                .transition(.scale(scale: 0.6).combined(with: .opacity))
            } else {
                Capsule().fill(Color.primary.opacity(0.12))
            }
        }
    }

    /// 皮肤头像框：比头像大 scale 倍、居中，画在头像之上，住民自己的头像不变
    @ViewBuilder
    private func avatarFrame(diameter: CGFloat) -> some View {
        if let frame = model.skin.avatarFrame {
            MapChromeSkinImage(source: frame.image, width: diameter * frame.scale, height: diameter * frame.scale) { EmptyView() }
                .allowsHitTesting(false)
        }
    }

    /// 工具栏里的头像：与按钮同在一块玻璃上，不再单独叠加玻璃
    private func dockAvatar(_ item: MapChromeItem) -> some View {
        let targeted = model.isTourTarget(item: item.id)
        // 高亮圈套在皮肤头像框外面
        let ringInset = -(model.skin.avatarFrame.map { 42 * ($0.scale - 1) / 2 } ?? 0) - 4
        return Button { model.tap(item) } label: {
            avatar(item.avatarURL)
                .frame(width: 42, height: 42)
                .clipShape(Circle())
                .overlay { avatarFrame(diameter: 42) }
                .matchedGeometryEffect(id: "accountAvatar", in: morphNamespace)
                .opacity(tourDim(targeted))
                .tourMark(targeted, shape: Circle(), color: accent, inset: ringInset, model: model)
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    // MARK: - 搜索栏（工具栏展开形态）

    /// 未输入时左侧是由工具栏收拢成的返回圆钮、右侧是头像；输入中返回圆钮收起、头像变为关闭按钮
    private func searchBar(showBack: Bool, editing: Bool) -> some View {
        HStack(spacing: 10) {
            if showBack {
                circleButton(symbol: "chevron.backward", label: model.text("exitSearch", "退出搜索"), glassID: "searchBack") {
                    searchFocused = false
                    model.closeSearch()
                }
            }
            searchField
            if let item = model.accountItem {
                if editing {
                    searchCloseButton(slotID: item.id)
                } else {
                    accountButton(item)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// 输入中占用头像位置；与头像共用玻璃 ID，玻璃不动、只替换内容。
    /// 点按收起键盘；还没输入内容时同时退出搜索，回到工具栏。
    private func searchCloseButton(slotID: String) -> some View {
        circleButton(symbol: "xmark", label: model.text("dismissKeyboard", "收起键盘"), glassID: slotID) {
            searchFocused = false
            focusPending = false
            if model.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                model.closeSearch()
            }
        }
    }

    private func circleButton(symbol: String, label: String, glassID: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .semibold))
                .frame(width: 52, height: 52)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(.primary)
        .glassEffect(Glass.regular.interactive(), in: .circle)
        .glassEffectID(glassID, in: glassNamespace)
        .accessibilityLabel(Text(label))
    }

    private var searchField: some View {
        let searchItem = model.toolbarItems.first { $0.id == "search" }
        return HStack(spacing: 8) {
            // 与工具栏“搜索”按钮同一个图标（皮肤图片或 SF Symbol），展开时原样滑过来
            MapChromeSkinImage(source: searchItem?.image, template: searchItem?.imageTemplate ?? false, width: 20, height: 20) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 17, weight: .semibold))
            }
            .foregroundStyle(accent)
            .matchedGeometryEffect(id: "searchIcon", in: morphNamespace)
            .accessibilityHidden(true)
            TextField(text: searchText, prompt: Text(model.search.placeholder)) {
                Text(model.search.placeholder)
            }
            .accessibilityHint(Text(model.search.hint))
            .focused($searchFocused)
            .submitLabel(.search)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.body)
            .tint(accent)
            .frame(maxWidth: .infinity)
            .onSubmit {
                searchFocused = false
                model.submitSearch()
            }
            if model.search.busy {
                ProgressView()
                    .controlSize(.small)
                    .frame(width: 36, height: 36)
                    .accessibilityLabel(Text(model.search.busyLabel))
            } else if !model.searchText.isEmpty {
                Button {
                    model.updateSearchText("")
                    searchFocused = true
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 17))
                        .foregroundStyle(.secondary)
                        .frame(width: 36, height: 36)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(model.text("clearSearch", "清空搜索内容")))
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .frame(maxWidth: .infinity)
        .frame(height: 52)
        .background {
            Capsule()
                .fill(accent.opacity(searchFocused ? 0.12 : 0.06))
                .matchedGeometryEffect(id: "searchHighlight", in: morphNamespace)
        }
        .glassEffect(Glass.regular.interactive(), in: .capsule)
        .glassEffectID("toolbar", in: glassNamespace)
        .animation(.easeOut(duration: 0.15), value: model.searchText.isEmpty)
        .animation(.easeOut(duration: 0.15), value: model.search.busy)
        .onAppear { applyFocusRequest() }
    }

    private var searchText: Binding<String> {
        Binding(get: { model.searchText }, set: { model.updateSearchText($0) })
    }

    /// 执行网页的焦点请求（每个 token 一次）。输入框可能刚插入层级，推迟一拍再设置焦点，否则可能被忽略。
    private func applyFocusRequest() {
        let request = model.search
        guard model.isShowing, model.searchExpanded, request.focusToken != model.appliedFocusToken else { return }
        model.appliedFocusToken = request.focusToken
        let focus = request.focus
        focusPending = focus
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(50))
            searchFocused = focus
            focusPending = false
        }
    }

    // MARK: - 浮动按钮

    /// 搜索时独立的头像圆钮（工具栏形变为输入框后从中分离出来）
    private func accountButton(_ item: MapChromeItem) -> some View {
        Button { model.tap(item) } label: {
            avatar(item.avatarURL)
                .frame(width: 42, height: 42)
                .clipShape(Circle())
                .overlay { avatarFrame(diameter: 42) }
                .matchedGeometryEffect(id: "accountAvatar", in: morphNamespace)
                .frame(width: 52, height: 52)
                .contentShape(Circle())
                // v12：有被驳回的地点时右上角小红点
                .overlay(alignment: .topTrailing) {
                    if let badge = item.badge, !badge.isEmpty {
                        MapChromeBadgeDot()
                            .offset(x: -3, y: 3)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .glassEffect(Glass.regular.interactive(), in: .circle)
        .glassEffectID(item.id, in: glassNamespace)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    @ViewBuilder
    private func avatar(_ source: String?) -> some View {
        // 默认头像（含皮肤的默认头像）在 App 包里或是 base64，同步读取；住民上传的头像走网络
        if let source, let image = MapChromeSkinImages.local(source) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            AsyncImage(url: source.flatMap { URL(string: $0) }) { image in
                image.resizable().scaledToFill()
            } placeholder: {
                Image(systemName: "person.crop.circle.fill")
                    .resizable().scaledToFit()
                    .foregroundStyle(accent)
            }
        }
    }

    private func floatingButton(_ item: MapChromeItem) -> some View {
        Button {
            model.tap(item)
        } label: {
            ZStack {
                if item.busy {
                    ProgressView()
                } else {
                    MapChromeSkinImage(source: item.image, template: item.imageTemplate, width: 24, height: 24) {
                        Image(systemName: item.symbol)
                            .font(.system(size: 20, weight: .semibold))
                    }
                }
            }
            .frame(width: 50, height: 50)
            // 共用的圆角矩形里，选中（筛选生效中）用一圈主题色底区分
            .background {
                if item.selected {
                    Circle().fill(accent.opacity(0.22)).padding(4)
                }
            }
            .contentShape(Circle())
            .foregroundStyle(foreground(for: item))
            .opacity((item.disabled ? 0.45 : 1) * tourDim(model.isTourTarget(item: item.id)))
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .tourMark(model.isTourTarget(item: item.id), shape: Circle(), color: accent, model: model)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    private func foreground(for item: MapChromeItem) -> Color {
        if item.tone == "danger" { return .red }
        if item.selected || item.tone == "accent" { return accent }
        return .primary
    }
}

// MARK: - 操作指引（v10）

@available(iOS 26.0, *)
private extension View {
    /// 操作指引当前要指出的控件：画高亮圈，并把它在根坐标系中的位置记为 frames["tour"]（随布局回传，网页据此挖空遮罩、摆放说明卡片）。
    /// 背景与叠层始终存在、只切换内容，控件本身的视图身份不变（玻璃形变、按压状态不受影响）。
    func tourMark<S: InsettableShape>(_ marked: Bool, shape: S, color: Color, inset: CGFloat = -4, model: MapChromeModel) -> some View {
        self
            .background {
                if marked {
                    Color.clear.onGeometryChange(for: CGRect.self, of: { proxy in
                        proxy.frame(in: .named(MapChromeView.coordinateSpaceName))
                    }, action: { rect in
                        model.setFrame("tour", rect)
                    })
                }
            }
            .overlay {
                if marked {
                    MapChromeTourRing(shape: shape, color: color, inset: inset)
                }
            }
    }
}

/// 操作指引的高亮圈：主题色描边加外晕，缓慢呼吸（减弱动态效果时静止），与网页指引的高亮框同一种样式。
/// 画在原生控件上：网页的遮罩在 WebView 里，盖不到原生控件，只能挖空它们下方的地图。
@available(iOS 26.0, *)
struct MapChromeTourRing<S: InsettableShape>: View {
    let shape: S
    let color: Color
    var inset: CGFloat = -4
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let ring = shape
            .strokeBorder(color, lineWidth: 2.5)
            .shadow(color: color.opacity(0.6), radius: 5)
            .padding(inset)
        Group {
            if reduceMotion {
                ring
            } else {
                ring.phaseAnimator([false, true]) { content, expanded in
                    content
                        .scaleEffect(expanded ? 1.05 : 1)
                        .opacity(expanded ? 0.65 : 1)
                } animation: { _ in
                    .easeInOut(duration: 0.8)
                }
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// 操作指引“更多功能”一步：手指从拖动条往上划的示意。cycle 每变一次播放一轮（与工具栏露出一截同一节拍）；
/// 每轮从透明开始、以透明结束，两轮之间不会看到手指往回移。不播放动画时静止停在拖动条上。
@available(iOS 26.0, *)
struct MapChromeSwipeHint: View {
    let color: Color
    let cycle: Int
    let animated: Bool

    private struct Pose {
        var y: CGFloat = 6
        var opacity: Double = 0
    }

    var body: some View {
        let hand = Image(systemName: "hand.point.up.left.fill")
            .font(.system(size: 34))
            .foregroundStyle(color)
            .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
            // 指尖在图标左上角：往右挪一点，让指尖落在拖动条中间
            .offset(x: 10)
        Group {
            if animated {
                hand.keyframeAnimator(initialValue: Pose(), trigger: cycle) { content, pose in
                    content
                        .offset(y: pose.y)
                        .opacity(pose.opacity)
                } keyframes: { _ in
                    KeyframeTrack(\.y) {
                        MoveKeyframe(6)
                        LinearKeyframe(6, duration: 0.2)
                        CubicKeyframe(-52, duration: 0.7)
                        LinearKeyframe(-52, duration: 0.4)
                    }
                    KeyframeTrack(\.opacity) {
                        MoveKeyframe(0)
                        LinearKeyframe(1, duration: 0.2)
                        LinearKeyframe(1, duration: 0.7)
                        LinearKeyframe(0, duration: 0.4)
                    }
                }
            } else {
                hand.offset(y: 6)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// v12：小红点（头像、面板行）
struct MapChromeBadgeDot: View {
    var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: 10, height: 10)
            .overlay(Circle().stroke(Color.white, lineWidth: 1.5))
            .accessibilityHidden(true)
    }
}
