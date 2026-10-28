# 搜索、随机美食与顺路

hooks/useSearchPanel 控制搜索面板；components/RandomFoodPanel 与 AlongRoutePanel 管理推荐/顺路交互；alongRoute.js 处理高德路线输入等工具。普通关键词、AI、随机的服务端规则仍由后端决定。MapView/MapUI 继续持有部分搜索状态；api/client 提供请求函数。

随机美食的抽取生命周期由 `hooks/useRandomFood.js` 统一持有：网页 `RandomFoodPanel` 与 iOS 原生 `random` 弹窗（工具栏协议 v13，`randomFoodSheet.js`）共用一次请求、固定中心与最近两家的排除记录。原生的查看、换一家、重定中心动作仍回网页执行。关闭、换账号与换中心会取消旧轮次，迟到结果不回写；失败重试保留社区抽取的 `draw_id`。`npm run test:random-browser` 用真实 React 与受控 HTTP 边界覆盖这些交互。

输入预览和回车只查询站内地点，回车保留 AI 推荐。网页和 iOS 原生输入共用这一规则；点击“没找到？查找未收录地点”才经后端查询高德。`useExternalSearch` 管理本次结果、错误、重复点击及过期响应；自有标记更新会刷新本地结果，但不会触发外部查询。额度与上线步骤见[外部搜索配置](../../../../backend/modules/maps/doc/search-budget.md)。

```mermaid
flowchart TD
    Submit[提交查询与当时地图中心] --> Local[已有地点关键词请求]
    Explicit[点击查找未收录地点] --> POI[后端计量的高德搜索]
    Local --> Result[保留服务端已有地点排序与距离]
    POI --> Result
    Result --> Select[选择结果 → 地图与地点卡片]
    AskAI[独立 AI 请求] --> AI{可用?}
    AI -->|是| Recommendation[校验并展示推荐]
    AI -->|否| Unavailable[可解释不可用 基础搜索保留]
    Random[打开随机面板] --> Center[固定本轮中心]
    Center --> Draw[抽取 排除最近两家]
    Draw --> More[换一家沿用中心 / 重定中心重新一轮]
    Close[关闭 / 换账号] --> Cancel[取消在途请求并忽略过期结果]
    Route[顺路输入] --> Resolve[解析路线 → 后端顺路查询 → 地图结果]
```

| 当前方案 | 对照 |
| --- | --- |
| 后端排序，前端保序 | 前端按旧字段再排序会撤销距离联合排序修复 |
| 随机一轮固定中心和短历史 | 每次悄悄换中心会使“再换一家”含义改变 |
| 取消与 controller 身份判断同时使用 | 单独 abort 不保证已完成或迟到回调不更新状态 |

测试见 [TEST_CASES.md](TEST_CASES.md)。前端 `test:search` 覆盖显式外部查询状态和去重；后端 `tests/maps/test_amap_search_ui.js` 覆盖网页及模拟原生 iOS 输入、按钮调用和收录后刷新。排序/随机算法由后端 test:search / test:random 验证；完整本地/AI 搜索竞态和顺路面板覆盖仍需补充，见 DSC-F01 / DSC-F02 的 [清单](../../../doc/HISTORY_AND_TODO.md)。
