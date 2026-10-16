# 前端维护入口

React + Vite，Web / Android / iOS 共用业务界面；平台差异集中在 platform 与原生工程。先读 [架构与边界](doc/ARCHITECTURE.md)，修改前读对应模块 doc，回归方法见 [测试协议](doc/TESTING.md)。

```text
src/
├── main.jsx                  # 稳定的 HTML 启动入口
├── app/                      # App、路由协调、账号与导航菜单
├── auth/                     # 登录、注册、重置、认证上下文
├── map/                      # 地图容器、渲染、聚合、卡片布局
├── places/                   # 地点录入、详情、管理、评论、评分、行为
├── discovery/                # 搜索、随机、顺路
├── journey/                  # 日记与同好工作区
├── dinners/、poster/          # 聚餐、地图海报
├── settings/、admin/          # 住民设置、管理界面
├── api/                      # 保留现有 HTTP 客户端契约
├── components/               # 公共 primitives/forms/feedback/layout/data/overlay
├── platform/、motion/        # 平台能力与动效政策
├── theme/、styles/、hooks/    # 主题、设计变量、通用 hook
└── i18n/、img/               # 文案与图片资源
tests/unit/<模块>/            # 逻辑、桥接与源码约束检查
tests/integration/            # 浏览器测试页面，由后端测试服务装配
scripts/                     # 原生构建补丁、JSON loader、签名工具、legacy
native/doc/                  # 真机验证与平台入口说明
```

| 模块 | 入口文档 |
| --- | --- |
| 应用与认证 | [app](src/app/doc/README.md)、[auth](src/auth/doc/README.md) |
| 地图与地点 | [map](src/map/doc/README.md)、[places](src/places/doc/README.md)、[discovery](src/discovery/doc/README.md) |
| 日记 / 聚餐 / 海报 | [journey](src/journey/doc/README.md)、[dinners](src/dinners/doc/README.md)、[poster](src/poster/doc/README.md) |
| 设置与管理 | [settings](src/settings/doc/README.md)、[admin](src/admin/doc/README.md) |
| 平台与动效 | [platform](src/platform/doc/README.md)、[motion](src/motion/doc/README.md)、[原生工程](native/doc/README.md) |
| 共用能力 | [components](src/components/doc/README.md)、[api](src/api/doc/README.md)、[theme](src/theme/doc/README.md)、[styles](src/styles/doc/README.md)、[hooks](src/hooks/doc/README.md)、[i18n](src/i18n/doc/README.md) |

```sh
npm test                 # 原有检查 + 新增结构检查
npm run test:structure   # 语法树导入、文档、图片/CSS 引用与联调入口
npm run test:ui          # 转发到后端的真实前后端浏览器集成测试
npm run build            # Web；build:mobile 验证移动配置并构建
```

旧 npm 命令名均保留，源码的旧文件路径不保留兼容壳。找旧文件看 [迁移对照](doc/MIGRATION_MAP.md)；找历史修复和后续拆分工作看 [Git 历史与待办](doc/HISTORY_AND_TODO.md)；本次实际结果见 [验证记录](doc/VERIFICATION.md)。文档集中在业务模块根部，不为每个 components/hooks 子目录重复生成整套文件。大型组件的状态逻辑本轮保留，后续按待办逐步提取。
