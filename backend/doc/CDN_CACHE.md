# CDN（阿里云 ESA）缓存

`www.dinnerparty.cc` 前面是阿里云 ESA。2026-11 之前 `/backend/*` 全部是 DYNAMIC（每次回源）：公告、展会每个页面每 30 秒轮询一次，`/places/nearby` 带视野范围和 token，URL 每次不同，三者占全部请求的一半。现在把与观看者无关的读接口改成公共可缓存，地图标记改用一份公共快照。

## 公共可缓存的接口

`http/middleware/publicCache.js` 统一处理，路由里不设 `Cache-Control`：

| 接口 | Cache-Control（200 / 304） |
| --- | --- |
| `GET /notices/current`、`/exhibitions`、`/exhibitions/current`（及 `/api/...`） | `public, max-age=30, s-maxage=60, stale-while-revalidate=300` |
| `GET /api/amap/js-config` | `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` |
| `GET /places/regions` | `public, max-age=300, s-maxage=300, stale-while-revalidate=3600` |
| `GET /places/markers` | `public, max-age=30, s-maxage=60, stale-while-revalidate=600` |

- 出错的响应一律 `no-store`，CDN 不会缓存 500。
- 这些路径固定回 `Access-Control-Allow-Origin: *`，不经过按 Origin 回头的 `cors()`，也没有 `Vary: Origin`。CDN 缓存的同一份响应网页（`https://www.dinnerparty.cc`）和 App（`https://localhost`、`capacitor://localhost`）都能用。前端请求这些路径不带 `Authorization`、不带自定义请求头、不带凭据，浏览器不发预检。
- 管理员改了公告或展会后，前端带一次性参数 `?fresh=<时间>` 读一次（`frontend/src/platform/polling.js`），依赖 CDN 缓存键包含查询字符串（ESA 默认如此）。

## 地图标记

- `GET /places/markers`（`modules/places/services/placeMarkers.js`）：全部公开地点的精简字段，按列存（`fields` + `rows`），约 3700 个地点时原始约 290 KB、br 约 120 KB。进程内缓存 15 秒（`MARKER_SNAPSHOT_TTL_MS`），预先压缩好 br / gzip，带弱 ETag，内容不变时回 304。
- `GET /places/overlay`（`no-store`，要登录）：自己审核中 / 未通过的地点（完整行）和屏蔽的住民创建的公开地点 id。
- 前端（`frontend/src/map/markerSnapshot.js`）启动时与高德 SDK 并行读取快照，上一份存在 IndexedDB 先用；平移缩放不再发请求，快照超过 5 分钟才在地图移动时后台刷新。打开卡片时读 `GET /places/:id` 补全描述、图片、创建者。新增、修改、删除、评价在本地立即生效，直到快照追上（最多 10 分钟）。
- `GET /places/nearby` 保持原样，给旧版 App 用；新版前端不再调用。

## ESA 规则

先部署后端，再加规则（顺序反过来时，CDN 会把按 Origin 回头的旧响应缓存下来，App 读不到公告）。

规则 > 缓存规则，新增一条：

```
(http.host in {"www.dinnerparty.cc" "dinnerparty.cc" "dinner.cdn.mccolor.cc"} and http.request.uri.path in {"/backend/notices/current" "/backend/exhibitions" "/backend/exhibitions/current" "/backend/api/amap/js-config" "/backend/places/regions" "/backend/places/markers"})
```

- 缓存资格：符合缓存条件。
- 边缘缓存过期时间：遵循源站缓存策略。
- 浏览器缓存过期时间：遵循源站缓存策略。
- 自定义 Cachekey：不改（查询字符串保留，不按请求头 / Cookie 区分）。
- 响应过期缓存（可选）：开启，源站暂时不可用时继续给出上一份。

原有那条匹配 `/backend`、`/_AMapService`、`/p` 的规则不用动。

## 验证

第二次请求看到 `x-site-cache-status: HIT`（或 `REVALIDATED`）即缓存生效：

```bash
curl --noproxy '*' -sI -H 'Accept-Encoding: br' https://www.dinnerparty.cc/backend/places/markers
```

还要确认响应头里是 `access-control-allow-origin: *`，没有 `vary: Origin`。

## 旧版 App

不需要强制更新：旧版仍调用 `/places/nearby`（行为不变）；公告、展会、高德 key、地区这几个接口旧版也是不带凭据的普通 GET，`Access-Control-Allow-Origin: *` 对它们同样有效。旧版仍每 30 秒轮询公告和展会，但规则生效后这些请求由 CDN 回答，不再回源。
