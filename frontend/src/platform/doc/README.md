# 平台能力与原生协议

业务通过本目录访问配置、导航/返回、凭证、定位、媒体、分享、生命周期、本机草稿和原生桥接；index.js 是能力导出入口，允许现有消费者直接导入单项文件。nativeMapChrome/nativeSettings 是 JS 会话，Swift 实现在 ios 工程；nativeShell 负责启动与深链。

```mermaid
flowchart TD
    Call[业务调用能力] --> Env[读取平台与运行配置]
    Env --> Kind{Web / 原生可用能力?}
    Kind -->|Web| Browser[浏览器实现 / 受控不可用提示]
    Kind -->|原生| Plugin[Capacitor 或自定义 plugin]
    Plugin --> Sanitize[动作 / 字段 / URL / 请求 ID 白名单]
    Sanitize --> Request[发送带会话和请求关联的状态]
    Request --> Event[原生事件回调]
    Event --> Valid{会话有效且请求仍匹配?}
    Valid -->|否| Drop[忽略迟到或不受支持结果]
    Valid -->|是| Business[Web 执行账号或业务请求并回送结果]
    Missing[协议或 plugin 不可用] --> Fallback[使用现有网页降级路径]
    Lifecycle[前后台 / 返回 / 深链] --> Dispatch[统一优先级与订阅清理]
```

| 当前方案 | 对照与边界 |
| --- | --- |
| 平台差异收口 | 各业务自行判断 UA 会扩散不一致；当前仍保留认证特有 XHR 兼容路径 |
| JS 执行业务，原生请求动作 | 不把凭证和任意 URL 操作权交给原生面板输出；字段清洗与会话 ID 都需保留 |
| WGS84/GCJ-02 单点转换 | 坐标转换不是按“是否中国境内”的粗矩形猜测，沿用 chinaRegion 与对应测试 |
| 缺能力降级 | 能力不可用不等于业务数据无效；不要改为静默成功 |

已有 test:platform / test:native-chrome（含设置），真机另看 [原生文档](../../../native/doc/README.md)。案例见 [TEST_CASES.md](TEST_CASES.md)，待办 PLT-01 / PLT-02 见 [清单](../../../doc/HISTORY_AND_TODO.md)。
