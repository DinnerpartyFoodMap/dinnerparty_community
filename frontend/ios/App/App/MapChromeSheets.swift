import UIKit
import SwiftUI

/// 地点卡片的 UIKit 呈现（代替 SwiftUI .sheet）。住民菜单、我的收藏不走这里，
/// 而是由 MapChromeView 在工具栏同一层画成玻璃面板（MapChromeMenuPanel），与工具栏同一种 Liquid Glass。
/// SwiftUI 的 .sheet 不知道宿主已经呈现了别的界面：例如分享时插件先弹出系统分享面板，
/// 随后网页的分享浮层关闭、地点卡片恢复，.sheet 会把分享面板顶掉，自己又因宿主“正在呈现”而弹出失败，
/// 状态卡在“已呈现”，之后点其他地点也不再出现卡片。这里自己持有面板控制器，按期望状态对账：
/// - 宿主正在呈现其他界面（系统分享、相册、网页弹出的选择器……）时不弹出，每 0.3 秒检查一次，空闲后再弹出；
/// - 自己的面板上方还叠着其他界面（大图预览）时不收起，否则会连带关闭它；
/// - 同一面板（id 不变）只原地刷新内容与停靠高度。
@available(iOS 26.0, *)
final class MapChromeSheetPresenter: NSObject {
    static let compactDetent = UISheetPresentationController.Detent.Identifier("foodmap.compact")
    /// 地点卡片第一段占最大停靠高度的比例：停靠高度不含状态栏与底部安全区，0.36 约等于整屏的三分之一
    static let compactFraction: CGFloat = 0.36

    private weak var host: UIViewController?
    private let model: MapChromeModel
    private var controller: UIViewController?
    /// 正在显示的面板（id 为 sheetId#token）
    private var presented: MapChromeSheet?
    /// 弹出 / 收起动画进行中的序号（0 表示空闲）：系统不允许两个转场同时进行
    private var transition = 0
    private var transitionSeq = 0
    private var updateScheduled = false
    private var retryScheduled = false

    init(host: UIViewController, model: MapChromeModel) {
        self.host = host
        self.model = model
        super.init()
    }

    /// 合并同一轮的多次状态变化，下一轮主循环再对账
    func setNeedsUpdate() {
        guard !updateScheduled else { return }
        updateScheduled = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            self.reconcile()
        }
    }

    /// 停靠高度依赖的内容变化（卡片摘要高度、菜单行数）：重新计算，不改变当前停靠段
    func invalidateDetents() {
        guard let sheet = shownController?.sheetPresentationController else { return }
        sheet.animateChanges { sheet.invalidateDetents() }
    }

    /// 卡片的“详情”按钮：在摘要与全屏详情之间切换
    func toggleCardExpanded() {
        guard presented?.isCard == true, let sheet = shownController?.sheetPresentationController else { return }
        let expand = sheet.selectedDetentIdentifier != .large
        sheet.animateChanges {
            sheet.selectedDetentIdentifier = expand ? .large : Self.compactDetent
        }
        // 代码修改停靠段不会回调代理
        model.cardExpanded = expand
    }

    private var shownController: UIViewController? {
        guard let controller, controller.presentingViewController != nil else { return nil }
        return controller
    }

    private func reconcile() {
        guard transition == 0, let host else { return }
        if controller != nil, shownController == nil {
            // 已经不在屏幕上（下滑由代理处理，这里兜底其他途径）
            clearPresented()
        }
        let desired = model.presentedCard
        if let controller = shownController, let presented {
            if let desired, desired.id == presented.id, desired.style == presented.style {
                // 同一面板原地更新：内容由 SwiftUI 观察模型刷新，这里只更新停靠高度
                if desired != presented {
                    self.presented = desired
                    invalidateDetents()
                }
                return
            }
            if controller.presentedViewController != nil {
                retryLater()
                return
            }
            let id = beginTransition()
            controller.dismiss(animated: true) { [weak self] in
                guard let self else { return }
                self.endTransition(id)
                if self.controller === controller { self.clearPresented() }
                self.setNeedsUpdate()
            }
            return
        }
        guard let desired else { return }
        if host.presentedViewController != nil || host.view.window == nil || host.transitionCoordinator != nil {
            retryLater()
            return
        }
        present(desired, from: host)
    }

    private func present(_ sheet: MapChromeSheet, from host: UIViewController) {
        let root = MapChromeSheetRoot(model: model, initial: sheet, onToggleCard: { [weak self] in
            self?.toggleCardExpanded()
        })
        let controller = MapChromeHostingController(rootView: root, model: model)
        // 背景交给系统：iOS 26 的面板是 Liquid Glass，视图不铺底色
        controller.view.backgroundColor = .clear
        controller.modalPresentationStyle = .pageSheet
        if let sheetController = controller.sheetPresentationController {
            configure(sheetController)
            sheetController.delegate = self
        }
        self.controller = controller
        presented = sheet
        model.cardExpanded = false
        let id = beginTransition()
        host.present(controller, animated: true) { [weak self] in
            self?.endTransition(id)
            self?.setNeedsUpdate()
        }
    }

    private func configure(_ sheet: UISheetPresentationController) {
        let model = self.model
        // 第一段约占屏幕三分之一：标题与操作按钮下面再露出一段简介（摘要本身更高时以摘要为准）；上滑到全屏显示完整详情
        let compact = UISheetPresentationController.Detent.custom(identifier: Self.compactDetent) { context in
            min(max(model.cardSummaryHeight, context.maximumDetentValue * MapChromeSheetPresenter.compactFraction), context.maximumDetentValue)
        }
        sheet.detents = [compact, .large()]
        sheet.selectedDetentIdentifier = Self.compactDetent
        // 第一段不压暗：地图仍可拖动、点选其他地点；全屏详情为模态
        sheet.largestUndimmedDetentIdentifier = Self.compactDetent
        sheet.prefersGrabberVisible = true
        sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        sheet.prefersEdgeAttachedInCompactHeight = true
    }

    private func beginTransition() -> Int {
        transitionSeq += 1
        let id = transitionSeq
        transition = id
        // 呈现失败时系统不会调用完成回调：超时后按实际状态继续对账，避免永远卡在“转场中”
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            guard let self, self.transition == id else { return }
            self.endTransition(id)
            self.setNeedsUpdate()
        }
        return id
    }

    private func endTransition(_ id: Int) {
        if transition == id { transition = 0 }
    }

    private func retryLater() {
        guard !retryScheduled else { return }
        retryScheduled = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self else { return }
            self.retryScheduled = false
            self.reconcile()
        }
    }

    private func clearPresented() {
        controller = nil
        presented = nil
        model.cardExpanded = false
    }
}

@available(iOS 26.0, *)
extension MapChromeSheetPresenter: UISheetPresentationControllerDelegate {
    /// 用户下滑或点遮罩关闭：通知网页（同一 token 不会再弹出）
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        guard presentationController.presentedViewController === controller else { return }
        clearPresented()
        model.dismissSheet()
        setNeedsUpdate()
    }

    func sheetPresentationControllerDidChangeSelectedDetentIdentifier(_ sheetPresentationController: UISheetPresentationController) {
        model.cardExpanded = sheetPresentationController.selectedDetentIdentifier == .large
    }
}

/// 面板内容入口。只显示创建时那一个面板：换成别的面板时，正在收起的旧面板保留最后一次内容，不闪成新面板。
@available(iOS 26.0, *)
struct MapChromeSheetRoot: View {
    @ObservedObject var model: MapChromeModel
    let initial: MapChromeSheet
    let onToggleCard: () -> Void

    var body: some View {
        let live = model.sheetContent.flatMap { $0.id == initial.id ? $0 : nil }
        let sheet = live ?? initial
        MapChromePlaceCard(model: model, sheet: sheet, onToggleExpand: onToggleCard)
        .tint(Color(uiColor: model.theme.primary))
        .environment(\.colorScheme, model.theme.dark ? .dark : .light)
        .dynamicTypeSize(...DynamicTypeSize.xxLarge)
    }
}

/// 住民菜单 / 我的收藏：在工具栏同一层（同一个 GlassEffectContainer）里画的玻璃面板，浮在工具栏上方。
/// 不再用 UIKit 系统面板：iOS 26 半屏面板的系统玻璃比工具栏的 Glass.regular 更厚、更亮，两者看起来不一致。
/// 交互与系统面板一致：右上角关闭、拖住顶部下滑关闭、点地图关闭（PassThroughHostView）；内容超出可用高度时滚动。
@available(iOS 26.0, *)
struct MapChromeMenuPanel: View {
    @ObservedObject var model: MapChromeModel
    let sheet: MapChromeSheet
    /// 面板可用的最大高度（工具栏上方的空间）
    let maxHeight: CGFloat
    /// 与工具栏同一个玻璃命名空间：出现 / 收起时由 GlassEffectContainer 形变
    let glassNamespace: Namespace.ID

    @State private var contentHeight: CGFloat = 0
    /// 拖住顶部下滑的位移；松手未达到关闭距离时回弹
    @GestureState(resetTransaction: Transaction(animation: .spring(response: 0.36, dampingFraction: 0.86)))
    private var dragOffset: CGFloat = 0

    static let cornerRadius: CGFloat = 32
    static let grabberHeight: CGFloat = 14

    private var accent: Color { Color(uiColor: model.theme.primary) }
    /// 玻璃上的分组底色（与地点卡片一致）
    private var groupFill: Color { Color(uiColor: .tertiarySystemFill) }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .continuous)
        let bodyLimit = max(120, maxHeight - Self.grabberHeight - 64)
        let scrolls = contentHeight > bodyLimit
        VStack(spacing: 0) {
            // 拖动条 + 标题行：拖住下滑关闭
            VStack(spacing: 0) {
                Capsule()
                    .fill(.secondary)
                    .frame(width: 36, height: 5)
                    .opacity(0.55)
                    .frame(maxWidth: .infinity)
                    .frame(height: Self.grabberHeight)
                header
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
            }
            .contentShape(Rectangle())
            .gesture(dismissGesture)
            ScrollView {
                content
                    .onGeometryChange(for: CGFloat.self, of: { proxy in
                        proxy.size.height
                    }, action: { height in
                        contentHeight = height
                    })
            }
            .scrollDisabled(!scrolls)
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(contentHeight, bodyLimit))
        }
        .frame(maxWidth: .infinity)
        .glassEffect(Glass.regular, in: shape)
        .glassEffectID("panel", in: glassNamespace)
        .offset(y: dragOffset)
        .onGeometryChange(for: CGRect.self, of: { proxy in
            proxy.frame(in: .named(MapChromeView.coordinateSpaceName))
        }, action: { rect in
            model.setFrame("panel", rect)
        })
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape) { model.dismissSheet() }
    }

    private var dismissGesture: some Gesture {
        DragGesture(minimumDistance: 6, coordinateSpace: .global)
            .updating($dragOffset) { value, state, _ in
                // 只跟随向下拖；向上拖带阻尼
                let y = value.translation.height
                state = y >= 0 ? y : y * 0.15
            }
            .onEnded { value in
                if value.translation.height > 80 || value.predictedEndTranslation.height > 220 {
                    model.dismissSheet()
                }
            }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            // 与右侧关闭钮等宽的占位，标题保持居中
            Color.clear.frame(width: 44, height: 44)
            VStack(spacing: 2) {
                Text(sheet.title)
                    .font(.title3.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                if let subtitle = sheet.subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
            Button {
                model.dismissSheet()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    // 与工具栏一致：面板是一整块玻璃，内部按钮不再叠加玻璃
                    .background(Circle().fill(Color.primary.opacity(0.1)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text(model.text("close", "关闭")))
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let message = sheet.message {
                messageView(message)
            }
            ForEach(sheet.sections) { section in
                sectionView(section)
            }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 14)
    }

    private func messageView(_ message: String) -> some View {
        HStack(spacing: 10) {
            if sheet.messageTone == "loading" {
                ProgressView()
            }
            Text(message)
                .foregroundStyle(sheet.messageTone == "danger" ? Color.red : Color.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, minHeight: 44)
    }

    private func sectionView(_ section: MapChromeSheetSection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = section.title {
                Text(title)
                    .font(.headline)
                    .padding(.horizontal, 4)
                    .accessibilityAddTraits(.isHeader)
            }
            if !section.rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 {
                            // 分隔线从文字处开始：行内边距 16 + 图标宽度 + 间距 12
                            Divider().padding(.leading, section.footnote ? 48 : 56)
                        }
                        rowButton(row, footnote: section.footnote)
                    }
                }
                .background(groupFill)
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            if let footer = section.footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }
        }
    }

    private func rowButton(_ row: MapChromeSheetRow, footnote: Bool) -> some View {
        Button {
            model.selectSheetRow(row)
        } label: {
            HStack(spacing: 12) {
                if let symbol = row.symbol {
                    Image(systemName: symbol)
                        .font(footnote ? Font.footnote : Font.body.weight(.semibold))
                        .foregroundStyle(row.tone == "danger" ? Color.red : (footnote ? Color.secondary : accent))
                        .frame(width: footnote ? 20 : 28)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .font(footnote ? Font.footnote : Font.body)
                        .foregroundStyle(titleStyle(row, footnote: footnote))
                        .lineLimit(2)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(row.tone == "warning" ? Color.orange : Color.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .frame(minHeight: footnote ? 44 : 52)
            .contentShape(Rectangle())
        }
        .buttonStyle(MapChromeRowButtonStyle())
        .disabled(row.disabled)
        .opacity(row.disabled ? 0.55 : 1)
        .accessibilityLabel(Text(row.subtitle.map { "\(row.title), \($0)" } ?? row.title))
    }

    private func titleStyle(_ row: MapChromeSheetRow, footnote: Bool) -> Color {
        if row.tone == "danger" { return .red }
        if row.tone == "muted" || footnote { return .secondary }
        return .primary
    }
}

/// 分组行的按压高亮（代替 List 的行高亮）
private struct MapChromeRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(Color.primary.opacity(configuration.isPressed ? 0.1 : 0))
    }
}

/// 地点卡片：两段停靠。第一段约占屏幕三分之一：摘要——左上角分享、居中标题、右上角关闭，下面一排等宽操作按钮（导航、收藏……），
/// 再露出简介的开头；上滑（或点“详情”）到全屏后继续显示完整简介、地址、相关日记与图片。
/// 展会面板用同一张卡片：左上角是展会图标（image），正文按 paragraphs 分段（展会简介、展会信息，行内 Markdown），
/// 地址行显示展会地点；展会名放不下时来回滚动。
@available(iOS 26.0, *)
struct MapChromePlaceCard: View {
    @ObservedObject var model: MapChromeModel
    let sheet: MapChromeSheet
    let onToggleExpand: () -> Void
    @State private var preview: MapChromeImagePreviewItem?

    /// 摘要上方留给系统拖动条的距离
    static let topInset: CGFloat = 20
    /// 摘要与第一段底边的距离
    static let summaryGap: CGFloat = 16

    private var accent: Color { Color(uiColor: model.theme.primary) }
    /// 玻璃面板上的分组底色
    private var groupFill: Color { Color(uiColor: .tertiarySystemFill) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                summary
                    .onGeometryChange(for: CGFloat.self, of: { proxy in
                        proxy.size.height
                    }, action: { height in
                        model.setCardSummaryHeight(Self.topInset + height + Self.summaryGap)
                    })
                details
            }
            .padding(.horizontal, 16)
            .padding(.top, Self.topInset)
            .padding(.bottom, 28)
        }
        // 第一段不滚动：上滑手势交给面板本身，展开到全屏详情
        .scrollDisabled(!model.cardExpanded)
        .scrollBounceBehavior(.basedOnSize)
        .fullScreenCover(item: $preview) { item in
            MapChromeImagePreview(item: item, closeLabel: model.text("closePreview", "关闭大图"))
        }
    }

    // MARK: 摘要

    private var summary: some View {
        VStack(spacing: 16) {
            header
            if let time = sheet.exhibitionTime {
                Label(time.text, systemImage: "calendar")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityLabel(Text([time.title, time.text].compactMap { $0 }.joined(separator: "：")))
            }
            if !sheet.actions.isEmpty {
                HStack(spacing: 10) {
                    ForEach(sheet.actions) { action in
                        actionButton(action)
                    }
                }
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            if let leading = sheet.leading {
                circleButton(
                    symbol: leading.symbol ?? "square.and.arrow.up",
                    image: leading.image,
                    template: leading.imageTemplate,
                    label: leading.title,
                    tint: leading.tone == "accent" ? accent : Color.primary,
                    disabled: leading.disabled
                ) {
                    model.selectSheetRow(leading)
                }
            } else if let image = sheet.image {
                headerImage(image)
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
            headerTitle
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
            circleButton(symbol: "xmark", image: sheet.closeImage, template: sheet.closeImageTemplate,
                         label: model.text("close", "关闭"), tint: Color.primary, disabled: false) {
                model.dismissSheet()
            }
        }
    }

    @ViewBuilder
    private var titleText: some View {
        if sheet.scrollsTitle {
            MapChromeMarqueeText(text: sheet.title, font: .title2.weight(.bold))
        } else {
            Text(sheet.title)
                .font(.title2.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }

    /// 标题与副标题。副标题可点（v9 subtitleAction，展会地点）时是主题色按钮，标题与按钮分开朗读；否则合并为一个标题
    @ViewBuilder
    private var headerTitle: some View {
        if let subtitle = sheet.subtitle, let action = sheet.subtitleAction {
            VStack(spacing: 2) {
                titleText
                    .accessibilityAddTraits(.isHeader)
                linkButton(subtitle, action: action)
            }
        } else {
            VStack(spacing: 2) {
                titleText
                if let subtitle = sheet.subtitle {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        }
    }

    /// 可点的地点文字（副标题、地址行）：主题色，点按按行处理（默认收起面板）并回传行 id
    private func linkButton(_ text: String, action: MapChromeSheetRow, lineLimit: Int? = 1) -> some View {
        Button {
            model.selectSheetRow(action)
        } label: {
            Label(text, systemImage: action.symbol ?? "mappin.and.ellipse")
                .font(.subheadline)
                .foregroundStyle(accent)
                .lineLimit(lineLimit)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(action.disabled)
        .accessibilityLabel(Text(action.title))
    }

    /// 标题左侧的图标（展会图标）：与右侧关闭钮同宽，标题保持居中；加载失败时显示占位符号
    private func headerImage(_ url: URL) -> some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image.resizable().scaledToFit()
            case .failure:
                Image(systemName: "building.columns")
                    .font(.system(size: 19, weight: .semibold))
                    .foregroundStyle(accent)
            default:
                ProgressView()
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityHidden(true)
    }

    /// 圆形玻璃按钮；image 为皮肤图标（v8），读不到时仍显示 symbol
    private func circleButton(symbol: String, image: String? = nil, template: Bool = false, label: String, tint: Color, disabled: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            MapChromeSkinImage(source: image, template: template, width: 22, height: 22) {
                Image(systemName: symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .contentTransition(.symbolEffect(.replace))
            }
            .foregroundStyle(tint)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(Glass.regular.interactive(), in: .circle)
        .disabled(disabled)
        .opacity(disabled ? 0.5 : 1)
        .accessibilityLabel(Text(label))
    }

    /// 等宽等高的操作按钮；主操作（导航）实心填充，收藏以实心 / 空心心形区分
    private func actionButton(_ row: MapChromeSheetRow) -> some View {
        let prominent = row.tone == "accent"
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        return Button {
            if row.expands {
                onToggleExpand()
            } else {
                model.selectSheetRow(row)
            }
        } label: {
            VStack(spacing: 5) {
                // 皮肤图标：单色（template）时与按钮文字同色，原色图标按原样显示
                MapChromeSkinImage(source: row.image, template: row.imageTemplate, width: 24, height: 24) {
                    Image(systemName: row.symbol ?? "circle")
                        .font(.system(size: 19, weight: .semibold))
                        .contentTransition(.symbolEffect(.replace))
                }
                .frame(height: 24)
                Text(row.title)
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 64)
            .foregroundStyle(prominent ? Color(uiColor: model.theme.onPrimary) : accent)
            .background(prominent ? accent : accent.opacity(0.14), in: shape)
            .contentShape(shape)
        }
        .buttonStyle(.plain)
        .disabled(row.disabled)
        .opacity(row.disabled ? 0.45 : 1)
        .accessibilityLabel(Text(row.title))
    }

    // MARK: 详情（全屏）

    /// 按行内 Markdown 显示（粗体、斜体、删除线、代码、链接），解析失败或旧网页没有下发时显示纯文本
    private static func inlineMarkdown(_ markdown: String?, fallback: String) -> AttributedString {
        if let markdown,
           let parsed = try? AttributedString(markdown: markdown, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
            return parsed
        }
        return AttributedString(fallback)
    }

    private var detailText: AttributedString {
        Self.inlineMarkdown(sheet.detailMarkdown, fallback: sheet.detail ?? model.text("noDescription", "暂无描述"))
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 24) {
            if sheet.paragraphs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(model.text("intro", "简介"))
                        .font(.headline)
                    Text(detailText)
                        .font(.body)
                        .foregroundStyle(sheet.detail == nil ? Color.secondary : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let caption = sheet.caption {
                        captionLabel(caption)
                            .padding(.top, 4)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(groupFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            } else {
                // 展会时间已在摘要显示；详情从地点开始，随后逐段显示简介与信息。
                if let caption = sheet.caption {
                    captionLabel(caption)
                        .padding(.horizontal, 4)
                }
                ForEach(sheet.paragraphs.filter { $0.id != sheet.exhibitionTime?.id }) { paragraph in
                    VStack(alignment: .leading, spacing: 8) {
                        if let title = paragraph.title {
                            Text(title)
                                .font(.headline)
                                .accessibilityAddTraits(.isHeader)
                        }
                        Text(Self.inlineMarkdown(paragraph.markdown, fallback: paragraph.text))
                            .font(.body)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(groupFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }

            ForEach(sheet.sections) { section in
                sectionView(section)
            }

            ForEach(sheet.gallery) { group in
                galleryView(group)
            }
        }
    }

    private func sectionView(_ section: MapChromeSheetSection) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title = section.title {
                Text(title)
                    .font(.headline)
            }
            if !section.rows.isEmpty {
                VStack(spacing: 0) {
                    ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                        if index > 0 {
                            Divider().padding(.leading, 52)
                        }
                        detailRow(row)
                    }
                }
                .background(groupFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            if let footer = section.footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }
        }
    }

    /// 地址行；可点（v9 captionAction，展会地点）时是主题色按钮
    @ViewBuilder
    private func captionLabel(_ caption: String) -> some View {
        if let action = sheet.captionAction {
            linkButton(caption, action: action, lineLimit: nil)
                .multilineTextAlignment(.leading)
        } else {
            Label(caption, systemImage: "mappin.and.ellipse")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private func detailRow(_ row: MapChromeSheetRow) -> some View {
        Button {
            model.selectSheetRow(row)
        } label: {
            HStack(spacing: 12) {
                // 评价一行：皮肤的评价表情（原色）代替 SF Symbol
                MapChromeSkinImage(source: row.image, template: row.imageTemplate, width: 24, height: 24) {
                    Image(systemName: row.symbol ?? "circle")
                        .font(.body.weight(.semibold))
                }
                .foregroundStyle(accent)
                .frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.title)
                        .foregroundStyle(.primary)
                    if let subtitle = row.subtitle {
                        Text(subtitle)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(row.disabled)
        .accessibilityLabel(Text(row.title))
    }

    private func galleryView(_ group: MapChromeSheetGallery) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let title = group.title {
                Text(title)
                    .font(.headline)
            }
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(Array(group.images.enumerated()), id: \.offset) { index, url in
                        Button {
                            preview = MapChromeImagePreviewItem(images: group.images, index: index)
                        } label: {
                            AsyncImage(url: index < group.thumbnails.count ? group.thumbnails[index] : url) { phase in
                                switch phase {
                                case .success(let image):
                                    image.resizable().scaledToFill()
                                case .failure:
                                    Image(systemName: "photo")
                                        .font(.title2)
                                        .foregroundStyle(.secondary)
                                default:
                                    ProgressView()
                                }
                            }
                            .frame(width: 148, height: 148)
                            .background(groupFill)
                            .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(Text(model.text("imageNumber", "{title} 第 {index} 张")
                            .replacingOccurrences(of: "{title}", with: group.title ?? model.text("image", "图片"))
                            .replacingOccurrences(of: "{index}", with: String(index + 1))))
                    }
                }
            }
            .scrollIndicators(.hidden)
        }
    }
}

/// 单行标题（展会名）：放得下时与普通标题一样居中；放不下时来回滚动，两端各停一会儿（速度与网页 MarqueeText 相同）。
/// 减弱动态效果时不自动滚动，改为可以手动横向滑动。读屏朗读完整标题。
@available(iOS 26.0, *)
struct MapChromeMarqueeText: View {
    let text: String
    let font: Font
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var boxWidth: CGFloat = 0
    @State private var textWidth: CGFloat = 0

    /// 滚动速度（pt/s）、单程最短时间与两端停留时间（秒）
    private static let speed: CGFloat = 32
    private static let minTravel: Double = 2
    private static let pause: Double = 1.2

    var body: some View {
        let overflow = max(0, (textWidth - boxWidth).rounded(.up))
        // 隐藏的占位文字提供一行的高度与可用宽度；真正的文字画在覆盖层里，按占位的框裁切
        Text(text)
            .font(font)
            .lineLimit(1)
            .frame(maxWidth: .infinity)
            .hidden()
            .onGeometryChange(for: CGFloat.self, of: { proxy in
                proxy.size.width
            }, action: { width in
                boxWidth = width
            })
            .overlay(alignment: overflow > 1 ? .leading : .center) {
                content(overflow: overflow)
            }
            .clipped()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(text))
    }

    /// 完整宽度的文字（量出宽度；滚动的 offset 在外层，不影响测量）
    private var label: some View {
        Text(text)
            .font(font)
            .lineLimit(1)
            .fixedSize()
            .onGeometryChange(for: CGFloat.self, of: { proxy in
                proxy.size.width
            }, action: { width in
                textWidth = width
            })
    }

    @ViewBuilder
    private func content(overflow: CGFloat) -> some View {
        if overflow <= 1 {
            label
        } else if reduceMotion {
            ScrollView(.horizontal) {
                label
            }
            .scrollIndicators(.hidden)
        } else {
            let travel = max(Self.minTravel, Double(overflow / Self.speed))
            let pause = Self.pause
            label
                .keyframeAnimator(initialValue: CGFloat(0), repeating: true) { content, x in
                    content.offset(x: x)
                } keyframes: { _ in
                    KeyframeTrack {
                        LinearKeyframe(0, duration: pause)
                        // 起止速度为 0：缓入缓出，不越过两端
                        CubicKeyframe(-overflow, duration: travel, startVelocity: 0, endVelocity: 0)
                        LinearKeyframe(-overflow, duration: pause)
                        CubicKeyframe(0, duration: travel, startVelocity: 0, endVelocity: 0)
                    }
                }
                // 可用宽度变了（字号、横竖屏）时从头开始
                .id(overflow)
        }
    }
}

struct MapChromeImagePreviewItem: Identifiable {
    let id = UUID()
    let images: [URL]
    let index: Int
}

/// 图片大图：左右滑动切换，右上角关闭
@available(iOS 26.0, *)
struct MapChromeImagePreview: View {
    let item: MapChromeImagePreviewItem
    let closeLabel: String
    @State private var selection: Int
    @Environment(\.dismiss) private var dismiss

    init(item: MapChromeImagePreviewItem, closeLabel: String) {
        self.item = item
        self.closeLabel = closeLabel
        _selection = State(initialValue: item.index)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $selection) {
                ForEach(Array(item.images.enumerated()), id: \.offset) { index, url in
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFit()
                        case .failure:
                            Image(systemName: "exclamationmark.triangle")
                                .font(.largeTitle)
                                .foregroundStyle(.secondary)
                        default:
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: item.images.count > 1 ? .automatic : .never))
            .ignoresSafeArea()
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.white)
            .glassEffect(Glass.regular.interactive(), in: .circle)
            .padding(16)
            .accessibilityLabel(Text(closeLabel))
        }
        .environment(\.colorScheme, .dark)
    }
}
