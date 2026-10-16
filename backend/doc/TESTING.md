# 面向 AI 的测试案例执行协议

案例库用于指导复现与回归，不等于已经通过的自动化测试。每个案例须标明现有自动化入口或“待自动化”。本次验证实绩见 [验证记录](VERIFICATION.md)。

## 执行规则

1. 从 backend 目录运行命令；先读模块 doc/README.md、TEST_CASES.md 和关联待办，再读对应测试实现。
2. 模块加载前设置 DB_FILE 为临时目录中的绝对路径，并关闭文件日志；需要上传时设置临时 UPLOADS_DIR。绝不默认连接工作库运行 init 或维护脚本。
3. 使用稳定的合成地点、随机 UUID 用户和确定时间；涉及北京时间配额时固定 UTC 时间，不依赖机器当前时区。
4. HTTP 测试监听 127.0.0.1 的随机端口；Redis 用 tests/helpers/fakeRedis.js 或脚本已有替身；替身必须在 require 业务模块前注入同一 infrastructure/redis 路径。
5. 保留真实路由、服务和数据库，只替换外部模型 / 地图 / QQ / OSS 边界。不要通过 mock 掉被测服务来证明业务正确。
6. 不读取生产密钥、不向真实群发消息、不执行真实付费请求。scripts/diagnostics/test_deepseek_latency.js 是手工探测，不属于 npm test。
7. 同时检查响应、数据库副作用、幂等性和权限；失败请求要验证没有部分写入。不要只断言 HTTP 200。
8. 浏览器测试至少验证用户看见的状态与最终数据库；结束时关闭浏览器、Vite、HTTP、worker、SQLite，并清理自己的临时资源。
9. 报告命令、退出状态、断言或测试文件数、跳过项和环境限制。历史文档写过“通过”不能作为本次通过证据。

## 固定案例格式

`ID / 关联历史或待办 / 前置数据 / 操作 / 预期响应与副作用 / 自动化入口或缺口`。

状态只有：`已有自动化`、`待自动化`、`人工环境验证`。与提交有关的问题先用 `git show <hash> -- <当时路径>` 阅读当时修改；用 [迁移表](MIGRATION_MAP.md) 找今天的位置，不回退当前工作区来复现旧版本。

## 测试入口矩阵

| 范围 | 命令（backend 下） | 重点 |
| --- | --- | --- |
| 静态结构 | npm run test:structure | 导入、业务文档、文档链接、稳定数据根目录 |
| 全部非浏览器 | npm test | 自动发现 tests 各模块；每文件独立进程、串行、180 秒超时，失败汇总 |
| 账号 | npm run test:session-store / test:sessions / test:qq-verification | 多设备、旧 token、验证码、重置撤销 |
| 地点 | npm run test:transactions / test:place-share | 申请事务、账号事务、分享与缩略图 |
| 评分 | npm run test:ratings | schema、数学权重、批处理、HTTP 与配额 |
| 发现 | npm run test:search / test:random | 排序、降级、地理边界、概率 |
| 偏好与社区 | npm run test:preferences / test:community | 行为去重、画像、同好隐私 |
| 日记 | npm run test:journeys / test:journey-resolution / test:journey-publication | 修订、澄清、公开快照、幂等提交 |
| Bot 与图片 | npm run test:qq-bot / test:images | 协议替身、草稿、通知、隐私、OSS 迁移 |
| 技术能力 | npm run test:ai-clients / test:logging / test:migration | 上游异常、脱敏、旧 schema |
| 资源路径 | node tests/infrastructure/test_resource_paths.js | 更换 cwd 后相对 DB_FILE、默认上传与日志仍指向既有位置；也由 npm test 执行 |
| 数据库备份 | npm run test:backup | 临时 WAL/向量库、模拟 OSS、上传与失败保留、恢复摘要、跨进程互斥、CLI 与日志；也由 npm test 执行 |
| 备份计划任务 | node tests/infrastructure/test_backup_task.js | PowerShell parser 与模拟 ScheduledTasks 边界；不安装真实任务，无 PowerShell 环境明确跳过运行检查 |
| 浏览器 | npm run test:ui | npm run test:place-location + test:journey-ui 对应两文件 |

`npm test` 不包括浏览器用例；二者必须分别报告。旧有脚本会打印预期的模型不可用或 Redis 降级警告，应以断言和退出码判断。连接本机出现 EACCES 时记录执行环境限制，不修改业务绕过权限。新增测试应进入对应 tests/<模块>，不要重新放进 scripts 根目录。
