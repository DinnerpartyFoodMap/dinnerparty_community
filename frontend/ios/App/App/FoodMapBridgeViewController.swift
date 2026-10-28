import UIKit
import SwiftUI
import WebKit
import Capacitor

/// 应用根控制器：在 Capacitor 的 WKWebView 之上承载 SwiftUI 原生地图控件（iOS 26 Liquid Glass）。
/// - 本地插件 NativeMapChromePlugin 在桥接初始化后注册。
/// - 透明宿主只命中可见控件区域，其余触摸交给 WebView（地图拖拽、缩放不受影响）。
/// - iOS 26 以下不创建原生控件，网页继续使用统一后的 Web 控件。
class FoodMapBridgeViewController: CAPBridgeViewController {
    private let chromeModel = MapChromeModel()
    private var chromePlugin: NativeMapChromePlugin?
    private var chromeHost: PassThroughHostView?
    private var clusterBridge: NativeClusterMarkerBridge?
    private var loadingObservation: NSKeyValueObservation?
    private var frameObservation: NSKeyValueObservation?
    private var keyboardObservers: [NSObjectProtocol] = []
    /// 原生面板的呈现器（iOS 26，MapChromeSheetPresenter）；存储属性不能声明可用版本，这里只持有引用
    private var sheetPresenter: AnyObject?
    /// 左边缘侧滑返回：只在网页报告“有东西可返回”时启用
    private var edgeBackGesture: UIScreenEdgePanGestureRecognizer?
    private let edgeBackDelegate = EdgeBackGestureDelegate()
    /// 新网页声明支持交互进度后，手势开始时锁定本轮协议；旧网页仍只接收最终返回事件。
    private enum EdgeBackProtocol: Equatable { case legacy, progress }
    private var edgeBackInteractive = false
    private var edgeBackTrackingProtocol: EdgeBackProtocol?
    private var edgeBackProgressActive: Bool { edgeBackTrackingProtocol == .progress }
    private var edgeBackGestureGeneration = 0
    private var edgeBackLastSample: (progress: CGFloat, velocity: CGFloat) = (0, 0)
    private var edgeBackPendingSample: (progress: CGFloat, velocity: CGFloat)?
    private var edgeBackDisplayLink: CADisplayLink?
    private let edgeBackFrameTarget = EdgeBackDisplayLinkTarget()
    private var edgeBackChangeInFlightGeneration: Int?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        let plugin = NativeMapChromePlugin()
        plugin.model = chromeModel
        plugin.geometryProvider = { [weak self] in
            guard let self = self, let host = self.chromeHost, let webView = self.webView else { return nil }
            return (host, webView)
        }
        bridge?.registerPluginInstance(plugin)
        bridge?.registerPluginInstance(NativeSettingsPlugin())
        bridge?.registerPluginInstance(NativeFeedbackPlugin())
        bridge?.registerPluginInstance(NativePlaceFormPlugin())
        chromePlugin = plugin
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        installChromeHost()
        // WebView 重新加载（导航、会话重置）时主动收起并销毁旧控件，等待网页重新握手
        loadingObservation = webView?.observe(\.isLoading, options: [.new]) { [weak self] webView, _ in
            if webView.isLoading {
                self?.chromePlugin?.handleWebViewReload()
                self?.clusterBridge?.reset()
                // 新页面会重新上报可返回状态，此前先关闭侧滑
                self?.cancelEdgeBackProgress()
                self?.edgeBackInteractive = false
                self?.edgeBackGesture?.isEnabled = false
            }
        }
        // 键盘插件（resize: native）直接设置 WebView.frame：尺寸变化后重新回传控件占用区域
        frameObservation = webView?.observe(\.frame, options: [.old, .new]) { [weak self] _, change in
            if change.oldValue?.size != change.newValue?.size {
                self?.chromePlugin?.handleWebViewResize()
            }
        }
        installKeyboardSync()
        installEdgeBack()
    }

    deinit {
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: NativeClusterMarkerBridge.channel, contentWorld: .page)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: Self.edgeBackMessageName)
        loadingObservation?.invalidate()
        frameObservation?.invalidate()
        edgeBackDisplayLink?.invalidate()
        for observer in keyboardObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    // MARK: - 侧滑返回

    private static let edgeBackMessageName = "foodMapEdgeBack"

    /// iOS 没有系统返回键：识别左边缘侧滑后通知网页执行与 Android 返回键相同的 dispatchBack。
    /// 网页通过 foodMapEdgeBack 上报 { enabled, interactive? }；根页面时手势关闭，不抢地图拖动。
    /// interactive 为真时发送 begin / change / end / cancel，网页按进度显示跟手反馈；否则保持旧版 ended-only 事件。
    private func installEdgeBack() {
        guard let webView = webView else { return }
        let gesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdgeBack(_:)))
        gesture.edges = .left
        gesture.isEnabled = false
        gesture.delegate = edgeBackDelegate
        webView.addGestureRecognizer(gesture)
        edgeBackGesture = gesture
        edgeBackFrameTarget.onFrame = { [weak self] in self?.flushEdgeBackProgress() }

        webView.configuration.userContentController.add(
            WeakScriptMessageHandler { [weak self] message in
                guard let self, let body = message.body as? [String: Any] else { return }
                let enabled = (body["enabled"] as? Bool) ?? false
                if !enabled { self.cancelEdgeBackProgress() }
                self.edgeBackInteractive = (body["interactive"] as? Bool) ?? false
                self.edgeBackGesture?.isEnabled = enabled
            },
            name: Self.edgeBackMessageName
        )
    }

    @objc private func handleEdgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard let webView else { cancelEdgeBackProgress(); return }
        let translation = gesture.translation(in: webView).x
        let rawVelocity = gesture.velocity(in: webView).x
        let distance = translation.isFinite ? max(0, translation) : 0
        let velocity = rawVelocity.isFinite ? rawVelocity : 0
        let progress = min(1, distance / max(1, webView.bounds.width))
        let sample = (progress: progress, velocity: velocity)
        if gesture.state != .began { edgeBackLastSample = sample }
        switch gesture.state {
        case .began:
            cancelEdgeBackProgress()
            edgeBackLastSample = sample
            edgeBackGestureGeneration += 1
            edgeBackTrackingProtocol = edgeBackInteractive ? .progress : .legacy
            if edgeBackProgressActive { emitEdgeBackProgress("begin", sample: sample) }
        case .changed:
            guard edgeBackProgressActive else { return }
            edgeBackPendingSample = sample
            if edgeBackDisplayLink == nil {
                let link = CADisplayLink(target: edgeBackFrameTarget, selector: #selector(EdgeBackDisplayLinkTarget.frame(_:)))
                edgeBackDisplayLink = link
                link.add(to: .main, forMode: .common)
            }
        case .ended:
            // 取消、禁用后的迟到 ended 不能落入旧协议并误触返回。
            guard let mode = edgeBackTrackingProtocol else { return }
            stopEdgeBackFrames()
            edgeBackTrackingProtocol = nil
            // 明显反向拖回时允许取消；旧协议保留原有的完成判断。
            let committed = mode == .progress
                ? ((progress >= 0.3 && velocity >= -150) || (velocity > 600 && distance > 24))
                : (distance > webView.bounds.width * 0.3 || (velocity > 600 && distance > 24))
            if mode == .progress {
                // 结束事件携带松手的最新值，不能被逐帧合并丢弃。
                emitEdgeBackProgress("end", sample: sample, committed: committed)
            } else if committed {
                webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('foodmap:edge-back'))", completionHandler: nil)
            }
            if committed { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
        case .cancelled, .failed:
            cancelEdgeBackProgress()
        default:
            break
        }
    }

    private func flushEdgeBackProgress() {
        guard edgeBackProgressActive, edgeBackChangeInFlightGeneration == nil, let sample = edgeBackPendingSample else { return }
        edgeBackPendingSample = nil
        let generation = edgeBackGestureGeneration
        edgeBackChangeInFlightGeneration = generation
        // WebView 忙时只保留最新一帧，最多一个 change 正在执行，防止积压过时的拖动位置。
        emitEdgeBackProgress("change", sample: sample) { [weak self] in
            // 只释放这次调用占据的槽位，不修改新手势的协议或待发送 sample。
            guard let self, self.edgeBackChangeInFlightGeneration == generation else { return }
            self.edgeBackChangeInFlightGeneration = nil
        }
    }

    private func stopEdgeBackFrames() {
        edgeBackDisplayLink?.invalidate()
        edgeBackDisplayLink = nil
        edgeBackPendingSample = nil
    }

    private func cancelEdgeBackProgress() {
        stopEdgeBackFrames()
        let mode = edgeBackTrackingProtocol
        edgeBackTrackingProtocol = nil
        if mode == .progress { emitEdgeBackProgress("cancel", sample: edgeBackLastSample) }
    }

    private func emitEdgeBackProgress(_ phase: String, sample: (progress: CGFloat, velocity: CGFloat),
                                      committed: Bool? = nil, completion: (() -> Void)? = nil) {
        var detail: [String: Any] = ["phase": phase, "progress": Double(sample.progress), "velocity": Double(sample.velocity)]
        if let committed { detail["committed"] = committed }
        guard let webView, let data = try? JSONSerialization.data(withJSONObject: detail),
              let json = String(data: data, encoding: .utf8) else { completion?(); return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('foodmap:edge-back-progress',{detail:\(json)}))") { _, _ in
            completion?()
        }
    }

    // MARK: - 键盘

    /// 只在 iPhone 上接管：iPad 上键盘插件另有台前调度与快捷栏规则，保持插件原行为。
    private func installKeyboardSync() {
        guard UIDevice.current.userInterfaceIdiom == .phone else { return }
        let center = NotificationCenter.default
        keyboardObservers = [
            center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { [weak self] note in
                self?.syncWebViewWithKeyboard(note, showing: true)
            },
            center.addObserver(forName: UIResponder.keyboardWillHideNotification, object: nil, queue: .main) { [weak self] note in
                self?.syncWebViewWithKeyboard(note, showing: false)
            }
        ]
    }

    /// 键盘插件（resize: native）在键盘动画结束后再等 0.2 秒才缩小 WebView，
    /// 底部搜索栏会先被键盘盖住、停顿后才跳到键盘上方。
    /// 这里按插件相同的公式，在键盘动画内同步设置 WebView.frame；插件稍后的设置变为同值，不再跳动。
    private func syncWebViewWithKeyboard(_ note: Notification, showing: Bool) {
        guard let webView = webView, let window = view.window ?? webView.window else { return }
        let info = note.userInfo ?? [:]
        let end = (info[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue ?? .zero
        // 与插件一致：取键盘高度的整数部分
        let height = showing ? CGFloat(Int(end.height)) : 0
        let current = webView.frame
        let bounds = window.bounds
        let target = CGRect(
            x: current.origin.x,
            y: current.origin.y,
            width: bounds.width - current.origin.x,
            height: bounds.height - current.origin.y - height
        )
        guard target != current else { return }
        let duration = (info[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        let curve = (info[UIResponder.keyboardAnimationCurveUserInfoKey] as? NSNumber)?.uintValue ?? 7
        UIView.animate(
            withDuration: duration,
            delay: 0,
            options: [UIView.AnimationOptions(rawValue: curve << 16), .beginFromCurrentState, .allowUserInteraction]
        ) {
            webView.frame = target
        }
    }

    private func installChromeHost() {
        guard #available(iOS 26.0, *), let webView = webView else { return }

        // Capacitor 8 的根 view 就是 WKWebView，必须先创建容器才能成为兄弟视图。
        let container = UIView(frame: webView.frame)
        container.backgroundColor = .systemBackground
        view = container
        // Keyboard 插件的 native 模式直接修改 WebView.frame，不能用四边约束覆盖它。
        webView.translatesAutoresizingMaskIntoConstraints = true
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)

        // 位于网页地图之上、原生工具栏之下；触摸与读屏仍由网页标记处理。
        clusterBridge = NativeClusterMarkerBridge(parent: self, webView: webView)

        let host = PassThroughHostView(model: chromeModel)
        host.translatesAutoresizingMaskIntoConstraints = false
        // 与 WebView 同级，避免 WebKit 的触摸/滚动识别器截获原生按钮手势。
        // 约束到容器而不是 WebView：键盘插件在键盘出现约 0.45 秒后才缩小 WebView，
        // 跟随 WebView 会让原生搜索框先被键盘盖住再跳上来；改由 SwiftUI 随键盘动画避让。
        view.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            host.topAnchor.constraint(equalTo: view.topAnchor),
            host.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])

        let hosting = MapChromeHostingController(rootView: MapChromeView(model: chromeModel), model: chromeModel)
        // 宿主已避开容器安全区，SwiftUI 只保留键盘避让：根视图原点不变，测量坐标与 UIKit hitTest 一致。
        hosting.safeAreaRegions = .keyboard
        hosting.view.backgroundColor = .clear
        hosting.view.isOpaque = false
        hosting.view.translatesAutoresizingMaskIntoConstraints = false
        addChild(hosting)
        host.addSubview(hosting.view)
        NSLayoutConstraint.activate([
            hosting.view.leadingAnchor.constraint(equalTo: host.leadingAnchor),
            hosting.view.trailingAnchor.constraint(equalTo: host.trailingAnchor),
            hosting.view.topAnchor.constraint(equalTo: host.topAnchor),
            hosting.view.bottomAnchor.constraint(equalTo: host.bottomAnchor)
        ])
        hosting.didMove(toParent: self)

        // 面板改由 UIKit 呈现：宿主被插件弹出的系统界面（分享等）占用时等待，而不是顶掉它
        let presenter = MapChromeSheetPresenter(host: self, model: chromeModel)
        chromeModel.onPresentationChange = { [weak presenter] in presenter?.setNeedsUpdate() }
        chromeModel.onSheetMetricsChange = { [weak presenter] in presenter?.invalidateDetents() }
        sheetPresenter = presenter

        chromeHost = host
        chromeModel.hostReady = true
    }
}

/// 侧滑返回手势优先于 WebView 自身的滚动拖动；不是从左边缘开始的触摸会让它立即失败，不影响其他手势。
private final class EdgeBackGestureDelegate: NSObject, UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: pan.view)
        return velocity.x > 0 && velocity.x > abs(velocity.y)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        return otherGestureRecognizer is UIPanGestureRecognizer && !(otherGestureRecognizer is UIScreenEdgePanGestureRecognizer)
    }
}

/// CADisplayLink 强引用 target；通过弱捕获闭包转发，避免它与根控制器相互持有。
private final class EdgeBackDisplayLinkTarget: NSObject {
    var onFrame: (() -> Void)?

    @objc func frame(_ link: CADisplayLink) { onFrame?() }
}

/// WKUserContentController 会强引用消息处理器，用闭包包一层避免与控制器循环引用。
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private let onMessage: (WKScriptMessage) -> Void

    init(_ onMessage: @escaping (WKScriptMessage) -> Void) {
        self.onMessage = onMessage
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        onMessage(message)
    }
}
