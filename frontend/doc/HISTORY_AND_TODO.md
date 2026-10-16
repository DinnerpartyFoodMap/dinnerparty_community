# Git 修改记录、复现与后续维护

核对基线 `2bc8c5e`，2026-10-15。历史表是已存在的修复/优化，本轮只整理目录与文档，不把旧修复算作新实现。原路径见 [迁移对照](MIGRATION_MAP.md)，本次结果见 [验证记录](VERIFICATION.md)。

## 已落地的历史改动

| 提交 / 日期 | 已核对内容 | 今日验证入口（frontend 下） | 案例 |
| --- | --- | --- | --- |
| `2bc8c5e` / 10-15 | 地点修改位置、保留表单草稿、标记移动与位置浏览器 harness | npm run test:ui 的地点组 | MAP-C03、PLC-FC03 |
| `d6af195` / 10-15 | Android 添加标记点相关背景触摸误关闭修复：MotionSurface + backdropPress 与 73 行回归 | npm run test:overlay | OVL-C01 |
| `ed3b2f9` / 10-15 | 评分权重更新后的前端提示和评分面板配套调整；数学权重在后端 | npm run test:rating；后端 test:ratings | PLC-FC01 |
| `65ce2d4` / 10-14 | 四档评分界面、摘要更新、兴趣画像与地图避雷共享展示规则 | npm run test:rating；后端 test:ratings | PLC-FC01、FC02 |
| `c19d13b` / 10-14 | 原生设置与 Web 共享账号请求、请求响应桥接、头像/地图/主题子页 | npm run test:native-chrome 的设置组 | SET-C01、PLT-C05 |
| `d285076` / 10-14 | QQ 私信码注册/重置表单、图片准备与分享、原生设置等稳定性修改 | npm test；后端 test:qq-verification / test:images / test:place-share | AUTH-C01～C06、PLT-C06 |
| `d944e8a` / 10-13 | 境外 CARTO tile、地图区域表、坐标边界与双指松手守卫 | npm run test:map；test:platform | MAP-C04、C05 |
| `3b965d5` / 10-13 | i18next 命名空间、t/tx、AST 文案检查与 JSON loader | npm run test:i18n | i18n 模块入口 |
| `55bbc18` / 10-12 | iOS 返回分发、WebView/深链/导航配合与优先级检查 | npm run test:platform + 人工真机 | PLT-C02 |
| `c841b7d` / 10-12 | 多端玻璃样式与原生显示调整 | 构建 + 原生人工清单 | PLT-C08、STY-C02 |
| `01e11a4` / 10-12 | 日记审阅、公开和地点日记交互完善，浏览器回归同步 | npm run test:ui 的日记组 | JRN-FC01～FC06 |

只读复现历史（仓库根目录）：

```sh
git show d6af195 -- frontend/src/components/overlay/backdropPress.js frontend/scripts/test-overlay.mjs
git show 2bc8c5e -- frontend/src/Map.jsx frontend/src/components/ManagePanel.jsx frontend/tests/place-location-harness.jsx
git show d944e8a -- frontend/src/map/pinchGuard.js frontend/src/platform/chinaRegion.js
git show c19d13b -- frontend/src/settings/useNativeSettings.js frontend/scripts/test-native-settings.mjs
git log --follow -- frontend/src/map/MapView.jsx
```

git log --follow 跨本次重命名需先提交；当前未提交时用旧路径查看 HEAD。运行回归使用现在的路径与临时数据，不切换当前工作区以模拟旧版本。

## 本轮维护内容

- [x] 64 文件归位；MapView、App、AuthPage、聚餐/海报/管理/设置入口各归模块；业务组件离开公共组件平铺目录。
- [x] 地点/发现面板、通用组件、主题/专用工具和测试/历史维护工具按职责组织。
- [x] 静态/动态导入、图片引用、i18n 数据白名单、后端源码读取路径与浏览器 harness 同步。
- [x] 各模块文档、Mermaid 流程与选型对照；复杂模块文字案例、测试协议与历史清单。
- [x] 新增 AST 静态结构检查，并接入 npm test；原命令名和 JSON loader 入口保留。

代码落地不自动等于验证通过，实绩以 VERIFICATION.md 为准。

## 修复与优化待办

以下全部未完成。P1 优先安排，P2 按演进需求安排，非线上事故定级。结构事实、覆盖缺口和待验证风险分开，不凭文件大就声称已存在 bug。

| ID / 优先级 / 类型 | 依据与维护影响 | 动作与验收条件 |
| --- | --- | --- |
| APP-01 / P1 / 结构优化 | app/App.jsx 仍协调认证、导航、主题、原生设置与页面装配，约 42KB | 先画共享状态写入者，再提取认证恢复、页面路由/离开保护和主题同步；保留地图常驻、订阅清理、旧请求抑制；APP-C01～C05 有真实 App 浏览器回归后拆 |
| APP-02 / P1 / 覆盖缺口 | 当前两套 harness 直接装配地图/日记，未加载完整 App | 加 App 级冷启动、离线、明确拒绝、A→B 换账号、深链/后退矩阵；断言凭证与所有消费者，不只菜单 |
| AUTH-01 / P1 / 结构优化 | AuthPage.jsx 约 45KB，含 fetch/XHR/超时/表单/样式 | 先独立测试 transport 与 request 生命周期，再拆表单模式与展示；保留 iOS Chrome 路径、发送码较长超时、requestId 安全处理 |
| AUTH-02 / P1 / 覆盖缺口 | 服务端验证码有测试，前端认证表单无完整浏览器覆盖 | AUTH-C01～C05 用可控 HTTP 与时钟覆盖取消、迟到、超时、冷却和 payload 校验；真实浏览器兼容另验 |
| MAP-01 / P1 / 结构优化 | MapView 约 84KB，MapUI 约 135KB；地图生命周期、查询、面板与业务协调仍混合 | 按地图实例生命周期、视口加载、选择/编辑模式、界面编排渐进提取；不为减少行数引入隐含共享 mutable state；每次只改一个生命周期边界 |
| MAP-02 / P1 / 覆盖缺口 | 聚合/缓存纯逻辑充分，但完整 SDK 手势、定位和多面板中断非两套 harness 全覆盖 | MAP-C02/C05 补晚到请求、定位清理、双指与卡片锚点；使用真实触摸设备验证不能用鼠标替代部分 |
| PLC-F01 / P1 / 待验证风险 | usePlaceRating 的读写请求使用不同状态更新路径，现有测试主要是纯函数/封装 | 用可控迟到评分响应验证切地点/账号后的摘要、saving 与配额隔离；先复现再决定修改，不把风险直接标成 bug |
| DSC-F01 / P1 / 覆盖缺口 | 搜索状态分散在 MapView/MapUI/useSearchPanel，随机面板有取消与身份判断但缺独立 UI 矩阵 | Q1→Q2、换中心、关面板、换账号和本地/POI/AI 逆序响应逐个回归；结果保后端顺序，不恢复客户端旧排序 |
| DSC-F02 / P2 / 覆盖缺口 | 顺路解析和面板缺独立逻辑/浏览器测试 | 无效链接、解析超时、旧路线晚到、取消、空结果与选点核对；与后端顺路几何用例分别覆盖 |
| JRN-F01 / P1 / 覆盖缺口 | 日记有真实浏览器回归，但账号切换、离线冷启动与存储配额失败组合需专项 | JRN-FC07 使用隔离上下文、可控上传和失败存储，验证 A 草稿不流入 B，失败保留可恢复内容 |
| PLT-01 / P1 / 覆盖缺口 | 凭证与本机草稿跨安全存储/IndexedDB/事件订阅，纯 token 辅助测试不能保证恢复时序 | 多窗口、退出期间恢复、切账号与存储失败矩阵；过期 promise 不复活 token、监听随会话清理 |
| PLT-02 / P1 / 真机验证 | JS bridge 单测不能验证 SwiftUI/Capacitor 的系统 UI 和生命周期 | 按 native/doc 清单记录设备/系统/应用/协议版本；键盘、原生 sheet、返回、前后台、相机相册和分享取消有实际结果 |
| SET-01 / P2 / 覆盖缺口 | 原生设置 JS 请求关联已有测试，网页编辑与换账号迟到结果未完整覆盖 | SET-C02/C04 补账号/密码/主题失败重试与账号隔离；头像真实裁图和键盘走真机 |
| UI-01 / P1 / 覆盖缺口 | backdropPress 有逻辑测试，完整 overlay 生命周期、焦点/inert、动效中断与触摸仍需专门场景 | 嵌套弹层、退出中重开、拖动取消、键盘返回、减少动效与后台恢复；断言焦点、栈条目、可点击区和最终状态 |
| API-01 / P2 / 结构优化 | api/client 仍包含多个业务端点，其他模块有专属 fetch；不是统一网络策略 | 按领域拆 API 文件并保留调用签名；错误/取消/认证语义先设矩阵再提取 transport；不能统一 catch 吞错误 |
| ADM-F01 / P1 / 覆盖缺口 | 管理页面缺独立权限/操作 UI 回归 | 角色×操作×目标、取消、服务端拒绝、旧列表晚到；拒绝不能显示成功，不以隐藏按钮代替授权 |
| DIN-01 / P2 / 结构优化与覆盖 | DinnerPages 共文件且缺页面状态回归 | 先 DIN-C01～C04，再拆列表/创建/详情与日期辅助，保留导出/路由语义 |
| PST-01 / P2 / 覆盖缺口 | 海报 canvas 与页面已分离但没有专门图像/交互回归 | 长文本、失败图、空/多地点、旧 blob 与重复生成、系统保存取消，保留可复核输出样例 |
| THM-01 / P2 / 覆盖缺口 | 主题解析与对比色/持久化/订阅跨多模块使用，无独立数学与切账号矩阵 | 固定颜色输入、系统偏好与存储，验证 DOM 变量、hook、原生同步和清理，不单凭截图 |
| I18N-01 / P2 / 文案与布局验证 | AST 检查通过不证明长译文、tx React 片段或真实语言切换布局 | 增加长文案/缺语言回退/可访问名称和计数插值浏览器检查；不要删除数据值白名单来规避约束 |
| PERF-01 / P2 / 性能评估 | 基线与本轮 Web build 均提示 >500KB 分包，日记有 lazy 但主包仍大 | 记录构建体积、路由进入与首屏成本；按业务依赖实测分包，避免仅提高告警阈值掩盖问题 |

本会话上一轮后端记录过日记 UI 首次按钮等待超时、随后复跑通过，根因未定：继续遵循 backend/doc/HISTORY_AND_TODO.md 的 QA-T01，不重复宣称已修复。

完成待办时保留 ID，附新提交、复现案例与实际结果；新增问题附代码/日志证据，未经复现的风险保留“待验证”状态。
