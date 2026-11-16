# 运维脚本与测试执行器

所有命令以 backend 为工作目录；目录改变，已有 npm 命令名保持兼容。

| 文件夹 | 工具 | 使用与副作用 |
| --- | --- | --- |
| accounts | add_user / set_hashed_password | 旧开发工具含固定账号配置，会写 User；不纳入测试，不用于生产，见 ACC-02 |
| images | repair_place_images | `npm run images:repair` 预演；`-- --apply` 才写入；drop-missing 有比例保护 |
| images | migrate_uploads_to_oss | `npm run images:migrate-oss` 预演；`-- --apply` 上传、备份并按参数改库；不要当测试运行 |
| places | check_place_coordinates | `npm run places:check-coordinates` 只读：列出地图无法显示的地点坐标（纬度超出 ±85.0511° 等）和提议坐标无效的待审核申请，有问题时退出码 2；不改库 |
| places | fill_place_regions | `npm run places:regions` 一次补齐没查过或坐标变了的地点的省 / 市 / 区（高德逆地理编码，需 `AMAP_WEB_SERVICE_KEY`，写 `PlaceRegion`，不改 `Place`）；`-- --dry-run` 只统计；结束时列出坐标被高德拒绝的地点。后端运行时后台也会慢慢补，见 [地点文档](../../modules/places/doc/README.md) |
| places | merge_categories | `npm run categories:merge` 预览按 `modules/places/categoryMerges.json` 合并标签的结果；`-- --db <file>` 指定数据库，`-- --apply` 备份后写入（`Place.category`、待处理申请的 `proposed.category`、Category 表；不改修改时间和修改人） |
| places | reassign_place_owners | `npm run places:reassign-owners -- <csv>` 预览按 CSV（名称、qq、创建人）把地点所有者改给 qq 对应的住民，找不到住民时新建账户；`--apply` 备份后写入，原创建者的评分一并转给新创建者。规则见脚本头注释，测试 `tests/places/test_reassign_place_owners.js` |
| ratings | rewrite_edit_comments | `npm run edit-comments:rewrite` 只读预览：把旧格式修改记录（「描述：旧 → 新」）改成只含描述里新增的文字；`-- --apply` 备份后写入，`--delete-empty` 另删除没有新增描述文字的记录（会写删除标记并作废相关作者研究包），`--db <file>` 指定数据库 |
| ratings | backfill_edit_comments / text_evidence_report | 编辑评论回填（默认预览，`--apply` 写入，每批 500 条）与文本证据队列报告（只读，`--compare` 看影子变化）；直接 `node` 运行，见 [编辑文本证据](../../modules/ratings/doc/EDIT_TEXT_EVIDENCE.md) |
| ratings | export_rating_evidence | 研究包导出，默认 dry-run，`--apply` 才写出；见 [评分服务接入](../../modules/ratings/doc/ALGORITHM_SERVICE.md) |
| vectors | backfill_place_vectors | `npm run vectors:backfill` 调外部 Embedding 并写库；需有明确数据维护任务再运行 |
| diagnostics | read_logs | `npm run logs -- --since 2h` 只读查询日志 |
| diagnostics | amap_search_budget | 查看或修改高德外部搜索预算（`--enabled=`、`--monthly-limit=`、`--daily-limit=`、`--used=`），改动对新请求立即生效；见 [外部搜索与配额](../../modules/maps/doc/search-budget.md) |
| diagnostics | test_deepseek_latency | 真实模型探测，可能使用配置密钥和消耗请求，不由 npm test 发现 |
| backups | backup_database | `npm run backup:database` 默认生成、校验并上传 SQLite 快照到独立私有 OSS；`-- --local-only` 仅本地验证，不需 OSS 配置；见 [备份与恢复](../../infrastructure/doc/DATABASE_BACKUP.md) |
| datasets | export_feedback | 手工数据导出；运行前读参数与研究同意过滤，不在测试汇总中执行 |
| testing | run_tests | `npm test` / `npm run test:ui`；按 tests 下文件名发现，每文件独立进程 |
| journeys | configure_private_algorithms | `npm run journey:configure-private` 仅预览；`-- --apply` 备份并更新两侧私有环境配置，不访问模型、不写数据库；见 [日记算法接入](../../modules/journeys/doc/ALGORITHM_SERVICE.md) |

维护流程：阅读脚本 → 确认数据范围和环境 → 预演（工具支持时）→ 审核结果 → 备份 → 显式应用 → 核对幂等性与恢复路径。流程不是本次已执行的数据操作。

脚本仅调用模块服务，不重新实现算法；需要写共享业务规则时回到 modules。移过来的旧注释如出现原文件路径应与 [迁移表](../../doc/MIGRATION_MAP.md) 核对。

数据库备份从 `backend/.env` 读取独立 `BACKUP_OSS_*` 配置；`--help` 不读取环境文件、不打开数据库。备份脚本以只读连接调用 SQLite 在线备份，包含已提交的 WAL 数据，不能用直接复制正在使用的 `data.sqlite` 替代。Windows 定时安装器位于仓库根的 `script/install-database-backup-task.ps1`，默认每 6 小时执行；安装、状态查询、失败产物清理和人工恢复步骤见上方文档。`npm run test:backup` 使用隔离库与 OSS 替身，不会安装计划任务或访问真实 OSS。
