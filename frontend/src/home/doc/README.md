# /home 下载页

独立的 Vite 页面（`frontend/home/index.html` → `main.jsx` → `HomePage.jsx`，`vite.config.js` 的 `STATIC_PAGES`），扫描海报上的二维码后进入，不加载地图，也没有隐私确认弹窗。文案在 `home` 命名空间。

- 下载 Android 版：`GET /api/app/android/latest.apk`，安装包放在服务器本地（后端 [App 更新与下载](../../../../backend/modules/appRelease/doc/README.md)）；服务器没有安装包时按钮置灰。
- 下载 iOS 版：发版信息里的 `ios.url`，缺省为 TestFlight 邀请链接。
- 打开网页版：`/`。

按设备把对应按钮排在最前；微信 / QQ 内置浏览器里提示换浏览器（那里下载不了安装包）。宽屏左右两栏，窄屏（≤ 720px）上下排列，跟随系统浅色 / 深色。

部署：网站服务器要把 `/home`、`/home/` 交给 `dist/home/index.html`（与 `/terms/`、`/privacy/` 相同）。万一 `/home` 被交给了地图页，`App.jsx` 会整页跳到 `/home/`。iOS 通用链接排除了 `/home*`（`public/.well-known/apple-app-site-association`），否则 App 里“去更新”打开的下载页会被系统送回 App。

App 启动时的更新检查在 `app/components/AppUpdatePrompt.jsx`：本机构建号（Android `versionCode`、iOS `CFBundleVersion`）小于服务器写的 `build` 时弹窗，“去更新”用系统浏览器打开这个页面。
