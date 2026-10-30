import SwiftUI
import UIKit

/// 与住民设置一致的整页呈现：地图与网页留在下方，页面从右侧推入、向右退出。
/// 由于不能移除 presenter view（否则返回时地图会重新挂载并闪一帧），这里使用自定义
/// presentation controller；左边缘侧滑在根页面关闭整页，在子页面交给页面栈返回。
final class NativeScreenTransitionDelegate: NSObject, UIViewControllerTransitioningDelegate {
    func animationController(forPresented presented: UIViewController, presenting: UIViewController,
                             source: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        NativeScreenSlideAnimator(presenting: true)
    }

    func animationController(forDismissed dismissed: UIViewController) -> UIViewControllerAnimatedTransitioning? {
        NativeScreenSlideAnimator(presenting: false)
    }

    func presentationController(forPresented presented: UIViewController, presenting: UIViewController?,
                                source: UIViewController) -> UIPresentationController? {
        NativeScreenPresentationController(presentedViewController: presented, presenting: presenting)
    }
}

final class NativeScreenPresentationController: UIPresentationController {
    override var shouldRemovePresentersView: Bool { false }

    override var frameOfPresentedViewInContainerView: CGRect {
        containerView?.bounds ?? .zero
    }

    override func containerViewWillLayoutSubviews() {
        super.containerViewWillLayoutSubviews()
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
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        if presenting {
            container.addSubview(movingView)
            movingView.transform = reduceMotion ? .identity : offset
            movingView.alpha = reduceMotion ? 0 : 1
        }
        UIView.animate(withDuration: transitionDuration(using: context), delay: 0,
                       options: [.curveEaseInOut, .beginFromCurrentState]) {
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

/// 持有转场并安装左边缘侧滑：根页面关闭，子页面调用页面栈返回。
final class NativeScreenPresenter: NSObject {
    private let transition = NativeScreenTransitionDelegate()

    var onEdgeBack: (() -> Void)?

    func present(_ host: UIViewController, from presenter: UIViewController, completion: (() -> Void)? = nil) {
        host.modalPresentationStyle = .custom
        host.transitioningDelegate = transition
        host.modalPresentationCapturesStatusBarAppearance = true
        let gesture = UIScreenEdgePanGestureRecognizer(target: self, action: #selector(handleEdge(_:)))
        gesture.edges = .left
        host.view.addGestureRecognizer(gesture)
        presenter.present(host, animated: !UIAccessibility.isReduceMotionEnabled, completion: completion)
    }

    @objc private func handleEdge(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended, let view = gesture.view else { return }
        let distance = max(0, gesture.translation(in: view).x)
        let velocity = gesture.velocity(in: view).x
        let committed = distance > max(60, view.bounds.width * 0.25) || (distance > 24 && velocity > 600)
        if committed { onEdgeBack?() }
    }
}
