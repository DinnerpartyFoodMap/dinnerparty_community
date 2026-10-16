# 日记文字测试案例库

遵循 [执行协议](../../../doc/TESTING.md)。使用临时库、假模型/地图边界，保留真实服务与事务。已有入口：test:journeys、test:journey-resolution、test:journey-publication、test:journey-ui。

2026-10-16 起，公开测试在私有算法 API 边界使用独立协议桩，算法内部断言移入私有服务。`test:journey-algorithms` 覆盖传输、回调、生命周期和配置工具；可选的 `test:journey-private-service` 通过真实服务验证完整链路，见 [接入说明](ALGORITHM_SERVICE.md)。

### JRN-C01 归属与修订

前置：A 拥有素材、照片、日记，B 是另一用户。操作：B 读写 A 的 ID；A 用旧 base_revision 覆盖新修订。预期：访问或并发冲突被拒，没有越权照片与部分更新。已有自动化 test:journeys。

### JRN-C02 素材生成与任务持久化

前置：同步过的 compose draft、确定的合成模型响应。操作：生成两次同请求、取消任务、重启 worker；改变文本模型视觉开关。预期：幂等请求不重复任务，取消不会回写已失效草稿；生成阶段不公开也不创地点；文本模型不接收图片。已有自动化 test:journeys / test:journey-ui；异常进程终止组合见 JRN-01。

### JRN-C03 澄清不覆盖用户编辑

前置：同名远近候选、已确认手动锚点、草稿有备注/照片/时间/花费。操作：发起澄清，等待时编辑非位置内容，再合并结果。预期：锚点影响排序；仅合并对应位置字段；保留等待期间编辑；撤回/重排停靠点导致 basis 不匹配时拒绝过期补丁。已有自动化 test:journey-resolution（同时比较前后端投影）。

### JRN-C04 原文与公开字段过滤

前置：原始文本中可定位的引句，私人备注、费用、计划未去站点、私图与允许公开图。操作：抽取再 map-preview。预期：引句有可核对来源；公开 body 仅含显式允许信息；计划站点与非公开媒体按规则过滤；不通过提示模型“注意隐私”替代确定性字段过滤。已有自动化 test:journeys / test:journey-publication。

### JRN-C05 过期预览与新重复地点

前置：可发布草稿和有效 preview_hash。操作：改草稿或地图候选后用旧 hash commit；预览后再添加附近同名地点。预期：409 preview_stale 或 duplicate_conflict；不留下日记公开快照、部分地点、评分、通知。已有自动化 test:journey-publication。

### JRN-C06 提交幂等与事务

前置：公开预览含 link 与 create，稳定 request_id。操作：同参数连续 commit；同 ID 换参数；模拟提交失败。预期：只创一次地点和 publication、评分与通知；重放返回既有结果；不同参数冲突；失败整体回滚。已有自动化 test:journey-publication；多入口全面故障注入见 PLC-01。

### JRN-C07 公开快照与撤回

前置：已公开日记，再保存私人编辑。操作：匿名读公开地址；撤回；重放最初成功 commit。预期：私有编辑不改变旧公开快照；撤回后公开日记/图不可读；晚到重试不重新激活已撤回内容。已有自动化 test:journey-publication。

### JRN-C08 浏览器完整流程（01e11a4）

前置：真实 React/Vite/API 与可控模型、地图边界。操作：入口 → 图文生成 → 审阅编辑 → 公开确认 → 打开日记 → 私有编辑/撤回，并检查窄屏。预期：同步提示和页面栈符合操作，公开与创建地点只发生在确认后；不横向溢出、无页面异常；最终检查 DB 副作用。已有自动化 test:journey-ui。

### JRN-C09 硬终止恢复（待自动化，JRN-01）

领取任务后终止子进程，重启 worker，覆盖模型迟到、用户取消及 revision 已前进三种情况。预期：任务可恢复或解释性失败，旧结果不会覆盖新草稿，通知与地点不重复；用可控子进程和临时库，不终止实际开发服务。

### JRN-C10 私有算法调用与竞争

操作：服务超时、返回畸形/超量结果；伪造回调凭据；合并或排序等待期间修改来源；生成期间取消任务；重试拆分前已有任务。预期：安全失败、不泄露上游正文，不持有数据库写锁，不落入过期结果；升级前任务仍可重放；前端审阅元信息不被校验过程丢弃。已有自动化 test:journey-algorithms / test:journey-publication。
