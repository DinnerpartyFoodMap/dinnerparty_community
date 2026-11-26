# 地点与修改申请

## 住民评论

`GET /places/:id` 返回 `comments`，每项包含 `id`、`user_id`、`username`、`content`、`status`、`time`、`updated_at`、`mine`。先选最近的 50 条可见评论，排除本人、封禁作者和观看者屏蔽的作者。登录时额外返回自己的那一条，任何审核状态都可见，并标记 `mine: true`。结果按 `time`、`id` 升序排列。评论独立于地点描述，只有单个地点详情返回评论。

住民在已有评分的公开地点发表或修改评论，写入与删除接口见 [社区互动](../../community/doc/README.md#住民评论)。初筛拦下的评论以 `request_type = 'comment'` 进入地点修改申请页，见 [审核流程](placeModeration.md#住民评论)。

## 地点打卡

已登录住民可在公开地点卡片提交打卡。 `POST /places/:id/check-ins` 接收 JSON，带照片时改用 multipart 表单，`payload` 是同一份 JSON，`photos` 最多 3 张，每张最多 3 MB。首次提交必填 `request_id` 与 `fix`，描述和四档评分均选填。服务端用当前店铺坐标和同一坐标系的设备定位计算距离，要求距离严格小于 50 米、报告精度不大于 25 米、定位不超过 15 秒。打卡响应与数据库不保存设备经纬度。按北京时间每日最多 5 家，同店每日一次。

同一账号及请求编号可安全重试。已提交的请求可省略 `fix` 取回回执，只有服务端需要新定位时才重新获取。打卡、额度、默认火柴人或当前所选小伙伴的投喂和待审核内容一次提交，饱食度加 1。选填评分沿用原有单票和配额，评分与打卡关联一并写入。评分保存暂时失败时，可从打卡回执重试，打卡和投喂已经生效。期间用其他设备修改或撤回了评分时，以当前评分为准。

补充描述和照片分别进入现有地点申请队列，管理员在同一审核页面批准或驳回。批准时以最新地点内容为准追加，描述仍受 1000 字限制，重复段落和照片只采纳一次。待审核照片通过有时效的链接供管理员预览，批准后加入地点卡片的「打卡照片」。地点详情、快照和明细瓦片提供 `checkin_count`。打卡与审核内容的评分作用见 [地点评价](../../ratings/doc/placeRatings.md)。

地点列表 `GET /places/list`（`services/placeList.js`，可选登录）：只给公开地点，可按 `tags`（逗号分隔，命中任一）、`minCost` / `maxCost`（设了范围时没填人均的不显示）与距离（`lat`、`lng`、`radiusKm`，半径只接受 0.5/1/3/5/10 公里）筛选；按综合评价排序：公开平均分以 2 份中性分（2.5）收缩，登录且有口味画像时与口味加权平均（`ratings/services/placeRatings.js` 的 `personalizedAverages`，按观看者缓存 2 分钟）各占一半。返回 `{ items, total, offset, limit, personalized }`，条目只有 id、店名、简介、分类、人均、第一张图和评价，不带经纬度、地址和距离（距离只用来筛选，防止整页抓取拿到坐标）。

新版地图用分层瓦片（见下文“分层瓦片”）绘制标记。`GET /places/overlay`（`no-store`，可选登录）给出自己审核中或未通过的地点，以及屏蔽的住民创建的公开地点 ID。打开卡片时从 `GET /places/:id` 读取描述、图片等详情。

旧版 App 的 `GET /places/nearby` 返回查询范围内所有对观看者可见的地点及详情。v2.2.4 用该响应更新整个范围的缓存，并直接用地点行打开卡片。2026-11-15 切换快照后、分层瓦片前的构建用 `GET /places/markers`（`services/placeMarkers.js`，公共缓存）。两条兼容路由使用 `legacy` [数据访问限流](../../../http/doc/README.md#数据访问限流)。使用快照的旧版 App 更新完之后，可将 `LEGACY_MARKER_SNAPSHOT` 设为 `off` 并刷新 ESA 上该路径的缓存。`GET /places` 回 410。`/places/:id`、`/places/:id/diaries`、`/p/:id`、`/places/list`、`/users/:id/places` 与搜索都按观看者限流。

## 分层瓦片

`services/placeTiles.js` + `routes/placeTiles.js`（挂在 `/places/tiles`，在 `/places` 之前），前端 `frontend/src/map/markerTiles.js` 按同样的级别和格式读取，两边一起改（`test:place-tiles` 用前端的展开与筛选函数读真实瓦片对照）：

- 三级聚合瓦片：z2 / z5 / z8 瓦片，格子 z9 / z12 / z14（约 70 / 8.8 / 2.2 km），分别给 z0–7、z8–10、z11–12。每个格子是成员重心（取整到 1/8 格）和每家店匿名的一行 `[标签编号, 人均或 -1, 地区编号或 -1, 图标类型]`（0 普通、1 避雷、2 待探索，`isAvoidedPlace` 与 `hasExploreTag`），按内容排序。z14 一级（`sub: 16`，瓦片里也有 `sub`）的行多一项：店所在的格内 1/16 小格编号 `y * 16 + x`（小格即 z18 瓦片，约 140 m），前端把匿名点放在小格中心，放大到 z13 换明细时标记按本地 3720 家算中位挪 3 px、最多 6 px（用格子重心时中位 18 px、最多 111 px）。代价是公开的位置变细：本地数据里 79% 的店是所在小格里唯一的一家（2.2 km 格子里唯一的是 24%），加上标签、人均、地区，能缩到一个街区内的几家高德 POI。**不带 id、店名、精确坐标**：id 只出现在明细瓦片和单店接口里，两处都有额度。
- 明细瓦片：z12，字段与旧快照相同（id、店名、坐标、标签、人均、省市区、评价汇总），z13 起显示。
- 字典：标签名、地区名（按地点 id 顺序第一次出现编号）；清单：版本、各级参数、每块瓦片的内容哈希（12 位）。

接口：`GET /places/tiles/manifest`（公共缓存 30 / 60 秒）；`/places/tiles/<哈希>/dict` 与 `/places/tiles/<哈希>/<2|5|8>/<x>/<y>`（公共缓存，永不过期，`http/middleware/publicCache.js` 的 `PUBLIC_PATTERNS`）；`/places/tiles/<哈希>/12/<x>/<y>`（明细：`private, max-age=31536000, immutable`，不进 CDN，按 IP / 账号的去重瓦片数限流）；`GET /places/tiles/ticket`（要登录，`no-store`）发 24 小时的明细瓦片票据，前端放在查询串 `?t=` 里认账号（不带 `Authorization`，App 里每块瓦片不用多一次预检），票据用 `TILE_TICKET_SECRET`（不设时由 `JWT_SECRET` 派生）签名。哈希和当前内容对不上时 302 到当前哈希（相对地址，保留 `?t=`），瓦片没有了 404，都是 `no-store`。全部瓦片在内存里建好，`TILE_SNAPSHOT_TTL_MS`（默认 15 秒）内复用，内容没变的瓦片沿用旧的压缩结果；改一家店只换它所在的四块瓦片（每级一块）的哈希。

实测（3720 家）：三级聚合瓦片全部加起来约 15 / 19 / 28 KB，明细 706 块共约 142 KB，字典约 6 KB，清单约 7 KB；一屏通常要 1 到 4 块。


地区（`services/placeRegions.js`，表在 `placeRegionSchema.js`）：省 / 市 / 区存在单独的 `PlaceRegion` 表，不写 `Place`，因为 Place 的任何 UPDATE 都会推进评分算法时钟，补齐几千个地点不能让评分缓存全部失效。表里记下查询时的坐标，地点挪了位置后对不上就重新查。后端启动时开后台任务（`startPlaceRegionWorker`，需要 `AMAP_WEB_SERVICE_KEY`，`PLACE_REGION_WORKER=false` 关闭），每轮取最多 20 个没查过或坐标变了的地点，用高德 Web 服务批量逆地理编码；新地点创建后 `wakePlaceRegionWorker` 立即补一次；QQ 新地点推送发出前用 `ensurePlaceRegions(ids)` 给其中还没查过的地点同步补查（没有 key 时不查）。直辖市的市用省名，省直辖县级市的市用区县名；境外坐标记为已查、省市区为空，其中不在高德境内格子里的（`maps/services/chinaRegion.js`，与前端同一张表）不发请求直接记下，免得消耗高德“海外服务”日配额；高德因海外配额用完整批拒绝（`USER_ABROAD_DAILY_QUERY_OVER_LIMIT`，批里有它算作境外的点，如海参崴）时逐个重查，被拒的点记为没有省市区、其余照常保存，全部被拒时不记录；请求失败不记录、等下一轮（QPS 超限会退避重试）；高德整批 `INVALID_PARAMS` 时逐个重查，被拒绝的坐标记为没有省市区并打日志。`npm run places:regions` 一次补完（`-- --dry-run` 只统计）。`GET /places/regions` 返回有公开地点的地区树（省 → 市 → 区，每层按地点数降序，带 `bounds` 供地图移动到该范围，进程内缓存 5 分钟，走公共 CDN 缓存）；`/places`、`/places/nearby`、`/places/:id`、`/places/list` 带出 `province` / `city` / `district`，`/places/list` 可按这三个参数筛选（下层要有上层）。

标签合并与“待探索”：相同或相近的标签由 `categoryMerges.json`（源标签 → 保留的标签）合并，`services/categoryMerges.js` 在 `placeService.normalizeCategoryList`（所有写入路径）、列表筛选和 `POST /categories` 里换成保留的标签；既有数据用 `npm run categories:merge` 一次性合并（默认预览，`--db <file>` 指定库，`--apply` 先备份；只改 `Place.category` 与待处理申请的 `proposed.category`，不改修改时间和修改人）。“待探索”标签（`ratings/services/ratingWarning.js` 的 `EXPLORE_TAG`，与前端 `places/rating.js` 保持一致；`seeds/categories.json` 里是常用标签）表示还没去过、先标记的地点：创建时不写创建者评分（`rating_input_kind = 'none'`），没人评价前地图上显示问号图标。

入口：routes 下 places、placeRequests、categories、placeShare。新增地点和创建者修改自己的地点都先经 DeepSeek 初筛（文字和图片），明显不合规的新地点只给创建者看、修改先不生效，交管理员在地点申请页复核，流程、提示词与可见性规则见 [placeModeration.md](placeModeration.md)。公共业务入口 `services/placeService.js` 同时服务 Web/App 和 Bot；日记发布通过既有底层地图关联流程复用地点规则。`placeRequestService.js` 处理申请审核，`placeNotifications.js` 写持久通知并唤醒 Bot。`placeCard.js` 负责分享文本与图片规则，实际图像存储由 media 提供。地点描述支持 Markdown（规则见前端 [components 文档](../../../../frontend/src/components/doc/README.md)），后端只在不能显示格式的地方用 `markdownText.js`（marked，与前端锁定同一版本；marked 18 只有 ES 模块，需要 Node 22.12+ 才能 require，更旧的 Node 退回只去标签）转纯文本：分享页 `/p/:id` 的卡片与正文、QQ 机器人的搜索 / 随机 / 新地点推送与图文卡片。描述在所有写入路径上统一由 `normalizePlaceDescription()` 校验（去首尾空白、最多 1000 字、接受 HTML）：新增、编辑 `PUT /places/:id`、提交修改申请、批准修改申请（校验前提交的超长申请不能批准，可驳回）与 QQ 机器人草稿；店名、分类、地址、标签仍只接受纯文本。描述还至少要 15 个字（`PLACE_DESCRIPTION_MIN_LENGTH`，去掉所有空白后按字符数，emoji 算一个；`checkPlaceDescriptionMinLength()`）：新增地点（网页 / App、QQ 机器人）必须满足；编辑 `PUT /places/:id` 和提交修改申请只在描述有改动时检查（与现有描述去首尾空白后比较），老地点描述本来就短时改别的字段不受影响，太短的修改申请返回 `PLACE_DESCRIPTION_TOO_SHORT`；批准修改申请、打卡补充描述和公开日记建的标记不检查。前端同规则在 `frontend/src/places/placeDescription.js`。AI 初筛的「简略」规则仍在，管的是够字数但没内容的描述（如同一个字重复）。

```mermaid
flowchart TD
    Input[网页 / App / Bot 添加地点] --> Validate[名称 / 分类 / 坐标 / 图片 / 创建者评分校验]
    Validate --> Valid{有效?}
    Valid -->|否| Reject[返回错误且不写入]
    Valid -->|是| TX[短 SQLite immediate 事务]
    TX --> Place[插入 Place 与分类关系]
    Place --> Rating[写创建者评分 不消耗每日配额]
    Rating --> Notice[插入群通知记录]
    Notice --> Commit{提交成功?}
    Commit -->|否| Rollback[整体回滚]
    Commit -->|是| Async[唤醒通知 / 排队向量更新]
    Async --> Return[返回含评分汇总的地点]
    Edit[编辑既有地点] --> Owner{创建者或具备管理权限?}
    Owner -->|是| Update[直接编辑并记录所需审计]
    Owner -->|否| Request[提交修改申请]
    Request --> Review[管理员审核]
    Review --> Approval[事务更新地点与申请状态]
```

修改申请（`placeRequestService.js`）只接受内容字段（名称、描述、坐标、分类、图片、人均），所有者 `creator_id` 和最近修改人 / 时间不能经申请修改，提交时剔除、批准时忽略。同一住民对同一地点只保留最新一条待审修改：再次提交时，之前未审的修改申请标成 `superseded`（保留在管理页历史里，不能再审）；新增复核和打卡申请不受影响。新申请按当时的地点内容生成，被取代申请里未重复填写的改动不会保留。批准后和直接编辑一样把 `updated_by` 记成申请人、`updated_time` 更新为批准时间，地点卡片的「最近修改」随之变化。

`GET /places/random` 的推荐算法在 discovery；`/places/:id/diaries` 的公开日记读取在 journeys。不要因为 URL 包含 places 就在本模块复制这两类规则。位置修改包含前端交互，代码主要位于 frontend，后端仍校验更新输入。

| 选择 | 当前实现 | 对照 |
| --- | --- | --- |
| 多入口创建 | 共享校验、事务内插入与提交后补偿 | 每个路由自行写表容易漏掉创建者评分或通知 |
| 非创建者编辑 | 修改申请，审核后写入 | 直接放开写权限会绕过现有治理；本次不变更权限 |
| 分享 | 服务端 HTML 元信息 + 本站缩略图 + 页面跳转 | 仅 SPA 动态标签不能保证抓取器读到；本机测试不代替 QQ/微信真实抓取 |

`routes/placeVisits.js`（`/api/visits`：状态、查看、到访推断与“是否去过”回答）挂在本模块，规则见 [到访与兴趣信号](../../preferences/doc/INTEREST_V3.md) 与 [评分迁移](../../ratings/doc/RATING_MIGRATION.md)。修改记录只保存描述里新增的文字，见 [编辑文本证据](../../ratings/doc/EDIT_TEXT_EVIDENCE.md)。

数据：Place（含 moderation_status）、PlaceRegion、Category、PlaceRequest（request_type 区分修改、新增复核、打卡和评论）、PlaceModeration。跨模块读写涉及 Comment、PlaceRating、QQBotNotification。测试见 [案例库](TEST_CASES.md)。历史：`2bc8c5e` 位置编辑、`d285076` 分享修复、`ce52848` Bot 共享创建。待办 PLC-01 见 [清单](../../../doc/HISTORY_AND_TODO.md)。

展会地点（denpawave Micro 跳转后定位到展馆）见 [展会场地点位](../../../doc/EXHIBITION_VENUE_LINK.md)：**场馆不进 `Place`**，只在 `modules/venues` 里存坐标；前端 `?venue=` 待做。
