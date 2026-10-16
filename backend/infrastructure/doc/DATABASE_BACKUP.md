# SQLite 备份与恢复

备份命令从正在使用的 SQLite 创建一致快照，校验后压缩并上传到独立的私有阿里云 OSS。计划任务安装器默认每 6 小时运行一次，本地默认保留最近 3 份成功上传的备份。远端保留期由 Bucket 的生命周期规则决定，下文以 30 天为配置示例；脚本不会改规则或删除云端对象。

当前工作区为非生产环境。本机计划任务已按用户要求撤销并确认不存在；已上传的手动验证备份保留。后续安装任务前须先确认实际生产主机，不能把此工作区当作生产部署目标。

这是部署操作说明；文中的真实上传、任务安装、恢复演练与正式恢复需要在目标环境执行，仓库自动化测试不表示这些生产操作已经完成。

低频访问（IA）Bucket 的启用验证直接上传正式备份，不创建额外探测文件；上传后仅通过 HEAD 读取元数据，不为验收下载备份正文，也不删除云端对象或改动现有生命周期。IA 对象有最低存储期，避免为清理测试文件产生提前删除费用；具体规则以 [OSS 存储费用说明](https://help.aliyun.com/zh/oss/storage-fees) 为准。正常备份每次创建归档与 manifest 两件对象，所有本地保留策略仅作用于本地磁盘。

## 备份包含什么

SQLite 账号、地点、评论、评分、日记、头像 BLOB、日记媒体 BLOB 和向量表随快照保存。备份通过源数据库的只读连接调用 SQLite 在线备份接口，包含已提交的 WAL 数据；不会初始化业务 schema，也不通过直接复制正在使用的主库文件制作快照。快照加载 `sqlite-vec` 后执行 `PRAGMA quick_check`，通过才生成 gzip 和 SHA256。

外部地点图片、`backend/uploads/`、图片 OSS 对象、`backend/.env` 和 Redis 会话不在 SQLite 快照里。地点图片要另行备份；环境文件中的凭证应另存于安全位置，恢复账号、向量和 AI 功能时仍需要相应配置。Redis 会话需要独立恢复或让用户重新登录。

每次运行在 `BACKUP_DIR` 下创建独立的 `sqlite-backup-<UTC 时间>-<UUID>/`，包含：

| 产物 | 用途 |
| --- | --- |
| `snapshot.sqlite.gz` | 通过 SQLite 校验的压缩快照 |
| `manifest.json` | `formatVersion: 1`；快照开始/完成 UTC 时间、源库文件名、解压库和 gzip 的字节数及 SHA256 |
| `uploaded.json` | 仅在两件远端对象上传并确认成功后写入；作为本地成功保留策略依据 |

远端键为 `<BACKUP_OSS_PREFIX>/YYYY/MM/DD/<作业名>.sqlite.gz` 和同名 `.manifest.json`，日期使用 UTC。先上传归档，最后上传 manifest 作为完成标记；归档和 manifest 都发送 `Content-MD5`，由 OSS 核对传输内容，再经过 HEAD 大小与 SHA256 元数据核验。HEAD 中的 SHA256 是本次上传写入的自定义元数据，下载恢复时仍要实际计算文件的 SHA256。只有归档、没有 manifest 的远端作业不能视为完整备份。对象使用私有 ACL、`Cache-Control: no-store`、HTTPS 和 V4 签名，无需公开域名。[OSS PutObject 校验规则](https://help.aliyun.com/zh/oss/developer-reference/putobject)

当前使用流式单次 PUT，每个压缩归档不能超过 OSS 的 5 GB 单次上传上限；更大文件需要先扩展为分片上传。磁盘需同时容纳快照和压缩归档。源数据库必须在 `BACKUP_DIR` 之外，包括真实路径解析后的目录；避免保留策略接触源库。完成的快照会单独切回 DELETE 日志模式再压缩，产物不依赖源库的 WAL 或共享内存文件。

## 配置独立备份 OSS

在 OSS 控制台创建独立的私有 Bucket，确认地域、访问控制和存储费用。备份独立使用 `BACKUP_OSS_*`；即使已配置图片上传 `OSS_*`，也要单独填写备份变量，脚本不会借用图片凭证、Bucket 或公开域名。

为专用 RAM 身份仅授予备份前缀的 `oss:PutObject` 与 `oss:GetObject`。HEAD 校验使用 GetObject 权限；不需要 ListObjects、DeleteObject 或修改生命周期权限。以下策略中的 Bucket 名需替换为自己的备份 Bucket，资源前缀要与 `BACKUP_OSS_PREFIX` 一致：

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["oss:PutObject", "oss:GetObject"],
    "Resource": ["acs:oss:*:*:your-private-backup-bucket/food-map/sqlite/*"]
  }]
}
```

在 OSS 控制台为 `food-map/sqlite/`（或自定义前缀）单独设置生命周期：对象创建 30 天后删除。只匹配备份前缀，核对规则不要覆盖其他用途对象；若 Bucket 开启版本控制，也要根据恢复需求配置非当前版本与删除标记的处理。安装脚本不会替你创建或验证此规则。

在服务器 PowerShell 打开后端目录；仅当环境文件不存在时才从示例新建，已有文件保留：

```powershell
Set-Location "D:\Learning\yUYUko_food_MAP\backend"
if (-not (Test-Path -LiteralPath ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
}
notepad .env
```

在 `backend/.env` 填写以下配置。示例不含可用凭证：

```dotenv
DB_FILE=data.sqlite
BACKUP_DIR=backups
BACKUP_LOCAL_KEEP=3
BACKUP_OSS_REGION=oss-cn-hangzhou
BACKUP_OSS_BUCKET=your-private-backup-bucket
BACKUP_OSS_ACCESS_KEY_ID=
BACKUP_OSS_ACCESS_KEY_SECRET=
BACKUP_OSS_STS_TOKEN=
BACKUP_OSS_ENDPOINT=
BACKUP_OSS_PREFIX=food-map/sqlite
BACKUP_UPLOAD_ATTEMPTS=3
BACKUP_UPLOAD_TIMEOUT_MS=120000
```

| 配置 | 约定 |
| --- | --- |
| `DB_FILE` | 与后端使用同一个源库；默认 `data.sqlite`，相对路径以 `backend/` 为根 |
| `BACKUP_DIR` | 默认 `backups`，相对路径以 `backend/` 为根；自定义目录需另设版本控制忽略规则和磁盘监控 |
| `BACKUP_LOCAL_KEEP` | 默认 `3`；仅上传成功后清理旧的成功备份 |
| `BACKUP_OSS_REGION` / `BACKUP_OSS_BUCKET` | 私有备份 Bucket 的地域与名称，上传模式必填 |
| `BACKUP_OSS_ACCESS_KEY_ID` / `BACKUP_OSS_ACCESS_KEY_SECRET` | 专用备份 RAM 凭证，上传模式必填 |
| `BACKUP_OSS_STS_TOKEN` | 可选临时凭证 token；使用时必须及时轮换，计划任务不会自动续期 |
| `BACKUP_OSS_ENDPOINT` | 可选地域 endpoint；例如同地域 ECS 的内网 endpoint，仍使用 HTTPS |
| `BACKUP_OSS_PREFIX` | 默认 `food-map/sqlite`，需与 RAM 策略及生命周期前缀相同 |
| `BACKUP_UPLOAD_ATTEMPTS` | 每个上传的最大尝试次数，默认 `3` |
| `BACKUP_UPLOAD_TIMEOUT_MS` | OSS 请求超时毫秒，默认 `120000`；计划任务另有 30 分钟整体上限 |

保护环境文件与本地备份的 Windows 目录权限。计划任务以 SYSTEM 执行，SYSTEM 必须能读取 Node、依赖、源库和 `.env`，并写入备份目录；用户映射盘或仅对登录用户可见的网络路径不适合作为默认部署路径。

## 先本地校验，再上传

以下命令都从 `backend/` 执行，前提是已安装与运行后端兼容的 Node 22+ 和后端依赖，且源数据库已存在。

```powershell
# 只显示用法；不读取 .env，不打开数据库。
npm run backup:database -- --help

# 真实读取配置中的源库并生成本地快照，不访问 OSS，不需要 OSS 配置。
npm run backup:database -- --local-only
if ($LASTEXITCODE -ne 0) { throw "Local snapshot verification failed" }

# 可选：明确使用另一个环境文件；该文件路径相对当前工作目录，文件内 DB_FILE/BACKUP_DIR 仍相对 backend/。
# 已有进程环境变量优先于文件，使用前核对继承的 DB_FILE 与 BACKUP_*。
# npm run backup:database -- --local-only --config "D:\private-config\database-backup.env"

# 默认模式：重新生成快照、校验、上传，并在确认成功后执行本地成功备份保留策略。
npm run backup:database
if ($LASTEXITCODE -ne 0) { throw "Database backup upload failed" }
```

检查命令输出的作业目录，确认 gzip 与 manifest 存在；上传模式还应生成 `uploaded.json`。在 OSS 控制台检查该作业的归档和 manifest、对象私有状态与生命周期规则。`--local-only` 不代表云端备份成功，不写 `uploaded.json`，也不会清理旧备份。下一次上传会创建新作业，不复用上次本地演练目录。

## Windows 定时任务

在管理员 PowerShell 中，从仓库根执行安装。安装器固定执行数据库备份 CLI，默认任务名为 `YuyukoFoodMapDatabaseBackup`，默认每 6 小时运行；可用 `-IntervalHours` 设置 1 到 168 小时。首次计划执行在安装一个间隔后，之后跨日连续重复；重装会重置时间。安装器不读取 `.env`、不执行备份、不立即启动任务。

```powershell
Set-Location "D:\Learning\yUYUko_food_MAP"
# 可先预览；-WhatIf 不写计划任务，也不需要管理员权限。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\script\install-database-backup-task.ps1" -WhatIf

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\script\install-database-backup-task.ps1"

# 可选：指定间隔、Node 绝对路径、后端目录与任务名。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\script\install-database-backup-task.ps1" `
    -IntervalHours 6 `
    -NodePath "C:\Program Files\nodejs\node.exe" `
    -BackendDir "D:\Learning\yUYUko_food_MAP\backend" `
    -TaskName "YuyukoFoodMapDatabaseBackup"

# 查询配置、手工启动一次，再查看最近执行状态；TaskName 需与安装时一致。
Get-ScheduledTask -TaskName "YuyukoFoodMapDatabaseBackup"
Start-ScheduledTask -TaskName "YuyukoFoodMapDatabaseBackup"
Get-ScheduledTaskInfo -TaskName "YuyukoFoodMapDatabaseBackup" |
    Select-Object LastRunTime, LastTaskResult, NextRunTime

# 卸载任务不删除现有本地或远端备份。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\script\install-database-backup-task.ps1" `
    -TaskName "YuyukoFoodMapDatabaseBackup" -Uninstall
```

任务无需用户登录，以 SYSTEM 执行，错过执行时间会补跑；计划任务忽略重叠启动，失败后每 5 分钟重试、最多 3 次，单次运行最多 30 分钟。脚本还通过备份目录中的专用 SQLite 控制文件互斥，防止手工命令与计划任务同时备份；锁只作用于控制文件，不锁业务库，进程退出或崩溃会自动释放。不要删除正在使用的控制文件来强行解锁。

安装后确认手工任务运行确实完成，`LastTaskResult=0` 仅对应最近一次任务进程成功；仍需同时检查对应作业的 `uploaded.json` 和远端 manifest。安装任务本身不等于已有一次有效云端备份。

## 失败处理与磁盘维护

快照校验失败或上传、HEAD 校验失败时，命令返回非零；上传失败会保留本次本地快照，不清理旧的成功备份。若已上传归档而 manifest 未完成，远端可能留下不完整作业，按完成标记判断，不将其纳入可恢复清单。

先核对报错阶段、源库路径、磁盘空间、SYSTEM 目录权限、地域/endpoint、网络和 RAM 前缀权限；密钥或 token 过期时更新 `backend/.env` 再运行。任务重试和下次定时运行会创建新作业。不要在故障处理中改用图片 OSS 凭证。

备份 CLI 复用后端结构化日志并在退出前 flush，记录 `database.backup.completed`、`database.backup.failed` 与 `database.backup.retention_failed`；默认日志位于 `backend/logs/`，遵循 `LOG_DIR`、`LOG_TO_FILE`、级别与保留设置。配置文件尚未成功读取时，失败日志使用进程继承的日志设置或默认目录。无人值守部署保留 `LOG_TO_FILE=true`，确保 SYSTEM 可写日志目录；`--help` 不创建日志或备份。

本地策略仅在成功上传后保留最近 `BACKUP_LOCAL_KEEP` 份成功备份；失败、被中断及 `--local-only` 作业不会自动删除，可能持续占用磁盘。定期查看 `BACKUP_DIR` 的占用和未完成作业，确认没有活跃备份后再人工处理；删前至少确认另有经过校验的完整恢复点。远端对象按控制台生命周期过期，脚本不负责补偿删除。

## 隔离恢复演练

1. 从 OSS 控制台选择同一作业的 `.sqlite.gz` 与 `.manifest.json`，下载到新的隔离目录，分别命名为 `snapshot.sqlite.gz`、`manifest.json`。保留原始下载文件，不覆盖工作库。
2. 用 `Get-FileHash -Algorithm SHA256` 计算压缩归档摘要，与 manifest 的 `archiveSha256` 完整比对，并用 `archiveBytes` 核对压缩文件字节数；不一致立即停止。解压后还要核对 `sqliteSha256` 与 `sqliteBytes`。
3. 使用下面的流式解压示例得到隔离目录中的 `restored.sqlite`，不要解压到正在使用的数据库路径。
4. 从已安装依赖的 `backend/` 执行只读校验，使用与备份兼容的 Node、`better-sqlite3` 和 `sqlite-vec` 版本。数据库能打开不代表应用层恢复成功；还要用隔离应用与独立测试配置验证账号、地点、评分、日记和向量。

```powershell
# 将此路径替换为上述下载目录；目录中只有待演练的文件。
$restoreDir = "D:\isolated-food-map-restore"
$archive = Join-Path $restoreDir "snapshot.sqlite.gz"
$manifest = Get-Content -LiteralPath (Join-Path $restoreDir "manifest.json") -Raw | ConvertFrom-Json
if ($manifest.formatVersion -ne 1) { throw "Unsupported manifest version" }
$archiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($archiveHash -ne $manifest.archiveSha256 -or (Get-Item -LiteralPath $archive).Length -ne [long]$manifest.archiveBytes) {
    throw "Archive SHA256 or size mismatch"
}

Add-Type -AssemblyName System.IO.Compression
$output = Join-Path $restoreDir "restored.sqlite"
$inputStream = [IO.File]::OpenRead($archive)
try {
    $gzipStream = New-Object IO.Compression.GzipStream($inputStream, [IO.Compression.CompressionMode]::Decompress)
    try {
        $outputStream = [IO.File]::Open($output, [IO.FileMode]::CreateNew)
        try { $gzipStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $gzipStream.Dispose() }
} finally { $inputStream.Dispose() }

$sqliteHash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
if ($sqliteHash -ne $manifest.sqliteSha256 -or (Get-Item -LiteralPath $output).Length -ne [long]$manifest.sqliteBytes) {
    throw "SQLite SHA256 or size mismatch"
}

Set-Location "D:\Learning\yUYUko_food_MAP\backend"
@'
const Database = require('better-sqlite3');
const vec = require('sqlite-vec');
const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
try {
    vec.load(db);
    const result = db.pragma('quick_check');
    if (result.length !== 1 || result[0].quick_check !== 'ok') {
        throw new Error(JSON.stringify(result));
    }
    console.log('quick_check: ok');
} finally {
    db.close();
}
'@ | node - $output
if ($LASTEXITCODE -ne 0) { throw "Restored SQLite verification failed" }
```

应用演练必须使用隔离副本与独立环境，禁用 QQ Bot、通知、向量自动回填等外部 worker，避免连接生产 Redis 或发送外部请求。核对关键表行数和已知样本：账号及权限、地点和图片引用、评分与配额、日记草稿与公开内容、向量表可读且相关查询能执行。记录备份作业、SHA256、扩展/代码版本和演练结果；演练不是正式覆盖授权。

## 正式恢复顺序

正式恢复需要维护窗口；先完成上面的隔离校验与业务演练，再执行切换：

1. 禁用数据库备份计划任务；禁用 watchdog 计划任务并停止正在运行的 watchdog，再停止所有 Node 后端、Bot、回填和手工维护进程，确认没有写库者。仅停止后端进程会被 watchdog 自动拉起。
2. 原样保留当前数据库及同目录的 `-wal`、`-shm` 文件和相关配置作为回退点，不在其上直接解压或覆盖。保存旧数据库路径与文件权限。
3. 将已校验的恢复库放入新的干净目录，确保目标旁没有旧的同名 WAL/SHM。更新 `backend/.env` 的 `DB_FILE` 指向该新库；若使用绝对路径，以 Node 与 SYSTEM 都可访问的位置为准。不要把旧 WAL/SHM 复制到恢复库旁，避免旧 WAL 重放破坏恢复点。
4. 使用与备份兼容的代码和扩展启动后端，检查启动迁移与关键业务数据；旧代码可能不认识新 schema，新代码可能执行迁移，需提前在演练副本验证。
5. 验证账号、地点、评分、日记、向量和外部图片访问后，再恢复 watchdog、worker 与备份计划任务，并创建一次新的完整云端备份。异常时停止所有写入，再按保留的原库及配套文件执行回退。

不要把生产 `DB_FILE` 指向演练过程中被应用写过的临时库；正式切换使用重新校验的恢复副本。此仓库不提供自动覆盖生产数据库的恢复脚本。

## 自动化验证

从 `backend/` 运行 `npm run test:backup`，使用临时 SQLite 和注入的 OSS 替身验证在线快照、校验、压缩、上传确认、失败保留、本地保留与路径等行为；Windows 安装器另有静态/隔离验证。测试不读取真实 `.env`，不连接工作库，不访问真实 OSS，不安装真实计划任务。

结构和相对链接检查入口为 `npm run test:structure`。真实 IAM/endpoint、对象 ACL、控制台生命周期、SYSTEM 执行权限以及完整业务恢复演练仍需在部署环境验证。
