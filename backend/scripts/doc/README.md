# 运维脚本与测试执行器

所有命令以 backend 为工作目录；目录改变，已有 npm 命令名保持兼容。

| 文件夹 | 工具 | 使用与副作用 |
| --- | --- | --- |
| accounts | add_user / set_hashed_password | 旧开发工具含固定账号配置，会写 User；不纳入测试，不用于生产，见 ACC-02 |
| images | repair_place_images | `npm run images:repair` 预演；`-- --apply` 才写入；drop-missing 有比例保护 |
| images | migrate_uploads_to_oss | `npm run images:migrate-oss` 预演；`-- --apply` 上传、备份并按参数改库；不要当测试运行 |
| vectors | backfill_place_vectors | `npm run vectors:backfill` 调外部 Embedding 并写库；需有明确数据维护任务再运行 |
| diagnostics | read_logs | `npm run logs -- --since 2h` 只读查询日志 |
| diagnostics | test_deepseek_latency | 真实模型探测，可能使用配置密钥和消耗请求，不由 npm test 发现 |
| backups | backup_database | `npm run backup:database` 默认生成、校验并上传 SQLite 快照到独立私有 OSS；`-- --local-only` 仅本地验证，不需 OSS 配置；见 [备份与恢复](../../infrastructure/doc/DATABASE_BACKUP.md) |
| datasets | export_feedback | 手工数据导出；运行前读参数与研究同意过滤，不在测试汇总中执行 |
| testing | run_tests | `npm test` / `npm run test:ui`；按 tests 下文件名发现，每文件独立进程 |
| journeys | configure_private_algorithms | `npm run journey:configure-private` 仅预览；`-- --apply` 备份并更新两侧私有环境配置，不访问模型、不写数据库；见 [日记算法接入](../../modules/journeys/doc/ALGORITHM_SERVICE.md) |

维护流程：阅读脚本 → 确认数据范围和环境 → 预演（工具支持时）→ 审核结果 → 备份 → 显式应用 → 核对幂等性与恢复路径。流程不是本次已执行的数据操作。

脚本仅调用模块服务，不重新实现算法；需要写共享业务规则时回到 modules。移过来的旧注释如出现原文件路径应与 [迁移表](../../doc/MIGRATION_MAP.md) 核对。

数据库备份从 `backend/.env` 读取独立 `BACKUP_OSS_*` 配置；`--help` 不读取环境文件、不打开数据库。备份脚本以只读连接调用 SQLite 在线备份，包含已提交的 WAL 数据，不能用直接复制正在使用的 `data.sqlite` 替代。Windows 定时安装器位于仓库根的 `script/install-database-backup-task.ps1`，默认每 6 小时执行；安装、状态查询、失败产物清理和人工恢复步骤见上方文档。`npm run test:backup` 使用隔离库与 OSS 替身，不会安装计划任务或访问真实 OSS。
