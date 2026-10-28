# 工具与测试支持

- patch-native-projects.mjs：Capacitor 生成/同步后的原生工程补丁，现有 npm cap:* 入口保留；本轮不执行。
- ci/ios-manual-signing.mjs：CI 签名项目修改工具，路径与参数入口保留；本轮不执行。
- support/json-modules.mjs、json-hooks.mjs：Node 测试加载前端 JSON；后端测试仍使用此稳定入口，不因测试文件移动而迁走。
- testing/test-native-clusters-browser.mjs：聚合点真实网页动画回归。读取本项目源码，启动临时 Vite 和独立的无头 Chromium 配置目录，通过 CDP 的真实时钟等待动画；`CHROME_BIN` 可指定浏览器。只在系统临时目录写入浏览器配置和诊断 HTML，不修改项目源码；退出时关闭本次启动的服务与浏览器。
- legacy/checkConfirm.js、cleanTip.js、fixTips.js：旧的一次性源码替换工具，部分目标已不存在；只归档，不纳入 npm test，不作为当前批量修复方式。确需复用应先在临时副本检查匹配范围与 diff。

现有逻辑测试迁入 tests/unit，业务可读案例跟随 src 对应模块/doc；入口映射见 [迁移表](../../doc/MIGRATION_MAP.md)。新增工具先说明输入、写入范围与恢复方式，不在测试命令中隐式执行原生工程或源码改写。
