# 偏好、收藏与向量

入口：routes/preferences.js（`/api/preferences`）、routes/favorites.js（`/api/favorites`）。userPreferenceService 记录行为，userVectorAdapter 收集版本快照并调用私有服务合成画像；placeVectorService 保留地点 Embedding 同步、哈希与重试；userPreferenceSchema/algorithmSchema 负责增量迁移。业务、状态和用途见 [偏好专题](PREFERENCES.md)，部署见 [数值服务接入](../../ratings/doc/ALGORITHM_SERVICE.md)。六类餐饮偏好雷达仍见 [六类餐饮偏好](TASTE_AXES.md)。

```mermaid
flowchart TD
    Place[地点创建或内容修改] --> Hash[生成地点文本与内容哈希]
    Hash --> Same{向量与哈希兼容?}
    Same -->|是| Reuse[复用向量]
    Same -->|否| Pending[标记待更新]
    Pending --> Embedding[调用 Embedding 边界]
    Embedding -->|成功| Save[保存模型 / 维度 / 向量与状态]
    Embedding -->|失败| Retry[记录失败供重试 worker 处理]
    Behavior[浏览 / 搜索点击 / 收藏 / 评分] --> Validate[身份 / 类型 / 地点 / 去重校验]
    Validate --> Event[存有效行为或收藏状态]
    Event --> Queue[排队刷新用户向量]
    Save --> Queue
    Queue --> Sources[冻结当前来源 / 地点向量 / 输入版本]
    Sources --> Compatible[私有服务按旧规则合成画像]
    Compatible --> Profile[校验模型 / 数值 / 输入版本后原子发布]
    Profile --> Consumers[随机 / 同好 / 口味评分只读使用]
```

| 选择 | 当前实现 | 对照 |
| --- | --- | --- |
| 用户向量 | 主后端提供版本快照，私有服务合成已有地点向量 | 不增加 embedding/LLM 调用；远程结果核对版本后发布 |
| 更新 | 内容哈希与状态机 + 后台重试 | 无条件重算浪费，失败后不留状态则无法补偿 |
| 不完整画像 | 输出状态与覆盖数，消费者按规则退回基础行为 | 把缺失向量当有效零向量会混淆语义 |

已有自动化：`npm run test:preferences`、`test:random`、`test:ratings`。文字案例：[案例库](TEST_CASES.md)。待办 PRF-01、INF-02 见 [清单](../../../doc/HISTORY_AND_TODO.md)。
