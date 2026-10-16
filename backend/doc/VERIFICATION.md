# 本次验证记录

基线：`2bc8c5e`。验证日期：2026-10-15，Windows / Node.js v24.19.0。以下均为本次运行结果；旧专题中的性能数字和通过记录不作为本次证据。

## 最终结果

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| `npm --prefix backend test` | 24/24 测试文件通过，退出 0 | 所有非浏览器测试；含结构与跨 cwd 资源路径两个新增测试 |
| `npm --prefix backend run test:ui` | 2/2 测试文件通过，退出 0 | 地点位置编辑完整流程；日记编辑、生成、发布、分享、撤回、社区与手机布局 |
| `npm --prefix backend run test:structure` | 通过 | 125 JS 文件相对导入、模块文档、Markdown 本地链接、资源根目录 |
| 每个源码 `node --check` | 125/125 通过 | 不加载数据库、不启动服务的语法检查 |
| 逐项迁移比对 | 124/124 目标存在，导入与静态文件路径等价 | 对照 HEAD 原文，规范化搬迁路径后比较，保留动态/延迟 require |
| `git diff --check` | 通过 | 已跟踪文件修改，无空白错误 |
| 独立只读审查 | 未发现剩余可操作问题 | 导入目标、延迟加载、require.cache、资源位置、子进程与脚本、测试发现和退出状态；审查者另跑结构检查通过 |

逐项比对中，除导入、静态路径与注释外的修改为：database / logger / imageStorage 使用统一资源根目录；日记澄清测试注册仓库已有 json-hooks；反馈导出 Usage 更新为新路径。没有改业务算法、API 前缀或表结构。新文件还有 paths 工具、测试汇总器和两个回归检查。

## 执行环境与已观察限制

- 后端测试使用临时数据库；浏览器流程使用真实 React/Vite/API，替换模型与地图外部边界，没有操作运行数据或真实 QQ/OSS。
- 本机 HTTP 连接在初次沙箱运行中被 EACCES 拦截；在允许本机测试连接的执行环境中完成最终回归。
- 项目未安装 Playwright；通过现有 `PLAYWRIGHT_MODULE` 配置使用应用自带包及系统 Edge，无新增依赖。其他环境可自行提供 Playwright 包和相应 browser channel。
- 日记浏览器首轮在“未完成 · 1”按钮匹配超时；仅加失败时打印页面状态的诊断副本随后全程通过，未触发诊断，删除副本后正式入口再次全程通过。未修改选择器或业务掩盖失败；根因未确定，后续稳定性任务 QA-T01 已记录。
- 非浏览器测试首次暴露日记澄清测试的 Node JSON 加载适配缺失，已复用前端现有 json-hooks，并由最终全套验证覆盖。
- 不验证真实高德、QQ/微信抓取、NapCat 图文展示、生产 OSS 备份恢复或进程硬终止恢复；这些属于明确列出的人工验收或专项覆盖缺口。

## 浏览器命令复现

在提供 Playwright 的环境中，使用既有配置入口，无需把机器路径写入项目：

```powershell
$env:PLAYWRIGHT_MODULE = '<可解析的 Playwright 包名或绝对路径>'
$env:PLAYWRIGHT_CHANNEL = 'msedge'
npm --prefix backend run test:ui
```

测试输出中的缺少模型密钥、模拟失败与预期 Redis 降级日志不代表断言失败，最终以测试退出码和逐文件结果为准。

## SQLite OSS 备份新增验证（2026-10-15）

新增独立备份 CLI、私有 OSS 上传与 Windows 计划任务后重新验证：

| 检查 | 实际结果 |
| --- | --- |
| `npm --prefix backend test` | 26/26 非浏览器测试文件通过，退出 0；使用允许本机回环连接的执行环境 |
| `node backend/tests/infrastructure/test_database_backup.js` | 11 个案例通过：路径与配置、缺失/空/坏库、WAL 并发写入和向量表恢复、归档/manifest 摘要、私有上传与 Content-MD5、重试及丢失确认、大小/元数据错误、manifest 失败、保留策略、互斥及强制退出恢复、CLI 与持久日志 |
| `node backend/tests/infrastructure/test_backup_task.js` | Windows PowerShell 5.1 parser、ASCII 与 19 个隔离任务场景通过；未注册真实任务 |
| `npm --prefix backend run test:structure` | 129 JS 文件、相对导入与文档链接通过，退出 0 |
| 新增四个 JS 文件 `node --check` | 全部通过，退出 0 |
| `git diff --check` | 通过，退出 0 |
| 文档恢复示例 | 在临时合成向量库上完成 gzip/SQLite 字节数与 SHA256 比对、解压及只读 quick_check；没有覆盖工作库 |
| 独立审查 | 早期环境文件错误未持久记录的问题已修复；回归验证配置读取失败也产生失败日志 |

默认沙箱首次全套为 7/24，既有 HTTP/模型替身测试受到本机连接 EACCES 限制；在允许本机测试连接的环境中，最终 26/26 通过。默认沙箱不能创建链接，单独运行备份测试时明确跳过保留策略的链接夹具；最终完整验证环境中该夹具也执行通过，没有该跳过项。PowerShell 测试以进程级 ExecutionPolicy Bypass 运行，与安装说明一致，未修改机器策略。

这次没有重跑浏览器测试，因为未修改 HTTP/前端流程。备份测试使用临时数据库与模拟 OSS，未访问真实 OSS 或注册任务；部署配置检查只报告缺失项名称，不输出凭证。上述为实现验证阶段；后续已配置环境的实际验证见下节。

## 手动云端验证与非生产任务撤销（2026-10-15）

- 用户填写独立备份配置后，手动备份成功。SQLite 快照 59,645,952 字节，压缩归档 12,743,097 字节；本地 SHA256 复核、上传时的 Content-MD5 与远端 HEAD 大小/摘要元数据校验通过，远端归档类型确认 IA。只上传正式归档与 manifest，没有额外测试对象，没有下载正文或删除云端文件，也未修改生命周期。
- 实际安装预览发现 PowerShell -File 下参数默认值求值时 PSScriptRoot 为空。先用真实入口重现，再把默认 BackendDir 解析移到参数块后。真实 -File -WhatIf 和 21 个隔离任务场景通过，最终再次运行后端测试为 26/26，退出 0。
- 本机任务曾注册，随后用户明确本环境不是生产并要求删除。YuyukoFoodMapDatabaseBackup 已卸载，独立任务查询返回 Exists=false。本机保持不启用定时备份，云端已上传对象保留。生产主机安装、生产恢复演练与生命周期确认不作为已完成事项。
