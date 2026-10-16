# 工具与测试支持

- patch-native-projects.mjs：Capacitor 生成/同步后的原生工程补丁，现有 npm cap:* 入口保留；本轮不执行。
- ci/ios-manual-signing.mjs：CI 签名项目修改工具，路径与参数入口保留；本轮不执行。
- support/json-modules.mjs、json-hooks.mjs：Node 测试加载前端 JSON；后端测试仍使用此稳定入口，不因测试文件移动而迁走。
- legacy/checkConfirm.js、cleanTip.js、fixTips.js：旧的一次性源码替换工具，部分目标已不存在；只归档，不纳入 npm test，不作为当前批量修复方式。确需复用应先在临时副本检查匹配范围与 diff。

现有逻辑测试迁入 tests/unit，业务可读案例跟随 src 对应模块/doc；入口映射见 [迁移表](../../doc/MIGRATION_MAP.md)。新增工具先说明输入、写入范围与恢复方式，不在测试命令中隐式执行原生工程或源码改写。
