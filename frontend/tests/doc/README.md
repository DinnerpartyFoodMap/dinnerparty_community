# 测试导航

unit 按 platform/map/overlay/places/journey/i18n/structure 分组，integration 保存真实浏览器加载的 React harness。原 npm 测试名保持不变；HTML harness 地址已和 backend/tests 同步更新。

执行 [AI 测试协议](../../doc/TESTING.md) 区分逻辑、浏览器、真机覆盖。不要把构建成功当交互通过，也不要把测试目录搬迁当新增覆盖。

`npm run test:native-clusters-browser` 启动临时 Vite/Chromium，运行 [聚合点浏览器案例](../integration/native-clusters-harness.js)：使用真实标记控制器、DOM、Supercluster 与 Web Animations，只替换高德和原生 WebKit 边界。检查合并拆分与中断、前景遮挡、页面/浮层切换、关闭玻璃和故障回退；不证明 SwiftUI 已编译或真机帧率。Windows 默认 Edge；其他 Chromium 可通过 `CHROME_BIN` 指定。
