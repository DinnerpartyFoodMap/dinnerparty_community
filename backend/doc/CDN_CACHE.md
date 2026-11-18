# CDN（阿里云 ESA）缓存

`www.dinnerparty.cc` 前面是阿里云 ESA。2026-11 之前 `/backend/*` 全部是 DYNAMIC（每次回源）：公告、展会每个页面每 30 秒轮询一次，`/places/nearby` 带视野范围和 token，URL 每次不同，三者占全部请求的一半。现在把与观看者无关的读接口改成公共可缓存，地图标记改用一份公共快照。

## 公共可缓存的接口

`http/middleware/publicCache.js` 统一处理，路由里不设 `Cache-Control`：

| 接口 | Cache-Control（200 / 304） |
| --- | --- |
| `GET /notices/current`、`/exhibitions`、`/exhibitions/current`（及 `/api/...`） | `public, max-age=30, s-maxage=60, stale-while-revalidate=300` |
| `GET /api/amap/js-config` | `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` |
| `GET /places/regions` | `public, max-age=300, s-maxage=300, stale-while-revalidate=3600` |
| `GET /places/markers`（旧快照，只留给旧版 App） | `public, max-age=30, s-maxage=60, stale-while-revalidate=600` |
| `GET /places/tiles/manifest` | `public, max-age=30, s-maxage=60, stale-while-revalidate=600` |
| `GET /places/tiles/<哈希>/dict`、`/places/tiles/<哈希>/<2\|5\|8>/<x>/<y>` | `public, max-age=31536000, s-maxage=31536000, immutable` |

z12 明细瓦片（`/places/tiles/<哈希>/12/<x>/<y>`）不在其中：回 `private, max-age=31536000, immutable`，只在浏览器缓存，源站按 IP / 账号计额度（[数据访问限流](../http/doc/README.md#数据访问限流)）。

- 出错的响应一律 `no-store`，CDN 不会缓存 500。
- 这些路径固定回 `Access-Control-Allow-Origin: *`，不经过按 Origin 回头的 `cors()`，也没有 `Vary: Origin`。CDN 缓存的同一份响应网页（`https://www.dinnerparty.cc`）和 App（`https://localhost`、`capacitor://localhost`）都能用。前端请求这些路径不带 `Authorization`、不带自定义请求头、不带凭据，浏览器不发预检。
- 管理员改了公告或展会后，前端带一次性参数 `?fresh=<时间>` 读一次（`frontend/src/platform/polling.js`），依赖 CDN 缓存键包含查询字符串（ESA 默认如此）。

## 安卓安装包

`/api/app/android/latest.apk` 302 跳到带版本号的 `/api/app/android/dinnerparty-<版本>-<构建号>.apk`：跳转 `no-cache`（规则命中也不会被缓存，发版后立即生效），安装包本身 `public, max-age=31536000, immutable`，ESA 缓存后不再回源（约 16 MB 一次）。每次发版文件名必须不同，见 [App 发版](../modules/appRelease/doc/README.md)。

## 地图标记

2026-11-18 起新版前端改用分层瓦片（[地点模块](../modules/places/doc/README.md#分层瓦片)、前端 `map/markerTiles.js`）：清单和聚合瓦片走 CDN，内容一变 URL 就变；明细瓦片只在浏览器里缓存。下面的整份快照只留给 11-15 之后、瓦片之前的 App，那些 App 更新完以后设 `LEGACY_MARKER_SNAPSHOT=off`（回 410）并刷新 ESA 上 `/backend/places/markers` 的缓存。

- `GET /places/markers`（`modules/places/services/placeMarkers.js`）：全部公开地点的精简字段，按列存（`fields` + `rows`），约 3700 个地点时原始约 290 KB、br 约 120 KB。进程内缓存 15 秒（`MARKER_SNAPSHOT_TTL_MS`），预先压缩好 br / gzip，带弱 ETag，内容不变时回 304。
- `GET /places/overlay`（`no-store`，要登录）：自己审核中 / 未通过的地点（完整行）和屏蔽的住民创建的公开地点 id。
- 前端（`frontend/src/map/markerSnapshot.js`）启动时与高德 SDK 并行读取快照，上一份存在 IndexedDB 先用；平移缩放不再发请求，快照超过 5 分钟才在地图移动时后台刷新。打开卡片时读 `GET /places/:id` 补全描述、图片、创建者。新增、修改、删除、评价在本地立即生效，直到快照追上（最多 10 分钟）。
- v2.2.4 的 `GET /places/nearby` 返回所查范围内的所有可见地点及详情。按观看者返回，使用 `no-store`，并受 `legacy` 请求频次限制。

## 源站 Caddy

Caddy 不能覆盖后端的 `Cache-Control`。`/backend` 那段原来写的是 `header_down Cache-Control "no-store"`，会把所有响应都改成 `no-store`，ESA 看到后一律 BYPASS。改成只在后端没设时补 `no-store`（`header` 的 `?` 前缀，会自动等反向代理写完响应头再判断）：

```
@backend path /backend /backend/*
handle @backend {
	uri strip_prefix /backend
	# 后端自己设了 Cache-Control 的照用（公共缓存接口、上传图片等），没设的仍是 no-store
	header ?Cache-Control "no-store"
	reverse_proxy localhost:7000 {
		header_up X-Forwarded-Prefix /backend
	}
}
```

限流要可信的客户端 IP（[数据访问限流](../http/doc/README.md#数据访问限流)）：让 Caddy 判断真实 IP，后端只信本机 Caddy。全局选项里只信 ESA 的回源 IP 段（ESA 控制台“源站保护”可下载）和 nginx 那台机器，从 ESA 带来的头里取客户端地址（头名先在源站日志里确认）；每个反代块覆盖写 `X-Forwarded-For`，直连 2053 / 8443 的请求不在信任列表里，伪造的头无效：

```
{
	servers {
		trusted_proxies static <ESA 回源 IP 段> <nginx 机器 IP>
		client_ip_headers ali-real-client-ip X-Forwarded-For
	}
}

reverse_proxy localhost:7000 {
	header_up X-Forwarded-For {client_ip}
}
```

nginx（apex）那条：`proxy_set_header X-Forwarded-For $remote_addr;`（覆盖，不追加）。改好后在后端 `.env` 设 `TRUST_PROXY=loopback`，用 `npm run logs -- --since 1h` 确认 `ip` 是真实客户端地址。

后端自己设了公共缓存的还有上传的图片（`/uploads`，一年 immutable）、静态地图、逆地理结果和饭局分享图。用户信息直接给出可长期缓存的 OSS 头像对象地址，固定头像入口 `/users/:id/avatar` 使用 `no-store`。其他未设置 `Cache-Control` 的接口由 Caddy 补成 `no-store`。

## ESA 规则

先部署后端，再加规则（顺序反过来时，CDN 会把按 Origin 回头的旧响应缓存下来，App 读不到公告）。

规则 > 缓存规则，新增一条：

```
(http.host in {"www.dinnerparty.cc" "dinnerparty.cc" "dinner.cdn.mccolor.cc"} and (
  http.request.uri.path in {"/backend/notices/current" "/backend/exhibitions" "/backend/exhibitions/current" "/backend/api/amap/js-config" "/backend/places/regions" "/backend/places/markers"}
  or starts_with(http.request.uri.path, "/backend/api/app/android/")
  or starts_with(http.request.uri.path, "/backend/places/tiles/")
))
```

- 缓存资格：符合缓存条件。
- 边缘缓存过期时间：遵循源站缓存策略。
- 浏览器缓存过期时间：遵循源站缓存策略。
- 自定义 Cachekey：不改（查询字符串保留，不按请求头 / Cookie 区分）。
- 响应过期缓存（可选）：开启，源站暂时不可用时继续给出上一份。

`/backend/places/tiles/` 整个前缀都可以进规则：明细瓦片回 `private`、票据回 `no-store`、跳转和错误回 `no-store`，“遵循源站缓存策略”时 ESA 不会缓存它们。

原有那条匹配 `/backend`、`/_AMapService`、`/p` 的规则不用动。

频次控制（规则 > 安全 > 频次控制）：CDN 命中的请求不回源，清单、聚合瓦片和旧快照的下载次数只有 ESA 看得到，给 `/backend/places/` 加一条按客户端 IP 的每分钟上限（先宽松，看日志再收紧；数值不写在这里）。`/backend/*` 不要开 JS 挑战，App 里的请求解不了。

## 验证

第二次请求看到 `x-site-cache-status: HIT`（或 `REVALIDATED`）即缓存生效：

```bash
curl --noproxy '*' -sI -H 'Accept-Encoding: br' https://www.dinnerparty.cc/backend/places/markers
```

还要确认响应头里是 `access-control-allow-origin: *`，没有 `vary: Origin`。

## 旧版 App

旧版通过 `/places/nearby` 或 `/places/markers` 加载地点。公告、展会、高德 key、地区接口也是不带凭据的普通 GET，`Access-Control-Allow-Origin: *` 对旧版同样有效。旧版仍每 30 秒轮询公告和展会，规则生效后这些请求由 CDN 回答。
