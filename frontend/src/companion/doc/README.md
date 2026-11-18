# 角色观察屋

地图账号菜单打开 `/settings/companions`。`useCompanion.js` 同步账号的当前角色、饱食度与已拥有的角色。打卡成功通知 WebView 刷新状态，饱食度变化触发爱心反馈。手机底栏上方的角色不截取地图触摸。个性化地图可关闭底栏显示，观察屋入口继续可用。

## 内置火柴人和 Live2D

默认火柴人的 Cubism 模型、纹理和动作在 `frontend/public/companions/stick-figure/`，随 Web 和 Capacitor 安装包发布。角色包公开入库，默认角色不涉及授予下载权限。火柴人由 [原创分层线稿](../art/stick-figure.psd) 经 [PSD2Live 3.8.2](https://github.com/tsunehimatoi/psd2live/releases/tag/v3.8.2) 导出。`live2dScene.js` 通过 PixiJS 加载 Cubism；模型或 WebGL 无法初始化时显示同一角色的线稿。

`npm run build` 和 `npm run build:mobile` 在构建前从 Live2D 官方地址准备 Cubism Core。生成的供应商运行时位于 `src/companion/runtime/`，由 Git 忽略并在构建时一起打包。已准备过 Core 的构建可以离线运行。开发时可先执行 `node scripts/prepare-live2d-core.mjs` 再启动 Vite。发版时按 [Live2D SDK 发布许可](https://www.live2d.com/en/sdk/license/) 核对项目适用的条款。

## 额外角色

网页观察屋和主题皮肤页共用兑换表单，角色和皮肤都按账号持有。选择已拥有的额外角色时获取版本和临时下载授权。资源格式和部署目录见 [皮肤与角色兑换](../../../../backend/modules/skins/doc/README.md#远程资源包)。

验收覆盖无外部资源服务时显示默认火柴人、退出登录或更换账号时不沿用他人角色、同一账号换设备显示已拥有内容、地图开关关闭后观察屋仍可用，以及 iPhone 与 Android 底栏上的活动和投喂反馈。
