# 住民主页

路由 `/users/:id`（`App.jsx` 的 `parseProfileIdFromPath`），页面 `UserProfilePage.jsx`，数据来自 `GET /users/:id/profile`（后端 `modules/accounts/services/userProfile.js`）。

- 左上圆形头像、名字、上次定位所在的城市（后端在 `PUT /users/me/location` 后逆地理编码得到，没有时显示“还没有定位记录”）。
- 右上“餐饮偏好”雷达（`TasteRadar.jsx`）：六类餐饮各自独立，有值的轴画相同的实心点，未知轴不画点；有效零值仍画点。相邻已知轴连线并填色，不显示估算或手填标记，也不显示推断依据。点类别名查看偏好描述，自己的主页可调整等级。算法见后端 [六类餐饮偏好](../../../../backend/modules/preferences/doc/TASTE_AXES.md)。手机宽度（≤480px）下头像和名字并排、雷达放到下面；雷达画布按 300 设计，轴名 15px。
- 下面两栏小组件，住民自己选（`PUT /users/me/profile`）：公开收藏夹 / 最近创建的 5 个地点 / 最喜欢的 5 个地点（自己评“均线之上”及以上的）。地点不带坐标，点开回到地图。
- 屏蔽与举报在这里（App Store 1.2）：看别人时“屏蔽并举报”（确认 → 屏蔽 → 打开预填的举报表），已屏蔽时“解除屏蔽”，小组件不显示。地图上住民地点列表里原来的“屏蔽并举报”改为“查看主页”。

入口：地点卡片“最近修改”→ 住民的地点列表 →“查看主页”；账号菜单“我的主页”（网页、iOS 原生账号面板、桌面顶栏）。

改轴时同步 `tasteAxes.js` 的 `TASTE_AXES` 与文案 `profile:taste.axes.*`（后端 `TASTE_AXES` 同顺序）。

2026-11-04 最终展示要求：保留六个 key 和等级选择，自动低值统一显示“一般”，不再使用相对偏向文案。Web/iOS 不区分数值来源，原生只传偏好描述，不传依据或估算标记。旧默认评价保留在计算中；地图和详情在模型无可用分时保留已有评价汇总。

## iOS 原生住民主页（2026-10-30）

iOS App 的住民主页由原生 SwiftUI 面板呈现（[NativeProfilePlugin.swift](../../../ios/App/App/NativeProfilePlugin.swift)）：网页取 `GET /users/:id/profile`、执行屏蔽、偏好与小组件请求，原生显示头像、六轴雷达、小组件与关系状态。视图模型在 [profileViewModel.js](../profileViewModel.js)（六轴补齐、评价文案、小组件行与全部标签），会话与字段白名单在 [nativeProfile.js](../../platform/nativeProfile.js)，入口 [useNativeProfile.js](../useNativeProfile.js)。插件不可用、打开失败或 profile 加载失败时回退网页 [UserProfilePage.jsx](../UserProfilePage.jsx)。桥接测试纳入 `test:native-panels`，真机验收见 [原生文档](../../../native/doc/README.md)。
