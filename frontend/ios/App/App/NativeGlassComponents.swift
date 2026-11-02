import SwiftUI

/// iOS 26 的原生液态玻璃卡片；更早的系统退回半透明材质，保持与网页一致的可读性。
/// 玻璃本身不承载业务状态：文案、颜色与数据都由网页下发或由各面板模型持有。
struct NativeGlassCard<Content: View>: View {
    var cornerRadius: CGFloat
    var padding: CGFloat
    let content: Content

    /// 页内卡片默认 lg 20（设计参考第 3 节）；卡片里贴边的元素按 外层 − 内边距 取同心圆角
    init(cornerRadius: CGFloat = FM.Radius.lg, padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
        self.cornerRadius = cornerRadius
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .nativeGlassSurface(cornerRadius: cornerRadius)
    }
}

extension View {
    /// 液态玻璃底板（iOS 26+）；更早的系统使用 regularMaterial，避免在深色地图上变成纯色块。
    @ViewBuilder
    func nativeGlassSurface(cornerRadius: CGFloat = FM.Radius.lg) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if #available(iOS 26.0, *) {
            self.glassEffect(Glass.regular, in: shape)
        } else {
            self
                .background(.regularMaterial, in: shape)
                .overlay(shape.strokeBorder(Color.primary.opacity(0.08), lineWidth: 1))
        }
    }

    /// 输入框在玻璃卡片上的浅色底，保证深浅主题下都有足够对比度。
    func nativeFieldBackground() -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color.primary.opacity(0.07), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// 胶囊标签 / 按钮的唯一样式（NativeTagChip 也用它），与网页筛选标签一致：未选为浅底，
    /// 选中为 tint 16% 底 + tint 描边与文字；不再叠加第二层玻璃。要别的文字色时在内容上先设 foregroundStyle。
    func nativeChip(selected: Bool = false, tint: Color = .accentColor) -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(selected ? tint.opacity(0.16) : Color.primary.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? tint : Color.clear, lineWidth: 1))
            .foregroundStyle(selected ? tint : Color.primary)
            .contentShape(Capsule())
    }
}

/// 标签、分类等可换行排列的紧凑布局（SwiftUI 没有内置 FlowLayout）。
struct NativeFlowLayout: Layout {
    var spacing: CGFloat = 8
    var lineSpacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var widest: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > maxWidth {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                x = bounds.minX
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            subview.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

/// 系统 sheet 的背景：iOS 26 由系统提供 Liquid Glass，内容保持透明；更早系统用整页底色（与网页 bg-base 一致）。
struct NativeSheetBackground: View {
    var body: some View {
        if #available(iOS 26.0, *) {
            Color.clear
        } else {
            FM.bgBase
        }
    }
}

extension View {
    /// 不透明整页（住民设置、后台、个人主页、表单页）的列表 / 表单底色：设计令牌的 bg-base，与网页整页相同，
    /// 替代系统分组灰（深色下是纯黑）。分组行仍用系统行底色（浅色同为白色）。玻璃半屏面板不要用。
    func nativePageBackground() -> some View {
        self
            .scrollContentBackground(.hidden)
            .background(FM.bgBase.ignoresSafeArea())
    }
}

// MARK: - 主题色

/// 住民设置里的两种主题色在原生页面里的用法（与网页一致）：主色是整页的 tint（主要按钮、选中状态），
/// 辅色用于标签与次要强调。辅色经 environment 传给子视图，标签默认用它。
/// 另有两个由网页算好的派生色：onPrimary（主色底上的文字）与 primaryText（主色当文字用的可读版本，网页 --theme-primary-text）。
private struct NativeSecondaryTintKey: EnvironmentKey {
    static let defaultValue = FM.themeSecondary
}

private struct NativePrimaryTintKey: EnvironmentKey {
    static let defaultValue = FM.themePrimary
}

private struct NativeOnPrimaryKey: EnvironmentKey {
    static let defaultValue = FM.themeOnPrimary
}

private struct NativePrimaryTextKey: EnvironmentKey {
    static let defaultValue = FM.themePrimaryText
}

extension EnvironmentValues {
    /// 主色（也设为 tint）：需要具体 Color（底色、描边）时从这里取
    var nativePrimaryTint: Color {
        get { self[NativePrimaryTintKey.self] }
        set { self[NativePrimaryTintKey.self] = newValue }
    }

    var nativeSecondaryTint: Color {
        get { self[NativeSecondaryTintKey.self] }
        set { self[NativeSecondaryTintKey.self] = newValue }
    }

    /// 主色底上的文字与图标
    var nativeOnPrimary: Color {
        get { self[NativeOnPrimaryKey.self] }
        set { self[NativeOnPrimaryKey.self] = newValue }
    }

    /// 主色当小字用（徽章、浅色底上的强调文字）
    var nativePrimaryText: Color {
        get { self[NativePrimaryTextKey.self] }
        set { self[NativePrimaryTextKey.self] = newValue }
    }
}

/// 网页下发的主题色（#RRGGBB，见 theme.js nativeThemeColors）；缺失时用设计令牌里的默认主题
struct NativeThemeColors {
    let primary: Color
    let secondary: Color
    let onPrimary: Color
    let primaryText: Color

    init(primary: String?, secondary: String?, onPrimary: String? = nil, primaryText: String? = nil) {
        let primaryColor = UIColor(cssHex: primary ?? "")
        self.primary = Color(uiColor: primaryColor ?? FM.UI.themePrimary)
        self.secondary = Color(uiColor: UIColor(cssHex: secondary ?? "") ?? FM.UI.themeSecondary)
        self.onPrimary = Color(uiColor: UIColor(cssHex: onPrimary ?? "") ?? FM.UI.themeOnPrimary)
        // 没下发 primaryText 时：有自定义主色就退回主色本身，否则用默认主题的计算值
        self.primaryText = Color(uiColor: UIColor(cssHex: primaryText ?? "") ?? primaryColor ?? FM.UI.themePrimaryText)
    }
}

extension View {
    /// 整页使用住民的主题色：tint 为主色，辅色与派生色放进 environment（未传派生色时文字用主色本身）
    func nativeThemeColors(primary: Color, secondary: Color, onPrimary: Color = FM.themeOnPrimary,
                           primaryText: Color? = nil) -> some View {
        self
            .tint(primary)
            .environment(\.nativePrimaryTint, primary)
            .environment(\.nativeSecondaryTint, secondary)
            .environment(\.nativeOnPrimary, onPrimary)
            .environment(\.nativePrimaryText, primaryText ?? primary)
    }

    func nativeThemeColors(_ colors: NativeThemeColors) -> some View {
        nativeThemeColors(primary: colors.primary, secondary: colors.secondary,
                          onPrimary: colors.onPrimary, primaryText: colors.primaryText)
    }
}

/// 表单里的一个可多选标签（分类、筛选）：选中时用辅色（网页里标签用辅色）；tint 只在需要别的颜色时传
struct NativeTagChip: View {
    let title: String
    var selected = false
    var tint: Color? = nil
    var symbol: String? = nil
    let action: () -> Void
    @Environment(\.nativeSecondaryTint) private var secondaryTint

    var body: some View {
        let tint = self.tint ?? secondaryTint
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol {
                    Image(systemName: symbol).font(.caption2.weight(.bold))
                }
                Text(title).font(.subheadline)
            }
            .nativeChip(selected: selected, tint: tint)
        }
        .buttonStyle(.borderless)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - 半屏面板里的分组（添加地点、顺路吃）

extension Color {
    /// 半屏面板里分组的底色：与收藏面板、地点卡片一致；iOS 26 以前面板不是玻璃，用卡片底色（网页 bg-surface）
    static var nativeSheetGroupFill: Color {
        if #available(iOS 26.0, *) { return Color(uiColor: .tertiarySystemFill) }
        return FM.bgSurface
    }
}

/// 半屏系统面板里的一栏：组外标题（可带右侧小字）、圆角分组、组下说明。
/// 面板本身不铺底色（不套 NavigationStack / Form）：半屏透出系统玻璃，拉到全屏由系统过渡为不透明，与地点卡片相同。
struct NativeSheetGroup<Content: View>: View {
    let title: String?
    var trailing: String? = nil
    var footer: String? = nil
    var footerColor: Color = .secondary
    let content: Content

    init(_ title: String?, trailing: String? = nil, footer: String? = nil, footerColor: Color = .secondary,
         @ViewBuilder content: () -> Content) {
        self.title = title
        self.trailing = trailing
        self.footer = footer
        self.footerColor = footerColor
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if title != nil || trailing != nil {
                HStack {
                    if let title { Text(title) }
                    Spacer(minLength: 8)
                    if let trailing { Text(trailing).monospacedDigit() }
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
            }
            VStack(alignment: .leading, spacing: 0) {
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.nativeSheetGroupFill, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            if let footer, !footer.isEmpty {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(footerColor)
                    .padding(.horizontal, 16)
            }
        }
    }
}

/// 分组里的一行：左右 16、至少 44 高
struct NativeSheetRow<Content: View>: View {
    let content: Content

    init(@ViewBuilder _ content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        content
            .padding(.horizontal, 16)
            .padding(.vertical, 11)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}

/// 半屏面板的标题行，与收藏面板一致：左边圆形关闭钮、居中标题、右边自定（提交钮或等宽占位）
struct NativeSheetHeader<Trailing: View>: View {
    let title: String
    let closeLabel: String
    var closeDisabled = false
    let onClose: () -> Void
    let trailing: Trailing

    init(title: String, closeLabel: String, closeDisabled: Bool = false, onClose: @escaping () -> Void,
         @ViewBuilder trailing: () -> Trailing) {
        self.title = title
        self.closeLabel = closeLabel
        self.closeDisabled = closeDisabled
        self.onClose = onClose
        self.trailing = trailing()
    }

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.primary)
                    .frame(width: 44, height: 44)
                    .background(Circle().fill(Color.primary.opacity(0.1)))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(closeDisabled)
            .accessibilityLabel(Text(closeLabel))
            Text(title)
                .font(.title3.weight(.bold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)
            trailing
                .frame(width: 44, height: 44)
        }
        .padding(.horizontal, 16)
        // 系统拖动条在上方
        .padding(.top, 18)
        .padding(.bottom, 10)
    }
}
