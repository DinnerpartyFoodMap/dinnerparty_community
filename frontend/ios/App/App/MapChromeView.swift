import SwiftUI

/// iOS 26 地图浮动按钮组与底部工具栏（系统 Liquid Glass）。
/// - 工具栏是一块整体玻璃（按钮与头像都在里面，内部不再叠加玻璃）；顶部拖动条上滑展开“更多功能”，下滑或点地图收起。
/// - 浮动按钮各自是圆形玻璃；二者放在同一个 GlassEffectContainer 中，出现/收起时由 glassEffectID 管理形变。
/// - 点“搜索”后工具栏形变为输入框：搜索按钮的高亮拉长成输入框底色。
///   输入时右侧头像位置变为关闭搜索按钮；收起键盘后头像回来，左侧分出一个返回圆钮用于退出搜索。
/// - 按压反馈、形变与布局留在原生线程；网页只下发按钮快照并接收动作与输入事件。
/// - 控件位置由始终参与布局的透明占位决定：即使控件尚未显示，网页也能先拿到占用区域完成握手。
/// - 住民菜单、我的收藏是工具栏上方的玻璃面板（MapChromeMenuPanel），与工具栏在同一个 GlassEffectContainer 里、同一种玻璃；
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let coordinateSpaceName = "mapChromeRoot"
    /// 工具栏收起时的高度：拖动条 14 + 按钮行 58
    static let dockHeight: CGFloat = 72
    static let grabberHeight: CGFloat = 14

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

    /// 更多功能当前露出的高度：展开时为内容高度，拖动时跟手，超出范围时带阻尼
    private var drawerRevealed: CGFloat {
        guard model.drawerAvailable, drawerContentHeight > 0 else { return 0 }
        let value = (model.drawerOpen ? drawerContentHeight : 0) + drawerDrag
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
                    if let panel {
                        // 住民菜单 / 我的收藏：真正参与布局，停在工具栏上方（浮动按钮让位）。
                        // 不放在占位的 overlay 里靠 alignmentGuide 上移：那样在真机上没有生效，面板盖住了工具栏
                        MapChromeMenuPanel(model: model, sheet: panel, maxHeight: panelMaxHeight, glassNamespace: glassNamespace)
                    } else if !model.floatingItems.isEmpty {
                        HStack(spacing: 12) {
                            ForEach(model.floatingItems) { item in
                                Color.clear
                                    .frame(width: 50, height: 50)
                                    .onGeometryChange(for: CGRect.self, of: { proxy in
                                        proxy.frame(in: .named(Self.coordinateSpaceName))
                                    }, action: { rect in
                                        model.setFrame(item.id, rect)
                                    })
                                    .overlay {
                                        // 搜索展开时让位给网页搜索结果
                                        if showing && !searching {
                                            floatingButton(item)
                                        }
                                    }
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
                        .overlay(alignment: .bottom) {
                            if showing && !model.toolbarItems.isEmpty {
                                if searching {
                                    searchBar(showBack: !editing, editing: editing)
                                } else {
                                    dock(revealed: revealed)
                                }
                            }
                        }
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        // 占位本身不接收触摸；可见控件由 PassThroughHostView 按区域放行
        .accessibilityHidden(!showing)
        .coordinateSpace(.named(Self.coordinateSpaceName))
        .environment(\.colorScheme, model.theme.dark ? .dark : .light)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
        .animation(animation, value: showing)
        .animation(animation, value: model.items)
        .animation(searchAnimation, value: searching)
        .animation(searchAnimation, value: editing)
        .animation(drawerAnimation, value: model.drawerExpanded)
        .animation(animation, value: panel?.id)
        // 焦点监听放在常驻根视图：输入框随浮层移出层级时失焦也能回传
        .onChange(of: searchFocused) { _, focused in
            model.searchFocusChanged(focused)
        }
        .onChange(of: model.search.focusToken) {
            applyFocusRequest()
        }
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
        .onGeometryChange(for: CGRect.self, of: { proxy in
            proxy.frame(in: .named(Self.coordinateSpaceName))
        }, action: { rect in
            model.setFrame("drawer", rect)
        })
        .highPriorityGesture(drawerGesture, including: model.drawerAvailable ? .all : .subviews)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("地图主要操作"))
    }

    /// 拖动条：上滑展开、下滑收起；点按切换（读屏也可用）
    private var grabber: some View {
        let available = model.drawerAvailable
        return Button {
            withAnimation(drawerAnimation) {
                model.setDrawerExpanded(!model.drawerOpen)
            }
        } label: {
            Capsule()
                .fill(.secondary)
                .frame(width: 36, height: 5)
                .opacity(available ? 0.55 : 0)
                .frame(maxWidth: .infinity)
                .frame(height: Self.grabberHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!available)
        .accessibilityLabel(Text(model.drawerOpen ? "收起更多功能" : "展开更多功能"))
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
                Image(systemName: row.symbol ?? "circle")
                    .font(.system(size: 22, weight: .semibold))
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
            .opacity(row.disabled ? 0.45 : 1)
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
            // 工具栏按钮统一用主文字色（深色模式为白色），选中只靠高亮底与实心图标区分
            .foregroundStyle(.primary)
            .background { toolbarHighlight(item) }
            .opacity(item.disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    @ViewBuilder
    private func toolbarIcon(_ item: MapChromeItem) -> some View {
        let image = Image(systemName: item.symbol)
            .font(.system(size: 21, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
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
            Capsule().fill(Color.primary.opacity(0.12))
        }
    }

    /// 工具栏里的头像：与按钮同在一块玻璃上，不再单独叠加玻璃
    private func dockAvatar(_ item: MapChromeItem) -> some View {
        Button { model.tap(item) } label: {
            avatar(item.avatarURL)
                .frame(width: 42, height: 42)
                .clipShape(Circle())
                .matchedGeometryEffect(id: "accountAvatar", in: morphNamespace)
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
                circleButton(symbol: "chevron.backward", label: "退出搜索", glassID: "searchBack") {
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
        circleButton(symbol: "xmark", label: "收起键盘", glassID: slotID) {
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
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(accent)
                .matchedGeometryEffect(id: "searchIcon", in: morphNamespace)
                .accessibilityHidden(true)
            TextField(text: searchText, prompt: Text(model.search.placeholder)) {
                Text("搜索地点或想吃的美食")
            }
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
                    .accessibilityLabel(Text("正在搜索"))
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
                .accessibilityLabel(Text("清空搜索内容"))
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
                .matchedGeometryEffect(id: "accountAvatar", in: morphNamespace)
                .frame(width: 52, height: 52)
                .contentShape(Circle())
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
        let url = source.flatMap { URL(string: $0) }
        // 默认头像由 Vite 打包在 public/assets，URLSession 无法读取 capacitor://。
        if let url, url.scheme == "capacitor", url.path.hasPrefix("/assets/"),
           !url.pathComponents.contains(".."),
           let root = Bundle.main.resourceURL,
           let image = UIImage(contentsOfFile: root.appendingPathComponent("public" + url.path).path) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            AsyncImage(url: url) { image in
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
                    Image(systemName: item.symbol)
                        .font(.system(size: 20, weight: .semibold))
                }
            }
            .frame(width: 50, height: 50)
            .contentShape(Circle())
            .foregroundStyle(foreground(for: item))
            .opacity(item.disabled ? 0.45 : 1)
        }
        .buttonStyle(.plain)
        .disabled(item.disabled)
        .glassEffect(item.selected ? Glass.regular.tint(accent.opacity(0.35)).interactive() : Glass.regular.interactive(), in: .circle)
        .glassEffectID(item.id, in: glassNamespace)
        .accessibilityLabel(Text(item.title))
        .accessibilityAddTraits(item.selected ? .isSelected : [])
    }

    private func foreground(for item: MapChromeItem) -> Color {
        if item.tone == "danger" { return .red }
        if item.selected || item.tone == "accent" { return accent }
        return .primary
    }
}
