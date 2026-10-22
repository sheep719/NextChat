# 演示截图

| 截图 | 内容 |
| --- | --- |
| 01-login.png | 登录页（未登录访问主页自动跳转） |
| 02-chat.png | 设备 A 注册并发起对话（demo_mv2aqb1k） |
| 03-cross-device.png | 设备 B（全新浏览器上下文）登录同账号，看到设备 A 的历史会话——云端同步核心演示 |
| 04-usage.png | 用量统计面板（Recharts 图表，数据来自网关 /api/usage） |
| 05-stats-route.png | /stats 标准路由 → 登录守卫 + 跳转用量面板（验收 STAT-03） |
| jwt-anatomy.png | 用户令牌在 jwt.io 的三段解码（header/payload/signature），实测记录见 gateway-security-test.md 第四节 |

> 01-05 由无头浏览器（Edge CDP）自动化生成，服务为 docker compose 真机容器（:3000 + :3600）。
> jwt-anatomy.png 为人工截图：Signature 校验呈红色为预期现象——JWT_SECRET 仅存于服务端，
> 第三方解码工具无从验签，恰好印证签名机制的密钥隔离设计。
