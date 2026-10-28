# App 更新检查与安装包下载

App（Android / iOS）启动时请求 `GET /api/app/release`，拿自己的构建号（Android `versionCode`、iOS `CFBundleVersion`）与服务器写的 `build` 比较，小于它就弹窗显示版本号与更新说明，点“去更新”打开公开网站的 `/home` 下载页。网页端不检查。

发版信息只放在服务器上：`backend/app-release/release.json`（目录可用 `APP_RELEASE_DIR` 改），格式见同目录的 `release.example.json`。改了即时生效，不用重启。

| 字段 | 说明 |
| --- | --- |
| `android.build` / `ios.build` | 最新构建号（正整数）；缺省时客户端不提示 |
| `version` | 展示用版本号 |
| `notes` | 更新说明，按原样分行显示 |
| `android.file` | 同目录里的 `.apk` 文件名（只能是文件名）；`GET /api/app/android/latest.apk` 下载它 |
| `ios.url` | TestFlight / App Store 链接（https），缺省为当前 TestFlight 邀请链接 |

`/home` 下载页（`frontend/home/`）用同一接口决定安卓按钮是否可点。安装包与 `release.json` 被 `.gitignore` 排除，只在服务器本地。
