# 账号文字测试案例库

遵循 [执行协议](../../../doc/TESTING.md)。下列除注明外均已有自动化；现有入口 `npm run test:session-store`、`test:sessions`、`test:qq-verification`、`test:phone-verification`。使用临时 SQLite、FakeRedis、假 OneBot、假短信发送端与假 fetch，不向真实 QQ 或手机发送消息。

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

### ACC-C12 JWT 密钥与登录失败限流

- 前置：临时库，alice / bob 两个账号，进程内计数。
- 操作：检查空密钥、回退值、短密钥；用 HS384 和 alg=none 签 alice 的 token 请求 `/users/me`；同一 IP 段对 alice 连续输错到账号 + IP 段额度后用正确密码登录；同 IP 段登录 bob、别的 IP 段登录 alice；差一次到额度时成功登录再连续输错；同一 /24 轮换账号名输错到 IP 段额度；密码传对象。
- 预期：三种密钥都报问题；非 HS256 token 401；锁定后正确密码也 429 且带 Retry-After，bob 和别的 IP 段不受影响；成功登录清零账号 + IP 段计数；IP 段额度覆盖整个 /24、不影响其他段；类型不对 400。
- 自动化：test:auth-hardening（同一脚本还覆盖删除他人饭局的权限与审计，见 community 的 COM-05）。

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

### ACC-C08 短信客户端（阿里云签名与请求）

- 前置：假 fetch，固定时间与 nonce；只配 OSS AccessKey、再加签名 / 国际签名与模板。
- 操作：用阿里云公开的签名示例算签名；发送 +86 与 +852 号码；模拟限流、号码非法、Success=false、超时。
- 预期：签名与官方示例一致；未配签名时 not_configured；+86 走 dypnsapi `SendSmsVerifyCode`（模板 100001/100004，TemplateParam 带 code 与 min），其他区号走 dysmsapi 2018-05-01 `SendMessageToGlobe`（ap-southeast-1 端点，To 为区号+号码，正文含验证码且不超过 70 字，Type=OTP，没有签名与模板，成功看 ResponseCode），未打开国际通道时 intl_not_configured；错误分类正确，超时标记 outcomeUnknown；请求体签名可复算。
- 自动化：test:phone-verification。真实下发为人工验证：2026-11-17 用赠送签名“速通互联验证码”向 +86 号码发送（阿里云受理），向 +1 号码发送并经 QueryMessage 确认 DELIVERED。

### ACC-C09 注册双验证与旧客户端

- 前置：白名单 QQ 与已发出的 QQ 码；假短信发送端。
- 操作：手机号格式错 / 缺 QQ 码 / QQ 码错时请求短信码；正确后发码、冷却内重发；`REGISTRATION_PHONE_REQUIRED` 关闭时不带手机号注册，带手机号缺短信码注册；打开后不带手机号注册；短信码错、用别的 QQ 申请的短信码、正确码注册。
- 预期：QQ 码错计次且不发短信；已被绑定的号码发码照常成功，注册提交时 409 且两个码都不消耗；只存哈希；旧客户端在开关关闭时注册成功且手机号为空，打开后提示更新且不消耗 QQ 码；短信码错返回 `field: phoneCode` 且 QQ 码仍可用；成功后两个码都标记 used，`User.phone` 为规范形式，`/users/me` 只回打码号码。
- 自动化：test:phone-verification、test:qq-verification、test:transactions。

### ACC-C10 换绑手机号、唯一性与境外号码

- 前置：没有手机号的老住民和已绑定的住民各一个。
- 操作：未登录申请；申请别人已绑定的号码；正常换绑（错误码、别人申请的码、正确码、重放）；与当前号码相同；发码后号码被别人抢先绑定；+852 号码在国际通道未配置 / 已配置时换绑，同号码换区号提交。
- 预期：未登录 401；别人的号码照常发码，提交正确验证码后才 409 且不改号码（发码阶段不泄露号码是否已注册）；与当前号码相同发码时 400；只验证新号码；验证码只对申请它的住民有效且单次使用；换绑后旧号码释放；境外号码未配置时 400 且不占配额，配置后按规范形式保存并打码显示；区号不同视为不同号码。
- 自动化：test:phone-verification。网页“绑定手机号”页与注册表单的区号选择、自动识别 `+区号` 粘贴、窄屏布局为人工浏览器验证；iOS 原生设置行为未编译验证。

### ACC-C11 短信配额

- 前置：固定时钟。
- 操作：同申请人、同号码连续预留到上限；分散到多个小时累计到全站 24 小时上限。
- 预期：分别返回 subject_hourly_limit、phone_hourly_limit、global_daily_limit（429，带 Retry-After 秒数）。
- 自动化：test:phone-verification；额度读取 LIMITS，不复制常量。
