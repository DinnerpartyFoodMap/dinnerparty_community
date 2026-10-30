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
