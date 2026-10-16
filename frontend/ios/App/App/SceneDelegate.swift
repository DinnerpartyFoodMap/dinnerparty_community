import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // Info.plist 的场景配置指定了 Main.storyboard 时，系统已创建窗口并加载根控制器
        // （FoodMapBridgeViewController）；只有没有窗口时才手动创建，避免出现两个桥接实例。
        if window == nil {
            window = UIWindow(windowScene: windowScene)
            window?.rootViewController = FoodMapBridgeViewController()
            window?.makeKeyAndVisible()
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
