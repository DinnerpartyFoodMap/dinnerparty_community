import UIKit
import MapKit

/// 原生底图（MapKit）：放在透明 WebView 下面。地点、聚合点、数量与名称都是 MapKit 的标注视图，
/// 拖动、缩放时由 MapKit 在同一帧里移动，不经过网页。
///
/// 聚合与网页相同：网页的聚合引擎（Supercluster）算出新的节点和转场计划（谁沿用、谁从哪个聚合拆出、
/// 谁并进哪个聚合，src/map/cluster/transitions.js），原生按计划用 Core Animation 播放与网页同样节奏的动画
/// （MARKER_TIMING：拆分 320ms 从父聚合位置飞出；合并 260ms 吸向父聚合并缩小，父聚合延迟 110ms 回弹出现）。
/// 动画在系统渲染进程里逐帧执行。网页在相机移动中（捏合、松手后的减速、动画）收到 change 事件，聚合层级一变就发计划，
/// 不等减速结束的 regionDidChange。新的手势开始时，进行中的转场立即收敛到终态（同网页）。
///
/// 缩放级别与网页、高德一致（Web Mercator、256 像素瓦片）：MKMapSize.world 宽 2^28 = 256·2^20，
/// 所以 z = 20 − log2(可见 MKMapRect 宽度 / 视图宽度)。地图不旋转、不倾斜，网页按同一公式在 JS 里投影。
/// 坐标由网页换算好（map/nativeMapFrames.js 按校准结果把店铺坐标转成这台手机上底图用的坐标）。
final class NativeMapController: NSObject {
    static let minZoom: Double = 3
    static let maxZoom: Double = 20
    /// MKMapPoint 与 256 像素瓦片缩放级别的换算基准（log2(2^28 / 256) = 20）
    static let worldZoom = log2(MKMapSize.world.width / 256)
    /// 拖动、缩放过程中的相机事件最多这么频繁（秒）：网页据此在移动中切换聚合层级，间隔即最大延迟
    static let changeInterval: CFTimeInterval = 0.05
    /// 一次转场最多播放这么多个节点的动画（网页 LIMITS.travelers）；超出时直接到终态
    static let animatedNodeLimit = 400
    /// 屏幕外这么远的节点不播放动画（网页 ONSCREEN_MARGIN）
    static let onscreenMargin: CGFloat = 80
    /// 相机修正的试探缩放范围（见 calibrateCameraFit）
    static let calibrationZoomRange: ClosedRange<Double> = 6...17

    let mapView: MKMapView

    var onCamera: (([String: Any]) -> Void)?
    var onTap: ((CLLocationCoordinate2D) -> Void)?
    var onMarkerTap: ((String) -> Void)?
    var onClusterTap: ((String) -> Void)?

    private(set) var style = NativeMapMarkerStyle()
    private var nodes: [String: NativeMapNodeAnnotation] = [:]
    private var ghosts: [NativeMapNodeAnnotation] = []
    private var transition = 0
    private var selectedId: String?
    private var overlayAnnotations: [String: NativeMapOverlayAnnotation] = [:]
    private var polylines: [String: NativeMapPolyline] = [:]
    private var moving = false
    private var moveStartZoom: Double = 0
    private var lastChangeEmit: CFTimeInterval = 0
    private var tapRecognizer: UITapGestureRecognizer?
    private var doubleTapLinked = false
    /// 设置相机时 MapKit 实际落下的范围与请求的关系（见 calibrateCameraFit）
    private var cameraFit: NativeMapCameraFit?
    /// 试探期间的区域变化在同一帧内完成，不回传相机事件
    private var calibratingCamera = false

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
        mapView.register(NativeMapNodeView.self, forAnnotationViewWithReuseIdentifier: NativeMapNodeView.reuseId)
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
        transition += 1
        mapView.isHidden = true
        mapView.removeAnnotations(mapView.annotations)
        mapView.removeOverlays(mapView.overlays)
        nodes.removeAll()
        ghosts.removeAll()
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

    /// 中心在 center、缩放为 zoom 时整个视图对应的地图矩形（与网页 viewport.js 同一公式）
    private func cameraRect(center: MKMapPoint, zoom: Double) -> MKMapRect {
        let size = mapView.bounds.size
        let scale = Self.scale(for: zoom)
        let width = Double(size.width) * scale
        let height = Double(size.height) * scale
        return MKMapRect(x: center.x - width / 2, y: center.y - height / 2, width: width, height: height)
    }

    /// 当前视图中心（可见矩形的中点）：相机事件、平移都以它为准，与网页的投影（中心在视图正中）一致
    private var visibleCenter: MKMapPoint {
        let rect = mapView.visibleMapRect
        return MKMapPoint(x: rect.midX, y: rect.midY)
    }

    func setCamera(center: CLLocationCoordinate2D, zoom: Double, animated: Bool) {
        let size = mapView.bounds.size
        guard size.width > 0, size.height > 0, CLLocationCoordinate2DIsValid(center) else { return }
        calibrateCameraFit()
        let target = cameraRect(center: MKMapPoint(center), zoom: Self.clampZoom(zoom))
        let request = cameraFit?.request(for: target, viewWidth: Double(size.width)) ?? target
        mapView.setVisibleMapRect(request, animated: animated)
    }

    /// MapKit 设置可见范围时会把矩形放进它自己的可见区域再显示（安全区、layoutMargins 等都可能参与，没有接口可查），
    /// 实际落下的缩放可能比请求的小、中心也可能偏：点聚合放大到展开层级时只放大一点点、聚合拆不开，
    /// 补放大落到同一个位置后只能打开成员列表。视图尺寸或边距变化后，用当前相机同步试探一次：
    /// 设置一个与 setCamera 同样构造的矩形、读回实际范围、再按结果恢复原样（同一帧内完成，不回传相机事件），
    /// 得到“实际宽度 = 请求宽度 × 比例、实际中心 = 请求中心 + 偏移（屏幕点）”，之后每次设置相机都先按它修正请求。
    /// MapKit 没有改动请求时比例为 1、偏移为 0，修正不起作用。
    private func calibrateCameraFit() {
        let size = mapView.bounds.size
        let margins = mapView.layoutMargins
        let safe = mapView.safeAreaInsets
        let key = "\(size.width)x\(size.height)|\(margins.top),\(margins.left),\(margins.bottom),\(margins.right)|\(safe.top),\(safe.left),\(safe.bottom),\(safe.right)"
        // 动画、手势进行中不试探（会打断它）：沿用上一次的结果
        guard cameraFit?.key != key, !moving, !mapView.isHidden, mapView.window != nil, size.width > 0, size.height > 0 else { return }
        let visible = mapView.visibleMapRect
        guard !visible.isNull, visible.size.width > 0 else { return }
        let center = MKMapPoint(x: visible.midX, y: visible.midY)
        let current = zoom
        // 试探放在中间的缩放：太小（刚显示时的全国视野）或太大时 MapKit 自己的缩放上下限会截住试探，量出错误的比例
        let probeZoom = min(Self.calibrationZoomRange.upperBound, max(Self.calibrationZoomRange.lowerBound, current))
        let probe = cameraRect(center: center, zoom: probeZoom)
        calibratingCamera = true
        defer { calibratingCamera = false }
        mapView.setVisibleMapRect(probe, animated: false)
        let fit = NativeMapCameraFit.measure(key: key, requested: probe, actual: mapView.visibleMapRect, viewSize: size)
        cameraFit = fit
        // 试探改变了相机：按刚得到的修正回到原来的范围
        if !fit.isIdentity || probeZoom != current {
            mapView.setVisibleMapRect(fit.request(for: cameraRect(center: center, zoom: current), viewWidth: Double(size.width)), animated: false)
        }
    }

    /// 地图中心不变，按屏幕点平移（网页的 panBy：正值让内容向右下移动）
    func panBy(dx: Double, dy: Double, animated: Bool) {
        let scale = Self.scale(for: zoom)
        let center = visibleCenter
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
        let center = visibleCenter.coordinate
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

    /// dark 跟所选样式（高德的深色样式）；muted 为高德的浅色 / 灰色样式（标准地图的柔和强调）
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

    // MARK: - 标记与聚合

    func setStyle(_ next: NativeMapMarkerStyle) {
        style = next
        for annotation in nodes.values {
            (mapView.view(for: annotation) as? NativeMapNodeView)?.configure(annotation, style: style)
        }
    }

    func setSelected(_ id: String?) {
        guard id != selectedId else { return }
        let previous = selectedId
        selectedId = id
        for key in [previous, id].compactMap({ $0 }) {
            guard let annotation = nodes[key] else { continue }
            annotation.selected = key == id
            (mapView.view(for: annotation) as? NativeMapNodeView)?.configure(annotation, style: style)
        }
    }

    /// 网页的一份新快照与转场计划。沿用的节点原地更新（位置变了从旧位置滑过去，数量变了轻微回弹）；
    /// 新节点按计划从父聚合飞出、作为汇合目标回弹出现，或淡入；离开的节点吸向父聚合、原地收拢或淡出后移除。
    func setNodes(_ inputs: [NativeMapNodeInput], plan: NativeMapTransitionPlan, animate requested: Bool, selected: String?) {
        finishTransitions()
        transition += 1
        let version = transition
        let reduced = UIAccessibility.isReduceMotionEnabled
        let animate = requested && !mapView.isHidden && mapView.window != nil && inputs.count <= Self.animatedNodeLimit
        selectedId = selected
        let previous = nodes
        var next: [String: NativeMapNodeAnnotation] = [:]
        var consumed = Set<String>()
        var added: [NativeMapNodeAnnotation] = []
        let deadline = CACurrentMediaTime() + 0.2

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in self?.completeTransition(version) }

        for input in inputs where next[input.id] == nil {
            let isSelected = input.id == selected
            let previousKey = plan.reuse[input.id] ?? (previous[input.id] != nil ? input.id : nil)
            if let previousKey, !consumed.contains(previousKey), let annotation = previous[previousKey] {
                // 沿用：同一个视图，原地更新
                consumed.insert(previousKey)
                let oldCount = annotation.count
                let wasCluster = annotation.cluster
                let moved = annotation.coordinate.latitude != input.coordinate.latitude || annotation.coordinate.longitude != input.coordinate.longitude
                let reanchor = plan.reanchor.contains(input.id)
                let fromPoint = moved && !reanchor ? point(annotation.coordinate) : .zero
                annotation.apply(input, selected: isSelected)
                if moved {
                    if reanchor {
                        UIView.performWithoutAnimation { annotation.coordinate = input.coordinate }
                    } else {
                        annotation.coordinate = input.coordinate
                    }
                }
                next[input.id] = annotation
                guard let view = mapView.view(for: annotation) as? NativeMapNodeView else { continue }
                view.configure(annotation, style: style)
                guard animate, isOnScreen(view) else { continue }
                if moved && !reanchor {
                    let to = point(input.coordinate)
                    view.playMove(from: CGPoint(x: fromPoint.x - to.x, y: fromPoint.y - to.y), reduced: reduced)
                }
                if wasCluster && input.cluster && oldCount != input.count && !reduced { view.playRecount() }
                continue
            }
            let annotation = NativeMapNodeAnnotation(input: input, selected: isSelected)
            if animate {
                if let parentKey = plan.splitFrom[input.id], let parent = previous[parentKey], !reduced {
                    // 从父聚合的位置飞出；起始大小按父聚合与自己的高度比缩小（网页 parentScale × 0.7）
                    let parentHeight = NativeMapGlyph.size(cluster: parent.cluster, count: parent.count, style: style).height
                    let ownHeight = NativeMapGlyph.size(cluster: input.cluster, count: input.count, style: style).height
                    annotation.entrance = .split(from: parent.coordinate, scale: min(1, parentHeight / max(1, ownHeight) * 0.7))
                } else if plan.mergeTargets.contains(input.id) && !reduced {
                    annotation.entrance = .mergeTarget
                } else {
                    annotation.entrance = .fade
                }
                annotation.entranceDeadline = deadline
            }
            next[input.id] = annotation
            added.append(annotation)
        }

        var removeNow: [NativeMapNodeAnnotation] = []
        for (key, annotation) in previous where !consumed.contains(key) {
            guard animate, let view = mapView.view(for: annotation) as? NativeMapNodeView, isOnScreen(view) else {
                removeNow.append(annotation)
                continue
            }
            // 残影：只做视觉过渡、不可点，转场结束后移除
            annotation.ghost = true
            view.configure(annotation, style: style)
            ghosts.append(annotation)
            if let targetKey = plan.mergeInto[key], let target = next[targetKey], !reduced {
                let from = point(annotation.coordinate)
                let to = point(target.coordinate)
                view.playMergeExit(by: CGPoint(x: to.x - from.x, y: to.y - from.y))
            } else if plan.splitSources.contains(key) && !reduced {
                view.playSplitSourceExit()
            } else {
                view.playFadeExit(reduced: reduced)
            }
        }

        nodes = next
        if !removeNow.isEmpty { mapView.removeAnnotations(removeNow) }
        if !added.isEmpty { mapView.addAnnotations(added) }
        CATransaction.commit()
    }

    /// 新的手势、新的快照到来时：进行中的转场立即收敛到终态（视图回到静止位置，残影移除）
    private func finishTransitions() {
        transition += 1
        for annotation in nodes.values {
            annotation.entrance = nil
            (mapView.view(for: annotation) as? NativeMapNodeView)?.finishAnimations()
        }
        if !ghosts.isEmpty {
            mapView.removeAnnotations(ghosts)
            ghosts.removeAll()
        }
    }

    private func completeTransition(_ version: Int) {
        guard version == transition, !ghosts.isEmpty else { return }
        mapView.removeAnnotations(ghosts)
        ghosts.removeAll()
    }

    private func point(_ coordinate: CLLocationCoordinate2D) -> CGPoint {
        mapView.convert(coordinate, toPointTo: mapView)
    }

    private func isOnScreen(_ view: UIView) -> Bool {
        guard let superview = view.superview else { return false }
        let center = superview.convert(view.center, to: mapView)
        return mapView.bounds.insetBy(dx: -Self.onscreenMargin, dy: -Self.onscreenMargin).contains(center)
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

    // MARK: - 校准用的地点搜索

    /// 苹果地点搜索：在给定位置附近按名称依次搜（中文、英文），把搜到的前几个坐标原样返回给网页判断坐标系
    static func search(_ probe: NativeMapSearchProbe, names: ArraySlice<String>? = nil, completion: @escaping ([Double]) -> Void) {
        var remaining = names ?? probe.names[...]
        guard let name = remaining.popFirst() else {
            completion([])
            return
        }
        let request = MKLocalSearch.Request()
        request.naturalLanguageQuery = name
        request.region = MKCoordinateRegion(center: probe.center, latitudinalMeters: probe.radius * 2, longitudinalMeters: probe.radius * 2)
        request.resultTypes = .pointOfInterest
        let localSearch = MKLocalSearch(request: request)
        Self.activeSearches.insert(localSearch)
        localSearch.start { response, _ in
            Self.activeSearches.remove(localSearch)
            var points: [Double] = []
            for item in (response?.mapItems ?? []).prefix(5) {
                let coordinate = item.placemark.coordinate
                points.append(coordinate.longitude)
                points.append(coordinate.latitude)
            }
            if points.isEmpty {
                Self.search(probe, names: remaining, completion: completion)
            } else {
                completion(points)
            }
        }
    }

    /// 搜索进行中要保持引用
    private static var activeSearches = Set<MKLocalSearch>()
}

extension NativeMapController: UIGestureRecognizerDelegate {
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        true
    }
}

extension NativeMapController: MKMapViewDelegate {
    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        if let node = annotation as? NativeMapNodeAnnotation {
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: NativeMapNodeView.reuseId, for: node)
            (view as? NativeMapNodeView)?.configure(node, style: style)
            return view
        }
        if let overlay = annotation as? NativeMapOverlayAnnotation {
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: NativeMapOverlayView.reuseId, for: overlay)
            (view as? NativeMapOverlayView)?.configure(overlay, appearing: true)
            return view
        }
        return nil
    }

    /// 新节点的视图加到地图上时播放入场（视图由 MapKit 按需创建，所以入场在这里而不是 setNodes 里开始）
    func mapView(_ mapView: MKMapView, didAdd views: [MKAnnotationView]) {
        let now = CACurrentMediaTime()
        let reduced = UIAccessibility.isReduceMotionEnabled
        for case let view as NativeMapNodeView in views {
            guard let annotation = view.annotation as? NativeMapNodeAnnotation, let entrance = annotation.entrance else { continue }
            annotation.entrance = nil
            // 过了时限才创建的视图（之后平移到可见范围）直接显示，不补播
            guard now <= annotation.entranceDeadline, !annotation.ghost else { continue }
            switch entrance {
            case .split(let from, let scale):
                let parent = point(from)
                let own = point(annotation.coordinate)
                view.playSplitEntrance(offset: CGPoint(x: parent.x - own.x, y: parent.y - own.y), scale: scale)
            case .mergeTarget:
                view.playMergeTargetEntrance()
            case .fade:
                view.playFadeEntrance(reduced: reduced)
            }
        }
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
        guard let node = annotation as? NativeMapNodeAnnotation, !node.ghost else { return }
        if node.cluster {
            onClusterTap?(node.id)
        } else {
            onMarkerTap?(node.id)
        }
    }

    func mapView(_ mapView: MKMapView, regionWillChangeAnimated animated: Bool) {
        guard !mapView.isHidden, !moving, !calibratingCamera else { return }
        moving = true
        moveStartZoom = zoom
        // 手势优先：进行中的合并、拆分立即收敛（网页 movestart / zoomstart 时同样处理）
        finishTransitions()
        onCamera?(cameraPayload(phase: "start", gesture: userGestureActive))
    }

    func mapViewDidChangeVisibleRegion(_ mapView: MKMapView) {
        guard !mapView.isHidden, moving, !calibratingCamera else { return }
        let now = CACurrentMediaTime()
        guard now - lastChangeEmit >= Self.changeInterval else { return }
        lastChangeEmit = now
        onCamera?(cameraPayload(phase: "change", gesture: userGestureActive))
    }

    func mapView(_ mapView: MKMapView, regionDidChangeAnimated animated: Bool) {
        guard !mapView.isHidden, !calibratingCamera else { return }
        moving = false
        var payload = cameraPayload(phase: "end")
        payload["zoomChanged"] = abs(zoom - moveStartZoom) > 0.001
        onCamera?(payload)
    }
}

// MARK: - 相机修正

/// MapKit 对 setVisibleMapRect 请求的改动：实际可见宽度 = 请求宽度 × scale，实际中心 = 请求中心 + (dx, dy) 个屏幕点。
/// 把请求放进某个内缩区域再显示（安全区、边距）正好是这种形式：比例与偏移（视图中心与该区域中心之差）都不随缩放变化。
struct NativeMapCameraFit {
    let key: String
    let scale: Double
    let dx: Double
    let dy: Double

    var isIdentity: Bool { scale == 1 && dx == 0 && dy == 0 }

    /// 从一次同步设置的结果得出修正；差别小到可以忽略、或明显不合理（被缩放上下限截住等）时不修正
    static func measure(key: String, requested: MKMapRect, actual: MKMapRect, viewSize: CGSize) -> NativeMapCameraFit {
        let identity = NativeMapCameraFit(key: key, scale: 1, dx: 0, dy: 0)
        let width = Double(viewSize.width)
        let height = Double(viewSize.height)
        guard width > 0, height > 0, !actual.isNull, requested.size.width > 0, actual.size.width > 0 else { return identity }
        let scale = actual.size.width / requested.size.width
        guard scale.isFinite, scale >= 0.5, scale <= 4 else { return identity }
        let perPoint = actual.size.width / width
        let dx = (actual.midX - requested.midX) / perPoint
        let dy = (actual.midY - requested.midY) / perPoint
        guard dx.isFinite, dy.isFinite, abs(dx) < width / 2, abs(dy) < height / 2 else { return identity }
        if abs(log2(scale)) < 0.002 && abs(dx) < 0.5 && abs(dy) < 0.5 { return identity }
        return NativeMapCameraFit(key: key, scale: scale, dx: dx, dy: dy)
    }

    /// 要让 MapKit 实际显示 target（整个视图的范围），应当请求的矩形
    func request(for target: MKMapRect, viewWidth: Double) -> MKMapRect {
        guard !isIdentity, viewWidth > 0 else { return target }
        let perPoint = target.size.width / viewWidth
        let width = target.size.width / scale
        let height = target.size.height / scale
        let midX = target.midX - dx * perPoint
        let midY = target.midY - dy * perPoint
        return MKMapRect(x: midX - width / 2, y: midY - height / 2, width: width, height: height)
    }
}

// MARK: - 数据

/// 网页下发的一个节点：单个地点或聚合（聚合与 key 由网页的聚合引擎决定）
struct NativeMapNodeInput {
    let id: String
    let cluster: Bool
    let coordinate: CLLocationCoordinate2D
    let count: Int
    let name: String
    /// 单点的图标种类：place / avoid / unexplored / add（与 markerContent.js 的 placeGlyphKind 相同）
    let glyph: String
}

/// 网页的转场计划（cluster/transitions.js 的 planTransition），只含两份快照都用到的 key
struct NativeMapTransitionPlan {
    /// 新 key → 旧 key：沿用同一个视图
    var reuse: [String: String] = [:]
    /// 换档只校正位置，直接落在新坐标的节点
    var reanchor: Set<String> = []
    /// 新 key → 旧父聚合：从父聚合的位置飞出
    var splitFrom: [String: String] = [:]
    /// 旧 key → 新父聚合：吸向父聚合并收拢
    var mergeInto: [String: String] = [:]
    /// 被拆开的旧聚合：原地收拢淡出
    var splitSources: Set<String> = []
    /// 汇合后出现的新聚合：延迟回弹出现
    var mergeTargets: Set<String> = []
}

enum NativeMapEntrance {
    case split(from: CLLocationCoordinate2D, scale: CGFloat)
    case mergeTarget
    case fade
}

final class NativeMapNodeAnnotation: NSObject, MKAnnotation {
    var id: String
    @objc dynamic var coordinate: CLLocationCoordinate2D
    var cluster: Bool
    var count: Int
    var name: String
    var glyph: String
    var selected: Bool
    /// 离开中的残影：不可点，转场结束后移除
    var ghost = false
    var entrance: NativeMapEntrance?
    var entranceDeadline: CFTimeInterval = 0

    init(input: NativeMapNodeInput, selected: Bool) {
        id = input.id
        coordinate = input.coordinate
        cluster = input.cluster
        count = input.count
        name = input.name
        glyph = input.glyph
        self.selected = selected
    }

    /// 沿用时换成新节点的内容（坐标由调用方单独设置，以便先记下旧位置）
    func apply(_ input: NativeMapNodeInput, selected: Bool) {
        id = input.id
        cluster = input.cluster
        count = input.count
        name = input.name
        glyph = input.glyph
        self.selected = selected
    }

    var title: String? { cluster ? nil : name }
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

/// 校准用的一次地点搜索（NativeMapPlugin.search）
struct NativeMapSearchProbe {
    let id: String
    let names: [String]
    let center: CLLocationCoordinate2D
    let radius: CLLocationDistance
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

    static func size(cluster: Bool, count: Int, style: NativeMapMarkerStyle) -> CGSize {
        guard cluster else { return style.glyphSize }
        let scale = clusterScale(count)
        return CGSize(width: (style.clusterBaseSize.width * scale * 10).rounded() / 10,
                      height: (style.clusterBaseSize.height * scale * 10).rounded() / 10)
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

/// 一个节点（单个地点或聚合），结构与网页 markerContent.js 相同：
/// 视图本身（底边中点在坐标上）└ travel 位移层（转场的平移与淡入淡出）
///                              ├ glyph 图形层（缩放与回弹，锚点在底边中点）：图标或聚合图 + 数量
///                              └ label 名称（单点；转场期间隐藏，结束后淡入）
/// 动画都用 Core Animation：先把图层设成终态，再加从起始值出发的动画，收敛时只要移除动画。
final class NativeMapNodeView: MKAnnotationView {
    static let reuseId = "fm.node"

    // 与网页 MARKER_TIMING 相同（秒）
    private enum Timing {
        static let merge: CFTimeInterval = 0.26
        static let mergeTargetDelay: CFTimeInterval = 0.11
        static let mergeTarget: CFTimeInterval = 0.21
        static let split: CFTimeInterval = 0.32
        static let splitSource: CFTimeInterval = 0.17
        static let fadeIn: CFTimeInterval = 0.16
        static let fadeOut: CFTimeInterval = 0.14
        static let reposition: CFTimeInterval = 0.22
        static let reducedFade: CFTimeInterval = 0.12
        static let labelIn: CFTimeInterval = 0.14
    }

    // 网页 EASE_OUT、EASE_IN_OUT 与 CSS 的 ease-out / ease-in
    private static let easeOut = CAMediaTimingFunction(controlPoints: 0.22, 0.8, 0.25, 1)
    private static let easeInOut = CAMediaTimingFunction(controlPoints: 0.4, 0, 0.2, 1)
    private static let cssEaseOut = CAMediaTimingFunction(name: .easeOut)
    private static let cssEaseIn = CAMediaTimingFunction(name: .easeIn)

    private let travel = UIView()
    private let glyph = UIView()
    private let imageView = UIImageView()
    private let countLabel = UILabel()
    private let label = NativeMapNameLabel(frame: .zero)
    private var glyphFrame = CGRect.zero

    override init(annotation: MKAnnotation?, reuseIdentifier: String?) {
        super.init(annotation: annotation, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        clipsToBounds = false
        canShowCallout = false
        travel.isUserInteractionEnabled = false
        glyph.isUserInteractionEnabled = false
        glyph.layer.anchorPoint = CGPoint(x: 0.5, y: 1)
        imageView.contentMode = .center
        countLabel.textAlignment = .center
        countLabel.isAccessibilityElement = false
        addSubview(travel)
        travel.addSubview(glyph)
        glyph.addSubview(imageView)
        glyph.addSubview(countLabel)
        travel.addSubview(label)
        isAccessibilityElement = true
        accessibilityTraits = .button
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func prepareForReuse() {
        super.prepareForReuse()
        finishAnimations()
    }

    func configure(_ node: NativeMapNodeAnnotation, style: NativeMapMarkerStyle) {
        let size = NativeMapGlyph.size(cluster: node.cluster, count: node.count, style: style)
        bounds = CGRect(origin: .zero, size: size)
        // 视图中心对准图形中心：图形底边中点落在坐标上
        centerOffset = CGPoint(x: 0, y: -size.height / 2)
        glyphFrame = CGRect(origin: .zero, size: size)
        travel.frame = glyphFrame
        glyph.bounds = glyphFrame
        glyph.center = CGPoint(x: size.width / 2, y: size.height)
        imageView.frame = glyphFrame
        if node.cluster {
            imageView.image = NativeMapImages.image(style.clusterImage, size: size, crop: style.clusterCrop) ?? NativeMapImages.fallbackPin
            let text = NativeMapGlyph.formatCount(node.count)
            countLabel.isHidden = false
            countLabel.text = text
            countLabel.font = .monospacedDigitSystemFont(ofSize: NativeMapGlyph.countFontSize(text, scale: NativeMapGlyph.clusterScale(node.count)), weight: .semibold)
            countLabel.textColor = style.countColor
            countLabel.sizeToFit()
            countLabel.center = CGPoint(x: size.width * style.countPosition.x, y: size.height * style.countPosition.y)
            label.isHidden = true
            accessibilityLabel = style.clusterLabel.replacingOccurrences(of: "%d", with: String(node.count))
        } else {
            imageView.image = NativeMapImages.image(style.glyphs[node.glyph] ?? style.glyphs["place"], size: size) ?? NativeMapImages.fallbackPin
            countLabel.isHidden = true
            label.apply(name: node.name, avoid: node.glyph == "avoid", selected: node.selected, style: style)
            let width = label.fittingWidth
            label.frame = CGRect(x: (size.width - width) / 2, y: size.height + 3, width: width, height: NativeMapNameLabel.height)
            label.isHidden = node.name.isEmpty
            accessibilityLabel = node.name + (style.kindSuffix[node.glyph] ?? "")
        }
        clusteringIdentifier = nil
        displayPriority = .required
        // 层级与网页 Z_INDEX 相同的先后：残影 < 单点 < 聚合（越大越靠上）< 选中
        let base = MKAnnotationViewZPriority.defaultUnselected.rawValue
        if node.ghost {
            zPriority = MKAnnotationViewZPriority(rawValue: base - 100)
        } else if node.selected {
            zPriority = .max
        } else if node.cluster {
            zPriority = MKAnnotationViewZPriority(rawValue: base + 10 + Float(min(40, log2(Double(max(node.count, 1))) * 4)))
        } else {
            zPriority = .defaultUnselected
        }
        isEnabled = !node.ghost
        isAccessibilityElement = !node.ghost
    }

    /// 点按范围：图形（至少 44×44）与名称；残影不可点
    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard isEnabled else { return false }
        let hit = glyphFrame.insetBy(dx: -max(4, (44 - glyphFrame.width) / 2), dy: -max(2, (44 - glyphFrame.height) / 2))
        return hit.contains(point) || (!label.isHidden && label.frame.contains(point))
    }

    // MARK: 动画

    /// 移除全部动画并回到静止状态（新手势、新快照、复用时）
    func finishAnimations() {
        for layer in [travel.layer, glyph.layer, label.layer] {
            layer.removeAllAnimations()
            layer.transform = CATransform3DIdentity
            layer.opacity = 1
        }
    }

    /// 拆分：从父聚合的位置飞到自己的位置，图形从小、半透明长到原大（前 55% 完成）
    func playSplitEntrance(offset: CGPoint, scale: CGFloat) {
        let size = CGSize(width: offset.x, height: offset.y)
        add(travel.layer, "transform.translation", values: [NSValue(cgSize: size), NSValue(cgSize: .zero)],
            duration: Timing.split, timing: Self.easeOut)
        add(glyph.layer, "transform.scale", values: [scale, 1, 1], times: [0, 0.55, 1], duration: Timing.split, timing: Self.easeOut)
        add(glyph.layer, "opacity", values: [0.35, 1, 1], times: [0, 0.55, 1], duration: Timing.split, timing: Self.easeOut)
        revealLabel(after: Timing.split)
    }

    /// 汇合目标：等子节点吸过来一段后出现，并轻微回弹
    func playMergeTargetEntrance() {
        add(glyph.layer, "transform.scale", values: [0.82, 1.06, 0.985, 1], times: [0, 0.55, 0.8, 1],
            duration: Timing.mergeTarget, delay: Timing.mergeTargetDelay, timing: Self.cssEaseOut)
        add(glyph.layer, "opacity", values: [0, 1, 1, 1], times: [0, 0.55, 0.8, 1],
            duration: Timing.mergeTarget, delay: Timing.mergeTargetDelay, timing: Self.cssEaseOut)
        revealLabel(after: Timing.mergeTargetDelay + Timing.mergeTarget)
    }

    func playFadeEntrance(reduced: Bool) {
        add(travel.layer, "opacity", values: [0, 1], duration: reduced ? Timing.reducedFade : Timing.fadeIn, timing: Self.cssEaseOut)
    }

    /// 沿用的节点换了位置：从旧位置滑到新位置
    func playMove(from offset: CGPoint, reduced: Bool) {
        guard abs(offset.x) > 0.5 || abs(offset.y) > 0.5 else { return }
        if reduced {
            add(travel.layer, "opacity", values: [0, 1], duration: Timing.reducedFade, timing: Self.cssEaseOut)
            return
        }
        add(travel.layer, "transform.translation", values: [NSValue(cgSize: CGSize(width: offset.x, height: offset.y)), NSValue(cgSize: .zero)],
            duration: Timing.reposition, timing: Self.easeOut)
        revealLabel(after: Timing.reposition)
    }

    /// 聚合数量变化：轻微回弹
    func playRecount() {
        add(glyph.layer, "transform.scale", values: [0.94, 1.04, 1], times: [0, 0.6, 1], duration: Timing.mergeTarget, timing: Self.easeOut)
    }

    /// 合并：吸向父聚合，同时缩小、最后淡出（终态留在父聚合位置、不可见，直到移除）
    func playMergeExit(by delta: CGPoint) {
        label.layer.opacity = 0
        travel.layer.transform = CATransform3DMakeTranslation(delta.x, delta.y, 0)
        glyph.layer.transform = CATransform3DMakeScale(0.72, 0.72, 1)
        glyph.layer.opacity = 0
        add(travel.layer, "transform.translation", values: [NSValue(cgSize: .zero), NSValue(cgSize: CGSize(width: delta.x, height: delta.y))],
            duration: Timing.merge, timing: Self.easeInOut)
        add(glyph.layer, "transform.scale", values: [1, 0.82, 0.72], times: [0, 0.7, 1], duration: Timing.merge, timing: Self.easeInOut)
        add(glyph.layer, "opacity", values: [1, 1, 0], times: [0, 0.7, 1], duration: Timing.merge, timing: Self.easeInOut)
    }

    /// 被拆开的父聚合：原地收拢淡出
    func playSplitSourceExit() {
        label.layer.opacity = 0
        glyph.layer.transform = CATransform3DMakeScale(0.86, 0.86, 1)
        glyph.layer.opacity = 0
        add(glyph.layer, "transform.scale", values: [1, 0.86], duration: Timing.splitSource, timing: Self.cssEaseIn)
        add(glyph.layer, "opacity", values: [1, 0], duration: Timing.splitSource, timing: Self.cssEaseIn)
    }

    func playFadeExit(reduced: Bool) {
        travel.layer.opacity = 0
        add(travel.layer, "opacity", values: [1, 0], duration: reduced ? Timing.reducedFade : Timing.fadeOut, timing: Self.cssEaseIn)
    }

    /// 名称在转场结束后淡入（网页同样在转场期间隐藏名称）
    private func revealLabel(after delay: CFTimeInterval) {
        guard !label.isHidden else { return }
        add(label.layer, "opacity", values: [0, 1], duration: Timing.labelIn, delay: delay, timing: Self.cssEaseOut)
    }

    /// 关键帧动画：图层的模型值已是终态，动画在开始前（含延迟）停在第一帧，结束后移除
    private func add(_ layer: CALayer, _ keyPath: String, values: [Any], times: [NSNumber]? = nil,
                     duration: CFTimeInterval, delay: CFTimeInterval = 0, timing: CAMediaTimingFunction) {
        let animation = CAKeyframeAnimation(keyPath: keyPath)
        animation.values = values
        animation.keyTimes = times
        animation.duration = duration
        animation.timingFunction = timing
        animation.fillMode = .backwards
        if delay > 0 { animation.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) + delay }
        layer.add(animation, forKey: "fm.\(keyPath)")
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
