# 场馆落点：denpawave Micro 跳转饭联地图后的聚焦

状态：P0 接收端已实现（`modules/venues`），跳转解析与前端待做。

核对基线：`b53d07d`（2026-11-15，origin/main）。

## 背景

denpawave Micro 的活动页已有「展馆周边吃」入口（`components/event/page-parts.tsx` 的 `VenueNearbyEat`），点击打开 `https://www.dinnerparty.cc/`。链接不带参数，落地是默认视野，用户得自己定位、缩放、搜索才看得到展馆周边。

不能让链接直接带场馆名/地址、落地自动搜索：

1. **额度**。地点搜索走 `modules/maps/services/amapSearchBudget.js` 的全局预算（月 4000，日按剩余天数分摊）。Micro 是公开入口，跳转量不可控。
2. **合同**。高德不允许存储搜索结果、回填地点、再分发。自动搜索恰好同时踩两条。

所以改成「先落点、再指路」：坐标只来自管理员在地图上的手工选点（不落任何搜索结果），日常跳转只做一次库内查询。

## 模型：场馆请求，不是活动镜像，也不是地点

对端说的是「这个场馆该在地图上有一个点」，这是一次性请求。所以饭联**不认识**活动、发布、草稿、审核，也不存活动日期——否则就得追改名、改期、取消、删除，都是永久负担。

**场馆也不进 `Place` 表。** 这是本方案的第二个关键取舍：场馆一旦成为 `Place`，会跟着进入地图标记快照（`placeMarkers.js` 只按 `moderation_status='visible'` 过滤）、随机美食候选池（`randomRecommendation.js` 只排除「避雷」和低分）、搜索与地区树。用户会在随机美食里抽到「上海新国际博览中心」。靠一个分类标签区分「场地」和「餐厅」，是把语义问题伪装成标签问题。

所以场馆只有坐标，没有地点身份：不写评分、不进搜索、不进随机、不进群推送。代价是不能被搜到、不能评价——这些恰好都不需要。

| 需求 | 落点 |
| --- | --- |
| 先加表存展会地址 | `Venue`（唯一键 `source + external_key`，三态 `pending/placed/ignored`，自带经纬度） |
| 建活动后送进管理员待办 | `POST /internal/venues` |
| 管理员落点、规避搜索结果不可存储 | 管理员在地图上选点 → `POST /admin/venues/:id/place`，不建 Place、不落搜索结果 |
| 有地点就聚焦、没有就提醒 | `GET /venues/:key` + 前端 `?venue=<key>` |

`external_key` 对饭联是不透明字符串：对端想按活动去重就传 `publicKey`，想按场馆去重就传 `hash(场馆名+地址)`，语义归对端。

**坐标只来自管理员选点**：对端即使硬塞 `latitude`/`longitude` 也一律丢弃。既满足「搜索结果不落库」的合同，也避免对端坐标系（可能是 WGS84）污染地图（饭联按 GCJ-02）。

## 数据

```sql
CREATE TABLE IF NOT EXISTS Venue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL DEFAULT 'denpawave',
    external_key TEXT NOT NULL,      -- 对端去重键，饭联不解释其语义
    label TEXT NOT NULL,             -- 展示文字
    address TEXT,
    city TEXT,                       -- 选点器按城市定位初始中心
    latitude REAL,                   -- 管理员选点（GCJ-02）
    longitude REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    note TEXT,
    created_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_time TEXT,
    handled_by TEXT,                 -- User.id（TEXT）
    handled_time DATETIME,
    UNIQUE (source, external_key)
);
```

## 接口

### 推送（服务到服务）

`POST /internal/venues`

```json
{
  "source": "denpawave",
  "events": [{
    "key": "con-8b1f9a",
    "label": "上海新国际博览中心（Comic Horizon 2026）",
    "address": "上海市浦东新区龙阳路2345号",
    "city": "上海"
  }]
}
```

- 鉴权：`Authorization: Bearer <VENUE_TOKEN>`（定长摘要比较）+ 来源 IP 白名单（`VENUE_ALLOWED_IPS`）。**两者缺一都是 503**；白名单留空等于拒绝所有来源。
- 限流：按来源 IP 计，60 秒 6 次，超出 429 + `Retry-After: 60`。
- 幂等：`UNIQUE(source, external_key)`。重复推送只更新展示文字；`ignored` 的行保持 `ignored`。
- 校验：`key` `^[A-Za-z0-9_-]{1,64}$`；`label` ≤120、`address` ≤200、`city` ≤40；纯文本，拒绝控制字符；单批 ≤50。
- 响应：`{ accepted, updated, ignored, failed: [{ index, key, code }], requestId }`。单条失败不影响同批；数据库异常返回 503 让对端整批重试（幂等，安全）。
- 不做 HMAC、不做回执表：见「为什么不加」。

### 解析（公开只读）

`GET /venues/:key` → `{ "status": "pending" | "placed" | "ignored" | "unknown", "latitude", "longitude" }`

- 坐标只在 `placed` 时给出；其余状态一律 `null`。
- 只回状态与坐标，**不回传 label / address / city**。
- `no-store`，不进 `publicCache` 白名单：管理员刚落完点就要生效。

### 管理员待办

- `GET /admin/venues`（`manage_places`）→ `{ pending: [...], count }`
- `POST /admin/venues/:id/place`，body `{ latitude, longitude }`：只接受 `pending`，重复 409，(0,0) 与超出 ±85.0511° 拒绝，写 `AdminAudit`（`place-venue`）
- `POST /admin/venues/:id/ignore`，body `{ note? }`：同上（`ignore-venue`）

## 前端跳转参数

`https://www.dinnerparty.cc/?venue=<key>`

- 单独一个 effect：先解析 `venue`，`placed` 时按坐标 `setZoomAndCenter(16)` 定位（**不开卡**——场馆没有店卡），`pending` / `ignored` / `unknown` 时只弹提示；参数一次性，处理后 `removeQueryParams(['venue'])`。
- 与 `?place=` 互不干扰：前者是地点 id、开卡片，后者是坐标、只移动视野。
- `pending` / `ignored` / `unknown`：打开地图并提示「这个展会地点还没在饭联地图标记」，**显式不调用任何高德搜索**。
- 两者同时出现时以 `place` 为准（分享链接优先）。

### 城市兜底

`pending` 时若想落在城市，复用已有的地区树，不引入任何外部调用：`GET /places/regions` 返回的每个市节点带 `bounds: [minLng, minLat, maxLng, maxLat]`（`places/services/placeRegions.js` 的 `regionTree()`，按已有地点算），前端 `frontend/src/places/placeRegions.js` 已有缓存与查找帮手。

- 只对有公开地点的城市有效；查不到就保持默认视野 + 提示，不额外造数据。
- 用 bounds 中心 + 固定 zoom（约 11），**不要直接 `setBounds`**：城市里只有两三家店时 bounds 很紧，会贴着那几家店放大。
- 高德 JS API 2.0 没有 `setCity`（那是 1.4 的 API），`AMap.DistrictSearch` 是服务插件、要外部调用，不用。`setZoomAndCenter` / `setBounds` 是纯视口操作，不消耗搜索额度。

## 为什么不加 HMAC / 回执表

威胁模型：对端是合作方，接口最坏只能往待办里塞几行数据，落点仍需管理员登录，量级是每月几场活动。请求走 HTTPS，Bearer 用于吊销，IP 白名单防「token 意外泄漏后被外部使用」。

重放没有副作用（幂等）；请求记录由既有 `requestLogger`（含 `requestId`）与 `AdminAudit` 覆盖。真需要时再加 nonce 唯一表或回执表，都不破坏现有数据。

## 配置

```dotenv
# 饭联侧
VENUE_TOKEN=
VENUE_ALLOWED_IPS=127.0.0.1,<denpa 生产出网 IP>  # 留空等于拒绝所有
```

## 测试

`node tests/venues/test_venues.js`（`npm test` 自动发现）。已覆盖：鉴权三条分支（缺 token / 错 token / 未配置）、重复推送幂等、`ignored` 保持、单条失败不影响整批、批大小与字段上限、link 的 400/404/409 与审计、解析四态、公开接口不泄露展示文字、地点被删退化为 `unknown`、非管理员 403。

前端回归（待自动化）：`/?venue=<key>` 命中时定位并开卡、参数被移除；未命中时出现提示且 `AmapSearchUsage` 无新增。

## 后续

| 阶段 | 内容 |
| --- | --- |
| P0 剩余 | 无（前端 `?venue=` 已实现） |
| P1（product-backend） | 场馆 `confirmed` 且活动发布后写 `event_outbox`，worker 调 `/internal/venues`；失败重试与死信告警 |
| P2（Micro） | 「展馆周边吃」链接带上 `publicKey` |

P0 完成即可先用 curl 验收全链路；P1/P2 只增加入口。

## 风险

- **合同**：搜索只服务管理员的即时选点、不落库、不再分发；解析接口只回饭联自己的地点 id。
- **额度**：本方案没有任何新增搜索调用；要防的是 `pending` 时前端自己按场馆名搜索，代码里显式不做。
- **数据质量**：同一展馆会被多场活动推成多条请求，管理员会看到两条相似待办；v1 靠人工忽略，不做自动合并。
- **iOS**：`?place=` 在 iOS 由原生接管，`?venue=` 的城市兜底需要原生桥配合，先做 Web，iOS 另开。
