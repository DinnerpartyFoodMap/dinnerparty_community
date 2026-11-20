import UIKit

/// 透明宿主：只命中可见控件的实际区域，其余位置 hitTest 返回 nil，触摸交给下方的 WKWebView。
/// 地图拖拽、惯性与双指缩放在控件外保持可用；可见但禁用的按钮区域仍消费触摸（不执行动作），
/// 避免点禁用按钮时意外点到底图；隐藏或收起时完全穿透。
final class PassThroughHostView: UIView {
    private let model: MapChromeModel
    /// 命中区域四周的容差（pt）
    private let slop: CGFloat = 4

    init(model: MapChromeModel) {
        self.model = model
        super.init(frame: .zero)
        backgroundColor = .clear
        isOpaque = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard !isHidden, alpha > 0.01, model.isShowing else { return nil }
        let rects = model.touchRects
        guard rects.contains(where: { $0.insetBy(dx: -slop, dy: -slop).contains(point) }) else {
            // 操作指引期间：触摸交给网页的指引层，不收起指引展开的更多功能
            if model.tour != nil { return nil }
            // 面板提交中（v19 打卡）：面板外的触摸由宿主吃掉，不关闭面板、也不交给地图
            // （点地图会换店或关掉店卡，连带取消进行中的打卡）
            if model.presentedPanel?.locked == true { return self }
            // 展开更多功能时碰到地图：收起（触摸照常交给地图，拖动、缩放不受影响）
            if model.drawerOpen {
                let model = self.model
                DispatchQueue.main.async { model.setDrawerExpanded(false) }
            }
            // 住民菜单 / 我的收藏打开时碰到地图：关闭面板（与系统面板点遮罩关闭一致）
            if model.presentedPanel != nil {
                let model = self.model
                DispatchQueue.main.async { model.dismissSheet() }
            }
            return nil
        }
        // 落在控件区域内：交给 SwiftUI；若 SwiftUI 没有命中具体按钮，仍由宿主消费，避免穿透到地图
        return super.hitTest(point, with: event) ?? self
    }
}
