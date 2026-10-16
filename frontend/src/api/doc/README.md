# HTTP 客户端契约

client.js 是旧 map/api.js，导出地点、nearby、关键词/AI、随机、顺路、当前用户/定位、聚餐、收藏、分类和评分请求。调用签名、响应和错误处理保持原样；该文件还不是全站统一网络层，认证、日记和设置仍有各自请求。

```mermaid
flowchart LR
    Caller[业务传入 URL/token/参数/signal] --> Params[编码路径与查询 / JSON body]
    Params --> Fetch[fetch 与请求选项]
    Fetch --> Status{HTTP 成功?}
    Status -->|是| Shape[按端点解析既有响应]
    Status -->|否| Failure[端点特有错误解析与抛出]
    Shape --> Consumer[消费者决定缓存 / key / 可见状态]
    Failure --> Consumer
```

采用函数封装维持原调用契约，对照本轮新引入请求库，可避免同时改变取消、错误与账号隔离语义。当前端点分组尚未拆分，后续 API-01 按领域拆后再考虑共用 transport，不先写吞掉业务错误的统一 catch。

已有 test:rating 验证评分请求；后端 test:random 导入这里验证前端随机封装。其他端点覆盖依其业务集成，不宣称完整。下一步案例：API-C01 signal 与 token 正确传递；API-C02 非 JSON/空响应错误可解释；API-C03 不把 401/403、网络断线和 AI 503 混同。后两类有部分专属实现，但尚无全端点矩阵，见 [清单](../../../doc/HISTORY_AND_TODO.md)。
