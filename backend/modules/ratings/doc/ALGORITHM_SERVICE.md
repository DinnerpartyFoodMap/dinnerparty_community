# 评分与用户向量私有服务接入

现有 `.private/journey-algorithm-service` 同时提供日记和数值能力。公开后端持有 SQLite、权限、评分/收藏/介绍/行为历史；私有服务只接收有界快照和计算，不读取数据库文件，不提供任意 SQL，也不自动保存请求正文。

本次保留迁移前公式、量表、算法版本与刷新周期。点击、介绍理由、同分确认作为下一阶段证据，本轮不额外影响评分或画像。地点 embedding 提供商、随机抽样策略、搜索排名及六类口味雷达整体模型仍属于原模块。

## 配置与启动顺序

后端可以复用原日记服务地址/令牌；也可单独配置数值入口：

```dotenv
JOURNEY_ALGORITHM_SERVICE_URL=http://127.0.0.1:7100
JOURNEY_ALGORITHM_SERVICE_TOKEN=<private-service-token>
# 留空表示复用上面两项
NUMERIC_ALGORITHM_SERVICE_URL=
NUMERIC_ALGORITHM_SERVICE_TOKEN=
ALGORITHM_DATASET_ID=primary
RATING_EVIDENCE_EXPORT_ENABLED=false
RATING_EVIDENCE_STATUS_TOKEN=
```

凭据只放服务器环境，不放 VITE 配置。一个私有实例对应一套数据集，dataset_id 由主后端配置，前端不能指定。

1. 备份原应用发布物、配置和数据库；先启动新版私有服务。
2. 检查 `/v1/capabilities` 的 ratings/preference/evidence 为 true、numeric_contract_version 为 1；原六个日记能力继续兼容。
3. 再启动新版主后端。`init()` 执行可重复的增量建表和 baseline_import，已有未知历史仍为未知。
4. 先在临时库或受控副本对照，确认数值、权限、撤回、封禁和故障行为，再进行实际发布。本文不会自动重启或部署服务。

启动信誉追平由评分请求的就绪检查约束。已有有效批次和输入版本一致的缓存可复用；失效结果和新评分计算需要服务在线。服务离线时不改用等权均分，也不显示伪造的 0 分。手工日记编辑等不依赖数值结果的功能仍使用原数据库。

## 数值协议

沿用 `POST /v1/compute/<operation>`、Bearer 鉴权、request_id 幂等和 protocol_version=1 信封。通用 input 带 contract_version=1、dataset_id、snapshot_id、input_revision、as_of_ms 和 purpose；响应必须回传相同上下文。

| operation | 用途 |
| --- | --- |
| preference | 原 UserPreference 合成及状态判断 |
| vectormean | 公共地点均值；按 200 个向量分批携带 Float64 累计状态 |
| ratingweights | 原信誉、衰减和逐评分权重；大结果返回分页票据 |
| ratingweightspage | 读取同一快照的后续权重结果页，不重复计算 |
| ratingsummary | 最多 200 店一批的公开评分统计 |
| ratingview | 单店公开/个人分，必要时包含投影后的本人画像 |
| personalaverages | 地点列表使用的个人评分集合 |
| ratingsort | 原地点列表综合排序分 |
| evidence | 校验和归并授权证据，返回计数，不产生新评分 |

持久化向量传 Float32 little-endian base64；mean/累计和传 Float64，避免截断精度。主后端校验维度、有限值、状态、分布人数、主体归属、输入版本、正权重和完整键集合后才能发布。

普通数值请求上限 32 MiB；信誉批次上限 128 MiB，以覆盖放大数据集的快照，返回仍每页不超过 1 MiB。大权重结果采用有期限、受同一快照上下文约束的随机票据，私有分页缓存总量不超过 16 MiB，票据 120 秒过期。后端收齐所有页并验证完整性后才一次性发布；服务重启/票据过期都不能发布半批。

数值客户端默认 10 秒超时；独立数值并发槽默认 4。原日记请求预算和超时不变。大批次需要按实际内存和并发配置容量；十倍合成测量的单进程统计包含测试客户端和服务端，不能视作线上资源保证。

## 业务与一致性

- 新评分/撤回先构造投影，再复核版本并原子发布评分、本人画像、历史、额度和回执。
- 同分确认不改旧 source/updated_at/weight，不多计票或额度；无确认标记的旧客户端保持原同分无操作语义。
- 同分确认保留仍有效的画像及原刷新期限；异步组合携带实际输入版本，返回前复核发现/屏蔽关系，写入事务重新读取账号和编辑权限。
- 幂等回执只证明已提交；重试重新鉴权并返回当前状态。已提交但当前汇总不可用时响应带 committed=true，前端明确提示已保存。
- 信誉更新、摘要缓存和用户向量各自验证输入版本。封禁/删除不能靠旧缓存保留评分；worker 停止后拒绝迟到发布。
- 创建地点保持本地短事务；Web/App 的单票摘要在提交前准备，QQ/日记原成功响应无需新增摘要 RPC。

## 研究证据与导出

原点击、导航、收藏分别保留其含义；导航是意图，收藏不是到访，点击不新增票权。研究选择、事件上下文及撤回链路独立于旧算法字段。

导出默认禁用；需要显式配置用途、至少 32 字符的 FEEDBACK_EXPORT_SECRET 和状态查询凭据。先在 backend 目录执行预览：

```powershell
node scripts/ratings/export_rating_evidence.js
# 审核预览后才显式 --apply；本次实现没有执行真实导出
```

只允许受控 datasets 目录。输出使用 HMAC 假名键，记录来源、可用时间、窗口、版本和 hash；这是假名化，不能称完全匿名。行为研究窗口最长 30 天；业务画像的读取窗口不改变。

包包含 events、favorite states、rating_revisions、description_revisions、reason_links 与 decisions。评分带入口/量表版本和体验时间依据；介绍仅导出有授权的新文本或可明确区分的前/后追加片段，旧 before 文本不输出，价格等修改不冒充介绍作者。任意混合修改只导出修订元信息并标记 mixed_or_replaced_unresolved，不推断逐段作者或将整段当作本人的评价理由。决策仅导出算法/策略/特征快照/展示版本、候选地点及原有概率或顺序，不复制自由文本、坐标或整个 result。缺失信息保持未知，搜索不补造 propensity。清空交互同步撤销原行为镜像的研究资格，保留原画像业务输入。

ResearchBundle 注册表保存成员/地点和最早到期时间。撤回、清除反馈、账户/关联地点删除使整包先失效，再由清理 worker 删除文件；失败可重试。私有离线加载器每次使用前调用受限 `/internal/rating-evidence/bundles/:id/status`，状态服务离线、hash 不符或过期时拒绝读取。

包状态接口使用独立 RATING_EVIDENCE_STATUS_TOKEN，仅返回有效状态/hash/期限，不扩展日记地点查询权限。初期只支持包文件与清理 worker 共享受控文件系统的部署；跨机未建立相同清理边界前保持导出关闭。运行时镜像不包含 datasets、测试、原始快照或凭据。

## 测试与回滚

公共协议测试 `test_numeric_client.js`、`test_numeric_protocol.js` 使用独立固定响应，不导入私有算法。数据/事务测试用临时 SQLite。完整数值集成测试需一个支持新契约的服务 URL/token；公开测试不需要导入私有源码。

拥有本地私有目录时，可从该目录运行：

```powershell
npm test
node scripts/run_backend_tests.js
node scripts/run_backend_tests.js scripts/testing/run_tests.js --ui
node scripts/benchmark_numeric.js
```

驱动启动临时本地数值服务并向后端测试子进程注入测试配置，不加载生产凭据、不打开生产数据库。真实 HTTP 集成必须实际启用，不能把 skipped 当通过。

回滚使用迁移前配对的主后端/私有服务发布物和数据库备份；保留新增历史表，不删除事件或回退 schema。最终公开代码无本地算法回退，也不依赖 `.private/` 本地 require。需要恢复旧公式时回滚发布物，不能临时在公开侧另写一个简化平均值。

本地交付与验证记录见 [迁移验收](MIGRATION_VERIFICATION.md)。实际发布、生产备份和配对发布物回滚演练尚未执行；发布前按以上顺序准备两个仓库的发布物，避免只更新主后端。
