# 住民主页

路由 `/users/:id`（`App.jsx` 的 `parseProfileIdFromPath`），页面 `UserProfilePage.jsx`，数据来自 `GET /users/:id/profile`（后端 `modules/accounts/services/userProfile.js`）。

- 左上圆形头像、名字、上次定位所在的城市（后端在 `PUT /users/me/location` 后逆地理编码得到，没有时显示“还没有定位记录”）。
- 右上“餐饮偏好”雷达（`TasteRadar.jsx`）：六类餐饮各自独立，有值的轴画相同的实心点，未知轴不画点；有效零值仍画点。相邻已知轴连线并填色，不显示估算或手填标记，也不显示推断依据。点类别名查看偏好描述，自己的主页可调整等级。算法见后端 [六类餐饮偏好](../../../../backend/modules/preferences/doc/TASTE_AXES.md)。手机宽度（≤480px）下头像和名字并排、雷达放到下面；雷达画布按 300 设计，轴名 15px。
- 第一栏固定显示收藏预览。本人可切换公开或查看完整清单。访客只能看到公开收藏。第二栏默认展示最近创建的 5 个地点，可切换为最喜欢的 5 个地点（自己评「均线之上」及以上的）。设置由 `PUT /users/me/profile` 保存。
- 本人住民名旁的「同好」进入 `?tab=community`。列表与星图每页最多显示 5 人，点按进入对方主页，返回恢复页码。同好设置保留在同好页。
- 「查看全部」进入 `?tab=favorites`。预览和完整清单均来自 `Favorite`。地点不带坐标，点开回到地图。
- 屏蔽与举报在这里（App Store 1.2）：看别人时“屏蔽并举报”（确认 → 屏蔽 → 打开预填的举报表），已屏蔽时“解除屏蔽”，小组件不显示。地图上住民地点列表里原来的“屏蔽并举报”改为“查看主页”。

入口：地点卡片“最近修改”→ 住民的地点列表 →“查看主页”；账号菜单“我的主页”（网页、iOS 原生账号面板、桌面顶栏）。

改轴时同步 `tasteAxes.js` 的 `TASTE_AXES` 与文案 `profile:taste.axes.*`（后端 `TASTE_AXES` 同顺序）。

2026-11-04 最终展示要求：保留六个 key 和等级选择，自动低值统一显示“一般”，不再使用相对偏向文案。Web/iOS 不区分数值来源，原生只传偏好描述，不传依据或估算标记。旧默认评价保留在计算中；地图和详情在模型无可用分时保留已有评价汇总。

## iOS 原生住民主页（2026-10-30）

iOS App 的住民主页由原生 SwiftUI 面板呈现。网页加载主页和执行屏蔽、偏好、收藏可见性与小组件请求。同好页与完整收藏清单使用共用的 React 页面。原生接口不可用时使用网页主页。桥接测试纳入 `test:native-panels`。 [原生主页](../../../ios/App/App/NativeProfilePlugin.swift) · [视图模型](../profileViewModel.js) · [会话](../../platform/nativeProfile.js) · [真机验收](../../../native/doc/README.md)
