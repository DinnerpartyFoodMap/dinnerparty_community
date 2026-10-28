import UIKit
import SwiftUI
import Combine
import WebKit

private struct ClusterGlassMarker: Identifiable {
    let id: String
    let rect: CGRect
    let opacity: Double
    let text: String
    let fontSize: CGFloat
    let countX: CGFloat
    let countY: CGFloat
    let zIndex: Double
    let color: Color?
    let visibleRects: [CGRect]
}

private struct ClusterGlassGroup: Identifiable {
    let id: String
    let clip: CGRect
    let markers: [ClusterGlassMarker]
    let dark: Bool
}

private final class ClusterGlassModel: ObservableObject {
    @Published var groups: [ClusterGlassGroup] = []
}

/// 被动显示层：不拦截地图手势、不重复进入读屏树。坐标与转场完全跟随网页的实际动画帧。
/// open -> frame(revision, sentAt) -> close。800ms 没有新帧自动收起，旧会话和过期帧不能恢复残影。
final class NativeClusterMarkerBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let channel = "foodMapClusters"
    private static let protocolVersion = 2
    private static let lease: TimeInterval = 0.8
    private static let markerLimit = 2048

    private struct Source {
        var revision = 0
        var expires: TimeInterval = 0
        var group: ClusterGlassGroup?
    }

    private weak var webView: WKWebView?
    private weak var host: UIView?
    private let model = ClusterGlassModel()
    private var sources: [String: Source] = [:]
    private var timer: Timer?
    private var observers: [NSObjectProtocol] = []

    init(parent: UIViewController, webView: WKWebView) {
        self.webView = webView
        super.init()
        if #available(iOS 26.0, *) {
            let hosting = UIHostingController(rootView: ClusterGlassLayer(model: model))
            hosting.safeAreaRegions = []
            hosting.view.backgroundColor = .clear
            hosting.view.isOpaque = false
            hosting.view.isUserInteractionEnabled = false
            hosting.view.accessibilityElementsHidden = true
            hosting.view.frame = parent.view.bounds
            hosting.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            parent.addChild(hosting)
            parent.view.addSubview(hosting.view)
            hosting.didMove(toParent: parent)
            host = hosting.view
        }
        webView.configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: Self.channel)
        let expiry = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in self?.expireFrames() }
        RunLoop.main.add(expiry, forMode: .common)
        timer = expiry
        let center = NotificationCenter.default
        observers = [UIApplication.willResignActiveNotification, UIAccessibility.reduceTransparencyStatusDidChangeNotification].map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.hideFrames() }
        }
    }

    deinit {
        timer?.invalidate()
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    func reset() {
        sources.removeAll()
        publish()
    }

    private func hideFrames() {
        for id in Array(sources.keys) { sources[id]?.group = nil }
        publish()
    }

    private func expireFrames() {
        let now = Date.timeIntervalSinceReferenceDate
        var changed = false
        for id in Array(sources.keys) where sources[id]?.group != nil && (sources[id]?.expires ?? 0) <= now {
            sources[id]?.group = nil
            changed = true
        }
        if changed { publish() }
    }

    private func publish() {
        var transaction = Transaction()
        transaction.animation = nil
        withTransaction(transaction) {
            model.groups = sources.keys.sorted().compactMap { sources[$0]?.group }
        }
        // WebKit 只在回执后隐藏 PNG；先让 hosting view 完成本次 SwiftUI 布局。
        host?.setNeedsLayout()
        host?.layoutIfNeeded()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, message.webView === webView,
              let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "Invalid cluster message")
            return
        }
        if op == "open" {
            guard #available(iOS 26.0, *), host != nil,
                  body["protocolVersion"] as? Int == Self.protocolVersion, sources.count < 4 else {
                replyHandler(["supportsGlass": false], nil)
                return
            }
            let id = UUID().uuidString
            sources[id] = Source()
            replyHandler(["protocolVersion": Self.protocolVersion, "sessionId": id, "leaseMs": Int(Self.lease * 1000)], nil)
            return
        }
        guard let id = body["sessionId"] as? String else {
            replyHandler(nil, "Missing cluster session")
            return
        }
        if op == "close" {
            sources.removeValue(forKey: id)
            publish()
            replyHandler(["closed": true], nil)
            return
        }
        guard op == "frame", var source = sources[id], let revision = body["revision"] as? Int,
              revision > source.revision, revision <= 1_000_000_000,
              let sentAt = body["sentAt"] as? Double, sentAt.isFinite,
              abs(Date().timeIntervalSince1970 - sentAt / 1000) <= Self.lease,
              UIApplication.shared.applicationState == .active, !UIAccessibility.isReduceTransparencyEnabled,
              let group = decodeFrame(body, id: id) else {
            sources[id]?.group = nil
            publish()
            replyHandler(["appliedRevision": -1], nil)
            return
        }
        source.revision = revision
        // 租期按发送时间计算，排队到达的旧帧不能延长玻璃的存活时间。
        let age = max(0, Date().timeIntervalSince1970 - sentAt / 1000)
        source.expires = Date.timeIntervalSinceReferenceDate + max(0, Self.lease - age)
        source.group = group.markers.isEmpty ? nil : group
        sources[id] = source
        host?.overrideUserInterfaceStyle = (body["dark"] as? Bool) == true ? .dark : .light
        publish()
        replyHandler(["appliedRevision": revision], nil)
    }

    private func number(_ object: [String: Any], _ key: String, _ range: ClosedRange<Double>) -> Double? {
        guard let value = object[key] as? Double, value.isFinite, range.contains(value) else { return nil }
        return value
    }

    private func decodeFrame(_ body: [String: Any], id: String) -> ClusterGlassGroup? {
        guard let webView = webView, let host = host,
              let viewport = body["viewport"] as? [String: Any],
              let viewWidth = number(viewport, "width", 1...10_000),
              let offsetLeft = number(viewport, "offsetLeft", -100_000...100_000),
              let offsetTop = number(viewport, "offsetTop", -100_000...100_000),
              let clip = body["clip"] as? [String: Any],
              let clipX = number(clip, "x", -100_000...100_000), let clipY = number(clip, "y", -100_000...100_000),
              let clipWidth = number(clip, "width", 0...10_000), let clipHeight = number(clip, "height", 0...10_000),
              let raw = body["markers"] as? [[String: Any]], raw.count <= Self.markerLimit else { return nil }
        let scale = webView.bounds.width / CGFloat(viewWidth)
        guard scale.isFinite, scale > 0 else { return nil }
        func converted(_ x: Double, _ y: Double, _ width: Double, _ height: Double) -> CGRect {
            webView.convert(CGRect(x: CGFloat(x - offsetLeft) * scale, y: CGFloat(y - offsetTop) * scale,
                                  width: CGFloat(width) * scale, height: CGFloat(height) * scale), to: host)
        }
        let clipping = converted(clipX, clipY, clipWidth, clipHeight).intersection(host.bounds)
        let dark = (body["dark"] as? Bool) == true
        if raw.isEmpty { return ClusterGlassGroup(id: id, clip: .zero, markers: [], dark: dark) }
        guard !clipping.isNull, !clipping.isEmpty else { return nil }
        var markers: [ClusterGlassMarker] = []
        var ids = Set<String>()
        for item in raw {
            guard let key = item["id"] as? String, !key.isEmpty, key.count <= 100, ids.insert(key).inserted,
                  let x = number(item, "x", -100_000...100_000), let y = number(item, "y", -100_000...100_000),
                  let width = number(item, "width", 0.01...512), let height = number(item, "height", 0.01...512),
                  let opacity = number(item, "opacity", 0...1), let fontSize = number(item, "fontSize", 0.01...128),
                  let countX = number(item, "countX", 0...1), let countY = number(item, "countY", 0...1),
                  let zIndex = number(item, "zIndex", 0...400),
                  let text = item["text"] as? String, !text.isEmpty, text.count <= 12,
                  let rawVisible = item["visibleRects"] as? [[String: Any]], rawVisible.count <= 256 else { return nil }
            var visibleRects: [CGRect] = []
            for piece in rawVisible {
                guard let px = number(piece, "x", 0...(width + 0.001)), let py = number(piece, "y", 0...(height + 0.001)),
                      let pw = number(piece, "width", 0...(width + 0.001)), let ph = number(piece, "height", 0...(height + 0.001)), pw > 0, ph > 0,
                      px + pw <= width + 0.001, py + ph <= height + 0.001 else { return nil }
                visibleRects.append(CGRect(x: CGFloat(px) * scale, y: CGFloat(py) * scale,
                                           width: CGFloat(pw) * scale, height: CGFloat(ph) * scale))
            }
            var color: Color?
            if let rgba = item["color"] as? [Double] {
                guard rgba.count == 4, rgba.allSatisfy({ $0.isFinite && (0...1).contains($0) }) else { return nil }
                color = Color(.sRGB, red: rgba[0], green: rgba[1], blue: rgba[2], opacity: rgba[3])
            }
            let bounds = converted(x, y, width, height).offsetBy(dx: -clipping.minX, dy: -clipping.minY)
            markers.append(ClusterGlassMarker(id: key, rect: bounds, opacity: opacity, text: text,
                                              fontSize: CGFloat(fontSize) * scale, countX: CGFloat(countX), countY: CGFloat(countY), zIndex: zIndex, color: color, visibleRects: visibleRects))
        }
        return ClusterGlassGroup(id: id, clip: clipping, markers: markers, dark: dark)
    }
}

/// 与 src/img/union.png 对应的非对称水滴轮廓；玻璃取景由系统实时生成。
@available(iOS 26.0, *)
private struct ClusterDropShape: Shape {
    func path(in rect: CGRect) -> Path {
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + rect.width * x, y: rect.minY + rect.height * y) }
        var path = Path()
        path.move(to: p(0.477, 1))
        path.addCurve(to: p(0.32, 0.735), control1: p(0.46, 0.995), control2: p(0.51, 0.89))
        path.addCurve(to: p(0, 0.345), control1: p(0.13, 0.57), control2: p(0, 0.49))
        path.addCurve(to: p(0.5, 0), control1: p(0, 0.155), control2: p(0.224, 0))
        path.addCurve(to: p(1, 0.345), control1: p(0.776, 0), control2: p(1, 0.155))
        path.addCurve(to: p(0.477, 1), control1: p(1, 0.655), control2: p(0.745, 0.875))
        path.closeSubpath()
        return path
    }
}

@available(iOS 26.0, *)
private struct ClusterGlassLayer: View {
    @ObservedObject var model: ClusterGlassModel
    @Namespace private var glassNamespace

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            ZStack(alignment: .topLeading) {
                ForEach(model.groups) { group in
                    ZStack(alignment: .topLeading) {
                        ForEach(group.markers) { marker in
                            Color.clear
                                .frame(width: marker.rect.width, height: marker.rect.height)
                                .glassEffect(.regular, in: ClusterDropShape())
                                .glassEffectID(marker.id, in: glassNamespace)
                                .overlay(alignment: .topLeading) {
                                    Text(marker.text)
                                        .font(.system(size: marker.fontSize, weight: .semibold))
                                        .monospacedDigit()
                                        .foregroundStyle(marker.color ?? (group.dark ? Color.white : Color.black))
                                        .shadow(color: (group.dark ? Color.black : Color.white).opacity(0.9), radius: 1)
                                        .fixedSize()
                                        .position(x: marker.rect.width * marker.countX, y: marker.rect.height * marker.countY)
                                }
                                .mask {
                                    Path { path in
                                        for piece in marker.visibleRects { path.addRect(piece) }
                                    }
                                }
                                .opacity(marker.opacity)
                                .position(x: marker.rect.midX, y: marker.rect.midY)
                                .zIndex(marker.zIndex)
                        }
                    }
                    .frame(width: group.clip.width, height: group.clip.height, alignment: .topLeading)
                    .environment(\.colorScheme, group.dark ? .dark : .light)
                    .clipped()
                    .position(x: group.clip.midX, y: group.clip.midY)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
