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
MODEL_PROFILE_TIMEOUT_MS=60000
MAP_EAGER_RATING_LIMIT=100
```

4. 删除已不使用的 `MODEL_FEATURE_EMBEDDING_URL/TOKEN`。不启动旧的 `Dockerfile.encoder`。
5. 等待后台画像逐步生成，检查地图原有评价、公共评分、本人预测评分、列表排序和随机推荐。需要灰度时使用原有四个 `RATING_*_MODE=shadow`；确认后改为 `active`。

## 数据与客户端

- 地图和六维偏好已有的 4B 向量继续保留；评分采用自己的文本模板，单独重新编码。
- 新画像按新模型 hash 保存，旧画像、历史导入及默认评价不会删除。画像尚未生成或接口暂时不可用时，保留原有地图聚合评分回退逻辑。
- 画像提取和编码会调用现有云端 API，需要账户余额；列表请求本身只读取缓存。
- 本次改动不涉及前端和 iOS 展示，不需要为这次 4B 切换重新打包。此前若还有未发布的客户端改动，按原客户端发布流程处理。

模型实验结果、特征约定与限制见 [FULL_NONCHAIN.md](FULL_NONCHAIN.md)。私有服务中的 `docs/UNIFIED_4B.md` 包含完整训练及回滚说明。

## 画像报错和地图卡顿修复

后续负面评价和显式“避雷”保护见 [LOCAL_NEGATIVE_GUARD.md](LOCAL_NEGATIVE_GUARD.md)。该修正需配套私有 Node 服务、后端、网页和 iOS 客户端；4B 模型包不变。

更新本次后端并重启即可，私有服务模型不需重训。画像提取使用独立的 60 秒超时；属性按编号输出为对象，省略的属性保留为未知，避免长数组漏项。embedding 失败会保留已完成的画像和向量，重试不再重复调用 DeepSeek。

`MAP_EAGER_RATING_LIMIT=100` 表示新版客户端的实际地图视野超过 100 个地点时，仅返回标记和已有汇总评价；少量点则批量预加载两个评分，外围预取点不计入阈值。点开详情卡仍刷新评分，列表和随机推荐不受影响。设为 `0` 关闭所有地图评分预加载。已有默认/导入评价保留。此次视野/卡片修正需要发布网页和重新打包 iOS，详见 [PROFILE_MAP_V4.md](../../preferences/doc/PROFILE_MAP_V4.md)。

如果仍出现 `Restaurant model profile extraction unavailable`，新日志包含 `stage`、`code`、HTTP 状态和超时时间：

- `profile_parse / profile_attributes_invalid`：模型属性输出格式异常；旧长数组报错会显示期望和实际长度。
- `profile_parse / profile_categories_invalid` 或 `profile_values_invalid`：升级到固定分类/属性编号格式，允许资料不足属性保持未知；旧失败记录自动按新格式重试。错误类型、越界值或未知编号仍会拒绝，不应关闭校验。
- `profile_request / upstream_timeout`：DeepSeek 超时，可按实际服务速度调整 `MODEL_PROFILE_TIMEOUT_MS`，最大 180000。
- `description_embedding` 或 `review_embedding` 配合 `http_status=401/403`：检查 SiliconFlow 密钥和访问权限；`402` 检查余额；`429` 为限流。
- `encoder_contract_mismatch`：确认私有服务加载的是 `research-full-nonchain-4b-v3`，并同步更新后端。

临时需要停止画像任务时可设置 `MODEL_PROFILE_MODE=off` 并重启；地图已有评价会保留。完整诊断和快照性能测量见 [MAP_RATING_PERFORMANCE.md](MAP_RATING_PERFORMANCE.md)。
