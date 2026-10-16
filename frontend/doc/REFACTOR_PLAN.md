# 前端模块化整理计划

日期：2026-10-15。Git 基线 `2bc8c5e`；工作区已有本会话完成的后端模块化改动，保留它们。

## 目标与边界

按用户已确认的方案完成目录和文档整理：保留 map、journey、platform、settings、admin、motion、i18n，归位根目录页面和业务组件，公共组件按职责分组。保持界面、路由、接口、主题、文案、动效和原生桥接协议不变。

本轮不重写大型组件的状态机。先用可复现测试稳定边界，后续提取 hooks/服务的具体工作列入带验收条件的待办。不增加依赖，不执行原生发布/同步或历史批量改源码脚本。

## 目标结构

- src/app：App 与应用装配。
- src/auth、dinners、poster：相应页面、业务组件与专用工具。
- src/places：地点表单、管理、评论、评分、图片与行为；src/discovery：搜索、随机、顺路面板与逻辑。
- src/map：MapView、MapUI、地图生命周期、卡片容器、聚合与底图。
- src/components/{primitives,forms,feedback,layout,data,overlay}：可跨业务复用的界面能力。
- src/api：现有 HTTP 客户端；src/theme：主题与深色模式；src/hooks：通用响应式 hook。
- tests/unit/<模块>：既有逻辑/桥接/国际化检查；tests/integration：既有浏览器 harness。
- scripts：保留构建/原生补丁和 JSON loader 的已有稳定入口；历史一次性工具归 legacy。
- 各业务/共用模块 doc 记录入口、流程与取舍；复杂模块拆文字案例库；历史、待办、迁移对照与验证集中在 frontend/doc。

## 执行与验收

1. [x] 记录原测试和构建基线，核对 Git 历史，生成迁移映射。
2. [x] 用语法树更新静态/动态导入、资源路径和测试文件引用；更新跨前后端测试 harness 入口。保留 lazy import 边界。
3. [x] 补模块文档、Mermaid 流程、架构与选型对照、历史修复和优化待办、AI 文字案例库。
4. [x] 增加静态路径/模块文档检查；运行 frontend npm test、网页与移动构建、backend npm test 和两个浏览器集成回归。
5. [x] 独立审查迁移目标、资源路径、测试与文档一致性，记录最终结果和覆盖限制；一处评分文档旧路径已修正。

## 重点风险

源码迁移要同时处理 import/export、import()、图片/CSS、测试的 src 路径字符串、i18n 数据白名单和 backend 的源码读取位置；测试迁移不能改变 JSON loader 的相对入口或项目根目录计算。原生 Swift/Android 工程与构建签名不属于本次移动范围，桥接的动作和字段不变。
