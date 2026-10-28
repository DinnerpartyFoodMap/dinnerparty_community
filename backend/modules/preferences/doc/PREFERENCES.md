# 用户偏好数据与私有计算

UserPreference 的合成计算已迁入私有服务。公开侧收集业务输入、保存版本和结果；算法实现与参数测试归私有仓库。部署见 [评分与向量服务](../../ratings/doc/ALGORITHM_SERVICE.md)。

## 数据与业务行为

- 当前评分与收藏状态是画像的现有输入。低分排除对应店铺的正向兴趣；当前规则和参数保持迁移前基线。
- 导航记录用户发起导航的意图，不证明地图应用打开或到店。
- 原生分享成功交给系统/应用后记录 share，不证明收件人收到；复制成功后记录 share_copy。
- 收藏增删在本地事务中写 Favorite 与 UserBehaviorEvent；相同状态不重复写行为。
- 点击写 MapInteraction，暂不进入当前画像。新理由与确认也只作下一阶段证据。

UserBehaviorEvent 使用服务端 UTC 毫秒时间。同一用户/event_id 幂等；相同 ID 不同操作冲突。同用户/店/类型在 30 分钟内保留后续事件但 contributes=0；渠道不绕过去重。原每分钟频率限制保留。

## 接口与状态

POST /api/preferences/events 需要登录，字段为 event_id、place_id、event_type、channel；新客户端可附 trigger/surface/contract_version，不改变原功能。

GET /api/preferences/me 返回 status、vector、model、dimensions、algorithm_version、source_place_count、vector_place_count、total_weight、updated_at。状态继续为 ready/pending/empty/unavailable；向量维度 1024，算法版本保留为 2。没有有效结果时不能制造零向量。

公开 getUserPreference 已改为 Promise；所有消费者需 await。随机推荐先取得普通画像对象，再交给同步抽样回调；不能把 async 回调塞入原同步 drawRecommendation。

## 更新与一致性

userVectorAdapter 收集固定快照，事务外调用 preference，写回前复核 input_revision。computed_input_revision 对齐后才清 dirty；同用户在途计算合并。输入连续变化时最多重取一次，随后保留 dirty 等待后台重试。

既有兼容、未过期的干净画像保持原刷新周期；升级时不强制重新计算。来源变化、地点向量变化和删除通过原触发链递增输入版本。worker 停止会取消发布；迟到的旧结果不能覆盖新的收藏或改评。

## 行为用途与保留

地图点击/决策原 30 天清理规则不变；画像的 180 天读取窗口不等于存储期限。AlgorithmEventContext 记录采集时的来源、用途凭据和触发方式，随原事件删除。

研究开关默认值不是明确选择凭据。仅操作既有研究设置开关时记录 ResearchConsentEvent；研究样本同时检查采集时依据、当前允许和撤回。撤回后的旧样本不会因重新开启而自动恢复。

收藏反馈还会镜像到 MapInteraction，统一证据以 UserBehaviorEvent 为主，按 user/event_id 去重。导出默认关闭并先 dry-run，不能靠导出绕过保留期限。更多见评分服务接入中的研究包章节。