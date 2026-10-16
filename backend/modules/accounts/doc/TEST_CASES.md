# 账号文字测试案例库

遵循 [执行协议](../../../doc/TESTING.md)。下列除注明外均已有自动化；现有入口 `npm run test:session-store`、`test:sessions`、`test:qq-verification`。使用临时 SQLite、FakeRedis、假 OneBot，不向真实 QQ 发送消息。

### ACC-C01 多设备与旧 token

- 前置：同一用户，两个客户端信息；另有 sid-less 旧会话。
- 操作：分别登录，查询会话列表；撤销其中一个 sid；请求另一设备和旧 token 的 `/users/me`；走旧会话升级接口。
- 预期：sid 各不相同、列表不泄露完整 token；被撤销设备失效，其他设备保留；旧凭证按既有 Redis key 检查，升级后得到设备会话。
- 自动化：test:sessions、test:session-store；避免把仅验 JWT 签名当作撤销验证。

### ACC-C02 白名单、占用与绑定冲突（d285076）

- 前置：不在白名单 QQ、允许注册 QQ、已绑定 QQ、历史多账号同 QQ 各一组。
- 操作：逐一请求 register 验证码，合法组完成注册。
- 预期：不合格或冲突状态被拒绝且不预留可用码；合法组成功；验证码只用于对应 QQ 和 purpose。
- 自动化：test:qq-verification。

### ACC-C03 时效、单次消费和错误次数（d285076）

- 前置：固定时间生成 6 位码，数据库只持 HMAC；保留发送替身收到的明文供断言。
- 操作：传错用途、错 QQ、错误码到上限、过期码；重新建立合法码并成功消费后重放。
- 预期：所有非法输入被拒，达到错误次数后失效；成功消费只生效一次；注册失败的事务不能留下半个账号。
- 自动化：test:qq-verification、test:transactions。

### ACC-C04 重发与发送失败

- 前置：同一 QQ 跨 register/reset_password；多个 QQ 共用 IP；固定时钟。
- 操作：60 秒内重发；到 QQ/IP/全局小时边界；模拟 OneBot 私信发送失败。
- 预期：冷却跨用途，返回可解释等待信息；失败记录为 failed，不作为成功发送码；失败可按当前规则重试。
- 自动化：test:qq-verification；具体小时额度读取 LIMITS，不复制可漂移的常量到新测试。

### ACC-C05 密码重置撤销（d285076）

- 前置：账户有两台设备会话，合法 reset_password 验证码。
- 操作：提交短密码后提交合法密码；用旧密码、旧 token、新密码、新 token 访问。
- 预期：短密码不消费成功码；成功后旧密码和全部旧会话失效，新会话可用；同码重放失败。
- 自动化：test:qq-verification、test:sessions。

### ACC-C06 Redis 故障与封禁

- 前置：签名有效 token，Redis 替身抛连接错误；另有未到期与到期封禁用户。
- 操作：GET 与写请求；恢复 Redis 后再验证已撤销会话。
- 预期：故障时按现行 JWT 降级策略；封禁不能靠降级绕过写限制；到期封禁自动解除，Redis 恢复后恢复会话校验。
- 自动化：test:sessions；长期故障撤销窗口专项验证见 ACC-01，不能把可用性降级写成“撤销仍严格生效”。

### ACC-C07 最近定位（13576c8）

- 前置：已认证用户，无定位；替身 Bot 可读取账户定位。
- 操作：两次 PUT /users/me/location，然后传越界、非数值、零点无效组合和无 token 请求，最后删账号。
- 预期：每用户只保留最后一条；非法请求不覆盖旧值；未认证被拒；删账号级联删除定位。
- 自动化：test:qq-bot 的定位组；位置是推荐中心，不是轨迹记录。
