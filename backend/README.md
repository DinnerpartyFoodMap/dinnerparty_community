# 后端维护入口

这是 Express + SQLite 的模块化单体。启动方式仍是 `cd backend && npm start`，所有 HTTP 地址、环境变量和数据文件位置保持原有约定。

日记算法通过独立私有 API 调用；前端、日记存储与发布事务留在此项目。配置及本机私有实现启动见 [日记算法服务接入](modules/journeys/doc/ALGORITHM_SERVICE.md)。未配置服务时仍可手动记录和保存日记。

## 目录与阅读顺序

```text
backend/
├── index.js                    # 装配、HTTP 启动、worker 生命周期
├── modules/<业务>/
│   ├── routes/                 # HTTP 入参、权限调用、响应
│   ├── services/               # 业务规则、查询、事务、任务
│   ├── middleware/             # 仅账号、管理模块需要
│   ├── runtime/                # 仅 QQ Bot：协议和交互运行时
│   └── doc/                    # 模块入口、流程、取舍、必要的案例库
├── infrastructure/             # SQLite、Redis、日志、AI、稳定资源路径
├── http/middleware/            # 请求日志、404、统一异常
├── tests/<业务>/               # 自动化回归，与业务模块对应
├── scripts/<用途>/             # 手工运维工具与测试汇总入口
├── seeds/                      # 启动种子数据
└── doc/                        # 跨模块架构、历史、待办、测试规范
```

先读 [架构与选型](doc/ARCHITECTURE.md)，再进入下表对应模块；定位旧文件用 [路径对照](doc/MIGRATION_MAP.md)。AI 修改代码前请读 [测试案例执行协议](doc/TESTING.md)，完成后更新相应模块案例及 [待办](doc/HISTORY_AND_TODO.md)。

| 模块 | 职责与文档 |
| --- | --- |
| accounts | [账号、QQ 验证码、多设备会话、最近定位](modules/accounts/doc/README.md) |
| places | [地点 CRUD、申请、分类、分享卡片、创建通知](modules/places/doc/README.md) |
| ratings | [评分、配额、声誉权重、避雷判定](modules/ratings/doc/README.md) |
| discovery | [关键词、语义搜索、随机推荐、顺路查询](modules/discovery/doc/README.md) |
| preferences | [行为、收藏、地点与用户向量](modules/preferences/doc/README.md) |
| journeys | [素材、生成、草稿、澄清、预览、发布](modules/journeys/doc/README.md) |
| community | [同好发现、同意设置、评论、聚餐、公告、反馈导出](modules/community/doc/README.md) |
| admin | [管理员权限、审核、审计、机器人管理](modules/admin/doc/README.md) |
| media | [图片校验、隐私处理、本地与 OSS 存储](modules/media/doc/README.md) |
| maps | [高德 Web 服务代理、文字匹配工具](modules/maps/doc/README.md) |
| qqbot | [OneBot 连接、命令、会话草稿、通知](modules/qqbot/doc/README.md) |
| infrastructure | [持久化、缓存、日志、模型调用](infrastructure/doc/README.md) |

## 常用命令

```sh
npm test                   # 发现并串行运行全部非浏览器 test_*.js
npm run test:structure     # 静态导入、资源根目录、模块文档和链接检查
npm run test:ui            # 地点位置 + 日记，真实浏览器与前后端集成
npm run test:ratings       # 原有分模块命令全部保留
npm run logs -- --since 2h --level warn
```

安装依赖继续使用 backend/package-lock.json；浏览器集成另需 frontend 依赖和测试脚本所用的 Playwright 浏览器。测试使用临时 SQLite 和本地替身；部分旧集成脚本会尝试本机 Redis，不需要生产 Redis。测试汇总不加载 backend/.env、不运行真实模型延迟探测，也不执行账号修改、图片迁移或向量回填。

业务文档写在模块的 `doc/`，不要求给 routes/services 等每个技术子目录重复建文档。简单模块把案例直接写在入口，复杂模块才拆 `TEST_CASES.md`。跨模块历史和待办只维护一份，并用模块名和稳定编号索引。
