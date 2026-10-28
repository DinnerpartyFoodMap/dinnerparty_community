# 地点评价业务与协议

评分、口味分和信誉计算由私有数值 API 提供；公开侧保留鉴权、四档量表、配额、版本历史和事务。计算实现与参数回归位于私有服务，旧专题已归档到其 original/docs/。部署、故障和测试见 [服务接入](ALGORITHM_SERVICE.md)。

## 量表与可见性

1 强烈拒绝、2 均线之下、3 均线之上、4 强烈推荐。每用户每店只有一条当前评分；撤回删除当前状态，修订记录保留业务历史。封禁用户的评分立即从有效汇总排除。审核中的地点只向创建者开放评分。

综合分小于 2.5 仍按避雷处理；无评分仍回退避雷标签。本次迁移不调整原有计算规则。

## API

所有响应 Cache-Control: no-store；当前身份只取认证结果。

- GET /api/ratings/places/:placeId：返回 place_id、summary（count/average/tier/distribution）、mine、personalized、quota；游客后三项为 null。
- PUT 同路径：score 必须是严格整数 1–4。新客户端附 request_id 和 confirm=true，仍是现有四档点选即时保存。
- DELETE 同路径：撤回；可附 JSON request_id。撤回不退还配额。

每天按北京时间统计评价过的不同地点数。PLACE_RATING_DAILY_LIMIT 默认 10；相同地点当天再次改评不多占一次，同分确认不占额度。创建时附带评价不占此额度。

## 主动确认与幂等

再次点击当前分数写一条 confirm 修订，但不改变当前评分的 source、updated_at、weight，不视作新一次体验。打开面板或默认预选不记录确认。旧客户端没有确认标记时，同分保持原无操作语义。

请求 ID 按用户隔离。同键同命令只执行一次；同键不同评分返回 409。重试先查提交回执，再返回当前可见状态，不能把后续已变化的评分旧响应原样重放。已保存但新汇总暂不可用时返回 committed=true 和明确提示；前端不显示普通“保存失败”。

## 来源、时间与介绍理由

RatingRevision 与 RatingStream 保存升级截点后的版本；RatingCommand 保存提交回执。旧数据只登记 baseline_import，不造过去操作。origin 独立于旧 source，创建来源不能从数值反推。

首评和实际改评的服务端提交时间代理体验时间，basis=submission；确认的空体验时间表示没有新一次体验。PlaceRevision 保存实际作者、执行者、前后资料、提交与可用时间；RatingEvidenceLink 只关联本人对该店的介绍贡献。待审核介绍采纳时归申请者，不归审核者；同值重存和空介绍不会生成新的理由。

介绍编辑仍走原来的地点向量更新逻辑；理由、确认与点击采集不额外参与当前算法。

## 发布与缓存

ratingBusiness 在写前计算拟提交状态，短事务复核输入版本、权限、额度和幂等键，原子提交评分及本人画像。信誉批次原子更新全部信誉、逐评分权重和刷新时间；远程失败不发布半批结果。

ratingSummaryAdapter 只缓存私有服务校验后的结果。RATING_COLUMNS_SQL 只读取缓存，没有本地均分回退；缓存失效后先刷新，再做避雷过滤和排序。不得把 unavailable 伪装为零分。