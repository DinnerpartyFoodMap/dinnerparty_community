# 小伙伴

点击地图头像进入「我的主页」，在「调整小组件」下方点「小伙伴」。网页与 Android 打开 `/settings/companions`，小伙伴页返回个人主页。iOS App 是住民主页里推入的原生 SwiftUI 二级页（2026-11-20，见 [住民主页](../../profile/doc/README.md#二级页2026-11-20)）：同样的开关、饱食度与切换角色，内置角色显示静态预览，没有 Live2D 动画和兑换表单，数据由网页 `buildCompanionViewModel` 整理。未登录时地图底栏不显示小伙伴（`App.jsx` 只在登录后传 `companion`）。「开启小伙伴」默认开启，保存到账号 `map_settings.companion_enabled`。关闭后隐藏房间里的角色及地图底栏角色，打卡自动投喂仍记入原角色的饱食度。只想隐藏底栏角色时，可在个性化地图关闭 `companion_roaming`。`useCompanion.js` 同步账号的当前角色、饱食度与已拥有的角色。打卡成功通知 WebView 刷新状态，饱食度变化触发爱心反馈。手机底栏上方的角色不截取地图触摸。

## 内置饭桶

默认角色饭桶的模型、纹理、动作和静态预览在 `frontend/public/companions/dinnerparty-bot/`，随 Web 和 Capacitor 安装包发布。账号继续用 `stick-figure` 记录默认角色的选择、饱食度及打卡投喂。模型加载失败或 WebGL 上下文丢失时显示静态预览，上下文恢复时重新加载。

模型、纹理、预览图和 `art/` 下的原画属于饭联地图开发团队，不在 AGPL 范围内（见 [LICENSING.md](../../../../LICENSING.md)）。新增或更换角色时同步更新那里的列表。只有脚本生成的动作文件随脚本适用 AGPL。

`npm run build` 和 `npm run build:mobile` 在构建前从 Live2D 官方地址准备 Cubism Core。生成的供应商运行时位于 `src/companion/runtime/`，由 Git 忽略并在构建时一起打包。已准备过 Core 的构建可以离线运行。开发时可先执行 `node scripts/prepare-live2d-core.mjs` 再启动 Vite。发版时按 [Live2D SDK 发布许可](https://www.live2d.com/en/sdk/license/) 核对项目适用的条款。

## 小伙伴页：起名和一天（2026-11-25，P1）

页面从上到下：舞台和饱食度、`CompanionRoom.jsx`（起名卡片，或名字、“现在”一行、时间线、名场面）、切换角色、兑换码，「开启小伙伴」开关在最下面；关掉开关只剩开关。数据来自后端 `modules/rooms`（`/api/rooms`，见 [后端文档](../../../../backend/modules/rooms/doc/README.md)），`roomApi.js` 取数；接口 404（`ROOMS_AUDIENCE` 没开）时 `CompanionRoom` 不渲染，页面和以前一样。

- **起名**（`RoomNameFlow.jsx`，底部面板三步）：名字 → 谁能看到（`RoomAudienceFields`：谁能看、和别的小伙伴互动、所在城市；选“只有我”时互动关闭置灰）→ 前 6 道题（上一题、这题跳过、以后再答）。一次提交 `POST /api/rooms/me/name`。填了东西再关先确认。名字的本地检查 `roomNameProblem` 只为及时提示，规则以后端为准：1 到 12 个字、不能全是标点、不能等于当前角色的默认名、不能带链接和联系方式。
- **时间线**（`RoomTimeline.jsx`，视图模型 `roomViewModel.js`）：一天从起床到睡着，过零点的排在最后；分段上午、下午、晚上、深夜；筛选全部、名场面、互动；一次外出、一段剧情归成一组；睡着那条不写时长；今天只显示已经发生的，下一条开始时（30 秒到 10 分钟之间）和回到前台时再取；最早翻到起名那天或 30 天前。
- **编辑性格**（`RoomSheetEditor.jsx`，全屏面板）：名字、标签（互斥的一对互换，最多 10 个；取消过的推测标签记进 `untagged`）、20 道题（再点取消）、小习惯（最多 3 个）、口头禅（最多 3 句、每句 8 字以内）、谁能看到。有未保存修改时关面板先确认。
- **iOS**：原生小伙伴页（`NativeProfilePlugin.swift`）显示同样的名字、“现在”、翻日期、筛选和时间线，快照由 `roomNativeModel.js` 算好经 `buildCompanionViewModel` 的 `room` 交给原生，翻日期和筛选是事件 `roomNavigate`。起名和编辑的表单只在网页：原生的“起名”“编辑”发事件 `editCompanion`，`NativeProfileHost` 把对应表单开在原生主页底下（全屏、短渐变），表单出来后网页用 `update({ hidden: true })` 让原生整页淡出；保存或放弃时先 `update({ hidden: false, companion })` 淡入、盖住表单再关表单，最后回传最新的小伙伴。主页会话和页面栈不变，回来仍是小伙伴页（2026-11-27，之前是收起主页再打开网页小伙伴页）。旧安装包的结束动作 `companionName` / `companionEdit` 仍打开 `/settings/companions?room=name|edit`。底栏进来时原生会在主页数据回来之前读小伙伴，`useNativeProfile` 先等主页这次读取，读不到时按登录的住民判断是不是自己。名场面列表也只在网页（原生用“名场面”筛选看当天的）。
- **面板边距**：起名、编辑、名场面三个面板的内容边距都是 `roomPanel.js` 的 `PANEL_BODY`。

## 小伙伴之间：熟悉的小伙伴、别人的小伙伴（2026-11-26，P2）

后端每天给小伙伴排拼桌和隔空聊天，熟悉度随之上涨（见 [后端文档](../../../../backend/modules/rooms/doc/README.md)）。前端这一期加了下面几处。

- **自己的小伙伴页**（`CompanionRoom.jsx`）：
  - 名字或口头禅没通过检查时，名字下方一条提示，点了进编辑页（`roomTextProblems`，数据是 `GET /api/rooms/me` 的 `texts`）。检查中不提示，只在编辑页标出。
  - 名场面入口下面是两块，没有人时整块不显示（`RoomPeople.jsx`）：
    - 「熟悉的小伙伴」：`day.owner.friends` 里点头之交以上的，最多 3 只（`roomFriends`）。
    - 「口味像你的小伙伴」：`GET /api/rooms/me/neighbors`，最多 5 只，失败就不显示。
- **编辑页**：已保存的名字旁写检查状态（检查中时别人看到的是默认名；没通过时只有自己看得到），每句口头禅旁标“检查中”或“没通过”（`roomTextStatus`）。
- **别人的小伙伴**（`OtherRoomPage.jsx`，路由 `/users/<id>/room`，只读）：
  - 内容：大号圆头像、名字、「{主人名} 的小伙伴」（点了进主人主页）、你们的熟悉程度（没互动过不显示）、性格标签和小习惯名、“现在”一行、时间线、名场面。不加载对方的 Live2D，没有饱食度。
  - 右上角菜单：举报（意见反馈预填 `userReportPrefill`）；屏蔽这位住民（确认框写清后果，`POST /users/:id/block`，成功后退出这一页，不打开举报）。
  - 没登录（401）显示「登录后才能看别人的小伙伴」和登录按钮；其他看不到的情况（404）统一「没有找到这个小伙伴」，不说原因。
  - 打开自己的 `/users/<自己>/room` 时显示自己的小伙伴页。
- **入口**（`App.jsx` 的 `openRoom`：点自己的回到 `/settings/companions`，点别人的进 `/users/<id>/room`）：
  - 别人的住民主页（`UserProfilePage.jsx`）：主页响应 `room` 为真时有按钮「去看 Ta 的小伙伴」。
  - 时间线里剧情的头像（自己的头像点了没有反应）。
  - 熟悉的小伙伴、口味像你的小伙伴。
- **大头照**：后端给站内路径（`/api/skins/packs/avatar/<grant>`）或 `null`；`fetchRoomDay` / `fetchRoomNeighbors` 补上接口地址（`roomAvatarUrl`），`null` 用饭桶的 `avatar.png`。
- **iOS**：
  - 别人的小伙伴是原生主页里推入的页面（路由 `.room(userId)`，`NativeOtherRoomView`），数据由事件 `loadRoom { userId, date, filter }` 取，网页用 `buildOtherRoomNativeModel` 算好回传 `room`。
  - 推入它的地方：别人主页的「去看 Ta 的小伙伴」（视图模型 `canOpenRoom`）、时间线头像（行里的 `avatars` 带 `userId`）、自己小伙伴页的熟悉的小伙伴和口味像你的小伙伴（快照 `friends` / `neighbors`）。点主人名回到对方主页（上一页就是时直接返回）。
  - 举报是事件 `reportUser`，网页打开预填的举报表，原生先收起主页；屏蔽走 `setBlocked`，带 `report: false` 时只屏蔽不打开举报，成功后退回上一页。
  - 组标题带店时（行的 `placeId`）点了回地图开这家店（结束动作 `openPlace`）。
  - 网页路由 `/users/<id>/room` 在 iOS 打开对方的原生主页并直接推入小伙伴页（快照 `initialPage: 'room'`）。

## 底栏状态

底栏角色由 `CompanionRoam.jsx` 渲染。`companionDirector.js` 是状态机，`companionBehavior.js` 放触发规则和数值，`companionActor.js` 负责移动。

登录后（注册完也一样）底栏就有默认的饭桶，不用先起名。点它进入小伙伴页（2026-11-25）：网页和安卓打开 `/settings/companions`，返回回到地图；iOS 打开原生主页并直接推入小伙伴页（`/users/<自己>?page=companion` → 快照字段 `initialPage`），返回先回到主页。只有身体那一层接触摸（`fm-companion-roam__body--tap`），外框、影子不挡地图。它一直在走动，所以标了 `data-native-touch-live`：iOS 原生底图不把它算进 12px 网格采样，而是每 150ms 量一次它的实时矩形作为网页区域（`nativeMapView.js` 的 `liveTouchHoles`）。

| 状态 | 什么时候 | 做什么 |
| --- | --- | --- |
| standby 发呆 | 刚落地或走完一段，2.5–6 秒（饿了 4–9 秒，饱了 2–5 秒） | 播 `Standby`；饿了播 `Hungry`，饱了一半时间播 `Full` |
| wandering 游走 | 发呆结束 | 在地面上走 40–180px，不走到右侧按钮底下；朝走的方向转头。速度 26px/s，饿了 14、饱了 32 |
| climb 攀爬 | 发呆结束时概率 35%（饱了 60%）；饿着不爬，两次至少隔 90 秒，按钮组从地面附近开始才爬 | 走到按钮组左侧，一下一下往上拉（`Climb`），翻到顶上站在中间待 12–28 秒 |
| jumpoff 跳下 | 在按钮上待够时间 | 蹲下、往左跳出 40–90px（`JumpOff`），着地压扁（`Land`） |
| drop 掉落 | 页面首次出现；更多功能或搜索收起后从空中落回；站着的按钮没了（隐藏、搜索），或爬到一半被打断 | 越落越快（`Drop`），着地压扁（`Land`） |
| sleep 睡觉 | 没有操作：白天 150 秒，饿着 90 秒，夜里（本机 23:00–7:00）30 秒 | 就地睡下（`Sleep`），头顶冒 z；触摸、按键、拖地图时醒来（`Wake`、轻蹦一下） |
| hungry 饿 | 距上次投喂超过 48 小时；没喂过时从领养算（内置角色按注册时间，额外角色按兑换时间） | 发呆时耷拉着、半睁眼、左右张望，肚子叫时抖一下；走得慢，不爬 |
| full 饱 | 投喂后 3 小时内 | 新的投喂补一次庆祝：点头、冒爱心、蹦两下，再晃着笑（`Full`）；之后走得快、更爱爬 |

- **飞：** 在 iOS 原生控件里上拉「更多功能」时，手指一动就起飞。
  - 先飞到展开高度再加 40px（拖动时工具栏最多被拉过这么多），松手展开后落到工具栏上沿悬停。
  - 从展开状态往下拖时原地等着，收起后落回。
  - 抽屉状态来自原生布局的 `drawer`（见 [平台文档](../../platform/doc/README.md)），旧版 App 不带这一项，角色不飞。
  - 窄屏 App 展开搜索时，先站在输入框上，结果列表出现后再飞到列表上沿。
  - 飞的时候打断其他状态，睡着的先醒；起飞前把位置收回地面范围，避开随抽屉上移的按钮。
- **数据来源：** 上次投喂时间和领养时间来自 `GET /api/skins/companions/me` 的 `fed_at`、`adopted_at`。庆祝过的那次投喂记在 localStorage，同一次投喂只庆祝一次。
- **操作信号：** 来自页面的触摸、按键、滚轮，以及 MapView 转发的地图拖动和缩放（`companionActivity.js`）。iOS 原生底图上的手势不经过网页的触摸事件。
- **右侧按钮组：**
  - iOS 原生控件：取原生回传的浮动按钮位置（`useMapChrome` 的 `floatingRect`）。
  - 网页控件：取标了 `data-companion-perch` 的按钮。
- **同一次页面里：** 记住位置，卡片关掉后从原处继续。
- **减弱动态效果：** 不走、不爬、不睡，换位置时淡出再淡入。

真机验收项见 [TEST_CASES.md](TEST_CASES.md)。

所有位移都用 Web Animations 改 transform 和 opacity，不写 style、不切换 class，也不增删节点。原因是 iOS 原生底图会监听整页属性和节点的变化，重新采样触摸区域（`map/nativeMapView.js`），每帧写属性会让它反复全屏采样。z、爱心和影子是常驻节点，只靠动画显示。测试：`npm run test:companion`。

## 动作文件

- **生成方式：** 各状态的 Live2D 动作由 `scripts/companion-motions.mjs` 按关键帧生成（`npm run companion:motions`）。
  - 脚本在 `public/companions/stick-figure/` 生成共享动作，并为饭桶生成适配的状态动作。饭桶的专属待机让左右幽灵按不同节奏摆动。
  - 共享的 `Standby` 和 `Feed`（nod）来自原火柴人的 idle、feed。原模型由 [原创分层线稿](../art/stick-figure.psd) 经 [PSD2Live 3.8.2](https://github.com/tsunehimatoi/psd2live/releases/tag/v3.8.2) 导出。
  - 改动作时改脚本里的 `MOTIONS` 再生成。`test:companion` 会核对文件与脚本一致。
- **可用参数：** 共享动作驱动头部和身体角度、呼吸、眼睛开合。饭桶还有两团幽灵和裙摆下方尾巴的形变。
- **复位：** 动作没写到的参数会停在上一个动作的值上，所以每个动作都驱动整组姿态参数。
- **眼睛：** 眼睛写成模型曲线 `EyeBlink`，由各模型自己的 `EyeBlink` 组决定驱动哪些参数。运行时只从开头连续读取模型曲线，所以模型曲线必须排在参数曲线前面。
- **叠加层：** 循环动作由运行时设为待机组反复播放；朝向和飞行姿态是叠加层（`live2dScene.js` 的 `FACING`、`MOODS`，单位是角度）。

## 其他角色用这些动作

- **补动作组：** 额外角色没有的动作组，加载资源包时用带标准参数的共享动作补上（`sharedMotions.js` 的 `withSharedMotions`，文件放在角色目录的 `companion-shared/` 下）。
  - 角色自己有同名组时用角色自己的。
  - 没有 `Standby` 时先用角色的 `Idle`。
- **适用范围：** 这些动作只驱动标准参数（`ParamAngleX/Y/Z`、`ParamBodyAngleX/Y/Z`、`ParamBreath` 和 `EyeBlink` 组），模型没有的参数会被忽略。火柴人专有的 `ParamBodyLean` 在别的模型上不起作用。
- **验证（2026-11-20）：** 用 84 个第三方 Cubism 3 模型（moc v1，动作都在一个无名组里）验证过。
  - 每个模型补上 11 个组后都能启动，播放时画面都有变化。
  - 其中一个模型左眼参数叫 `ParamEyeLOpen1`，靠 `EyeBlink` 组同样闭眼。
  - Cubism Viewer 5.3 打开补过动作的模型，日志没有错误。

## 预览

`npm run dev` 后打开下面两个页面，都用与应用相同的运行时（Cubism Core + pixi-live2d-display）。

- `/tests/integration/companion-motions.html`：每个动作按时间排成一张表。
  - `?groups=Sleep,Full&size=2` 选择动作组、放大格子。
  - `?probe` 看各参数的形变。
  - `?model=<model3.json 地址>` 换别的模型，缺的组按资源包同样的方式补上。
  - `?check=<返回 model3.json 地址数组的地址>` 逐个检查一批模型。
- `/tests/integration/companion-roam.html`（窄窗口）：真的底栏小伙伴，配假的工具栏和右侧按钮，按钮把它推到投喂、饿、上拉更多功能、爬、睡等状态。开发时状态机挂在 `window.__foodmapCompanion`。

## 额外角色

网页小伙伴页和主题皮肤页共用兑换表单，角色和皮肤都按账号持有。选择已拥有的额外角色时获取版本和临时下载授权。资源格式和部署目录见 [皮肤与角色兑换](../../../../backend/modules/skins/doc/README.md#远程资源包)。

窄屏网页把活动区域放在搜索栏上方，应用内角色沿用底栏位置。验收覆盖无外部资源服务时显示饭桶、退出登录或更换账号时不沿用他人角色、同一账号换设备显示已拥有内容、地图开关关闭后小伙伴页仍可用，以及 iPhone 与 Android 底栏上的活动和投喂反馈。
