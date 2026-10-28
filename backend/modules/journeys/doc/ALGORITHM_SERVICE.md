# 日记私有算法服务接入

前端继续使用现有 `/api/journeys`、`/api/public/journeys` 和地点日记接口。开源后端负责账户、权限、日记与图片、草稿、版本、任务、配额和发布事务；图文抽取、候选评分与排序、位置澄清、合并规划和分享生成由独立私有 API 完成。

## 开源部署

地图及手工日记不要求算法源码或模型密钥。启用算法时向服务运营方取得地址、凭据及对应的地点回调配置，在 `backend/.env` 设置：

```dotenv
JOURNEY_ALGORITHM_SERVICE_URL=https://your-algorithm-service.example
JOURNEY_ALGORITHM_SERVICE_TOKEN=your-service-token
JOURNEY_ALGORITHM_CALLBACK_TOKEN=your-different-callback-token
JOURNEY_ALGORITHM_TIMEOUT_MS=120000
```

这些配置只属于后端，不添加 `VITE_` 变量。未配置或服务离线时能力发现返回不可用，日记保存、日历、图片读取、公开阅读和地图发布继续使用原数据库；生成、候选重排、澄清和合并需要服务在线。静态分享地图仍由原后端处理。

评分与用户向量也由该私有实例提供数值能力。地图评分读取、Web 创建的评分摘要及画像重建的服务依赖和缓存规则，见 [评分与向量接入](../../ratings/doc/ALGORITHM_SERVICE.md)。手工日记不因此新增大模型调用或体验填写步骤。

**一个算法服务实例与一套地图后端/地点数据库配对。** 私有实例的 `JOURNEY_PLACE_LOOKUP_URL` 固定指向配对后端；同一实例和凭据不能服务多套独立地点数据库，因为数字地点 ID 可能代表不同店。多个部署应由运营方提供分别配置的实例。

## 本机私有实现与启动

本机实现位于仓库根目录 `.private/journey-algorithm-service/`，整个目录被 Git 忽略。复制它到私有仓库即可单独维护，公开克隆不包含它。Node.js 22+ 即可运行，无新增运行依赖。

本机已有服务源码时，从 `backend/` 先预览再应用配置：

```sh
npm run journey:configure-private
npm run journey:configure-private -- --apply
```

工具复用原有模型配置，将它写入私有服务 `.env`，创建两组不同的随机凭据，并补齐原后端的调用配置。它保留其他配置，首次修改前备份原后端 `.env` 到私有目录，不输出密钥。可用 `--service-dir` 指定已移到其他位置的私有源码，用 `--url` 指定实际 API 地址。

随后分别在私有服务目录和 `backend/` 执行 `npm start`。默认私有服务监听 `127.0.0.1:7100`，地图后端监听原来的端口（通常为 7000）。两侧修改配置后重启对应进程，前端不用重建。

跨机器部署时，将私有服务的 `JOURNEY_PLACE_LOOKUP_URL` 指向地图后端的 `/internal/journey-algorithms/places`，设置相同回调凭据。使用内网或 HTTPS，并限制回调入口访问；浏览器不直接访问私有服务。日记模型密钥放在私有服务环境中；原后端用于语义搜索和地图代理的独立密钥继续保留。

## 接口与一致性

私有请求使用服务 Bearer。成功信封为 `{protocol_version:1,result}`，错误为 `{protocol_version:1,error:{code,message}}`。原后端限制响应大小、检查结构、设置超时并拒绝重定向。

| 接口 | 输入 | 结果 |
| --- | --- | --- |
| `GET /v1/capabilities` | 无 | 文本、图片、地图能力及版本 |
| `POST /v1/compute/reconstruct` | 生成输入、已授权图片 | 原有文档、候选、问题和算法版本 |
| `POST /v1/compute/search` | 名称、城市、搜索中心 | 地点候选 |
| `POST /v1/compute/rank` | 文档、候选替换 | 带位置 basis 的补丁 |
| `POST /v1/compute/clarify` | 草稿快照、目标地点、补充线索 | 位置补丁与回答 |
| `POST /v1/compute/merge` | 两篇文档及版本、合并选项 | 合并预览、冲突和哈希 |
| `POST /v1/compute/share` | 用户选择的事实和分享选项 | 分享文字 |

计算请求体为 `{request_id,input}`。检索、生成与澄清还传入宿主的 `amap_storage_allowed` 布尔值，第三方地点搜索同时受宿主和私有服务开关约束。

地点回调只接收 `POST {name}`，使用独立回调 Bearer，返回最多 400 条地点的 `id/name/longitude/latitude/address`。输入不能指定 SQL、表名、用户或回调地址。私有服务不直接访问数据库。

所有网络计算在 SQLite 写事务之外执行。合并落库前重新检查来源版本、预览哈希和请求幂等；排序期间草稿更新会拒绝旧结果；取消或删除生成任务后，迟到结果不会挂到草稿。图片归属和最终保存校验仍由原后端执行。

私有服务合并同请求 ID 的并发计算，并短期缓存成功结果；缓存不跨重启持久化。调用方不自动重试超时生成，避免再次消耗模型费用。移走当前文件不清除已经公开过的历史版本。

## 验证

```sh
npm run test:journey-algorithms
npm run test:journeys
npm run test:journey-resolution
npm run test:journey-publication
```

公开测试使用独立 HTTP 协议桩，不需要私有源码或真实模型。完整后端 `npm test` 自动发现这些测试。

真实服务集成：设置 `JOURNEY_PRIVATE_SERVICE_DIR` 为私有源码的绝对路径，在 `backend/` 运行 `npm run test:journey-private-service`。它启动真实算法服务、地图回调和临时数据库，仅模型提供方使用本机替身，不产生付费请求。未设置目录时明确跳过。

私有目录内 `npm test` 覆盖与原算法的一致性、鉴权、请求限制、超时、权限开关和并发去重。浏览器回归沿用 `npm run test:journey-ui`。
