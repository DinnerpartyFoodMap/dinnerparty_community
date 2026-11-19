# /home 主页与下载入口

独立的 Vite 页面（`frontend/home/index.html` → `main.jsx` → `HomePage.jsx`，`vite.config.js` 的 `STATIC_PAGES`），扫描海报上的二维码后进入，不加载地图，也没有隐私确认弹窗。宽屏地图顶栏的「东方饭联地图」也链接到此页。文案在 `home` 命名空间。

- 下载 Android 版：`GET /api/app/android/latest.apk`，安装包放在服务器本地（后端 [App 更新与下载](../../../../backend/modules/appRelease/doc/README.md)）；服务器没有安装包时按钮置灰。
- 下载 iOS 版：发版信息里的 App Store `ios.url`，缺省为正式商店地址 `https://apps.apple.com/app/id6823438886`；旧 TestFlight 或非 App Store 地址会回退到正式商店。
- 打开网页版：`/`。

页面采用瑞士平面风格：无衬线大字、非对称网格、细分隔线与粉色强调色（`#E2789F`）。页面以白色背景为主，不跟随系统切换深色；社区理念区使用强调色背景，文字与星号使用浅色。包含首屏介绍、发现 / 收录 / 评价功能、社区理念和下载入口；顶部锚点直达介绍与下载区，页脚提供隐私、协议、支持和运行配置里的备案链接。

首屏使用 `public/home/main.png` 作为 `.home__hero-panel` 背景，限定在导航下方黑线与首屏底部黑线之间；左右边缘通过同一 `.home__container` 与黑线端点对齐，图片不延伸到外侧留白。图片随站点发布，CSS 设置 cover 裁切与两侧渐变到白色的遮罩，窄屏调整背景位置和遮罩强度。两行主标题增加间距；首屏按钮下的推荐文案和底部双语标语已移除，底部仅保留黑色分隔线。已移除原右侧几何图形和相关样式；背景不参与文字入场动效，不加载地图 SDK 或第三方图片。

首屏主按钮与下载区共用设备判断：桌面端突出网页版，iOS 突出 iOS 下载，Android 突出安装包下载；下载区把对应按钮排在最前。两处主按钮默认使用 `#8C6BB1`，悬停时使用粉色强调色 `#E2789F`。首屏移动设备的次要入口为网页版，桌面端的次要入口直达下载区。两处共用 PlatformLink，保持目标地址、Android 的 download 属性、iOS 的新窗口属性及不可用状态一致。

微信 / QQ 内置浏览器在首屏提示换浏览器（那里下载不了安装包）。发版请求失败时保留原有安卓下载地址和 App Store 回退链接；安卓明确不可用时首屏与下载区均禁用下载，并显示“安装包暂未上传”。保留版本号、平台更新说明和请求卸载取消。

下载区三种入口始终保留。入场动效由稳定的 `.home__download-card` 外层承载，发版信息返回后内部链接变成禁用元素时，观察目标仍保持不变，避免安卓卡片永久透明。`npm run test:home` 检查可用 / 不可用卡片的观察外层、禁用文案、链接属性与 App Store 回退。

宽屏首屏左侧文字与容器内背景、三栏功能与下载区；窄屏（≤ 720px）单栏。标题通过行内遮罩从底部渐入，其他区块由 IntersectionObserver 滚动触发，交错延迟且仅播放一次。默认正文可见，缺少观察器时无需动效也能使用；实时响应 `prefers-reduced-motion`，减少动态效果时取消位移、渐入和平滑滚动。提供跳转正文链接及键盘焦点样式。

部署：网站服务器要把 `/home`、`/home/` 交给 `dist/home/index.html`（与 `/terms/`、`/privacy/` 相同）。万一 `/home` 被交给了地图页，`App.jsx` 会整页跳到 `/home/`。iOS 通用链接排除了 `/home*`（`public/.well-known/apple-app-site-association`），否则 App 里“去更新”打开的下载页会被系统送回 App。

App 启动时的更新检查在 `app/components/AppUpdatePrompt.jsx`：本机构建号（Android `versionCode`、iOS `CFBundleVersion`）小于服务器写的 `build` 时弹窗，“去更新”用系统浏览器打开这个页面。
