# 网关鉴权安全实测报告（2026-10-22）

> 对象：自建网关（Fastify，:3600）的统一鉴权层 `gateway/src/auth.ts` 与数据访问层
> `gateway/src/conversations.ts`。方法：黑盒注入四类攻击向量，观察响应与数据面行为。
> 相关文档：[gateway-auth.md](./gateway-auth.md)（鉴权设计）、[request-flow-log.md](./request-flow-log.md)（请求链路）。

## 一、测试环境与素材

| 项 | 值 |
|---|---|
| 网关 | http://127.0.0.1:3600（dev 模式，Fastify + tsx watch） |
| 受害账号 A | linktest（uid=23），持有私密会话 id=3 |
| 攻击账号 B | attacker（uid=24），正常注册的合法账号 |
| 凭证 | A/B 各自的合法 JWT（HS256，typ=user，TTL 7 天） |
| 隔离基线 | A 当日 usage 7 calls vs B 0 calls（同日数据已隔离） |

## 二、防线代码定位（攻击前先明确攻击面）

```
请求 → extractCredential()     取 Bearer / X-Api-Key
     → authenticate()          凭证校验：JWT 形状 → verifyJwt()；否则 API Key 匹配
     → assertUser()            聊天/会话接口要求 kind=user（typ=user 的 JWT）
     → assertScope()           scope 声明了则必须命中（未声明放行）
     → conversations.ts        所有 SQL 强制 WHERE user_id = ?（数据层最后防线）
```

## 三、攻击向量与结果（四发全挡）

### 攻击 1：水平越权（合法凭证，读他人资源）

用 B 的**合法 JWT** 请求 A 的私密会话：

```bash
curl -s http://127.0.0.1:3600/api/conversations/3 \
  -H "Authorization: Bearer ${TOKEN_B}"
```

**结果：404**（不是 403）。数据层 SQL `WHERE user_id = ?` 使查询无命中，
按"资源不存在"处理——**不向攻击者暴露资源存在性**（403 会泄露"id=3 存在"这一事实）。

### 攻击 2：篡改 payload（合法 token，改身份声明）

解码 B 的 JWT（payload 明文可读），将 `uid: 24` 改为 `23`（伪装成 A），重新编码：

**结果：401 `JWT signature verification failed`**。签名覆盖 `header.payload`，
payload 任何字节变动 → HMAC 重算失配。payload 明文可读 ≠ 可伪造。

### 攻击 3：无凭证访问

```bash
curl -s http://127.0.0.1:3600/api/conversations
```

**结果：401 `missing_credentials`**，错误体附凭证格式指引。
网关未配置凭证且未显式 `ALLOW_ANONYMOUS` 时拒绝启动（fail-closed，见 `assertAuthConfigured()`）。

### 攻击 4：alg:none 降级攻击（经典 JWT 攻击）

构造 `header.alg = "none"`、去掉签名段的 token：

**结果：401 `Unsupported JWT alg "none"`**。`verifyJwt()` 在**验签之前**校验算法白名单
（`JWT_ALGS`，默认仅 HS256），杜绝算法混淆类攻击。

## 四、JWT 结构实测（token 解剖）

签发给 A 的令牌解码（jwt.io 解码截图见 [demo/jwt-anatomy.png](./demo/jwt-anatomy.png)，
Signature 校验呈红色为预期现象——密钥仅存服务端，第三方工具无从验签）：

| 段 | 内容 | 说明 |
|---|---|---|
| header | `{"alg":"HS256","typ":"JWT"}` | 声明算法，服务端按白名单校验后才采信 |
| payload | `uid:23, sub:"user:23", typ:"user", role:"user", iss:"nextchat-gateway", iat/nbf/exp, scope:"chat.completions models.read conversation.read conversation.write"` | 明文可读；exp-iat = 168h = 7 天（`clampTtl` 上限 8 天，防永久令牌） |
| signature | HMAC-SHA256(JWT_SECRET, `header.payload`) | 43 字符 base64url = 32 字节定长；比较用 `timingSafeEqual` 防时序侧信道 |

校验顺序（先廉价后昂贵，顺序即安全设计）：
结构 → 算法白名单 → 验签 → exp/nbf（留 60s 时钟偏差容忍）→ iss/aud。

## 五、验证顺序的安全含义

1. **算法白名单先于验签**：若先按 header 声明的算法验签，`alg:none` 或 RS256→HS256
   公钥混淆攻击即可绕过；白名单判定前置消除了这一类攻击面。
2. **签名比较用定长摘要**：`safeEqual()` 先 sha256 再 `timingSafeEqual`，
   避免逐字节短路比较泄露"匹配到第几位"的时序信号。
3. **404 优于 403（水平越权场景）**：资源级授权失败统一按不存在处理，
   防止资源 ID 枚举。
4. **fail-closed 启动自检**：凭证未配置 → 拒绝启动，"默认拒绝"不依赖人工记忆。

## 六、已知边界（如实声明）

- 无 refresh token：7 天过期后需重新登录；
- 无主动失效机制：改密码后旧 token 在剩余 TTL 内仍有效（无 token 黑名单/版本号）；
- 密钥单一：JWT_SECRET 同时用于所有用户令牌的 HMAC，轮换需全体重新登录；
- token 存 localStorage：XSS 场景可被读取（与 httpOnly Cookie 的取舍见产品决策，
  换取跨子域分发与实现简单性）。

## 七、结论

四类攻击向量全部被拒（401×3、404×1），用户数据隔离经 usage 对照验证有效。
鉴权设计的三道纵深（凭证校验 → 身份/权限断言 → 数据层强制过滤）各自独立生效，
单点绕过不导致越权。已知边界均有明确定位与后续演进方向。
