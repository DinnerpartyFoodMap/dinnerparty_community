import UIKit
import MapKit
import Capacitor

/// 本地 Capacitor 插件：网页与原生底图（NativeMapController）之间的桥接协议（protocolVersion 1）。
///
/// capabilities() -> { protocolVersion }
/// attach({ sessionId, lng, lat, zoom, dark, muted }) -> { ready, camera }   显示底图、WebView 变透明
/// setCamera({ sessionId, lng, lat, zoom, animated }) -> { camera }
/// fitBounds({ sessionId, minLng, minLat, maxLng, maxLat, top, right, bottom, left, maxZoom, animated }) -> { camera }
/// panBy({ sessionId, dx, dy, animated }) -> { camera }
/// setStyle({ sessionId, style: { glyphs, glyphWidth, glyphHeight, clusterImage, clusterCrop?, clusterWidth, clusterHeight,
///            countX, countY, countColor, labelText, labelBackground, labelBorder, avoidText, avoidBackground, avoidBorder,
///            kindSuffix, clusterLabel } })
/// setNodes({ sessionId, ids, clusters: [Bool], coords: [lng0, lat0, …], counts, names, glyphs, selected, animate,
///            reuse: [新, 旧, …], splitFrom: [新, 旧父, …], mergeInto: [旧, 新父, …], splitSources: [旧], mergeTargets: [新] })
///   网页聚合引擎的一份快照与转场计划（cluster/transitions.js）；原生按计划播放拆分 / 合并动画
/// setSelected({ sessionId, id })
/// search({ sessionId, probes: [{ id, names: [String], lng, lat, radius }] }) -> { results: [{ id, points: [lng, lat, …] }] }
///   坐标校准：苹果地点搜索在地标附近按名称搜，结果原样返回，由网页判断这台手机上各地区的底图用哪种坐标
/// setOverlays({ sessionId, markers: [{ id, kind, lng, lat, text?, fill, textColor?, border?, size?, zIndex?, label? }],
///               lines: [{ id, coords, color, width, opacity, dashed, zIndex }] })
/// setAppearance({ sessionId, dark, muted }) / setInsets({ sessionId, top, right, bottom, left })
/// setTouch({ sessionId, active, rect: [x, y, w, h], holes: [[x, y, w, h], …] })   WebView 视口坐标（CSS px = pt）
/// dispose({ sessionId })
///
/// 事件：camera { sessionId, phase: start|change|end, lng, lat, zoom, minLng, minLat, maxLng, maxLat, width, height, gesture, zoomChanged? }
///      tap { sessionId, lng, lat }（地图空白处）、markerTap { sessionId, id }（单点）、clusterTap { sessionId, id }（聚合）
///
/// - 标记、聚合点与名称都是 MapKit 标注视图，拖动缩放时与底图同帧移动；网页只在缩放结束、数据变化时下发。
/// - 旧会话的调用被拒绝（STALE_SESSION）；WebView 重新加载时由根控制器收起底图并清空（handleWebViewReload）。
@objc(NativeMapPlugin)
public class NativeMapPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMapPlugin"
    public let jsName = "NativeMap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "attach", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setCamera", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "fitBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "panBy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setStyle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setNodes", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "search", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSelected", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setOverlays", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAppearance", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setInsets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTouch", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dispose", returnType: CAPPluginReturnPromise)
    ]

    static let protocolVersion = 1
    static let nodeLimit = 5_000
    static let probeLimit = 12
    static let overlayLimit = 200
    static let pathPointLimit = 20_000
    static let holeLimit = 400
    static let textLimit = 80
    static let imageLimit = 300_000
    static let glyphKinds: Set<String> = ["place", "avoid", "unexplored", "add"]
    static let overlayKinds: Set<String> = ["location", "pin", "badge"]

    /// 由 FoodMapBridgeViewController 注入
    var controllerProvider: (() -> NativeMapController?)?
    var touchRouter: NativeMapTouchRouter?
    /// 显示 / 收起底图时由根控制器切换 WebView 的透明度
    var onAttachedChange: ((Bool) -> Void)?

    private var sessionId: String?

    // MARK: - 协议方法

    @objc func capabilities(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["protocolVersion": NativeMapPlugin.protocolVersion, "available": self.controllerProvider?() != nil])
        }
    }

    @objc func attach(_ call: CAPPluginCall) {
        guard let session = call.getString("sessionId"), !session.isEmpty else {
            call.reject("sessionId is required", "INVALID_ARGUMENT")
            return
        }
        let center = Self.coordinate(call.getDouble("lng"), call.getDouble("lat"))
        let zoom = call.getDouble("zoom") ?? 16
        let dark = call.getBool("dark") ?? false
        let muted = call.getBool("muted") ?? false
        DispatchQueue.main.async {
            guard let controller = self.controllerProvider?() else {
                call.reject("Native map unavailable", "UNAVAILABLE")
                return
            }
            // 新会话替换旧会话：清掉上一份标记与覆盖物
            if self.sessionId != nil { controller.detach() }
            self.sessionId = session
            self.touchRouter?.reset()
            self.bind(controller, session: session)
            controller.setAppearance(dark: dark, muted: muted)
            controller.attach(center: center ?? CLLocationCoordinate2D(latitude: 23.016485, longitude: 113.394405), zoom: zoom)
            self.onAttachedChange?(true)
            call.resolve(["ready": true, "camera": controller.cameraPayload(phase: "end")])
        }
    }

    @objc func setCamera(_ call: CAPPluginCall) {
        let center = Self.coordinate(call.getDouble("lng"), call.getDouble("lat"))
        let zoom = call.getDouble("zoom")
        let animated = call.getBool("animated") ?? false
        withController(call) { controller in
            let target = center ?? controller.mapView.centerCoordinate
            controller.setCamera(center: target, zoom: zoom ?? controller.zoom, animated: animated)
            call.resolve(["camera": controller.cameraPayload(phase: "end")])
        }
    }

    @objc func fitBounds(_ call: CAPPluginCall) {
        guard let southWest = Self.coordinate(call.getDouble("minLng"), call.getDouble("minLat")),
              let northEast = Self.coordinate(call.getDouble("maxLng"), call.getDouble("maxLat")) else {
            call.reject("bounds are required", "INVALID_ARGUMENT")
            return
        }
        let padding = UIEdgeInsets(top: Self.length(call.getDouble("top")), left: Self.length(call.getDouble("left")),
                                   bottom: Self.length(call.getDouble("bottom")), right: Self.length(call.getDouble("right")))
        let maxZoom = call.getDouble("maxZoom") ?? NativeMapController.maxZoom
        let animated = call.getBool("animated") ?? false
        withController(call) { controller in
            let a = MKMapPoint(southWest), b = MKMapPoint(northEast)
            let rect = MKMapRect(x: min(a.x, b.x), y: min(a.y, b.y), width: abs(a.x - b.x), height: abs(a.y - b.y))
            controller.fitBounds(rect, padding: padding, maxZoom: maxZoom, animated: animated)
            call.resolve(["camera": controller.cameraPayload(phase: "end")])
        }
    }

    @objc func panBy(_ call: CAPPluginCall) {
        let dx = call.getDouble("dx") ?? 0
        let dy = call.getDouble("dy") ?? 0
        let animated = call.getBool("animated") ?? false
        withController(call) { controller in
            if dx.isFinite, dy.isFinite { controller.panBy(dx: dx, dy: dy, animated: animated) }
            call.resolve(["camera": controller.cameraPayload(phase: "end")])
        }
    }

    @objc func setStyle(_ call: CAPPluginCall) {
        let style = Self.parseStyle(call.getObject("style") ?? [:])
        withController(call) { controller in
            controller.setStyle(style)
            call.resolve()
        }
    }

    @objc func setNodes(_ call: CAPPluginCall) {
        let nodes = Self.parseNodes(call)
        let plan = Self.parsePlan(call)
        let selected = call.getString("selected")
        let animate = call.getBool("animate") ?? false
        withController(call) { controller in
            controller.setNodes(nodes, plan: plan, animate: animate, selected: selected)
            call.resolve(["count": nodes.count])
        }
    }

    @objc func search(_ call: CAPPluginCall) {
        let probes = (call.getArray("probes", JSObject.self) ?? []).prefix(Self.probeLimit).compactMap(Self.parseProbe)
        withController(call) { _ in
            var results: [[String: Any]] = []
            let group = DispatchGroup()
            for probe in probes {
                group.enter()
                // MKLocalSearch 在主线程回调，results 只在主线程修改
                NativeMapController.search(probe) { points in
                    results.append(["id": probe.id, "points": points])
                    group.leave()
                }
            }
            group.notify(queue: .main) { call.resolve(["results": results]) }
        }
    }

    @objc func setSelected(_ call: CAPPluginCall) {
        let id = call.getString("id")
        withController(call) { controller in
            controller.setSelected(id)
            call.resolve()
        }
    }

    @objc func setOverlays(_ call: CAPPluginCall) {
        let markers = (call.getArray("markers", JSObject.self) ?? []).prefix(Self.overlayLimit).compactMap(Self.parseOverlay)
        let lines = (call.getArray("lines", JSObject.self) ?? []).prefix(Self.overlayLimit).compactMap(Self.parseLine)
        withController(call) { controller in
            controller.setOverlays(markers: Array(markers), lines: Array(lines))
            call.resolve()
        }
    }

    @objc func setAppearance(_ call: CAPPluginCall) {
        let dark = call.getBool("dark") ?? false
        let muted = call.getBool("muted") ?? false
        withController(call) { controller in
            controller.setAppearance(dark: dark, muted: muted)
            call.resolve()
        }
    }

    @objc func setInsets(_ call: CAPPluginCall) {
        let insets = UIEdgeInsets(top: Self.length(call.getDouble("top")), left: Self.length(call.getDouble("left")),
                                  bottom: Self.length(call.getDouble("bottom")), right: Self.length(call.getDouble("right")))
        withController(call) { controller in
            controller.setInsets(insets)
            call.resolve()
        }
    }

    @objc func setTouch(_ call: CAPPluginCall) {
        let active = call.getBool("active") ?? false
        let rect = Self.rect(call.getArray("rect")) ?? .zero
        let holes = (call.getArray("holes") ?? []).prefix(Self.holeLimit).compactMap { Self.rect($0) }
        withController(call) { _ in
            self.touchRouter?.update(active: active && rect.width > 0 && rect.height > 0, mapRect: rect, holes: Array(holes))
            call.resolve()
        }
    }

    @objc func dispose(_ call: CAPPluginCall) {
        let session = call.getString("sessionId")
        DispatchQueue.main.async {
            guard session != nil, session == self.sessionId else {
                call.resolve(["disposed": false])
                return
            }
            self.teardown()
            call.resolve(["disposed": true])
        }
    }

    /// WebView 重新加载：旧网页的会话作废，底图收起、触摸全部还给网页
    func handleWebViewReload() {
        guard sessionId != nil else { return }
        teardown()
    }

    // MARK: - 内部

    private func teardown() {
        sessionId = nil
        touchRouter?.reset()
        controllerProvider?()?.detach()
        onAttachedChange?(false)
    }

    private func bind(_ controller: NativeMapController, session: String) {
        controller.onCamera = { [weak self] payload in
            guard let self, self.sessionId == session else { return }
            var data = payload
            data["sessionId"] = session
            self.notifyListeners("camera", data: data)
        }
        controller.onTap = { [weak self] coordinate in
            guard let self, self.sessionId == session else { return }
            self.notifyListeners("tap", data: ["sessionId": session, "lng": coordinate.longitude, "lat": coordinate.latitude])
        }
        controller.onMarkerTap = { [weak self] id in
            guard let self, self.sessionId == session else { return }
            self.notifyListeners("markerTap", data: ["sessionId": session, "id": id])
        }
        controller.onClusterTap = { [weak self] id in
            guard let self, self.sessionId == session else { return }
            self.notifyListeners("clusterTap", data: ["sessionId": session, "id": id])
        }
    }

    private func withController(_ call: CAPPluginCall, _ body: @escaping (NativeMapController) -> Void) {
        let session = call.getString("sessionId")
        DispatchQueue.main.async {
            guard let session, session == self.sessionId, let controller = self.controllerProvider?(), controller.isAttached else {
                call.reject("Stale session", "STALE_SESSION")
                return
            }
            body(controller)
        }
    }

    // MARK: - 解析（白名单与上限）

    private static func coordinate(_ lng: Double?, _ lat: Double?) -> CLLocationCoordinate2D? {
        guard let lng, let lat, lng.isFinite, lat.isFinite, abs(lng) <= 180, abs(lat) <= 85.05112878 else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    private static func length(_ value: Double?) -> CGFloat {
        guard let value, value.isFinite else { return 0 }
        return CGFloat(min(2000, max(0, value)))
    }

    /// [x, y, width, height]
    private static func rect(_ raw: Any?) -> CGRect? {
        guard let value = raw as? [Any], value.count == 4 else { return nil }
        let numbers = value.compactMap { ($0 as? NSNumber)?.doubleValue }
        guard numbers.count == 4, numbers.allSatisfy({ $0.isFinite }), numbers[2] > 0, numbers[3] > 0 else { return nil }
        return CGRect(x: numbers[0], y: numbers[1], width: min(numbers[2], 10_000), height: min(numbers[3], 10_000))
    }

    private static func text(_ value: Any?, limit: Int = textLimit) -> String? {
        guard let string = value as? String else { return nil }
        return String(string.prefix(limit))
    }

    private static func color(_ value: Any?) -> UIColor? {
        (value as? String).flatMap { UIColor(cssHex: $0) }
    }

    /// 图片地址：App 包内网页资源（capacitor:）或位图 data URL；不带凭据，超长丢弃
    private static func image(_ value: Any?) -> String? {
        guard let source = value as? String, !source.isEmpty, source.count <= imageLimit else { return nil }
        if source.hasPrefix("data:image/") { return source }
        guard let url = URL(string: source), url.scheme?.lowercased() == "capacitor", url.user == nil, url.password == nil else { return nil }
        return source
    }

    private static func number(_ value: Any?) -> Double? {
        guard let number = (value as? NSNumber)?.doubleValue, number.isFinite else { return nil }
        return number
    }

    static func parseStyle(_ raw: JSObject) -> NativeMapMarkerStyle {
        var style = NativeMapMarkerStyle()
        if let glyphs = raw["glyphs"] as? JSObject {
            for (key, value) in glyphs where glyphKinds.contains(key) {
                if let source = image(value) { style.glyphs[key] = source }
            }
        }
        if let width = number(raw["glyphWidth"]), let height = number(raw["glyphHeight"]), width > 0, height > 0, width < 200, height < 200 {
            style.glyphSize = CGSize(width: width, height: height)
        }
        style.clusterImage = image(raw["clusterImage"])
        if let rect = rect(raw["clusterCrop"]), rect.maxX <= 1.0001, rect.maxY <= 1.0001, rect.minX >= 0, rect.minY >= 0 {
            style.clusterCrop = rect
        }
        if let width = number(raw["clusterWidth"]), let height = number(raw["clusterHeight"]), width > 0, height > 0, width < 200, height < 200 {
            style.clusterBaseSize = CGSize(width: width, height: height)
        }
        if let x = number(raw["countX"]), let y = number(raw["countY"]), (0...1).contains(x), (0...1).contains(y) {
            style.countPosition = CGPoint(x: x, y: y)
        }
        if let value = color(raw["countColor"]) { style.countColor = value }
        if let value = color(raw["labelText"]) { style.labelText = value }
        if let value = color(raw["labelBackground"]) { style.labelBackground = value }
        if let value = color(raw["labelBorder"]) { style.labelBorder = value }
        if let value = color(raw["avoidText"]) { style.avoidText = value }
        if let value = color(raw["avoidBackground"]) { style.avoidBackground = value }
        if let value = color(raw["avoidBorder"]) { style.avoidBorder = value }
        if let suffix = raw["kindSuffix"] as? JSObject {
            for (key, value) in suffix where glyphKinds.contains(key) {
                if let text = text(value, limit: 20) { style.kindSuffix[key] = text }
            }
        }
        if let label = text(raw["clusterLabel"], limit: 40), label.contains("%d") { style.clusterLabel = label }
        return style
    }

    static func parseNodes(_ call: CAPPluginCall) -> [NativeMapNodeInput] {
        let ids = call.getArray("ids") ?? []
        let clusters = call.getArray("clusters") ?? []
        let coords = call.getArray("coords") ?? []
        let counts = call.getArray("counts") ?? []
        let names = call.getArray("names") ?? []
        let glyphs = call.getArray("glyphs") ?? []
        let count = min(ids.count, coords.count / 2, nodeLimit)
        var result: [NativeMapNodeInput] = []
        result.reserveCapacity(count)
        for index in 0..<count {
            guard let id = text(ids[index], limit: 160), !id.isEmpty,
                  let coordinate = coordinate(number(coords[index * 2]), number(coords[index * 2 + 1])) else { continue }
            let cluster = index < clusters.count ? ((clusters[index] as? Bool) ?? false) : false
            let total = index < counts.count ? Int(min(10_000_000, max(1, number(counts[index]) ?? 1))) : 1
            let name = index < names.count ? (text(names[index]) ?? "") : ""
            let rawGlyph = index < glyphs.count ? (glyphs[index] as? String) : nil
            let glyph = rawGlyph.flatMap { glyphKinds.contains($0) ? $0 : nil } ?? "place"
            result.append(NativeMapNodeInput(id: id, cluster: cluster, coordinate: coordinate, count: cluster ? max(2, total) : 1,
                                             name: cluster ? "" : name, glyph: glyph))
        }
        return result
    }

    /// 计划按成对的扁平数组下发：[新, 旧, 新, 旧, …]
    private static func pairs(_ value: JSArray?) -> [String: String] {
        guard let value else { return [:] }
        var result: [String: String] = [:]
        var index = 0
        while index + 1 < value.count, result.count < nodeLimit {
            if let key = text(value[index], limit: 160), let other = text(value[index + 1], limit: 160), !key.isEmpty, !other.isEmpty {
                result[key] = other
            }
            index += 2
        }
        return result
    }

    private static func keys(_ value: JSArray?) -> Set<String> {
        Set((value ?? []).prefix(nodeLimit).compactMap { text($0, limit: 160) }.filter { !$0.isEmpty })
    }

    static func parsePlan(_ call: CAPPluginCall) -> NativeMapTransitionPlan {
        NativeMapTransitionPlan(
            reuse: pairs(call.getArray("reuse")),
            reanchor: keys(call.getArray("reanchor")),
            splitFrom: pairs(call.getArray("splitFrom")),
            mergeInto: pairs(call.getArray("mergeInto")),
            splitSources: keys(call.getArray("splitSources")),
            mergeTargets: keys(call.getArray("mergeTargets"))
        )
    }

    static func parseProbe(_ raw: JSObject) -> NativeMapSearchProbe? {
        guard let id = text(raw["id"], limit: 64), !id.isEmpty,
              let center = coordinate(number(raw["lng"]), number(raw["lat"])),
              let rawNames = raw["names"] as? [Any] else { return nil }
        let names = rawNames.prefix(4).compactMap { text($0, limit: 60) }.filter { !$0.isEmpty }
        guard !names.isEmpty else { return nil }
        let radius = number(raw["radius"]).map { min(20_000, max(200, $0)) } ?? 3000
        return NativeMapSearchProbe(id: id, names: names, center: center, radius: radius)
    }

    static func parseOverlay(_ raw: JSObject) -> NativeMapOverlayInput? {
        guard let id = text(raw["id"], limit: 64), !id.isEmpty,
              let kind = raw["kind"] as? String, overlayKinds.contains(kind),
              let coordinate = coordinate(number(raw["lng"]), number(raw["lat"])) else { return nil }
        let size = number(raw["size"]).map { CGFloat(min(64, max(12, $0))) } ?? 28
        let zIndex = number(raw["zIndex"]).map { Int(min(5000, max(0, $0))) } ?? 100
        return NativeMapOverlayInput(
            id: id, kind: kind, coordinate: coordinate,
            text: text(raw["text"], limit: 4),
            fill: color(raw["fill"]) ?? FM.UI.location,
            textColor: color(raw["textColor"]) ?? .white,
            border: color(raw["border"]),
            size: size, zIndex: zIndex,
            label: text(raw["label"])
        )
    }

    static func parseLine(_ raw: JSObject) -> NativeMapPolylineInput? {
        guard let id = text(raw["id"], limit: 64), !id.isEmpty, let flat = raw["coords"] as? [Any] else { return nil }
        var coordinates: [CLLocationCoordinate2D] = []
        let pairs = min(flat.count / 2, pathPointLimit)
        coordinates.reserveCapacity(pairs)
        for index in 0..<pairs {
            if let coordinate = coordinate(number(flat[index * 2]), number(flat[index * 2 + 1])) { coordinates.append(coordinate) }
        }
        guard coordinates.count >= 2 else { return nil }
        return NativeMapPolylineInput(
            id: id, coordinates: coordinates,
            color: color(raw["color"]) ?? .systemPink,
            width: number(raw["width"]).map { CGFloat(min(20, max(1, $0))) } ?? 5,
            opacity: number(raw["opacity"]).map { CGFloat(min(1, max(0.1, $0))) } ?? 1,
            dashed: (raw["dashed"] as? Bool) ?? false,
            zIndex: number(raw["zIndex"]).map { Int(min(5000, max(0, $0))) } ?? 100
        )
    }
}
