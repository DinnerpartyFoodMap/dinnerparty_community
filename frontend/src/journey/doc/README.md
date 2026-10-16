# 日记与同好工作区

JourneyWorkspace 维护单个 overlay 内页面栈；EntrySheet 提供图文生成/日历/同好；Composer 与 useComposeDraft 处理素材；Generation 管理任务；Review 与 useJourneyDraft 编辑草稿；Resolution/地图选择解决位置；Detail/PublicJourneyView/PlaceDiaryList 展示私有与公开；Share/cover 生成分享；Community 与 feedback 处理同好及同意反馈。

```mermaid
flowchart TD
    Entry[入口 sheet] --> Mode{图文 / 日历 / 同好}
    Mode -->|图文| Compose[本机素材 + 服务端素材草稿]
    Compose --> Sync[上传照片与版本同步]
    Sync --> Job[提交生成任务 可离开再恢复]
    Job --> Review[审阅草稿与候选地点]
    Mode -->|日历| Calendar[日期 / 既有日记 / 未完成内容]
    Calendar --> Review
    Review --> Local[本机备份 + 带 revision 自动保存]
    Local --> Resolve[手动选点或位置澄清补丁]
    Resolve --> Preview[选择私密或公开并预览地图操作]
    Preview --> Commit[request_id + preview_hash 提交]
    Commit --> Saved[确认保存状态后显示详情]
    Commit --> Unknown[确认丢失时保留相同请求供重试]
    Saved --> Public[公开读取只走 publication 接口]
    Leave[返回或离开] --> Protect[未同步则保护 / 等待 / 明确选择]
    Mode -->|同好| Consent[同意设置 → 兼容画像 → 同好/公开收藏]
```

| 选择 | 对照与约束 |
| --- | --- |
| 页面栈内保留下层挂载 | 简单切页销毁会丢编辑状态；active 决定副作用和交互 |
| 本机与服务端草稿协作 | 仅本机易跨设备丢失，仅服务端无法在离线编辑时保护数据；需账号隔离 |
| 公开预览与确认提交分开 | 私有编辑不能自动改公开内容，费用/私图不能进入公开快照 |
| 位置 basis 补丁 | 整文替换会覆盖澄清等待期间备注和费用 |

案例见 [TEST_CASES.md](TEST_CASES.md)；已有 test:journey-text、后端日记测试与完整浏览器 harness。历史 `01e11a4`、`cc11a4f`；待办 JRN-F01 及已记录的 UI 稳定性问题见 [清单](../../../doc/HISTORY_AND_TODO.md)。
