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

## 2026-11-01 修订：系统表单、页面栈与加载

环境同上（Windows，未编译 Swift）。前端 `npm test` 中除 `test-native-journey.mjs` 的日历断言外全部通过；该断言按“当前月份”取日历，11 月起在未改动的代码上同样失败，把时钟固定在 2026-10-15 时通过。`npm run test:web-layout-browser`（Edge 无头）通过。

- **管理后台 / 日记 · 同好的子项打不开**：插件的 `lastSeq` 不随会话重置，第二次打开起网页回执的序号都比它小，全部被当成过期丢掉；滑入动画期间收到的 `close` 被忽略，留下没有会话的原生页。现在每次 `open` 重置序号，滑入途中的关闭排队执行。另加 20 秒无回执超时提示，不再无反应。
- **页面引擎改为页面栈**（`NativePageEngine.swift`）：根页与子页都是 insetGrouped 列表（同住民设置），子页由 `NavigationStack` 推入，系统返回与左边缘侧滑跟手；页面带 `level`（网页侧层级），新页面更深则推入、同级原地刷新、更浅则退回；动作带 `push` 时先推入占位页再填内容。一行有多个操作时推入这一行的详情页（不再用操作菜单），表单也是推入的页面（不再是全屏弹窗）。弹出网页页面后发 `back`（`level` 为现在最上面那一级）。根页才启用整页侧滑关闭。
- **加载慢**：住民主页、日记入口、顺路吃都不再等网络再打开——主页先显示加载中（`update` 补数据 / 失败原因，可重试），日记入口先不带未完成计数，顺路吃的标签目录用整页缓存、读到后 `update`。
- **添加地点、顺路吃改为分组表单**：分组标题在组外、说明在组下（后来改为不用系统 Form，见下）。
- **住民主页**：“调整小组件”移到所有小组件下方居中，编辑改为系统表单 sheet。
- **右侧按钮组收起动画**：按钮在面板展开时隐去，外壳完全缩回右侧后再淡入。
- **地图筛选原生面板（协议 v14）**：`filter` 面板复用右侧按钮组的玻璃外壳；分组 `style: "chips"` 画成标签，行 tone `include` / `exclude` / `accent`。

待 iOS 26+ 真机：上述所有界面、页面栈返回与侧滑、表单在半屏/全屏的底色、筛选面板标签换行与点按、收起动画。

### 添加地点表单细节（2026-11-01 第二轮）

- 去掉 `NavigationStack` 与系统导航栏：它会在面板里铺一层自己的底色，使半屏不透出玻璃、半屏到全屏没有底色过渡。现在与地点卡片一样不铺任何底色，标题行与收藏面板一致（左关闭、居中标题、右提交），分组底色 `tertiarySystemFill`、圆角 20，与收藏面板相同。
- 去掉右上角“展开”按钮（`onExpand`），展开只靠上拉面板。
- 店名、分类、人均各自一栏；分类改为网页同款输入：已选分类是可点掉的标签，后面是输入框，聚焦/输入时列出常用或匹配分类，回车或“添加新分类”加入新分类（不再推入选项列表页）。
- 评价四档同一种圆角（12）与边框粗细（1.5），只用颜色深浅区分选中。
- 每组图片只有一个“添加图片”，点开系统小菜单选“从相册选择 / 拍照”。
- 未验证：面板材质仍是系统 sheet 的玻璃（收藏面板是工具栏同款 `Glass.regular`，系统 sheet 的玻璃略厚），两者能否完全一致需真机对比。

### 顺路吃细节（2026-11-01 第三轮）

- 与添加地点共用 `NativeGlassComponents.swift` 的 `NativeSheetHeader` / `NativeSheetGroup` / `NativeSheetRow`：不套 `NavigationStack` / `Form`、不铺底色，半屏透出系统玻璃、全屏由系统过渡为不透明；标题行与收藏面板一致。
- 出行方式不再用分段控件（分组里再套一层边框），四个按钮直接放在分组里，选中用主题色浅底。
- “想吃什么”“标签”标题右侧注明“可选”。
- “离路线最远”单独一栏，“规划路线并找店”是独立的主按钮。
