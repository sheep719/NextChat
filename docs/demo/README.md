# 演示截图

| 截图 | 内容 |
| --- | --- |
| 01-login.png | 登录页（未登录访问主页自动跳转） |
| 02-chat.png | 设备 A 注册并发起对话（demo_mv2aqb1k） |
| 03-cross-device.png | 设备 B（全新浏览器上下文）登录同账号，看到设备 A 的历史会话——云端同步核心演示 |
| 04-usage.png | 用量统计面板（Recharts 图表，数据来自网关 /api/usage） |

> 截图由无头浏览器（Edge CDP）自动化生成，服务为 docker compose 真机容器（:3000 + :3600）。
| 05-stats-route.png | /stats 标准路由 → 登录守卫 + 跳转用量面板（验收 STAT-03） |
