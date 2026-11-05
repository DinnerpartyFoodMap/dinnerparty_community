import SwiftUI
import UIKit

/// 两档只限制触摸起点，完成距离仍按整页宽度计算；不能用 began 时已移动的位置判断起点。
enum NativeBackGestureRegion {
    static let map: CGFloat = 24
    static let content: CGFloat = 80

    static func accepts(_ touch: UITouch, for gesture: UIGestureRecognizer, width: CGFloat) -> Bool {
        guard let view = gesture.view else { return false }
        let x = touch.location(in: view).x - view.bounds.minX
        return x >= 0 && x <= min(width, view.bounds.width)
    }

    static func isBackPan(_ gesture: UIGestureRecognizer) -> Bool {
        guard let pan = gesture as? UIPanGestureRecognizer else { return false }
        let velocity = pan.velocity(in: pan.view)
        return velocity.x > 0 && velocity.x > abs(velocity.y)
    }
}

/// 与住民设置一致的整页呈现：地图与网页留在下方，页面从右侧推入、向右退出。
/// 由于不能移除 presenter view（否则返回时地图会重新挂载并闪一帧），这里使用自定义
/// presentation controller；根页面的左边缘侧滑跟手关闭整页（可拖回取消），子页面交给页面栈返回。
final class NativeScreenTransitionDelegate: NSObject, UIViewControllerTransitioningDelegate {
    var interaction: UIPercentDrivenInteractiveTransition?
    var onDismissalEnd: ((Bool) -> Void)?

    func animationController(forPresented presented: UIViewController, presenting: UIViewController,
                             source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        NativeScreenSlideAnimator(presenting: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        NativeScreenSlideAnimator(presenting: false)
    }

    func interactionControllerForDismissal(using animator: UIViewControllerAnimatedTransitioning) -> UIViewControllerInteractiveTransitioning? {
        interaction
    }

    func presentationController(forPresented presented: UIViewController, presenting: UIViewController?,
                                source: UIViewController) -> UIPresentationController? {
        let controller = NativeScreenPresentationController(presentedViewController: presented, presenting: presenting)
        controller.onDismissalEnd = { [weak self] completed in self?.onDismissalEnd?(completed) }
        return controller
    }
}

final class NativeScreenPresentationController: UIPresentationController {
    var onDismissalEnd: ((Bool) -> Void)?

    override var shouldRemovePresentersView: Bool { false }

    override var frameOfPresentedViewInContainerView: CGRect {
        containerView?.bounds ?? .zero
    }

    override func dismissalTransitionDidEnd(_ completed: Bool) {
        super.dismissalTransitionDidEnd(completed)
        onDismissalEnd?(completed)
    }

    override func containerViewWillLayoutSubviews() {
        super.containerViewWillLayoutSubviews()
        // 用 bounds / center 布局，保留横向动画正在使用的 transform。
        let frame = frameOfPresentedViewInContainerView
        presentedView?.bounds = CGRect(origin: .zero, size: frame.size)
        presentedView?.center = CGPoint(x: frame.midX, y: frame.midY)
    }
}

final class NativeScreenSlideAnimator: NSObject, UIViewControllerAnimatedTransitioning {
    private let presenting: Bool

    init(presenting: Bool) { self.presenting = presenting }

    func transitionDuration(using transitionContext: UIViewControllerContextTransitioning?) -> TimeInterval {
        UIAccessibility.isReduceMotionEnabled ? 0.15 : 0.34
    }

    func animateTransition(using context: UIViewControllerContextTransitioning) {
        let key: UITransitionContextViewControllerKey = presenting ? .to : .from
        guard let controller = context.viewController(forKey: key),
              let movingView = context.view(forKey: presenting ? .to : .from) else {
            context.completeTransition(false)
            return
        }
        let container = context.containerView
        let frame = presenting ? context.finalFrame(for: controller) : context.initialFrame(for: controller)
        movingView.frame = frame.isEmpty ? container.bounds : frame
        let offset = CGAffineTransform(translationX: container.bounds.width, y: 0)
        // 手指直接驱动时仍按水平距离跟随；自动动画遵循“减弱动态效果”。
        let reduceMotion = UIAccessibility.isReduceMotionEnabled && !context.isInteractive
        if presenting {
            container.addSubview(movingView)
            movingView.transform = reduceMotion ? .identity : offset
            movingView.alpha = reduceMotion ? 0 : 1
        }
        let curve: UIView.AnimationOptions = context.isInteractive ? .curveLinear : .curveEaseInOut
        UIView.animate(withDuration: transitionDuration(using: context), delay: 0,
                       options: [curve, .beginFromCurrentState]) {
            movingView.transform = self.presenting || reduceMotion ? .identity : offset
            movingView.alpha = !self.presenting && reduceMotion ? 0 : 1
        } completion: { _ in
            let completed = !context.transitionWasCancelled
            if !completed {
                movingView.transform = .identity
                movingView.alpha = 1
            }
            context.completeTransition(completed)
            movingView.transform = .identity
            movingView.alpha = 1
        }
    }
}

/// 持有转场并安装左边缘侧滑。根页面时手势直接驱动退场动画（与住民设置相同，松手按距离与速度决定关闭或回弹）；
/// 插件通过 dismiss(_:animated:completion:) 关闭，回弹取消时 completion 不会执行，改为通知 onDismissCancelled。
final class NativeScreenPresenter: NSObject, UIGestureRecognizerDelegate {
    private let transition = NativeScreenTransitionDelegate()
    private weak var gesture: UIPanGestureRecognizer?
    private weak var host: UIViewController?
    private var tracking = false

    /// 根页面左边缘侧滑开始：插件在这里调用自己的关闭流程（最终走到 dismiss）；
    /// 返回 false 表示没有开始关闭（正在呈现或已在关闭），这次侧滑不驱动动画
    var onEdgeBack: (() -> Bool)?
    /// 侧滑拖回、退场取消：插件恢复为“未在关闭”
    var onDismissCancelled: (() -> Void)?

    /// 只在根页启用：子页的左边缘侧滑是系统导航的跟手返回，两个手势不能同时响应
    var edgeEnabled = true {
        didSet { gesture?.isEnabled = edgeEnabled }
    }

    override init() {
        super.init()
        transition.onDismissalEnd = { [weak self] completed in
            guard let self else { return }
            self.tracking = false
            self.transition.interaction = nil
            if !completed { self.onDismissCancelled?() }
        }
    }

    func present(_ host: UIViewController, from presenter: UIViewController, completion: (() -> Void)? = nil) {
        host.modalPresentationStyle = .custom
        host.transitioningDelegate = transition
        host.modalPresentationCapturesStatusBarAppearance = true
        let gesture = UIPanGestureRecognizer(target: self, action: #selector(handleEdge(_:)))
        gesture.maximumNumberOfTouches = 1
        gesture.delegate = self
        gesture.isEnabled = edgeEnabled
        host.view.addGestureRecognizer(gesture)
        self.gesture = gesture
        self.host = host
        tracking = false
        transition.interaction = nil
        presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled, completion: completion)
    }

    /// 关闭整页。侧滑驱动时始终带动画（跟手）；被拖回时不执行 completion。
    func dismiss(_ host: UIViewController, animated: Bool, completion: @escaping () -> Void) {
        guard let presenter = host.presentingViewController else { completion(); return }
        let interactive = transition.interaction != nil
        presenter.dismiss(animated: animated && (interactive || !UIAccessibility.isReduceMotionEnabled)) { [weak host] in
            // 交互退场取消时 UIKit 也可能回调：页面仍在就不算关闭
            guard host?.presentingViewController == nil else { return }
            completion()
        }
    }

    private var canBeginInteraction: Bool {
        guard let host else { return false }
        return host.presentingViewController != nil && host.presentedViewController == nil && host.transitionCoordinator == nil
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        NativeBackGestureRegion.accepts(touch, for: gestureRecognizer, width: NativeBackGestureRegion.content)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        canBeginInteraction && NativeBackGestureRegion.isBackPan(gestureRecognizer)
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
        otherGestureRecognizer is UIPanGestureRecognizer && !(otherGestureRecognizer is UIScreenEdgePanGestureRecognizer)
    }

    @objc private func handleEdge(_ gesture: UIPanGestureRecognizer) {
        guard let view = gesture.view else { return }
        let distance = max(0, gesture.translation(in: view).x)
        let progress = min(1, distance / max(1, view.bounds.width))
        switch gesture.state {
        case .began:
            guard canBeginInteraction else { return }
            let interaction = UIPercentDrivenInteractiveTransition()
            interaction.completionCurve = .easeOut
            transition.interaction = interaction
            tracking = true
            guard onEdgeBack?() == true else {
                tracking = false
                transition.interaction = nil
                return
            }
            interaction.update(progress)
        case .changed:
            guard tracking else { return }
            transition.interaction?.update(progress)
        case .ended:
            guard tracking, let interaction = transition.interaction else { return }
            tracking = false
            interaction.update(progress)
            let velocity = gesture.velocity(in: view).x
            let committed = (progress >= 0.3 && velocity >= -150) || (distance > 24 && velocity > 600)
            if committed { interaction.finish() } else { interaction.cancel() }
        case .cancelled, .failed:
            guard tracking else { return }
            tracking = false
            transition.interaction?.cancel()
        default:
            break
        }
    }
}
