# 参与贡献

欢迎提交 issue 和 Pull Request。

## 贡献者许可协议（CLA）

- 外部贡献者在第一个 PR 合并前需要签署 [CLA](CLA.md)。提交 PR 后 CLA Assistant 会自动留言，按提示在 PR 中回复一句话即可签署，之后的 PR 不需要再签。
- 需要 CLA 的原因：本项目以 AGPL-3.0-only 开源，而官方应用还要在 App Store 等平台发布，这些平台的条款与 AGPL 不兼容。CLA 让核心开发者能把包含你贡献的代码用于这些渠道，同时承诺包含你贡献的公开版本始终以开源许可证提供。
- [核心开发者](CORE_DEVELOPERS.md)不需要签署。

## 提交前

- 不要提交密钥、口令、数据库或用户数据。本地配置写在被 Git 忽略的 `backend/.env` 中；`frontend/.env.local` 等已跟踪的文件里只能放浏览器端本来就公开的 key。
- 界面文案写在 `frontend/src/i18n/locales/zh-CN/` 中，不要在组件里硬编码中文。
- 运行相关测试：前端 `cd frontend && npm test`，后端 `cd backend && npm test`。
- 引入第三方代码或素材时，在 PR 中写明来源和许可证。
