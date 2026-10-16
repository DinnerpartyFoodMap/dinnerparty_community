# Git 修改证据、复现入口与维护待办

核对到 `2bc8c5e`，2026-10-15。本文件基于本地 Git 提交内容与当前代码；标题不等于缺陷根因，下面只概括已核对的改动。原路径见 [迁移对照](MIGRATION_MAP.md)。本次没有回退工作区或对运行数据做迁移。

2026-10-16 工作区新增：日记算法移到独立私有 API，前端、数据库和公开发布事务保持原边界。新增传输/回调、迟到结果、版本竞争、旧任务重试及配置工具回归；算法细节在私有服务验证，见 [日记算法接入](../modules/journeys/doc/ALGORITHM_SERVICE.md)。这些变更尚未提交。

## 历史已落地的修复与优化

这些不是待修复缺陷，也不是本次新完成的业务功能。复现用今日对应的临时库测试，历史实现在 Git 中只读核对。

| 提交 / 日期 | 可核对的修改 | 今日回归入口（backend 下） | 文字案例 |
| --- | --- | --- | --- |
| `2bc8c5e` / 10-15 | 增加地点位置编辑交互与真实前后端测试，后端位置校验沿用原流程 | npm run test:place-location | PLC-C03 |
| `2566978` / 10-15 | 搜索从固定字段层级改为文字 + 距离联合排序，先排序后 limit，显式避雷筛选与日期解析 | npm run test:search | DSC-C01～C06 |
| `ed3b2f9` / 10-15 | 贡献/一致度/时间衰减权重、三轮计算、声誉 worker 和原子发布，补迁移与权重测试 | npm run test:ratings | RAT-C01、C04～C07 |
| `13576c8` / 10-15 | Bot AI 命令解释、最近定位随机中心、共享卡片与 AI 客户端异常覆盖 | npm run test:qq-bot；test:ai-clients | BOT-C02、C05；ACC-C07 |
| `65ce2d4` / 10-14 | 引入四档评价、每日配额、个性化口味分与画像正向信号 | npm run test:ratings；test:preferences | RAT-C01～C04、C07 |
| `d285076` / 10-14 | QQ 私信验证码注册/重置、图片隐私与重复编码处理、QQ/微信分享与缩略图测试 | npm run test:qq-verification；test:images；test:place-share | ACC-C02～C05；MED-C02；PLC-C04～C05 |
| `2eadd01` / 10-13 | 图片 OSS 迁移与历史链接兼容相关实现 | npm run test:images | MED-C03～C06 |
| `ce52848` / 10-12 | OneBot、Bot 草稿、群成员同步与持久通知，共用地点创建逻辑 | npm run test:qq-bot | BOT-C01、C03～C04 |
| `01e11a4` / 10-12 | 日记生成与审阅交互完善、公开发布测试调整 | npm run test:journeys；test:journey-publication；test:journey-ui | JRN-C01～C08 |
| `582e5e3` / 09-16 | 初始 AI 行程总结能力 | npm run test:journeys | JRN-C02～C04 |
| `ee40402` / 09-08 | 随机推荐边界修正与回归：先判断完整候选池，再排除最近两家 | npm run test:random | DSC-C07 |

核对方法（仓库根目录）：

```sh
git show --stat 2566978
git show 2566978 -- backend/services/placeSearch.js backend/scripts/test_place_search.js
git show d285076 -- backend/services/qqVerification.js backend/scripts/test_qq_verification.js
git show ed3b2f9 -- backend/services/ratingWeightModel.js backend/scripts/test_rating_weight_model.js
git log --follow -- backend/modules/discovery/services/placeSearch.js
```

最后一条在本次改动提交后可跨重命名追踪；未提交时对新路径运行不会凭空出现历史，先用迁移表找到旧路径。案例文件与模块入口：accounts、places、ratings、discovery、preferences、journeys、media、qqbot 的 `doc/TEST_CASES.md`；小模块案例直接写在 README。

## 本次整理已完成的维护项

- [x] 业务路由与服务归入模块；数据库、日志、缓存、模型客户端归基础设施；测试与运维工具分开。
- [x] 124 个旧文件路径对照，内部导入与 npm 入口同步迁移，保留延迟加载位置。
- [x] 统一 backend 数据根目录，保留 DB_FILE 相对路径含义及上传、seed、日志位置。
- [x] 按模块补可编辑 Mermaid 流程与选型对照，复杂流程配文字案例，原专题文档保留。
- [x] 增加静态结构检查与非浏览器/浏览器测试汇总；日记澄清测试复用现有 JSON loader 适配 Node。

“已完成”指维护内容落地，测试实绩与限制单列在 [验证记录](VERIFICATION.md)，不把下面未执行的专项验证算作通过。

## 后续待办

2026-10-15 追加：独立 SQLite → 私有 OSS 备份、Windows 计划任务安装器与恢复说明已实现，见 [备份操作说明](../infrastructure/doc/DATABASE_BACKUP.md)。临时 WAL/向量库恢复、模拟上传失败和任务构造已覆盖自动化；真实备份 Bucket 配置、首次云端上传、生命周期设置及生产恢复演练仍需在部署环境完成。

所有事项仍未完成。P1 表示优先维护，P2 表示按需求安排；这不是线上事故严重度。`已确认结构问题` 可由代码直接观察，`覆盖缺口` 不等于已经证实功能错误，`策略评估` 需要产品/部署决策。本次不顺带改变这些行为。

| ID / 优先级 / 类型 | 依据与影响 | 建议动作与验收 |
| --- | --- | --- |
| INF-01 / P2 / 已确认结构问题 | index.js 仍同时处理 CORS、SDK 流式代理、客户端诊断、路由装配与生命周期；本次先稳定模块目录 | 提取 createApp、代理和配置，保持中间件与路由顺序；补本机伪上游的 CORS/取消/错误请求回归，启动不得打开工作库 |
| INF-02 / P1 / 已确认结构问题 | placeVectorService.startVectorRetryWorker 返回 interval，内部还有 initialTimer；index.js 未保存/停止它，其他 worker 有停止入口 | 统一 worker stop 契约，清理两个定时器，明确在途任务策略；启动后立即退出、重复退出、上游超时各有断言 |
| INF-03 / P2 / 已确认结构问题 | infrastructure/database.js 仍包含基础表与旧 ID 兼容迁移，并回调业务 schema | 在保留旧库夹具下分迁移阶段，显式顺序与幂等性；test:migration 和全部事务测试通过后再替换 |
| ACC-01 / P1 / 策略评估 | auth.js 的 Redis 错误路径允许 JWT 认证；服务不可用时撤销不能严格即时生效 | 明确故障可用性与撤销窗口要求；补断线、撤销、重连组合测试，按决定记录策略，不悄悄改成全部拒绝 |
| ACC-02 / P1 / 已确认工具问题 | scripts/accounts 的两个旧工具内置开发用户名与密码，会直接写 User | 改为显式参数与目标 DB，拒绝缺参数，避免输出密码；用临时库覆盖无参数拒绝、指定用户、错误目标场景；不可作为生产账号初始化方案 |
| PLC-01 / P1 / 覆盖缺口 | Web/Bot/日记创建都涉及评分与通知，已有测试分散在不同入口，审核事务测试不能代表全链 | 补分类/评分/通知写入故障注入矩阵，三入口都验证无部分记录、提交后动作不发生、重试不重复，见 PLC-C06 |
| RAT-01 / P2 / 覆盖缺口 | 配额、时间衰减、迁移时间和每日声誉各有测试，但组合时钟与重启失败需更明确 | 提供共享固定时钟夹具，跑跨北京时间零点与刷新失败恢复；不改变现有数学公式，见 RAT-C08 |
| DSC-01 / P2 / 性能评估 | placeSearch 当前召回完整候选后在 JS 排序；此设计修复先截断漏结果，但成本随候选量增加 | 保存合成规模数据、生成参数、P50/P95/内存和排名等价性；有证据再评估索引或搜索引擎，不能先恢复候选截断 |
| DSC-02 / P2 / 覆盖缺口 | alongRoute 独立几何工具与路由，无专门 test 文件 | 为非法/重复/极短路径、距离边界、避雷与空结果补服务及 HTTP 案例；不把直线距离当行车路线 |
| PRF-01 / P1 / 覆盖缺口 | placeVectorService 有内容哈希、pending 与网络重试，现有画像测试不等于完整向量写入竞态测试 | 用可控 Embedding 延迟验证旧响应、连续修改、重启重试；向量必须匹配当前文本哈希，见 PRF-C06 |
| JRN-01 / P1 / 覆盖缺口 | 日记任务持久化和取消已有测试，需覆盖领取后进程硬终止及模型迟到的组合 | 可控子进程中断和恢复，验证 revision/取消检查、幂等提交及无重复通知，见 JRN-C09 |
| JRN-02 / P2 / 已确认耦合 | communityPreferences 与 community 路由依赖 journeys/Store 的 SQL、now、fail 等通用工具 | 将通用数据库/错误工具移到合适共用层，避免社区初始化隐式依赖日记；保留错误状态、事务边界并跑两模块测试 |
| COM-T01 / P2 / 覆盖缺口 | 评论、聚餐、公告没有对应独立测试文件，test:community 重点是向量匹配 | 补身份、归属、删除级联、公告可见时间与空内容边界；测试名按实际模块发现，不宣称已有覆盖 |
| COM-T02 / P2 / 维护优化 | 同意、曝光、抽取、事件校验仍集中于 community 路由 | 按状态写入边界提取服务，保留 consent_version 与请求哈希；用现有 test:journeys 覆盖后再补重复/冲突矩阵 |
| ADM-T01 / P1 / 覆盖缺口 | 集中权限表存在，但缺完整管理角色 × 操作 × 目标身份矩阵 | 补 ADM-01/02，拒绝时无写入；逐条核对审计与业务写入是否需原子性，不默认所有操作已原子 |
| MAP-T01 / P2 / 覆盖缺口 | 高德 REST 路由与 index SDK 代理缺独立上游失败/超时/取消测试 | 本机伪上游验证坐标、key 缺失、限流、header 过滤、jscode、8s/15s 路径；不访问真实高德 |
| MED-01 / P1 / 恢复演练 | 图片迁移有预演、备份和幂等测试；备份生成不证明恢复步骤已演练 | 临时 DB + 假 OSS 注入失败并恢复，给出对象与引用核对结果，见 MED-C07 |
| BOT-01 / P1 / 人工兼容与覆盖缺口 | 图文卡依赖 NapCat 发包，通知存在外部发送与本地状态提交边界 | 补断线/崩溃重试窗口测试并明确至少一次的限制；经授权测试群人工核验卡片与链接降级，记录环境，见 BOT-C07 |
| QA-T01 / P2 / 待验证的测试稳定性 | 本次日记 UI 首轮等待“未完成 · 1”超时，未改选择器的诊断复跑和正式复跑均通过，尚不能判定根因 | 失败时保存可见按钮、草稿接口与页面异常；多次隔离运行定位状态或时序因素，不用延长固定等待或弱化断言代替分析 |

## 维护规则

修完一个待办：保留 ID，标完成，附新提交、复现案例与实际验证结果。新发现先写证据和可执行验收；推测风险需标“待验证”，不能添加成已确认 bug。不要删去已修复的历史记录，也不要把历史性能数字当本次机器上的基准。
