# 原生工程与人工验证

frontend/ios 是 Xcode/Swift 工程，含原生地图 chrome、设置、键盘与 WebView 协调；frontend/android 是 Android/Capacitor 工程；native/ios 保存相关原生来源文件。它们本轮不搬迁，JS 入口与协议见 [platform](../../src/platform/doc/README.md)。

流程：Web/mobile 构建 → Capacitor sync 与仓库补丁 → 对应平台原生构建/签名 → 测试设备安装 → 权限/生命周期/键盘/桥接验证。此流程记录供维护，不表示本次执行了 sync、签名或发布。

采用 platform 适配加部分原生 UI，对照全平台各写一套业务，能复用数据规则；代价是必须同时维护桥接协议、项目文件和真机覆盖。新 Swift 文件需要 Xcode 项目引用，不能只新增源码；原生工程内路径属于构建系统，不随 JS 业务目录调整。

已有 [iOS 玻璃验收清单](ios-glass-checklist.md) 保留。另需真实设备验证账号恢复、相册/定位权限、系统返回、分享取消、App 前后台、原生设置关闭及协议降级；Node bridge 检查不能替代这些环节。本次范围与限制见 [验证记录](../../doc/VERIFICATION.md)。
