import SwiftUI

/// iOS 26 的原生液态玻璃卡片；更早的系统退回半透明材质，保持与网页一致的可读性。
/// 玻璃本身不承载业务状态：文案、颜色与数据都由网页下发或由各面板模型持有。
struct NativeGlassCard<Content: View>: View {
    var cornerRadius: CGFloat
    var padding: CGFloat
    let content: Content

    init(cornerRadius: CGFloat = 24, padding: CGFloat = 16, @ViewBuilder content: () -> Content) {
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
    func nativeGlassSurface(cornerRadius: CGFloat = 24) -> some View {
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

    /// 玻璃卡片内部的胶囊按钮 / 标签底色；不再叠加第二层玻璃。
    func nativeChip(selected: Bool = false, tint: Color = .accentColor) -> some View {
        self
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(selected ? tint : Color.primary.opacity(0.08), in: Capsule())
            .foregroundStyle(selected ? Color.white : Color.primary)
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

/// 系统 sheet 的背景：iOS 26 由系统提供 Liquid Glass，内容保持透明；更早系统用分组底色。
struct NativeSheetBackground: View {
    var body: some View {
        if #available(iOS 26.0, *) {
            Color.clear
        } else {
            Color(uiColor: .systemGroupedBackground)
        }
    }
}

/// 表单里的一个可多选标签（分类、筛选）：选中时用主题色底，与系统 Picker 的选中色一致
struct NativeTagChip: View {
    let title: String
    var selected = false
    var tint: Color = .accentColor
    var symbol: String? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let symbol {
                    Image(systemName: symbol).font(.caption2.weight(.bold))
                }
                Text(title).font(.subheadline)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(selected ? tint.opacity(0.18) : Color.primary.opacity(0.07), in: Capsule())
            .overlay(Capsule().strokeBorder(selected ? tint : Color.clear, lineWidth: 1))
            .foregroundStyle(selected ? tint : Color.primary)
            .contentShape(Capsule())
        }
        .buttonStyle(.borderless)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - 半屏面板里的分组（添加地点、顺路吃）

extension Color {
    /// 半屏面板里分组的底色：与收藏面板、地点卡片一致；iOS 26 以前面板不是玻璃，用系统分组行底色
    static var nativeSheetGroupFill: Color {
        if #available(iOS 26.0, *) { return Color(uiColor: .tertiarySystemFill) }
        return Color(uiColor: .secondarySystemGroupedBackground)
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
