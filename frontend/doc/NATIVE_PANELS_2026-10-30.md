# 原生顺路吃 / 住民主页 / 添加地点玻璃 / 管理后台 / 日记同好（2026-10-30）

环境：Windows 11 / Node.js v26.12.1；未执行 Xcode 编译、签名、模拟器或真机渲染。Windows 无法验证 Swift 语法与系统 Liquid Glass，下列结果为 JS 测试、移动 Web 构建与工程补丁实绩。

## 实际执行

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm --prefix frontend run test:native-panels` | 通过，退出 0 | 顺路吃、住民主页、管理后台会话与后台控制器 smoke；日记会话与入口/素材/日历页面 smoke；字段白名单、requestId、旧会话丢弃、图片回传、生成进度推送、关闭与失败 |
| `npm --prefix frontend test` | 通过，退出 0 | 全量既有逻辑/桥接/i18n/结构测试与新面板测试 |
| `npm --prefix frontend run test:structure` | 通过 | 286 个受检源码、1175 处相对导入、模块文档与链接 |
| `npm --prefix frontend run test:i18n` | 通过 | 2171 个翻译键、3464 个调用点；新代码只使用字面量键 || `npm --prefix frontend run build:mobile` | 通过，退出 0 | 825 个模块；保留既有主包体积与 ActionSheet 动静态导入提示 |
| `node frontend/scripts/patch-native-projects.mjs ios` | 通过 | NativePageEngine / NativeAdminPlugin / NativeJourneyPlugin 加入 Xcode 编译源；再次执行无改动 |

## 本轮改动

- 添加地点半屏表单：iOS 26+ 使用系统 sheet 玻璃 + 玻璃卡片；更早系统保留不透明分组底色。字段、上传、评价、分类、选点与草稿行为不变。
- 顺路吃：新增 `NativeAlongRoutePlugin.swift` 与网页会话 `nativeAlongRoute.js`；`alongRouteController.js` 负责解析行程、规划路线、画线与查询，`useNativeAlongRoute.js` 接入地图。原生不可用或失败时回退网页面板。
- 住民主页：新增 `NativeProfilePlugin.swift`、`profileViewModel.js`、`nativeProfile.js` 与 `useNativeProfile.js`；网页执行屏蔽/偏好/小组件请求，失败回退 `UserProfilePage`。
- 共享玻璃组件 `NativeGlassComponents.swift`。
- 管理后台：新增声明式页面引擎 `NativePageEngine.swift`、`NativeAdminPlugin.swift`、`nativeAdminController.js`、`nativeAdmin.js`、`useNativeAdmin.js`；覆盖用户、普通用户、地点申请、口味分类、QQ 白名单、公告、展会、兑换码、反馈与审计。
- 日记 · 同好：新增 `NativeJourneyPlugin.swift`、`nativeJourneyController.js`、`nativeJourney.js`、`useNativeJourney.js`；覆盖入口、素材、生成、核对、日历、详情、未完成、私人图片、公开页、同好与分享设置。生成进度经 `update` 推送；地图查看与分享画布交回网页工具页。`JourneyWorkspace` 增加 `journey:open-share` / `journey:show-map` / `journey:open-workspace` 事件。
- 管理后台、住民主页与日记 · 同好改为与住民设置相同的整页呈现：`NativeScreenPresentation.swift` 从右侧滑入、地图留在下方、左边缘侧滑返回；根页面侧滑关闭，子页面侧滑交给页面栈。
- 添加地点新建半屏：初始约 45% 高度，半屏时 `scrollDisabled`，上滑由面板本身连续展开；导航栏“展开全部”按钮用 `animateChanges` 展开，全屏后才允许滚动，与地点详情卡片一致。
- **插件注册修复**：新插件已加入 `FoodMapBridgeViewController.capacitorDidLoad()` 的 `registerPluginInstance`。此前只把 Swift 文件加入工程但没有注册，网页 `isPluginAvailable` 为 false，所有新原生页静默回退网页，导致真机只看到添加地点表单的玻璃变化。
- **Xcode 工程修复**：`NativeScreenPresentation.swift` 初次加入时使用了与 `MapChromeModel.swift` 构建对象重复的 ID，且一次 PowerShell 改写引入了 UTF-8 BOM；两者都会让 Xcode project loader 以 74 退出。现已改用唯一 ID `0031/0032`、移除重复条目和 BOM，并让 `patch-native-projects.mjs` 在结束时校验重复对象 ID。
- **Swift 编译失败诊断**：GitHub 的 bash 默认带 `-e`，编译失败会在管道后立即退出，原来的 `tail -50` 会隐藏真正的 Swift 错误。工作流现在先 `set +e` 再读取 `PIPESTATUS`，失败时打印 `error:` 行和日志末尾，并上传 `ios-xcodebuild-log` 工件。退出码 65 的直接原因是三个插件在 `DispatchQueue.main.async` 的逃逸闭包里直接引用了类属性 `screenPresenter`；Swift 要求显式 `self.`，现已改为 `self.screenPresenter`。同时为跨文件使用的 `NativePageView` 与 `NativeFormSheet` 增加显式 internal 初始化器，并把雷达绘制中与 `point(_:)` 同名的局部变量改名，作为额外的稳健性修复。

## 未验证与限制

- Swift 未编译：线框、类型推断、iOS 26 API 可用性与 SwiftUI 布局需要 Xcode 26 构建确认。
- 未执行 `cap sync ios`、签名或发版；安装包未包含本轮网页资源。
- 玻璃材质、表单 sheet、照片选择、雷达绘制、VoiceOver、半屏面板与地图的触摸竞争、前后台恢复需真机或模拟器按 [原生验收清单](../native/doc/README.md) 检查。
- 管理后台与日记的控制器是网页侧的新编排层；后端接口、权限与草稿协议未改。日记日历多选合并、同好星图、本机未上传照片素材、逐站照片选择与分享画布仍未原生化，继续由网页工作区完成。
- 网页面板仍保留原有顺路流程，未改为共用 `alongRouteController.js`；两条入口共用底层 `alongRoute.js` 与后端规则，但编排存在两套实现，后续可单独收敛。
