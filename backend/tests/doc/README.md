# 自动化测试导航

tests 的业务子目录对应 modules，同名分组之外的 infrastructure 负责跨模块事务与技术边界，helpers 只放测试替身。`test_*.js` 是离线测试发现约定，`*_ui.js` 单独进入浏览器测试组。

先读 [AI 执行协议与命令矩阵](../../doc/TESTING.md)。可读案例跟随模块 doc；自动化断言以本目录实际脚本为准。不要复制案例文本到测试 helpers，也不要在测试汇总中加入真实运维命令。
