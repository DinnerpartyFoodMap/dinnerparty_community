# 角色观察屋

点击地图头像进入「我的主页」，在「调整小组件」下方点「角色观察屋」，打开 `/settings/companions`。观察屋返回个人主页。「开启角色观察屋」默认开启，保存到账号 `map_settings.companion_enabled`。关闭后隐藏房间里的角色及地图底栏角色，打卡自动投喂仍记入原角色的饱食度。只想隐藏底栏角色时，可在个性化地图关闭 `companion_roaming`。`useCompanion.js` 同步账号的当前角色、饱食度与已拥有的角色。打卡成功通知 WebView 刷新状态，饱食度变化触发爱心反馈。手机底栏上方的角色不截取地图触摸。

## 内置火柴人和 Live2D

默认火柴人的 Cubism 模型、纹理和动作在 `frontend/public/companions/stick-figure/`，随 Web 和 Capacitor 安装包发布。角色包公开入库，默认角色不涉及授予下载权限。火柴人由 [原创分层线稿](../art/stick-figure.psd) 经 [PSD2Live 3.8.2](https://github.com/tsunehimatoi/psd2live/releases/tag/v3.8.2) 导出。地图和底栏就绪后，`live2dScene.js` 按实际显示尺寸用 PixiJS 加载 Cubism。内置火柴人首次出图通过颜色检查后才替换彩色线稿。模型加载失败、首帧异常或 WebGL 上下文丢失时会显示线稿，上下文恢复时重新加载。

`npm run build` 和 `npm run build:mobile` 在构建前从 Live2D 官方地址准备 Cubism Core。生成的供应商运行时位于 `src/companion/runtime/`，由 Git 忽略并在构建时一起打包。已准备过 Core 的构建可以离线运行。开发时可先执行 `node scripts/prepare-live2d-core.mjs` 再启动 Vite。发版时按 [Live2D SDK 发布许可](https://www.live2d.com/en/sdk/license/) 核对项目适用的条款。

## 底栏飞行

底栏角色由 `CompanionRoam.jsx` 渲染，飞行逻辑在 `companionFlight.js`。
- 左右走仍用 CSS 动画。
- 在 iOS 原生控件里上拉「更多功能」时，手指一动角色就起飞：先飞到展开高度再加 40px（拖动时工具栏最多被拉过这么多），松手展开后落到工具栏上沿悬停。从展开状态往下拖时原地等着，收起后落回原位继续走。抽屉状态来自原生布局的 `drawer`（见 [平台文档](../../platform/doc/README.md)），旧版 App 不带这一项，角色不飞。
- 窄屏 App 展开搜索时，小伙伴先站在输入框上。结果列表出现后才飞到列表上沿，随列表高度移动。
- 起飞会冲过一点再回到位置，身体先拉长；落下越落越快，着地时压扁再弹回；在空中悬停时上下浮动。地面影子随高度变小变淡。Live2D 在空中抬头、略向后仰（`live2dScene.js` 的 `MOODS`，叠加在待机动作上）。内置火柴人只对头身角度、前倾、比例和呼吸做了形变；手臂、嘴、眉毛、眼珠的参数存在，但不会改变画面。想要举手、张嘴，需要在原稿里补这些形变后重新导出。
- 减弱动态效果时不飞，而是淡出后在新位置淡入。

所有位移都用 Web Animations 改 transform，不写 style 或 class。原因是 iOS 原生底图会监听整页属性的变化，重新采样触摸区域（`map/nativeMapView.js`），每帧写属性会让它反复全屏采样。暂停和继续行走也通过动画对象控制，不切换 class。测试：`npm run test:companion`。

## 额外角色

网页观察屋和主题皮肤页共用兑换表单，角色和皮肤都按账号持有。选择已拥有的额外角色时获取版本和临时下载授权。资源格式和部署目录见 [皮肤与角色兑换](../../../../backend/modules/skins/doc/README.md#远程资源包)。

窄屏网页把活动区域放在搜索栏上方，应用内角色沿用底栏位置。验收覆盖无外部资源服务时显示默认火柴人、退出登录或更换账号时不沿用他人角色、同一账号换设备显示已拥有内容、地图开关关闭后观察屋仍可用，以及 iPhone 与 Android 底栏上的活动和投喂反馈。
