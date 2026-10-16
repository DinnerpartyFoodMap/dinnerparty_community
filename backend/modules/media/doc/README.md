# 图片存储

入口：`routes/upload.js`（`/upload`，认证由 index.js 挂载）、services/imageStorage.js、imageUrls.js。地点图片保存为公开 URL；账号头像、日记私图分别由 accounts / journeys 管理 BLOB，不经过本模块迁移。分享缩略图生成逻辑在 places/placeCard。

```mermaid
flowchart TD
    Upload[已认证 multipart 上传] --> Limit[multer 限制 20MB]
    Limit --> Sniff[sharp 按真实内容识别 jpg/png/webp/gif]
    Sniff --> Valid{格式有效?}
    Valid -->|否| Reject[拒绝 不按客户端扩展名放行]
    Valid -->|是| Privacy[prepareImage 清理 Exif/XMP/IPTC 等隐私信息]
    Privacy --> Orientation{需要方向纠正或重编码?}
    Orientation -->|是| Encode[解码并保存正确方向的图片]
    Orientation -->|否| Preserve[允许的 JPEG 路径保留像素编码]
    Encode --> Mode{IMAGE_STORAGE}
    Preserve --> Mode
    Mode -->|本地| Local[写 backend/uploads 唯一文件名]
    Mode -->|oss| OSS[写配置的 OSS_PREFIX]
    Local --> URL[返回本地或自有域名 URL]
    OSS --> URL
    Legacy[读取历史 uploads URL] --> Exists{本地存在?}
    Exists -->|是| Static[immutable 静态响应]
    Exists -->|否| Redirect[OSS 模式且路径安全时 302]
```

| 选择 | 当前实现 | 对照与约束 |
| --- | --- | --- |
| 格式判断 | 内容嗅探，不信任文件名 | 仅扩展名检查不能保证浏览器可显示 |
| 隐私与质量 | 能移除段信息时不重编码，需转向时重编码 | 全部压缩会重复损失画质；全部原样保存会带出元数据 |
| 存储 | local/OSS 适配、自有域名与限定前缀 | 直接把厂商默认域名写库会绑定部署地址；共享 bucket 不能越过本站前缀 |
| 历史迁移 | 预演、备份、显式 apply、幂等 | 启动时自动重写历史数据不便审核与回滚 |

维护命令见 [运维目录](../../../scripts/doc/README.md)，案例见 [TEST_CASES.md](TEST_CASES.md)。历史 `2eadd01`、`d285076`；待办 MED-01 见 [清单](../../../doc/HISTORY_AND_TODO.md)。
