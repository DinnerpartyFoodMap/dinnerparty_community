# 日记算法私有服务拆分设计

日期：2026-10-16。范围来自本次确认：前端保持不变，后端算法闭源；开源项目可以依赖作者运营的私有 API。

## 边界

原后端保留账户、日记/图片 CRUD、素材草稿、版本、任务、额度、权限和全部地图发布事务。私有服务负责原有图文重建、地点候选融合与评分、序列排序、位置澄清、合并规划和分享文案。算法实现和提示词从公开跟踪的源码移出，不保留本地算法回退。

私有源码放在仓库根目录 `.private/journey-algorithm-service/`；整个 `.private/` 被 Git 忽略，可独立复制到私有仓库。开源文档只描述协议与接入。现有数据库和前端源码不迁移。

## 协议

私有服务通过 Bearer `JOURNEY_ALGORITHM_SERVICE_TOKEN` 鉴权。`GET /v1/capabilities` 返回 `{protocol_version:1,result:{text_ai,vision_ai,amap_search,amap_export,version}}`。`POST /v1/compute/:operation` 接收 `{request_id,input}`，返回相同信封中的计算结果。

操作：`reconstruct` 输入 `{input,images:[{id,data}]}`，图片 data 为 WebP base64；`search` 输入 `{name,city,center}`；`rank` 输入 `{document,replacements}`；`merge` 输入 `{a,b,options}`；`clarify` 输入 `{input}`；`share` 输入 `{platform,style,min,max,facts}`。结果保持原有业务方法返回结构。模型密钥只存在于私有服务。

私有服务没有数据库权限。检索本地地点通过配置好的 `JOURNEY_PLACE_LOOKUP_URL` 调用原后端 `POST /internal/journey-algorithms/places`，使用单独的 `JOURNEY_ALGORITHM_CALLBACK_TOKEN`。仅接受 `{name}`，只返回原先 LIKE 查询的最多 400 条地点基本字段，不提供任意 SQL、用户或日记数据。

每个私有实例只与一套地图数据库配对。检索、生成和澄清输入携带 `amap_storage_allowed`，与私有实例的开关共同约束第三方地点搜索。接收请求上限为 144 MiB，覆盖既有 100 MiB 图片配额的 base64 开销；结果上限保持 1 MiB。

## 一致性与失败

所有 HTTP 计算在 SQLite 写事务之外执行；远程结果到达后重新检查归属、草稿/来源版本和任务取消状态。合并提交在本地事务内再次复核版本、预览哈希和 request_id。远程返回的文档在保存前仍使用现有规范化与图片归属检查。

私有服务以请求 ID 和输入哈希去重正在运行与近期完成的计算；同 ID 不同内容返回 409。成功结果缓存有大小与期限限制。客户端设置超时、限制响应大小、不跟随重定向，不盲目自动重试生成；原任务的取消使迟到结果无法落库。服务重启后的模型费用去重不作保证，沿用现有失败后主动重试语义。

未配置服务时能力发现返回不可用，手工日记和地图功能继续工作。远程错误不向客户端暴露密钥、私有输入或上游响应正文。服务配置只写服务器环境，不产生 VITE 配置。

## 验证与交付

公开测试用本地协议桩验证业务行为，不依赖私有源码；算法原有细节回归迁入私有服务测试。补充服务鉴权、回调隔离、协议/畸形响应、超时、重复请求、取消、版本竞争和合并事务测试。运行完整后端测试、前端测试和生产构建；另运行真实私有服务的端到端回归。交付可启动的私有服务、部署示例、开源接入说明、私有打包产物和验证记录，不推送或部署线上服务。
