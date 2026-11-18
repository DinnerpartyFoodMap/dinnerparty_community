# 后端日志使用说明

后端启动后会同时输出可读控制台日志，并在 `backend/logs/` 写入 JSON Lines 文件：

- `app-YYYY-MM-DD.log`：`debug`、`info`、`warn` 应用、请求和安全事件。
- `error-YYYY-MM-DD.log`：仅 `error` 与 `fatal` 事件。
- 文件达到 `LOG_MAX_FILE_MB` 后生成 `.1.log`、`.2.log`；超过保留天数的文件在启动时和每天换文件时清理（正被读取而删不掉的文件下次再删，不影响写日志）。
- **网络日志依法保存不少于六个月**：`LOG_RETENTION_DAYS` 默认 186 天，小于 184 天（最长的六个月）的配置按 184 天处理并在启动时提示。按 20 MB 分片、半年的量估算磁盘，必要时把旧文件另行归档压缩（`npm run logs` 只读未压缩的 `.log`）。

每个 HTTP 请求都会获得 `X-Request-ID`。错误 JSON 也包含 `requestId`，登录和注册界面会直接显示该编号。拿到编号后可运行：

```powershell
cd backend
npm run logs -- --request-id "请求编号" --since 2h
```

常用命令：

```powershell
# 最近两小时的警告、错误与致命日志
npm run logs -- --since 2h --level warn

# 最近七天的登录事件
npm run logs -- --since 7d --event auth.login

# 按客户端 IP 或登录用户 UUID 追溯；NAT 后的访问者用 IP + 源端口定位
npm run logs -- --since 24h --ip "203.0.113.10"
npm run logs -- --since 180d --ip "203.0.113.10" --port 52344
npm run logs -- --since 7d --user-id "用户 UUID"

# 最近一天最多 200 条错误，输出原始 JSON
npm run logs -- --level error --limit 200 --json
```

## 记录内容

- 请求完成、耗时、状态码、来源、IP 与源端口（`port`）、登录用户 UUID、User-Agent、响应错误摘要。
- 注册、登录等事件与该请求的其他日志一样带 `ip`、`port`；短信验证码的发送 / 失败（`auth.sms.*`，手机号打码）、换绑手机号（`auth.phone.changed`）和旧客户端无手机号注册（`auth.register.without_phone`）。
- 登录、注册、退出、鉴权拒绝、Redis 会话故障和 CORS 拒绝。
- 所有既有 `console.log/warn/error`、未捕获异常和未处理 Promise 拒绝。
- 提前断开的连接以及超过 `LOG_SLOW_REQUEST_MS` 的慢请求。
- SQLite 查询错误、超过 `DB_SLOW_QUERY_MS` 的慢查询，以及高德代理故障。
- 登录前端失败阶段事件 `auth.client.stage`；正常阶段只在 `LOG_LEVEL=debug` 时记录。
- 数据访问限流（[说明](../../http/doc/README.md#数据访问限流)）：`anti_scrape.would_limit`（observe 模式下本该拦的）、`anti_scrape.limited`（enforce 模式下拦了的），带策略、主体（`u:<id>` 或 IP 段）、计数与额度，同一主体同一规则十分钟记一次。汇总用 `npm run scrape:report`。

正常请求默认只写一条完成日志；错误只进入 `error-*`，不会再在 `app-*` 中重复。每条请求日志都带 IP 和（已知时的）源端口，认出用户后还会自动带用户 UUID：必须登录的接口（`requireAuth`）、可选登录的接口（`attachViewer`：地点详情、列表、搜索、住民地点等）和带票据的地图明细瓦片都算，2026-11-18 之前可选登录的请求只有 IP。地图明细瓦片的票据参数 `t` 与坐标、搜索词一样在路径里打码。

## 客户端源端口

运营商 NAT 后很多人共用一个 IP，追溯到人需要 IP + 源端口 + 时间。`http/middleware/requestLogger.js` 的 `port` 取值：

1. TCP 对端是受信任代理（`trust proxy`）时，读 `LOG_CLIENT_PORT_HEADER`（默认 `X-Client-Port`）里的端口；
2. 请求没有 `X-Forwarded-For`（客户端直连 Node）时，用套接字自己的端口；
3. 经过代理却没有端口头时不记录——那是代理的端口，不是客户端的。

端口只有最外层代理知道，所以要由它写入，中间层原样透传：

- nginx：`proxy_set_header X-Client-Port $remote_port;`
- Caddy 作为最外层（直连入口）：`reverse_proxy` 里 `header_up X-Client-Port {http.request.remote.port}`；Caddy 前面还有 nginx 时不要再覆盖。
- 阿里云 ESA：回源请求头没有客户端端口变量，ESA 的离线 / 实时日志里有 `ClientSrcPort`。经 ESA 访问的请求要用 ESA 日志（投递到 SLS 并保留 ≥ 180 天）按时间、IP、路径与本站日志对照。管理员审计记录同时保存 IP、请求编号、操作者 UUID 和目标用户 UUID。

密码、JWT、Authorization、Cookie、邀请码、API Key 和头像二进制字段会被自动脱敏。请求正文不会写入访问日志。

## 环境变量

配置示例位于 `.env.example`。生产环境建议至少设置：

```dotenv
LOG_LEVEL=info
LOG_DIR=logs
LOG_TO_FILE=true
LOG_TO_CONSOLE=true
LOG_CONSOLE_LEVEL=warn
LOG_MAX_FILE_MB=20
LOG_RETENTION_DAYS=186
LOG_CLIENT_PORT_HEADER=X-Client-Port
LOG_SLOW_REQUEST_MS=1500
DB_SLOW_QUERY_MS=100
LOG_NOISY_PATH_PREFIXES=/_AMapService,/uploads
```

控制台默认只显示 `warn` 及以上（以及启动/停止提示），完整日志仍按 `LOG_LEVEL` 写入文件；调试时可设 `LOG_CONSOLE_LEVEL=info` 或 `debug` 恢复逐条输出。

高德瓦片和上传静态文件的正常请求默认不逐条记录，以免日志快速膨胀；它们的失败、慢请求和异常仍会记录。
