# App 更新检查与安装包下载

App（Android / iOS）启动时请求 `GET /api/app/release`，拿自己的构建号（Android `versionCode`、iOS `CFBundleVersion`）与服务器写的 `build` 比较，小于它就弹窗显示版本号与更新说明，点“去更新”打开公开网站的 `/home` 下载页。网页端不检查。

发版信息只放在服务器上：`backend/app-release/release.json`（目录可用 `APP_RELEASE_DIR` 改），格式见同目录的 `release.example.json`。改了即时生效，不用重启。

| 字段 | 说明 |
| --- | --- |
| `android.build` / `ios.build` | 最新构建号（正整数）；缺省时客户端不提示 |
| `version` | 展示用版本号 |
| `notes` | 更新说明，按原样分行显示 |
| `android.file` | 同目录里的 `.apk` 文件名（只能是文件名）；`GET /api/app/android/latest.apk` 跳到它 |
| `ios.url` | TestFlight / App Store 链接（https），缺省为当前 TestFlight 邀请链接 |

`/home` 下载页（`frontend/home/`）用同一接口决定安卓按钮是否可点。安装包与 `release.json` 被 `.gitignore` 排除，只在服务器本地。

安卓下载走 CDN 缓存：`GET /api/app/android/latest.apk` 用 302 跳到当前版本自己的地址 `GET /api/app/android/<文件名>`（相对地址，经 `/backend` 前缀转发时也对），跳转本身 `no-cache`，发版后立即指向新包；带文件名的地址回 `public, max-age=31536000, immutable`，ESA 与浏览器长期缓存，支持断点续传。所以**每次发版的文件名必须不同**（沿用 `dinnerparty-<版本>-<构建号>.apk`），同名文件换内容时 CDN 会继续给旧包，只能去 ESA 手动刷新。旧版文件可以留在目录里，已经发出去的地址仍能下载。下载页和旧版 App 都只用 `latest.apk`，不用改。ESA 规则见 [CDN 缓存](../../../doc/CDN_CACHE.md)。测试：`npm run test:app-release`。
