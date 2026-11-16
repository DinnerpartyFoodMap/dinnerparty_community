# 种子数据

categories.json 是现有分类种子，由 infrastructure/database.js 的 loadInitialCategories 在初始化中读取；位置固定在 backend/seeds。选用仓库内 JSON 便于版本追踪和离线初始化，对照外部配置中心不增加启动依赖。

`is_common` 决定前端筛选与表单里的常用标签。2026-11-11 加入常用标签“待探索”（sort_order 10）：带它的地点创建时不写创建者评分，见 [地点文档](../../modules/places/doc/README.md)。相近标签的合并不改种子，而是由 `modules/places/categoryMerges.json` 在写入时换成保留的标签，既有数据用 `npm run categories:merge` 合并。

修改分类前核对既有地点的分类文本兼容与初始化逻辑。执行 `npm run test:migration`、`npm run test:ratings`；新需求若涉及删除/重命名分类，应另给旧数据迁移方案，不能把修改种子等同于迁移既有数据。
