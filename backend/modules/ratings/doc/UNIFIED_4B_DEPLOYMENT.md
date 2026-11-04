# 统一 4B 后的部署

本次把评分画像改为复用后端现有的 `Qwen/Qwen3-Embedding-4B` 接口，并重新训练配套 PCA 和预测模型。私有服务继续使用 Node，不需要部署 Python、Torch、独立编码容器或 Hugging Face 模型缓存。

配套私有服务版本：`main` 提交 `2d3ed8c`。请同时更新本次后端改动与该私有版本。

## 部署顺序

1. 备份现有数据库和当前版本。
2. 更新私有服务，包含完整的 `src/` 和 `models/research-full-nonchain-4b-v3/`。若配置过 `RECOMMENDATION_MODEL_DIR`，删掉旧配置或指向新的 4B 目录。重启后检查 `/v1/capabilities` 的 `result.bootstrap_model`：`status=ready`、`model_id=research-full-nonchain-4b-v3`、`encoder_model=Qwen/Qwen3-Embedding-4B`。
3. 更新并重启后端，保留现有私有服务 URL/token、DeepSeek 配置及以下 embedding 配置：

```dotenv
SILICONFLOW_API_KEY=现有密钥
SILICONFLOW_BASE_URL=https://api.siliconflow.cn
EMBEDDING_MODEL=Qwen/Qwen3-Embedding-4B
MODEL_PROFILE_MODE=active
```

4. 删除已不使用的 `MODEL_FEATURE_EMBEDDING_URL/TOKEN`。不启动旧的 `Dockerfile.encoder`。
5. 等待后台画像逐步生成，检查地图原有评价、公共评分、本人预测评分、列表排序和随机推荐。需要灰度时使用原有四个 `RATING_*_MODE=shadow`；确认后改为 `active`。

## 数据与客户端

- 地图和六维偏好已有的 4B 向量继续保留；评分采用自己的文本模板，单独重新编码。
- 新画像按新模型 hash 保存，旧画像、历史导入及默认评价不会删除。画像尚未生成或接口暂时不可用时，保留原有地图聚合评分回退逻辑。
- 画像提取和编码会调用现有云端 API，需要账户余额；列表请求本身只读取缓存。
- 本次改动不涉及前端和 iOS 展示，不需要为这次 4B 切换重新打包。此前若还有未发布的客户端改动，按原客户端发布流程处理。

模型实验结果、特征约定与限制见 [FULL_NONCHAIN.md](FULL_NONCHAIN.md)。私有服务中的 `docs/UNIFIED_4B.md` 包含完整训练及回滚说明。
