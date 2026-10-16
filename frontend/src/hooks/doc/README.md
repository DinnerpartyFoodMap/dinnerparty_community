# 通用 hooks

useMediaQuery.js 是无业务状态的响应式查询订阅；useDarkMode 归 theme，usePlaceRating 归 places/hooks，useSearchPanel 归 discovery/hooks。按拥有状态的业务组织，对照把所有 use* 文件集中于一个目录，能减少跨模块阅读成本。

流程：传入 query → 获取当前 matches → 订阅变更 → 组件更新 → 卸载清理。案例（待独立自动化）：HK-C01 初始宽度与 resize 更新；HK-C02 不支持浏览器 API 时有既有回退；HK-C03 换 query 或卸载后不残留旧监听。不要用增加通用参数来把具体地点或搜索状态塞进本目录。
