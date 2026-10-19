# 管理界面

AdminExhibitions 在后台底部提供展会联动设置，沿用公告发布权限。名称/信息使用 TextInput，简介使用 TextArea；图标复用 `/upload`。发布后替换当前展会，支持下架。接口与浏览器回归分别在 `backend/tests/community/test_exhibitions.js` 和 `test_exhibition_ui.js`。

AdminDashboard.jsx 提供管理入口，AdminUsers/GeneralUsers/Places/Comments/QQWhitelist/Notices 分业务页，BanModal/AuditModal 负责关联弹层。显示权限与当前用户联动，后端才是授权和事务权威；目录整理不新增权限。

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

现有分页面方式优于一个管理大组件；通用表格在 components/data。列表页面仍存在重复网络与错误处理，可在覆盖充分后抽取。案例（待独立浏览器自动化）：ADM-F01 三种管理员和普通用户看到正确入口；ADM-F02 后端拒绝时不乐观显示成功；ADM-F03 封禁/删除确认取消不发请求；ADM-F04 切目标/账号时旧列表不覆盖当前页。i18n 仅检查文案，不算这些行为覆盖，见 ADM-F01 的 [清单](../../../doc/HISTORY_AND_TODO.md)。
