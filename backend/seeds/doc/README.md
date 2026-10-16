# 种子数据

categories.json 是现有分类种子，由 infrastructure/database.js 的 loadInitialCategories 在初始化中读取；位置固定在 backend/seeds。选用仓库内 JSON 便于版本追踪和离线初始化，对照外部配置中心不增加启动依赖。

修改分类前核对既有地点的分类文本兼容与初始化逻辑。执行 `npm run test:migration`、`npm run test:ratings`；新需求若涉及删除/重命名分类，应另给旧数据迁移方案，不能把修改种子等同于迁移既有数据。
