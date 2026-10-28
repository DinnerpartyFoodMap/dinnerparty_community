# iOS 聚合点液态玻璃验证（2026-10-28）

环境：Windows / Node.js v24.19.0 / Edge 无头浏览器。原生运行要求 iOS 26+；Windows 未执行 Xcode 编译、签名或真机玻璃渲染。

| 实际执行 | 结果与覆盖 |
| --- | --- |
| `npm --prefix frontend test` | 退出 0；前端全量现有测试及新聚合点会话/几何采样测试通过 |
| `npm --prefix frontend run test:native-clusters-browser` | 退出 0；18 项浏览器断言，84 帧，最多 1 个在途帧；真实控制器、Supercluster、DOM 和 Web Animations，只替换高德与 WebKit 原生边界 |
| `npm --prefix frontend run build:mobile` | 退出 0；移动产物生成成功；保留既有 ActionSheet 动静态导入及大包提示 |
| `npx cap copy ios`（frontend） | 退出 0；更新 App 内置网页资源；64 个产物逐文件 SHA-256 与 dist 一致 |
| `node frontend/scripts/patch-native-projects.mjs ios` | 新 Swift 文件进入 Xcode 编译源；再次执行无改动 |
| 最后一次 `test:structure` / `test:i18n` | 退出 0；253 个源码、1070 个相对导入；2190 个翻译键、2768 个调用点 |
| 独立只读代码检查 | 已修正握手超时后迟到的会话清理，以及网页前景控件的遮挡；复查无剩余可操作问题 |

浏览器案例包括初始接管、聚合拆分与源残影、合并旅行节点、手势中断、页面切换、公告/定位点/搜索结果/展会入口/声明控件的遮挡、网页浮层、列表覆盖、玻璃开关、原生拒绝、桥接背压、销毁回收。

新增测试先运行暴露缺失实现；迟到握手回归先失败再修复。浏览器执行器最初使用虚拟时间，造成 JS 超时先于 compositor 动画推进；改用 CDP 真实时钟后验证真实动画。原生工程补丁首次因 Windows CRLF 锚点失败，兼容 CRLF 后执行及重复执行通过。

当前目录存在其他并行改动，本任务未修改后端或其他原生表单逻辑。真机检查步骤见 [原生聚合点案例](../native/doc/README.md)。
