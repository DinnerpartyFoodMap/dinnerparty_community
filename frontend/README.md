# 前端维护入口

技术支持页位于 [support/index.html](support/index.html)，无需登录或 JavaScript，可在 `/support/` 阅读联系方式、常见问题、账号注销与英文支持说明。App Store Connect 的 Support URL 使用 `https://www.dinnerparty.cc/support/`，须先将构建后的 `dist/support/index.html` 部署到官网并确认匿名访问正常。该页面已加入 Vite 多页入口与开发/预览路由，并排除在 iOS Universal Links 之外，避免打开支持链接时跳回 App。支持邮箱与政策页保持一致：`bl333@dinnerparty.cc`。

隐私权政策与用户协议为独立静态页面，源文件在 [privacy/index.html](privacy/index.html) 与 [terms/index.html](terms/index.html)，开发和构建后均通过 `/privacy/`、`/terms/`（或不带斜杠）访问。Vite 多页入口将其输出为 `dist/privacy/index.html`、`dist/terms/index.html`，仅阅读政策不会加载业务脚本、高德 SDK 或字体 CDN。两个入口总是成对出现（`src/auth/legalPages.js`、`src/auth/components/LegalLinks.jsx`）：登录页底部、桌面顶部更多菜单、窄屏更多面板底部、iOS 原生工具栏上拉面板底部小字与 iOS 原生设置首页，均以新窗口或系统浏览器打开，不丢失当前表单和编辑状态。注册（登记名册）须勾选同意这两份文件。首次使用由 `src/app/PrivacyConsent.jsx` 阻断业务启动，同意后才动态导入 App、初始化平台并加载高德和图标字体；拒绝后可阅读政策和重新选择。同好发现、反馈和研究的默认开启状态不等于有效的单独授权。

部署静态产物时需保留 `privacy/`、`terms/` 目录，令 `/privacy/`、`/terms/` 提供各自目录的 `index.html`，不要将这些地址回退到地图应用首页（`public/.well-known/apple-app-site-association` 也已把它们排除在通用链接之外）。Vite 开发与预览服务器已处理 `/privacy`、`/terms` 的目录跳转；App 中的政策链接使用运行配置中的公开网站地址并交给系统浏览器打开。高德条款核对依据：[现行隐私权政策](https://lbs.amap.com/pages/privacy/)、[SDK 合规使用方案](https://lbs.amap.com/api/compliance-center/check-and-reference/sdkhgsy)。政策提供方名称以现行政策为准，不能直接套用历史模板。

隐私选择以 `foodmap.privacy-consent` 保存在本机，包含政策版本、accepted/rejected 与时间。重大政策变化时更新 `src/platform/privacyConsent.js` 的 `PRIVACY_POLICY_VERSION` 并同步政策正文，旧版本记录会重新提示。存储受限时仍支持本次选择；`loadAmap()` 本身也检查同意状态。运行 `npm run test:privacy` 验证旧版/损坏记录、拒绝、SDK 守卫和存储不可用；浏览器另需验证全新访问、拒绝后刷新、重新选择、同意后刷新及独立政策页。

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
