# 地图协调、渲染与缓存

MapExhibition 的 `useCurrentExhibition` 由 App 调用（只在地图页轮询），入口按钮由 App 挂载以避让公告；展会面板由 MapUI 渲染：网页为 `ExhibitionPanel`，iOS 原生控件接管时改为原生两段停靠卡片（协议 v7 的 `exhibition` 面板，快照由 `exhibition.js` 的 `exhibitionChromeSheet` 生成，纳入 `test:map`）。简介与信息支持基础 Markdown：网页面板用 `Markdown` 组件显示，原生卡片的每段正文带纯文本 `text`（旧版 App）与行内 `markdown`。展会名可长达 80 字：入口标签与面板标题都用 `MarqueeText` 单行来回滚动（减少动态效果时改为可手动横滑），原生卡片标题同样滚动（`MapChromeMarqueeText`）。展会设置了地点时面板有“展会附近随机美食”：收起面板，以展会地点为本轮中心打开随机面板（RandomFoodPanel 的 `origin`）。展会有坐标时地址可点（网页面板的地址行；原生卡片的副标题与详情地址行，协议 v9 `subtitleAction` / `captionAction`，回传行 id `venue`；没填地点名时显示“查看位置”）：收起面板与地点卡片，地图移到展会地点（16 级）并插上临时图钉（`useExhibitionVenuePin`，样式 `.fm-exhibition-venue` 在 `marker-motion.css`），点图钉标签上的关闭钮或地图空白处取消（添加地点、地点卡片打开时那一下留给它们），展会撤下或换了地点时也会消失。原生卡片第一段时地图仍可点选，选中其他地点会收起展会卡片。窄屏入口距顶部 30px，详情全屏展示；宽屏入口位于右下角，详情参照顺路吃的侧板尺寸（宽 370px、顶部 68px、底部 42px）。44px 图标缺失或加载失败回退 favicon；窄屏由 ResizeObserver 根据公告实际矩形避让，公告关闭恢复原位。`exhibitionLayout.js` 负责矩形相交计算，纳入 `test:map`。

操作指引（MapOnboarding.jsx + onboarding.js）：第一次打开地图时，地图就绪、没有其他浮层、没有选中地点且原生控件握手结束后自动出现，看完、跳过或返回都记入 localStorage `foodmap.onboarding`（带 `ONBOARDING_VERSION`，内容大改时加一让老用户再看一次）；网页与安卓“更多”、iOS 原生上滑抽屉、桌面顶栏“更多”都能再次打开。步骤的相对顺序各布局相同（欢迎、入乡、搜索、定位、收藏、添加、顺路吃、日记），之后是“更多”，最后是该布局里收在“更多”里的功能（窄屏的日记、iOS 网页工具栏的顺路吃和日记、iOS 原生工具栏的顺路吃）。网页按钮用 `data-tour="<步骤 id>"` 标记；收在“更多”里的功能高亮“更多”按钮，卡片里写明「在哪里」。iOS 原生工具栏（协议 v10 `tour`）：指引打开时原生控件不收起，原生把其余控件变暗、给目标画高亮圈、不接收触摸，并把目标位置作为 `tour` slot 回传；网页遮罩挖空目标下方的地图，卡片避开全部原生控件，每一步都写明位置（如“底部工具栏最右边的头像”）。“更多功能”一步原生播放上滑示意（手指往上划、工具栏露出一截更多功能），并允许真的拖动工具栏，展开后自动进入下一步（展开的更多功能里高亮顺路吃）。新增或移动主要按钮时同步步骤表、`data-tour` 与原生目标，步骤表和卡片位置纳入 `test:map`，桥接字段纳入 `test:native-chrome`。

按住民筛选（`userPlaces.js`，纳入 `test:map`）：地点卡片“最近修改”的名字可点（修改过的是最后修改人，否则是创建者；账号已注销的不能点），点开后 MapView 读取 `GET /users/:id/places`（最近创建在前，最多 200 个，自己还能看到审核中的），地图只显示这位住民的地点并调整视野。筛选与搜索、沿途互斥：提交搜索、选建议、沿途出结果、随机美食、分享链接、新增地点都会退出筛选。列表是临时面板（宽屏与收藏同一位置、地图可操作；窄屏底部面板，选中地点后让位给卡片；iOS 原生控件接管时为协议 v11 的 `userPlaces` 列表面板，卡片里“最近修改”是全屏详情中的一行），关闭列表不退出筛选；地图上的筛选条（窄屏在定位按钮左侧同一行，宽屏底部居中）重新打开列表或退出。接口返回的 `relation`（`self`，以及为屏蔽某人预留、目前恒为 false 的 `blocked`）随筛选状态保存；以后的屏蔽 / 取消屏蔽加在 `userPlacesActions`，网页按钮与原生面板行共用 id，在 MapUI 的 `runUserPlacesRow` 分发。

导航（MapUI 的导航选择面板、MapView 处理的 `nav=amap` 分享链接）里的高德链接由 `amapNavigation.js` 生成（纳入 `test:map`）：`uri.amap.com` 不是 Universal Link / App Link，所以 App 内直接用高德 scheme（iOS `iosamap://path`，Android `amapuri://route/plan/`，坐标本来就是 GCJ-02，`dev=0`），没装高德时 `openExternal` 的 `fallbackUrl` 改开网页版；网页端（以及后端分享页 `placeShare.js`）用 `uri.amap.com` 加 `callnative=1`，由高德网页尝试唤起 App。只直接打开、不用 `canOpenUrl` 探测，所以 iOS 不需要 `LSApplicationQueriesSchemes`，Android 也不需要在 `<queries>` 里登记。

MapView.jsx 是旧 src/Map.jsx，仍是地图协调者；MapUI.jsx 负责地图 UI 与面板编排，二者尚未拆完。MarkerLayerController、markerContent 与 cluster 下引擎/快照/转场/缓存负责标记；viewport、pinchGuard、overseasTileLayer 各自处理视口、手势与境外底图。MapPanel/MapAnchoredCard 是地图布局容器，不是通用页面组件。locationReport 记下最近一次定位，按最新登录状态上报 `PUT /users/me/location`（QQ Bot `!随机` 的中心），App 启动时的自动定位早于登录恢复时在登录后补报。

```mermaid
flowchart TD
    Mount[地图容器挂载] --> SDK[订阅 SDK 状态并创建 AMap]
    SDK --> Setup[建立标记控制器 / 海外底图 / 事件]
    Setup --> View[读取视口边界与缩放]
    View --> Cache{范围缓存覆盖且有效?}
    Cache -->|是| Render[使用缓存结果]
    Cache -->|否| Gate[请求闸门 取消或淘汰旧请求]
    Gate --> API[请求 nearby 范围]
    API --> Current{仍为有效请求?}
    Current -->|否| Ignore[丢弃旧响应]
    Current -->|是| Merge[写缓存并更新可见地点]
    Merge --> Render
    Render --> Cluster[生成聚合快照与转场计划]
    Cluster --> Markers[统一标记内容 / 点击 / 卡片锚点]
    Select[地点操作] --> Business[places / discovery / journey]
    Business --> Patch[按现有规则回写选中地点与缓存]
    Leave[地图卸载] --> Cleanup[销毁地图 / 监听 / 控制器与定位资源]
```

| 当前实现 | 对照 |
| --- | --- |
| 视口缓存 + 请求版本闸门 | 只缓存列表不能阻止旧响应覆盖；移动后要同时核对范围与请求身份 |
| 引擎/快照/转场分离 | 直接在 React 列表逐点管理难维护现有聚合成员与动画中断不变量 |
| 海外 tile overlay 与 SDK 分工 | CARTO 是配置可选覆盖，不替换国内坐标和高德区域判断 |
| MapView/MapUI 继续协调 | 本轮先归位地点与发现面板，状态拆分见 MAP-01，不假定文件移动已解除耦合 |

已有 `test:map` / `test:platform` 逻辑测试；真实地图相关交互覆盖一部分在位置与日记浏览器回归。案例见 [TEST_CASES.md](TEST_CASES.md)。历史 `d944e8a`、`2bc8c5e`；待办 MAP-01 / MAP-02 见 [清单](../../../doc/HISTORY_AND_TODO.md)。
