# 管理界面

AdminExhibitions 在后台底部提供展会联动设置，沿用公告发布权限。名称使用 TextInput，简介与信息使用带 Markdown 提示与预览的 TextArea（`markdown`）；图标复用 `/upload`。展会地点（选填）用场馆名加全屏地图选点（MapView 导出的 `FullScreenMapPicker`，`context="exhibition"`）：选中站内地点时顺带填入场馆名，也可以用图钉位置；有地点时地图上的展会面板才有“展会附近随机美食”。支持同时发布多个活动，通过活动选择框逐项编辑和下架，新增活动不会替换其他活动；活动时间使用 `datetime-local`（举办地本地时间，精确到分钟），用于首页排序。接口与浏览器回归分别在 `backend/tests/community/test_exhibitions.js` 和 `test_exhibition_ui.js`。

AdminDashboard.jsx 提供管理入口，AdminUsers/GeneralUsers/Places/Comments/QQWhitelist/Notices 分业务页，BanModal/AuditModal 负责关联弹层。显示权限与当前用户联动，后端才是授权和事务权威；目录整理不新增权限。

三个等级都显示操作日志和地点审核入口；皮肤兑换码仅 YUYUKO 显示。YOUMU 的普通用户管理面板增加封禁/解封与状态，复用 AdminBanModal 和 `/admin/users/ban`、`/unban`，目标限普通用户。KOMACHI 仍只有普通用户删除操作，不显示封禁按钮。QQ 白名单、公告/展会和隐藏的评论面板沿用原有范围。

普通用户面板提交删除/封禁/解封期间暂停所有行操作和刷新，避免共享列表请求编号使另一个成功响应失效；关闭封禁弹层不取消已提交请求。浏览器用例通过延迟响应验证等待期间的禁用状态与最终封禁结果。

`backend/tests/admin/test_admin_permissions_ui.js` 搭配 `frontend/tests/integration/admin-harness.jsx`，使用真实管理组件、路由与临时数据库，覆盖角色入口、日志弹层、兑换码隐藏、YOUMU 桌面封禁/窄屏解封及重载状态、取消封禁、目标升为管理员后后端拒绝及重试、KOMACHI 没有封禁控件；其余操作的取消/错误/旧响应场景仍待补齐。

```mermaid
flowchart LR
    User[当前用户与 token] --> Dashboard[按角色显示管理入口]
    Dashboard --> Page[选择管理业务页]
    Page --> Load[加载列表 / 筛选 / 选择目标]
    Load --> Confirm[编辑或确认操作]
    Confirm --> API[请求后端管理接口]
    API --> Result{成功?}
    Result -->|是| Refresh[更新列表与审计展示]
    Result -->|否| Error[保留上下文并提示错误]
```

现有分页面方式优于一个管理大组件；通用表格在 components/data。列表页面仍存在重复网络与错误处理，可在覆盖充分后抽取。案例：ADM-F01 角色入口已有上述浏览器覆盖；ADM-F02/03 已覆盖封禁后端拒绝、重试与取消，其余操作仍待自动化；ADM-F04 已覆盖提交期间关闭弹层与阻止并发刷新，切账号和其他旧响应场景仍待自动化。i18n 仅检查文案，不算这些行为覆盖，见 ADM-F01 的 [清单](../../../doc/HISTORY_AND_TODO.md)。

## iOS 原生管理后台（2026-10-30）

iOS App 的管理后台由 SwiftUI 呈现（[NativeAdminPlugin.swift](../../../ios/App/App/NativeAdminPlugin.swift)），共用声明式页面引擎 `NativePageEngine.swift`。网页按管理员等级构建 dashboard 与各面板页面模型，原生只渲染 rows / form / calendar / images 并回传动作、筛选与表单值；账号请求、权限与校验仍在网页（[nativeAdminController.js](../nativeAdminController.js)、[nativeAdmin.js](../../platform/nativeAdmin.js)）。

覆盖面板：用户、普通用户、地点申请（含 AI 初筛原因与图片）、口味分类、QQ 白名单、公告、展会（含图标上传）、皮肤兑换码、住民反馈、操作日志。原生不可用或请求失败时回退网页 `AdminDashboard`。桥接测试纳入 `test:native-panels`，真机验收见 [原生文档](../../../native/doc/README.md)。
