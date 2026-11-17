import UIKit
import MapKit

/// 原生底图（MapKit）：放在透明 WebView 下面。标记、聚合点、名称与覆盖物都是 MapKit 的标注视图，
/// 拖动、缩放时由 MapKit 在同一帧里移动，不经过网页。网页只在数据变化时下发（标记、样式、覆盖物、相机），
/// 相机变化与点按以事件回传（NativeMapPlugin）。
///
/// 缩放级别与网页、高德一致（Web Mercator、256 像素瓦片）：MKMapSize.world 宽 2^28 = 256·2^20，
/// 所以 z = 20 − log2(可见 MKMapRect 宽度 / 视图宽度)。地图不旋转、不倾斜，网页按同一公式在 JS 里投影。
/// 坐标原样使用：店铺坐标在高德的境内格子里是 GCJ-02，MapKit 在中国大陆同样按 GCJ-02 显示（港澳台与边境待实测）。
final class NativeMapController: NSObject {
    static let clusterIdentifier = "fm.place"
    static let minZoom: Double = 3
    static let maxZoom: Double = 20
    /// MKMapPoint 与 256 像素瓦片缩放级别的换算基准（log2(2^28 / 256) = 20）
    static let worldZoom = log2(MKMapSize.world.width / 256)
    /// 拖动、缩放过程中的相机事件最多这么频繁（秒）
    static let changeInterval: CFTimeInterval = 0.1

    let mapView: MKMapView

    var onCamera: (([String: Any]) -> Void)?
    var onTap: ((CLLocationCoordinate2D) -> Void)?
    var onMarkerTap: ((String) -> Void)?
    var onClusterMembers: (([String], CLLocationCoordinate2D) -> Void)?

    private(set) var style = NativeMapMarkerStyle()
    private var places: [String: NativeMapPlaceAnnotation] = [:]
    private var selectedId: String?
    private var overlayAnnotations: [String: NativeMapOverlayAnnotation] = [:]
    private var polylines: [String: NativeMapPolyline] = [:]
    private var moving = false
    private var moveStartZoom: Double = 0
    private var lastChangeEmit: CFTimeInterval = 0
    private var tapRecognizer: UITapGestureRecognizer?

    override init() {
        mapView = MKMapView(frame: .zero)
        super.init()
        mapView.isHidden = true
        mapView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        mapView.isRotateEnabled = false
        mapView.isPitchEnabled = false
        mapView.showsCompass = false
        mapView.showsScale = false
        mapView.showsUserLocation = false
        // 苹果自己的地点只做底图展示，不可选中：点地图空白处交给网页（关闭卡片、添加地点选点）
        mapView.selectableMapFeatures = []
        mapView.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: .default)
        mapView.delegate = self
        mapView.register(NativeMapPlaceView.self, forAnnotationViewWithReuseIdentifier: NativeMapPlaceView.reuseId)
        mapView.register(NativeMapClusterView.self, forAnnotationViewWithReuseIdentifier: NativeMapClusterView.reuseId)
        mapView.register(NativeMapOverlayView.self, forAnnotationViewWithReuseIdentifier: NativeMapOverlayView.reuseId)
        installTap()
    }

    // MARK: - 显示

    var isAttached: Bool { !mapView.isHidden }

    func attach(center: CLLocationCoordinate2D, zoom: Double) {
        mapView.isHidden = false
        mapView.layoutIfNeeded()
        setCamera(center: center, zoom: zoom, animated: false)
        // MapKit 的双击手势挂在内部视图上，显示后才齐全
        DispatchQueue.main.async { [weak self] in self?.requireDoubleTapFailure() }
    }

    /// 网页会话结束（重载、失效）：收起并清空，等待下一次握手
    func detach() {
        mapView.isHidden = true
        mapView.removeAnnotations(mapView.annotations)
        mapView.removeOverlays(mapView.overlays)
        places.removeAll()
        overlayAnnotations.removeAll()
        polylines.removeAll()
        selectedId = nil
        moving = false
    }

    // MARK: - 相机

    var zoom: Double {
        let width = Double(mapView.bounds.width)
        let rectWidth = mapView.visibleMapRect.size.width
        guard width > 0, rectWidth > 0 else { return Self.minZoom }
        return Self.worldZoom - log2(rectWidth / width)
    }

    /// 每个屏幕点对应多少 MKMapPoint
    private static func scale(for zoom: Double) -> Double { pow(2, worldZoom - zoom) }

    private static func clampZoom(_ zoom: Double) -> Double { min(maxZoom, max(minZoom, zoom)) }

    func setCamera(center: CLLocationCoordinate2D, zoom: Double, animated: Bool) {
        let size = mapView.bounds.size
        guard size.width > 0, size.height > 0, CLLocationCoordinate2DIsValid(center) else { return }
        let scale = Self.scale(for: Self.clampZoom(zoom))
        let point = MKMapPoint(center)
        let width = Double(size.width) * scale
        let height = Double(size.height) * scale
        mapView.setVisibleMapRect(MKMapRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), animated: animated)
    }

    /// 地图中心不变，按屏幕点平移（网页的 panBy：正值让内容向右下移动）
    func panBy(dx: Double, dy: Double, animated: Bool) {
        let scale = Self.scale(for: zoom)
        let center = MKMapPoint(mapView.centerCoordinate)
        let next = MKMapPoint(x: center.x - dx * scale, y: center.y - dy * scale)
        setCamera(center: next.coordinate, zoom: zoom, animated: animated)
    }

    /// 让一组坐标落在扣掉 padding 后的区域中央；maxZoom 限制单点或很近的点放得太大
    func fitBounds(_ rect: MKMapRect, padding: UIEdgeInsets, maxZoom: Double, animated: Bool) {
        guard let fit = fitZoom(rect, padding: padding) else { return }
        moveCamera(to: rect, padding: padding, zoom: Self.clampZoom(min(fit, maxZoom)), animated: animated)
    }

    /// 能把 rect 放进扣掉 padding 的区域的最大缩放级别（单点为 maxZoom）
    private func fitZoom(_ rect: MKMapRect, padding: UIEdgeInsets) -> Double? {
        let size = mapView.bounds.size
        guard size.width > 0, size.height > 0, !rect.isNull else { return nil }
        let available = CGSize(width: max(1, size.width - padding.left - padding.right),
                               height: max(1, size.height - padding.top - padding.bottom))
        let needed = max(rect.size.width / Double(available.width), rect.size.height / Double(available.height))
        return needed > 0 ? Self.worldZoom - log2(needed) : Self.maxZoom
    }

    /// 以 zoom 显示，并让 rect 的中心落在扣掉 padding 后的区域中央（padding 不对称时把地图中心往反方向挪）
    private func moveCamera(to rect: MKMapRect, padding: UIEdgeInsets, zoom target: Double, animated: Bool) {
        let scale = Self.scale(for: target)
        let dx = Double(padding.left - padding.right) / 2 * scale
        let dy = Double(padding.top - padding.bottom) / 2 * scale
        let center = MKMapPoint(x: rect.midX - dx, y: rect.midY - dy)
        setCamera(center: center.coordinate, zoom: target, animated: animated)
    }

    func cameraPayload(phase: String, gesture: Bool = false) -> [String: Any] {
        let center = mapView.centerCoordinate
        let rect = mapView.visibleMapRect
        let topLeft = MKMapPoint(x: rect.minX, y: rect.minY).coordinate
        let bottomRight = MKMapPoint(x: rect.maxX, y: rect.maxY).coordinate
        return [
            "phase": phase,
            "lng": center.longitude,
            "lat": center.latitude,
            "zoom": zoom,
            "minLng": topLeft.longitude,
            "maxLat": topLeft.latitude,
            "maxLng": bottomRight.longitude,
            "minLat": bottomRight.latitude,
            "width": Double(mapView.bounds.width),
            "height": Double(mapView.bounds.height),
            "gesture": gesture
        ]
    }

    private var userGestureActive: Bool {
        let recognizers = (mapView.subviews.first?.gestureRecognizers ?? []) + (mapView.gestureRecognizers ?? [])
        return recognizers.contains { $0.state == .began || $0.state == .changed }
    }

    // MARK: - 外观

    /// dark 跟网页的深浅色；muted 为高德的浅色 / 灰色样式（标准地图的柔和强调）
    func setAppearance(dark: Bool, muted: Bool) {
        mapView.overrideUserInterfaceStyle = dark ? .dark : .light
        let emphasis: MKStandardMapConfiguration.EmphasisStyle = muted ? .muted : .default
        if let current = mapView.preferredConfiguration as? MKStandardMapConfiguration, current.emphasisStyle == emphasis { return }
        mapView.preferredConfiguration = MKStandardMapConfiguration(elevationStyle: .flat, emphasisStyle: emphasis)
    }

    /// 被工具栏、状态栏挡住的边距：苹果地图标志与“法律信息”放在边距之内，不被控件盖住
    func setInsets(_ insets: UIEdgeInsets) {
        if mapView.layoutMargins != insets { mapView.layoutMargins = insets }
    }

    // MARK: - 标记

    func setStyle(_ next: NativeMapMarkerStyle) {
        style = next
        for annotation in mapView.annotations {
            guard let view = mapView.view(for: annotation) else { continue }
            if let place = annotation as? NativeMapPlaceAnnotation, let placeView = view as? NativeMapPlaceView {
                placeView.configure(place, style: style)
            } else if let cluster = annotation as? MKClusterAnnotation, let clusterView = view as? NativeMapClusterView {
                clusterView.configure(count: cluster.memberAnnotations.count, style: style)
            }
        }
    }

    /// 整份替换当前要显示的地点：只增删变化的部分，坐标变化原地移动，名称、图标变化原地重画
    func setPlaces(_ next: [NativeMapPlaceInput], selected: String?) {
        selectedId = selected
        var seen = Set<String>()
        var added: [NativeMapPlaceAnnotation] = []
        var reinserted: [NativeMapPlaceAnnotation] = []
        for input in next {
            guard !seen.contains(input.id) else { continue }
            seen.insert(input.id)
            let isSelected = input.id == selected
            if let existing = places[input.id] {
                let clusteringChanged = existing.selected != isSelected
                let appearanceChanged = existing.name != input.name || existing.glyph != input.glyph || clusteringChanged
                if existing.coordinate.latitude != input.coordinate.latitude || existing.coordinate.longitude != input.coordinate.longitude {
                    existing.coordinate = input.coordinate
                }
                existing.name = input.name
                existing.glyph = input.glyph
                existing.accessibility = input.accessibility
                existing.selected = isSelected
                if clusteringChanged {
                    // 选中的地点不参与聚合：重新加入，MapKit 才会重新计算聚合
                    reinserted.append(existing)
                } else if appearanceChanged, let view = mapView.view(for: existing) as? NativeMapPlaceView {
                    view.configure(existing, style: style)
                }
            } else {
                let annotation = NativeMapPlaceAnnotation(input: input, selected: isSelected)
                places[input.id] = annotation
                added.append(annotation)
            }
        }
        let removed = places.filter { !seen.contains($0.key) }
        for key in removed.keys { places.removeValue(forKey: key) }
        if !removed.isEmpty || !reinserted.isEmpty { mapView.removeAnnotations(Array(removed.values) + reinserted) }
        if !added.isEmpty || !reinserted.isEmpty { mapView.addAnnotations(added + reinserted) }
    }

    func setSelected(_ id: String?) {
        guard id != selectedId else { return }
        let previous = selectedId
        selectedId = id
        var changed: [NativeMapPlaceAnnotation] = []
        for key in [previous, id].compactMap({ $0 }) {
            guard let place = places[key] else { continue }
            place.selected = key == id
            changed.append(place)
        }
        guard !changed.isEmpty else { return }
        mapView.removeAnnotations(changed)
        mapView.addAnnotations(changed)
    }

    /// 点聚合：能放大拆开就把成员放进可见区域；成员重合或已到最大缩放时交给网页列出成员
    private func expand(_ cluster: MKClusterAnnotation) {
        let members = cluster.memberAnnotations.compactMap { $0 as? NativeMapPlaceAnnotation }
        guard !members.isEmpty else { return }
        var rect = MKMapRect.null
        for member in members {
            rect = rect.union(MKMapRect(origin: MKMapPoint(member.coordinate), size: MKMapSize(width: 0, height: 0)))
        }
        // 同一位置（几个点在最大缩放下也不到 1 个屏幕点）放大也拆不开
        let samePlace = rect.size.width / Self.scale(for: Self.maxZoom) < 1 && rect.size.height / Self.scale(for: Self.maxZoom) < 1
        let current = zoom
        if samePlace || current >= Self.maxZoom - 0.05 {
            onClusterMembers?(members.map(\.id), cluster.coordinate)
            return
        }
        let margins = mapView.layoutMargins
        let pad: CGFloat = 48
        let padding = UIEdgeInsets(top: margins.top + pad, left: pad, bottom: margins.bottom + pad, right: pad)
        guard let fit = fitZoom(rect, padding: padding) else { return }
        // 至少放大到下一级：成员本来就都在视野里时相机也要动，聚合才会拆开（与网页 handleClusterClick 相同）
        let target = Self.clampZoom(max(fit, ceil(current + 0.01)))
        moveCamera(to: rect, padding: padding, zoom: target, animated: true)
    }

    // MARK: - 覆盖物（添加地点的图钉、我的位置、路线与起终点、日记站点）

    func setOverlays(markers: [NativeMapOverlayInput], lines: [NativeMapPolylineInput]) {
        var seen = Set<String>()
        var added: [NativeMapOverlayAnnotation] = []
        var replaced: [NativeMapOverlayAnnotation] = []
        for input in markers {
            guard !seen.contains(input.id) else { continue }
            seen.insert(input.id)
            if let existing = overlayAnnotations[input.id], existing.input.kind == input.kind {
                if existing.input != input {
                    let moved = existing.coordinate.latitude != input.coordinate.latitude || existing.coordinate.longitude != input.coordinate.longitude
                    existing.input = input
                    if moved { existing.coordinate = input.coordinate }
                    (mapView.view(for: existing) as? NativeMapOverlayView)?.configure(existing, appearing: false)
                }
            } else {
                if let old = overlayAnnotations[input.id] { replaced.append(old) }
                let annotation = NativeMapOverlayAnnotation(input: input)
                overlayAnnotations[input.id] = annotation
                added.append(annotation)
            }
        }
        let removed = overlayAnnotations.filter { !seen.contains($0.key) }
        for key in removed.keys { overlayAnnotations.removeValue(forKey: key) }
        if !removed.isEmpty || !replaced.isEmpty { mapView.removeAnnotations(Array(removed.values) + replaced) }
        if !added.isEmpty { mapView.addAnnotations(added) }

        // 路线：路径相同只改颜色、粗细（高亮切换不闪）；路径变了整条替换。按 zIndex 从低到高叠放
        var lineIds = Set<String>()
        var stale: [NativeMapPolyline] = []
        var fresh: [NativeMapPolyline] = []
        for input in lines {
            guard !lineIds.contains(input.id) else { continue }
            lineIds.insert(input.id)
            if let existing = polylines[input.id], existing.pathSignature == input.pathSignature {
                if existing.input != input {
                    existing.input = input
                    if let renderer = mapView.renderer(for: existing) as? MKPolylineRenderer {
                        existing.apply(to: renderer)
                        renderer.setNeedsDisplay()
                    }
                }
                continue
            }
            if let existing = polylines[input.id] { stale.append(existing) }
            let line = NativeMapPolyline.make(input)
            polylines[input.id] = line
            fresh.append(line)
        }
        for (key, line) in polylines where !lineIds.contains(key) {
            stale.append(line)
            polylines.removeValue(forKey: key)
        }
        if !stale.isEmpty { mapView.removeOverlays(stale) }
        if !fresh.isEmpty {
            // 高亮的路线在最上面：整组按 zIndex 重新排序
            let ordered = polylines.values.sorted { $0.input.zIndex < $1.input.zIndex }
            mapView.removeOverlays(ordered.filter { !fresh.contains($0) })
            mapView.addOverlays(ordered, level: .aboveRoads)
        }
    }

    // MARK: - 点按地图空白处

    private func installTap() {
        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap(_:)))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        mapView.addGestureRecognizer(tap)
        tapRecognizer = tap
    }

    private var doubleTapLinked = false

    /// 双击放大不能同时算作一次点按：等 MapKit 的双击识别失败后再处理
    private func requireDoubleTapFailure() {
        guard let tap = tapRecognizer, !doubleTapLinked else { return }
        doubleTapLinked = true
        let recognizers = (mapView.subviews.first?.gestureRecognizers ?? []) + (mapView.gestureRecognizers ?? [])
        for case let doubleTap as UITapGestureRecognizer in recognizers where doubleTap !== tap && doubleTap.numberOfTapsRequired == 2 {
            tap.require(toFail: doubleTap)
        }
    }

    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        guard gesture.state == .ended else { return }
        let point = gesture.location(in: mapView)
        // 点在标记上由选中回调处理
        var view = mapView.hitTest(point, with: nil)
        while let current = view {
            if current is MKAnnotationView { return }
            view = current.superview
        }
        onTap?(mapView.convert(point, toCoordinateFrom: mapView))
    }
}

extension NativeMapController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

extension NativeMapController: MKMapViewDelegate {
    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        if let place = annotation as? NativeMapPlaceAnnotation {
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: NativeMapPlaceView.reuseId, for: place)
            (view as? NativeMapPlaceView)?.configure(place, style: style)
            return view
        }
        if let cluster = annotation as? MKClusterAnnotation {
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: NativeMapClusterView.reuseId, for: cluster)
            (view as? NativeMapClusterView)?.configure(count: cluster.memberAnnotations.count, style: style)
            return view
        }
        if let overlay = annotation as? NativeMapOverlayAnnotation {
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: NativeMapOverlayView.reuseId, for: overlay)
            (view as? NativeMapOverlayView)?.configure(overlay, appearing: true)
            return view
        }
        return nil
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        guard let line = overlay as? NativeMapPolyline else { return MKOverlayRenderer(overlay: overlay) }
        let renderer = MKPolylineRenderer(polyline: line)
        line.apply(to: renderer)
        return renderer
    }

    func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
        guard let annotation = view.annotation else { return }
        // 选中状态由网页决定（setSelected）：系统的选中立即取消，同一个标记可以再点
        DispatchQueue.main.async { mapView.deselectAnnotation(annotation, animated: false) }
        if let cluster = annotation as? MKClusterAnnotation {
            expand(cluster)
        } else if let place = annotation as? NativeMapPlaceAnnotation {
            onMarkerTap?(place.id)
        }
    }

    func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
        guard !mapView.isHidden, !moving else { return }
        moving = true
        moveStartZoom = zoom
        onCamera?(cameraPayload(phase: "start", gesture: userGestureActive))
    }

    func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
        guard !mapView.isHidden, moving else { return }
        let now = CACurrentMediaTime()
        guard now - lastChangeEmit >= Self.changeInterval else { return }
        lastChangeEmit = now
        onCamera?(cameraPayload(phase: "change", gesture: userGestureActive))
    }

    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
        guard !mapView.isHidden else { return }
        moving = false
        var payload = cameraPayload(phase: "end")
        payload["zoomChanged"] = abs(zoom - moveStartZoom) > 0.001
        onCamera?(payload)
    }
}

// MARK: - 数据

/// 网页下发的一个地点（标记只需要这些字段）
struct NativeMapPlaceInput {
    let id: String
    let coordinate: CLLocationCoordinate2D
    let name: String
    /// 图标种类：place / avoid / unexplored / add（与 markerContent.js 的 placeGlyphKind 相同）
    let glyph: String
    let accessibility: String
}

final class NativeMapPlaceAnnotation: NSObject, MKAnnotation {
    let id: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var name: String
    var glyph: String
    var accessibility: String
    var selected: Bool

    init(input: NativeMapPlaceInput, selected: Bool) {
        id = input.id
        coordinate = input.coordinate
        name = input.name
        glyph = input.glyph
        accessibility = input.accessibility
        self.selected = selected
    }

    var title: String? { name }
    var avoid: Bool { glyph == "avoid" }
}

/// 标记的图标与名称样式：网页按当前主题色、皮肤与深浅色算好后下发（与 marker-motion.css 同一套取值）
struct NativeMapMarkerStyle {
    /// 单点图标：键为图标种类，值为图片地址（App 包内资源 capacitor://localhost/assets/… 或 data URL）
    var glyphs: [String: String] = [:]
    var glyphSize = CGSize(width: 36, height: 43)
    var clusterImage: String?
    /// 聚合图的可见区域（按图片宽高的比例）：默认聚合图裁去透明留白，皮肤图用整张画布
    var clusterCrop: CGRect?
    var clusterBaseSize = CGSize(width: 36, height: 52)
    var countPosition = CGPoint(x: 0.5, y: 0.35)
    var countColor = UIColor(red: 0x2B / 255.0, green: 0x25 / 255.0, blue: 0x33 / 255.0, alpha: 1)
    var labelText: UIColor = .label
    var labelBackground: UIColor = .systemBackground
    var labelBorder = UIColor(red: 0xE2 / 255.0, green: 0x78 / 255.0, blue: 0x9F / 255.0, alpha: 1)
    var avoidText: UIColor = .systemRed
    var avoidBackground: UIColor = .secondarySystemBackground
    var avoidBorder: UIColor = .systemRed
    /// 与网页聚合半径（CLUSTER_DEFAULTS.radiusPx）相当的碰撞框边长：框相互重叠时 MapKit 合并为聚合
    var collisionSize: CGFloat = 68
    /// 读屏：地点名后的后缀（避雷、待探索、未收录）与聚合的读法（%d 为数量）
    var kindSuffix: [String: String] = [:]
    var clusterLabel = "%d 个地点"
}

/// 网页下发的一个覆盖物标记
struct NativeMapOverlayInput: Equatable {
    let id: String
    /// location（我的位置蓝点）/ pin（添加地点的图钉）/ badge（圆形徽记：路线起终点、日记站点序号）
    let kind: String
    let coordinate: CLLocationCoordinate2D
    var text: String?
    var fill: UIColor
    var textColor: UIColor
    var border: UIColor?
    var size: CGFloat
    var zIndex: Int
    var label: String?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.kind == rhs.kind && lhs.coordinate.latitude == rhs.coordinate.latitude
            && lhs.coordinate.longitude == rhs.coordinate.longitude && lhs.text == rhs.text && lhs.fill == rhs.fill
            && lhs.textColor == rhs.textColor && lhs.border == rhs.border && lhs.size == rhs.size && lhs.zIndex == rhs.zIndex
            && lhs.label == rhs.label
    }
}

final class NativeMapOverlayAnnotation: NSObject, MKAnnotation {
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var input: NativeMapOverlayInput

    init(input: NativeMapOverlayInput) {
        self.input = input
        coordinate = input.coordinate
    }

    var title: String? { input.label }
}

struct NativeMapPolylineInput: Equatable {
    let id: String
    let coordinates: [CLLocationCoordinate2D]
    var color: UIColor
    var width: CGFloat
    var opacity: CGFloat
    var dashed: Bool
    var zIndex: Int

    var pathSignature: String {
        guard let first = coordinates.first, let last = coordinates.last else { return "0" }
        return "\(coordinates.count)|\(first.latitude),\(first.longitude)|\(last.latitude),\(last.longitude)"
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id && lhs.pathSignature == rhs.pathSignature && lhs.color == rhs.color && lhs.width == rhs.width
            && lhs.opacity == rhs.opacity && lhs.dashed == rhs.dashed && lhs.zIndex == rhs.zIndex
    }
}

final class NativeMapPolyline: MKPolyline {
    var input = NativeMapPolylineInput(id: "", coordinates: [], color: .systemPink, width: 5, opacity: 1, dashed: false, zIndex: 0)
    var pathSignature: String { input.pathSignature }

    static func make(_ input: NativeMapPolylineInput) -> NativeMapPolyline {
        var coordinates = input.coordinates
        let line = NativeMapPolyline(coordinates: &coordinates, count: coordinates.count)
        line.input = input
        return line
    }

    func apply(to renderer: MKPolylineRenderer) {
        renderer.strokeColor = input.color.withAlphaComponent(input.opacity)
        renderer.lineWidth = input.width
        renderer.lineCap = .round
        renderer.lineJoin = .round
        renderer.lineDashPattern = input.dashed ? [NSNumber(value: Double(input.width) * 1.6), NSNumber(value: Double(input.width) * 1.6)] : nil
    }
}

// MARK: - 图片

/// 标记图片：读取网页下发的地址（同 MapChromeSkinImages），按显示尺寸预先缩好并缓存，避免每个标记都缩放大图
enum NativeMapImages {
    private static let cache = NSCache<NSString, UIImage>()

    static func image(_ source: String?, size: CGSize, crop: CGRect? = nil) -> UIImage? {
        guard let source, size.width > 0, size.height > 0 else { return nil }
        let key = "\(source.hashValue)|\(source.count)|\(size.width)x\(size.height)|\(crop.map { "\($0)" } ?? "")" as NSString
        if let cached = cache.object(forKey: key) { return cached }
        guard var base = MapChromeSkinImages.local(source) else { return nil }
        if let crop, let cg = base.cgImage {
            let pixels = CGRect(x: crop.minX * CGFloat(cg.width), y: crop.minY * CGFloat(cg.height),
                                width: crop.width * CGFloat(cg.width), height: crop.height * CGFloat(cg.height)).integral
            if let part = cg.cropping(to: pixels) { base = UIImage(cgImage: part, scale: base.scale, orientation: base.imageOrientation) }
        }
        // 按比例放进框内、居中（网页图标的素材比例与框相同，效果一致）
        guard base.size.width > 0, base.size.height > 0 else { return nil }
        let ratio = min(size.width / base.size.width, size.height / base.size.height)
        let drawn = CGSize(width: base.size.width * ratio, height: base.size.height * ratio)
        let fitted = CGRect(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2, width: drawn.width, height: drawn.height)
        let rendered = UIGraphicsImageRenderer(size: size).image { _ in base.draw(in: fitted) }
        cache.setObject(rendered, forKey: key)
        return rendered
    }

    static var fallbackPin: UIImage? {
        UIImage(systemName: "mappin.circle.fill")?.withTintColor(.systemPink, renderingMode: .alwaysOriginal)
    }
}

/// 与网页 cluster/glyph.js 相同的尺寸与数量格式（改动时两边一起改）
enum NativeMapGlyph {
    static func clusterScale(_ count: Int) -> CGFloat {
        guard count >= 2 else { return 1 }
        let growth = min(0.55, 0.09 * log2(max(1, Double(count) / 2)))
        return CGFloat(1 + growth * (0.3 / 0.55))
    }

    static func formatCount(_ count: Int) -> String {
        if count < 1000 { return String(count) }
        if count < 10000 {
            let value = floor(Double(count) / 100) / 10
            let text = String(format: "%.1f", value)
            return (text.hasSuffix(".0") ? String(text.dropLast(2)) : text) + "k"
        }
        return "\(count / 1000)k"
    }

    static func countFontSize(_ text: String, scale: CGFloat) -> CGFloat {
        let base: CGFloat = text.count <= 2 ? 20 : text.count == 3 ? 16 : 13
        return (base * scale * 10).rounded() / 10
    }
}

// MARK: - 标注视图

/// 地点名称：12pt，内边距 2/8/2/6，圆角 8，1pt 描边，与网页 .fm-marker__label 相同
final class NativeMapNameLabel: UILabel {
    static let height: CGFloat = 22
    static let maxWidth: CGFloat = 140
    /// 内边距加 1pt 描边
    static let insets = UIEdgeInsets(top: 3, left: 7, bottom: 3, right: 9)

    override init(frame: CGRect) {
        super.init(frame: frame)
        numberOfLines = 1
        lineBreakMode = .byTruncatingTail
        textAlignment = .left
        layer.cornerRadius = 8
        layer.borderWidth = 1
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = 0.15
        layer.shadowRadius = 2
        layer.shadowOffset = CGSize(width: 0, height: 1)
        isUserInteractionEnabled = false
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func drawText(in rect: CGRect) {
        super.drawText(in: rect.inset(by: Self.insets))
    }

    func apply(name: String, avoid: Bool, selected: Bool, style: NativeMapMarkerStyle) {
        text = name
        font = .systemFont(ofSize: 12, weight: selected ? .semibold : .regular)
        textColor = avoid ? style.avoidText : style.labelText
        layer.backgroundColor = (avoid ? style.avoidBackground : style.labelBackground).cgColor
        layer.borderColor = (avoid ? style.avoidBorder : style.labelBorder).cgColor
    }

    var fittingWidth: CGFloat {
        let textWidth = (text ?? "").size(withAttributes: [.font: font ?? UIFont.systemFont(ofSize: 12)]).width
        return min(Self.maxWidth, ceil(textWidth) + Self.insets.left + Self.insets.right)
    }
}

/// 单个地点：36×43 图标（底边中点在坐标上）与下方的名称。碰撞框取网页的聚合半径，图标居中，
/// 名称画在框外、不参与碰撞；点按范围是图标（至少 44×44）与名称。
final class NativeMapPlaceView: MKAnnotationView {
    static let reuseId = "fm.place"
    private let glyphView = UIImageView()
    private let label = NativeMapNameLabel(frame: .zero)
    private var glyphFrame = CGRect.zero

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        clipsToBounds = false
        canShowCallout = false
        collisionMode = .rectangle
        glyphView.contentMode = .center
        addSubview(glyphView)
        addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(_ place: NativeMapPlaceAnnotation, style: NativeMapMarkerStyle) {
        let glyph = style.glyphSize
        let box = CGSize(width: max(glyph.width, style.collisionSize), height: max(glyph.height, style.collisionSize))
        bounds = CGRect(origin: .zero, size: box)
        // 视图中心对准图标中心：图标底边中点落在坐标上
        centerOffset = CGPoint(x: 0, y: -glyph.height / 2)
        glyphFrame = CGRect(x: (box.width - glyph.width) / 2, y: (box.height - glyph.height) / 2, width: glyph.width, height: glyph.height)
        glyphView.frame = glyphFrame
        glyphView.image = NativeMapImages.image(style.glyphs[place.glyph] ?? style.glyphs["place"], size: glyph) ?? NativeMapImages.fallbackPin
        label.apply(name: place.name, avoid: place.avoid, selected: place.selected, style: style)
        let width = label.fittingWidth
        label.frame = CGRect(x: (box.width - width) / 2, y: glyphFrame.maxY + 3, width: width, height: NativeMapNameLabel.height)
        label.isHidden = place.name.isEmpty
        clusteringIdentifier = place.selected ? nil : NativeMapController.clusterIdentifier
        displayPriority = place.selected ? .required : .defaultHigh
        zPriority = place.selected ? .max : .defaultUnselected
        let suffix = style.kindSuffix[place.glyph] ?? ""
        accessibilityLabel = place.name.isEmpty ? place.accessibility : place.name + suffix
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        let hit = glyphFrame.insetBy(dx: -max(4, (44 - glyphFrame.width) / 2), dy: -max(2, (44 - glyphFrame.height) / 2))
        return hit.contains(point) || (!label.isHidden && label.frame.contains(point))
    }
}

/// 聚合点：聚合图（大小随数量增长到 1.3 倍）与数量，碰撞框同单点
final class NativeMapClusterView: MKAnnotationView {
    static let reuseId = "fm.cluster"
    private let imageView = UIImageView()
    private let countLabel = UILabel()
    private var glyphFrame = CGRect.zero

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        clipsToBounds = false
        canShowCallout = false
        collisionMode = .rectangle
        imageView.contentMode = .center
        countLabel.textAlignment = .center
        countLabel.adjustsFontSizeToFitWidth = false
        countLabel.isAccessibilityElement = false
        addSubview(imageView)
        addSubview(countLabel)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func configure(count: Int, style: NativeMapMarkerStyle) {
        let scale = NativeMapGlyph.clusterScale(count)
        let glyph = CGSize(width: (style.clusterBaseSize.width * scale * 10).rounded() / 10,
                           height: (style.clusterBaseSize.height * scale * 10).rounded() / 10)
        let box = CGSize(width: max(glyph.width, style.collisionSize), height: max(glyph.height, style.collisionSize))
        bounds = CGRect(origin: .zero, size: box)
        centerOffset = CGPoint(x: 0, y: -glyph.height / 2)
        glyphFrame = CGRect(x: (box.width - glyph.width) / 2, y: (box.height - glyph.height) / 2, width: glyph.width, height: glyph.height)
        imageView.frame = glyphFrame
        imageView.image = NativeMapImages.image(style.clusterImage, size: glyph, crop: style.clusterCrop) ?? NativeMapImages.fallbackPin
        let text = NativeMapGlyph.formatCount(count)
        countLabel.text = text
        countLabel.font = .monospacedDigitSystemFont(ofSize: NativeMapGlyph.countFontSize(text, scale: scale), weight: .semibold)
        countLabel.textColor = style.countColor
        countLabel.sizeToFit()
        countLabel.center = CGPoint(x: glyphFrame.minX + glyph.width * style.countPosition.x,
                                    y: glyphFrame.minY + glyph.height * style.countPosition.y)
        displayPriority = .defaultHigh
        zPriority = MKAnnotationViewZPriority(rawValue: MKAnnotationViewZPriority.defaultUnselected.rawValue + Float(min(40, log2(Double(max(count, 1))) * 4)))
        accessibilityLabel = style.clusterLabel.replacingOccurrences(of: "%d", with: String(count))
    }

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        glyphFrame.insetBy(dx: -max(4, (44 - glyphFrame.width) / 2), dy: -max(2, (44 - glyphFrame.height) / 2)).contains(point)
    }
}

/// 覆盖物标记：不参与聚合、总在地点标记上方、不可点（点按交给地图）
final class NativeMapOverlayView: MKAnnotationView {
    static let reuseId = "fm.overlay"
    private let pulse = CAShapeLayer()
    private let dot = UIView()
    private let symbolView = UIImageView()
    private let textLabel = UILabel()
    private var shownId: String?

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        clipsToBounds = false
        canShowCallout = false
        isEnabled = false
        layer.addSublayer(pulse)
        addSubview(dot)
        addSubview(symbolView)
        dot.addSubview(textLabel)
        textLabel.textAlignment = .center
        symbolView.contentMode = .scaleAspectFit
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        pulse.removeAllAnimations()
        transform = .identity
        alpha = 1
        shownId = nil
    }

    func configure(_ annotation: NativeMapOverlayAnnotation, appearing: Bool) {
        let input = annotation.input
        clusteringIdentifier = nil
        displayPriority = .required
        zPriority = MKAnnotationViewZPriority(rawValue: MKAnnotationViewZPriority.max.rawValue - Float(max(0, 1000 - input.zIndex)) / 100)
        isAccessibilityElement = input.label != nil
        accessibilityLabel = input.label
        pulse.isHidden = true
        dot.isHidden = true
        symbolView.isHidden = true
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        switch input.kind {
        case "location":
            // 与网页 .fm-user-location 相同：44 的呼吸光圈 + 18 的蓝点、3pt 白边
            bounds = CGRect(x: 0, y: 0, width: 44, height: 44)
            centerOffset = .zero
            pulse.isHidden = false
            pulse.frame = bounds
            pulse.path = UIBezierPath(ovalIn: bounds).cgPath
            pulse.fillColor = input.fill.withAlphaComponent(0.28).cgColor
            if !reduceMotion && pulse.animation(forKey: "pulse") == nil {
                let scale = CABasicAnimation(keyPath: "transform.scale")
                scale.fromValue = 0.4
                scale.toValue = 1
                let fade = CABasicAnimation(keyPath: "opacity")
                fade.fromValue = 1
                fade.toValue = 0
                let group = CAAnimationGroup()
                group.animations = [scale, fade]
                group.duration = 2
                group.timingFunction = CAMediaTimingFunction(name: .easeOut)
                group.repeatCount = .infinity
                pulse.add(group, forKey: "pulse")
            }
            dot.isHidden = false
            dot.frame = CGRect(x: 13, y: 13, width: 18, height: 18)
            dot.layer.cornerRadius = 9
            dot.backgroundColor = input.fill
            dot.layer.borderWidth = 3
            dot.layer.borderColor = (input.border ?? .white).cgColor
            applyShadow(to: dot.layer, opacity: 0.35, radius: 2)
            textLabel.text = nil
        case "pin":
            // 添加地点：主题色图钉，尖端落在坐标上，出现时轻落
            let size = CGSize(width: 40, height: 44)
            bounds = CGRect(origin: .zero, size: size)
            centerOffset = CGPoint(x: 0, y: -size.height / 2)
            symbolView.isHidden = false
            symbolView.frame = bounds
            symbolView.image = UIImage(systemName: "mappin.and.ellipse",
                                       withConfiguration: UIImage.SymbolConfiguration(pointSize: 34, weight: .semibold))?
                .withTintColor(input.fill, renderingMode: .alwaysOriginal)
            applyShadow(to: symbolView.layer, opacity: 0.35, radius: 1.5)
            if appearing && shownId != input.id && !reduceMotion {
                transform = CGAffineTransform(translationX: 0, y: -14)
                alpha = 0
                UIView.animate(withDuration: 0.32, delay: 0, usingSpringWithDamping: 0.7, initialSpringVelocity: 0,
                               options: [], animations: {
                    self.transform = .identity
                    self.alpha = 1
                }, completion: nil)
            }
        default:
            // badge：路线起终点、日记站点序号
            let side = max(20, input.size)
            bounds = CGRect(x: 0, y: 0, width: side, height: side)
            centerOffset = .zero
            dot.isHidden = false
            dot.frame = bounds
            dot.layer.cornerRadius = side / 2
            dot.backgroundColor = input.fill
            dot.layer.borderWidth = input.border == nil ? 0 : 2
            dot.layer.borderColor = input.border?.cgColor
            applyShadow(to: dot.layer, opacity: 0.12, radius: 4)
            textLabel.frame = dot.bounds
            textLabel.text = input.text
            textLabel.textColor = input.textColor
            textLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .bold)
        }
        shownId = input.id
    }

    private func applyShadow(to layer: CALayer, opacity: Float, radius: CGFloat) {
        layer.shadowColor = UIColor.black.cgColor
        layer.shadowOpacity = opacity
        layer.shadowRadius = radius
        layer.shadowOffset = CGSize(width: 0, height: 1)
    }
}
