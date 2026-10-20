# 外部地点搜索与配额

普通地图输入、回车只搜索自有标记（提交时保留 AI 推荐）。网页、iOS 原生输入框和网页回退共用此策略。用户点击结果列表的“没找到？查找未收录地点”才查询高德；输入新词或退出搜索会重置本次结果。行程地址搜索仍接受城市、地址，在手动提交时调用。

`POST /api/amap/search` 接收 `{q, center?, city?, source}`。来源只允许 `map_manual`、`journey_address`；关键词最多 100 字符。提供中心点时查周围 20km，否则查关键词；固定第一页、最多 20 条。响应 `{places}` 仅含页面需要的名称、坐标、地址、城市、分类。失败返回 `{code,error}`，与空结果区分。无自动重试，不持久化 POI 响应，仅合并进行中的相同请求。

## 部署

- 后端搜索复用 `AMAP_WEB_SERVICE_KEY`，必须是 Web 服务类型并有搜索权限。缺失时外部搜索报不可用，自有标记仍可搜索。
- SDK 底图继续使用 `AMAP_JS_KEY` 和 `AMAP_JS_CODE`，原有换 Key 流程保留。接口迁移不会增加高德配额。
- 先部署后端，再发布网页和构建 iOS。旧 App 的 `/_AMapService` POI 查询也计数，来源为 `legacy_sdk`。搜索预算不阻止瓦片、逆地理编码或路线规划。
- 所有服务实例须共享同一 SQLite 数据库才能共享计数。统计不覆盖账号其他应用或绕过本后端的调用，仍须与高德控制台对账。

## 实时管理

默认启用，每月最多 4000 次，为 5000 次额度留出余量。`dailyLimit=0` 按“当天开始时可用月余额 / 当月剩余天数”向上取整分配；正整数则指定每日上限，仍受月上限约束。月额度为 0 时停止搜索。

账期固定 Asia/Shanghai。SQLite `IMMEDIATE` 事务在发起上游调用前扣减；失败也保守计数、不退还，避免漏计已被高德处理的超时请求。重启不清零，新月份自动进入新账期。用量、配置、上线前对账差额分别存入 `AmapSearchUsage`、`AmapSearchConfig`、`AmapSearchAdjustment`。

在 `backend/` 目录运行下列命令，配置即时生效，无需重启。脚本读取服务的 `.env` 和 `DB_FILE`，输出不含密钥和搜索词。

```powershell
# 查看配置、日/月用量、按来源统计
node scripts/diagnostics/amap_search_budget.js
# 关闭；重新开放使用 --enabled=true
node scripts/diagnostics/amap_search_budget.js --enabled=false
# 修改预算，自动分配每日额度
node scripts/diagnostics/amap_search_budget.js --monthly-limit=4000 --daily-limit=0
# 首次上线填入控制台本月已用总次数；1200 仅为示例
node scripts/diagnostics/amap_search_budget.js --used=1200
```

**首次上线先对账。** 新计数器不知道此前已用额度。`--used` 是当前已用总数，不是追加数，不能低于本后端记录的次数。选择低流量时段核对，考虑控制台统计延迟，并为账号其他调用留余量。

来源统计按实际预约的上游请求数计算，合并请求只计一次。`amap.search.reserved/completed/failed` 日志不记录关键词、坐标或 Key。新接口还限制每 IP 每分钟 10 次提交；持久化总预算是最终上限。

## 验证

```powershell
node tests/maps/test_amap_search.js
npm --prefix ../frontend run test:search
npm --prefix ../frontend run test:native-chrome
# 需 Playwright，或 PLAYWRIGHT_MODULE 指向已有包
node tests/maps/test_amap_search_ui.js
```

浏览器回归运行真实 React、本地搜索和外部搜索路由，仅替换高德上游和原生插件边界，覆盖桌面和 iOS 原生输入事件。SwiftUI 真机布局、系统键盘和原生编译须在 macOS/Xcode 验证。
