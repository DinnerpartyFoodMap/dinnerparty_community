# 许可说明

东方饭联地图（dinnerparty）的源代码以 **GNU Affero 通用公共许可证第 3 版**发布，仅限该版本（SPDX：`AGPL-3.0-only`），全文见 [LICENSE](LICENSE)。

Copyright (C) 2026 dinnerparty 核心开发者（bl3x3、Chenan-LightFox、lofur）及各位贡献者

## 使用本项目

- 你可以按 AGPL-3.0-only 使用、修改、再分发本项目的代码。
- 如果你修改了本项目，并把修改版作为网络服务提供给他人（例如自己部署一个修改过的站点），AGPL 第 13 条要求你向这些用户提供修改版的完整源代码。
- 自行部署时，请把 `frontend/.env.*` 中的备案号、域名、高德 / CARTO key 换成你自己的。这些 key 只授权官方站点使用。
- AGPL 不授予项目名称和标识的使用权。分发修改版时，请不要让人误以为它是官方版本。

## 版权与另行授权

- 代码的著作权归各自作者所有。核心开发者之间按 [CORE_DEVELOPERS.md](CORE_DEVELOPERS.md) 相互授权；外部贡献者按 [CLA.md](CLA.md) 授权给核心开发者。
- 因此，核心开发者除了按 AGPL 发布之外，还可以按其他条款分发本项目。例如在 App Store、Google Play 等平台发布官方应用（这些平台的条款与 AGPL 冲突），或在全体核心开发者同意后向第三方提供其他授权。具体规则见 CORE_DEVELOPERS.md。
- 这些安排不影响任何人按 AGPL-3.0-only 获得的权利。

## 不适用 AGPL 的内容

AGPL 只覆盖本仓库中由项目作者编写的源代码和文档。下列内容不在 AGPL 授权范围内，版权归各自的权利人；未经权利人许可，请勿在本项目之外使用。

| 内容 | 说明 |
|---|---|
| 图片、图标、启动图等美术素材，包括 `frontend/src/img/`、`frontend/public/favicon.*`、`frontend/android/app/src/main/res/`、`frontend/ios/App/App/Assets.xcassets/` 下的图片 | 涉及东方Project 角色的形象，版权归上海爱丽丝幻乐团（ZUN）及各自的绘制者 |
| `frontend/src/img/qrcode.png` | 东方饭联 QQ 群二维码，仅供本项目使用 |
| `frontend/public/ghs.png` | 公安机关互联网站安全备案图标 |
| `frontend/public/fonts/material-symbols-outlined.woff2` | Google Material Symbols，Apache License 2.0 |
| 第三方依赖（`package.json` 中声明、安装到 `node_modules/` 的包） | 遵循各自的许可证 |
| 高德地图、CARTO 等在线服务 | 使用时须遵守各服务的条款 |
