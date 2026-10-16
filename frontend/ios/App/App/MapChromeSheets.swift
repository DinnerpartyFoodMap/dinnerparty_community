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
            applyInterfaceStyle(to: controller)
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
        let controller = UIHostingController(rootView: root)
        // 背景交给系统：iOS 26 的面板是 Liquid Glass，视图不铺底色
        controller.view.backgroundColor = .clear
        controller.modalPresentationStyle = .pageSheet
        if let sheetController = controller.sheetPresentationController {
            configure(sheetController)
            sheetController.delegate = self
        }
        applyInterfaceStyle(to: controller)
        self.controller = controller
        presented = sheet
        model.cardExpanded = false
        let id = beginTransition()
        host.present(controller, animated: true) { [weak self] in
            self?.endTransition(id)
            self?.setNeedsUpdate()
        }
        // 容器视图在开始呈现时才创建：赶在第一帧之前补上，弹出动画里的玻璃底就是正确的明暗
        applyInterfaceStyle(to: controller)
    }

    /// 只作用于这个面板：跟随应用主题而不是系统外观。只设面板控制器不够，
    /// 面板的玻璃底、全屏时的底色和遮罩画在呈现控制器的容器视图里，仍会跟随系统，所以容器视图也要指定。
    /// 只用视图 / 控制器的 overrideUserInterfaceStyle：呈现控制器的 traitOverrides 曾在弹出卡片时闪退（原因未确认），不再使用。
    private func applyInterfaceStyle(to controller: UIViewController) {
        let style: UIUserInterfaceStyle = model.theme.dark ? .dark : .light
        controller.overrideUserInterfaceStyle = style
        controller.sheetPresentationController?.containerView?.overrideUserInterfaceStyle = style
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

    /// 弹出动画开始前容器视图已经创建：此时指定明暗，第一帧的玻璃底就是应用主题
    func presentationController(_ presentationController: UIPresentationController, willPresentWithAdaptiveStyle style: UIModalPresentationStyle, transitionCoordinator: UIViewControllerTransitionCoordinator?) {
        guard let controller, presentationController.presentedViewController === controller else { return }
        applyInterfaceStyle(to: controller)
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
            .accessibilityLabel(Text("关闭"))
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
        .accessibilityLabel(Text(row.subtitle.map { "\(row.title)，\($0)" } ?? row.title))
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
            MapChromeImagePreview(item: item)
        }
    }

    // MARK: 摘要

    private var summary: some View {
        VStack(spacing: 16) {
            header
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
                    label: leading.title,
                    tint: leading.tone == "accent" ? accent : Color.primary,
                    disabled: leading.disabled
                ) {
                    model.selectSheetRow(leading)
                }
            } else {
                Color.clear.frame(width: 44, height: 44)
            }
            VStack(spacing: 2) {
                Text(sheet.title)
                    .font(.title2.weight(.bold))
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
            circleButton(symbol: "xmark", label: "关闭", tint: Color.primary, disabled: false) {
                model.dismissSheet()
            }
        }
    }

    private func circleButton(symbol: String, label: String, tint: Color, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .contentTransition(.symbolEffect(.replace))
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
                Image(systemName: row.symbol ?? "circle")
                    .font(.system(size: 19, weight: .semibold))
                    .contentTransition(.symbolEffect(.replace))
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

    private var details: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text("简介")
                    .font(.headline)
                Text(sheet.detail ?? "暂无描述")
                    .font(.body)
                    .foregroundStyle(sheet.detail == nil ? Color.secondary : Color.primary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if let caption = sheet.caption {
                    Label(caption, systemImage: "mappin.and.ellipse")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(groupFill, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

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

    private func detailRow(_ row: MapChromeSheetRow) -> some View {
        Button {
            model.selectSheetRow(row)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: row.symbol ?? "circle")
                    .font(.body.weight(.semibold))
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
                        .accessibilityLabel(Text("\(group.title ?? "图片") 第 \(index + 1) 张"))
                    }
                }
            }
            .scrollIndicators(.hidden)
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
    @State private var selection: Int
    @Environment(\.dismiss) private var dismiss

    init(item: MapChromeImagePreviewItem) {
        self.item = item
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
            .accessibilityLabel(Text("关闭大图"))
        }
        .environment(\.colorScheme, .dark)
    }
}
