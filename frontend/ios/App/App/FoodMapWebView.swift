import UIKit
import WebKit

/// 原生底图的触摸分配。网页按自己的命中判断（elementFromPoint）算出地图区域里哪些位置是网页元素（holes），
/// 其余位置是空的地图画布：这些触摸穿过 WebView，交给下面的 MKMapView。
/// 网页任何浮层、页面盖住地图时，命中的都是网页元素，触摸自然留在网页；地图页不在前台时网页关闭 active。
final class NativeMapTouchRouter {
    /// 网页上报的命中区域边缘容差（pt）：采样网格之间的元素边缘留给网页
    private let slop: CGFloat = 2
    private(set) var active = false
    private(set) var mapRect: CGRect = .zero
    private(set) var holes: [CGRect] = []

    func update(active: Bool, mapRect: CGRect, holes: [CGRect]) {
        self.active = active
        self.mapRect = mapRect
        self.holes = holes
    }

    func reset() {
        update(active: false, mapRect: .zero, holes: [])
    }

    func routesToMap(_ point: CGPoint) -> Bool {
        guard active, mapRect.contains(point) else { return false }
        return !holes.contains { $0.insetBy(dx: -slop, dy: -slop).contains(point) }
    }
}

/// Capacitor 的 WKWebView 子类（FoodMapBridgeViewController.webView(with:configuration:) 创建）：
/// 原生底图接管时，地图画布上的触摸返回 nil，由容器继续命中 WebView 下面的 MKMapView。
final class FoodMapWebView: WKWebView {
    let touchRouter = NativeMapTouchRouter()

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if touchRouter.routesToMap(point) { return nil }
        return super.hitTest(point, with: event)
    }
}
