# 前端整理验证记录

2026-10-28 的地图界面与 iOS 交互修改单独记录于 [地图验证](MAP_UI_2026-10-28.md)，以下为 2026-10-15 的整理记录。

基线 `2bc8c5e`，2026-10-15；Windows / Node.js v24.19.0。仅记录本次实际运行，不引用其他轮次结果。

## 最终验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm --prefix frontend test` | 通过，退出 0 | 原有逻辑/桥接/i18n 检查 + 新增结构检查 |
| `npm --prefix frontend run test:structure` | 通过 | 161 个受检源码、688 处相对导入，18 个模块入口、文档链接、图片/CSS 模块引用和联调入口 |
| `npm --prefix frontend run build` | 通过，退出 0 | Web 与备案页产物，保留既有分包提示 |
| `npm --prefix frontend run build:mobile -- --outDir ../artifacts/frontend-refactor/mobile-dist` | 通过，退出 0 | 移动配置 HTTPS 闸门、随包图标字体与移动 Web 产物；未同步或修改原生工程 |
| `npm --prefix backend test` | 24/24 测试文件通过，退出 0 | 包括读取前端随机封装、行为源码与日记投影的跨包测试 |
| `npm --prefix frontend run test:ui` | 2/2 浏览器测试文件通过，退出 0 | 使用迁移后 integration harness 的地点位置和日记完整流程 |
| 语法树等价审计 | 160 个原有源码全部等价 | 规范化导入、静态项目根与 i18n 文件路径键后比较 HEAD 与当前 AST；64 个迁移目标存在 |
| `git diff --check` | 通过 | 已跟踪文件无空白错误；新增源码另由 AST 与构建验证 |
| Git 忽略检查 | frontend 文档未被忽略 | 文档可随本次代码收录；根 /docs 忽略规则不影响 frontend/doc |
| 独立只读审查 | 一处 P3 文档问题已修正，其余无可操作问题 | 审查者对照 HEAD 与新文件 AST，核对导入/资源/测试根/i18n/harness/npm 入口；后端评分文档两处旧前端路径已同步 |

## 保持与改变

- 64 文件归位、18 个 src 模块入口、7 套复杂模块文字案例；没有改业务状态机、网络端点、UI 文案、路由、坐标算法或桥接字段。
- 相比迁移前，i18n 仍为 1521 keys / 1911 call sites；DATA_STRINGS 仅同步文件路径，不删除检查或放宽白名单。
- 静态与动态导入保持原方式；AST 审计覆盖全部原有前端 JS/JSX/MJS，确认未把 lazy import 变成同步导入。
- tests 移动后更新了 Node 项目根和 npm 入口；scripts/support JSON loader 原路径保留。后端两处读取前端源码的路径与两套 HTML harness 地址同步。
- 大型 App/MapView/MapUI/AuthPage 本轮未拆状态逻辑，后续工作已给出依据与验收条件。

## 环境与覆盖限制

- 迁移前全套既有检查和 Web build 已通过；新结构测试在文档未齐时按预期失败，补齐后最终通过。
- 浏览器使用应用已有 Playwright 包和系统 Edge，通过原有 PLAYWRIGHT_MODULE 环境变量指定，无新依赖；测试连接本机临时 Vite/HTTP 服务与临时 SQLite，未用生产模型/地图/QQ/OSS。
- 本轮正式浏览器回归首次运行即 2/2 通过；之前后端轮次记录的偶发按钮等待超时仍作为未定位事项保留，不宣称已修复。
- Web/mobile 构建均保留原先的 >500KB 主包提示，未通过提高阈值消除告警；分包优化列为 PERF-01。
- 没有执行 Capacitor sync、原生签名/发布、Xcode/Android 编译或真实设备验收。移动 Web 构建不等于原生 App 已通过。
- 认证/管理/聚餐/海报/完整 App 的文字案例中有明确覆盖缺口；两套已有浏览器流程不能证明全站所有页面正确。

## 浏览器复现

从 frontend 运行，或仓库根加 `--prefix frontend`：

```powershell
$env:PLAYWRIGHT_MODULE = '<可解析的 Playwright 包名或绝对路径>'
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm run test:ui
```

保留最终退出码与逐文件断言。测试中的模拟模型不可用、预期 bridge 失效/Redis 降级提示按其测试断言解释，不把输出的一行警告当通过或失败的唯一依据。
