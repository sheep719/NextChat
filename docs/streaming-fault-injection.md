# 流式透传故障注入实测（2026-10-22）

> 对象：网关 SSE 透传链路（`gateway/src/server.ts` 的 `pipe(tap).pipe(reply.raw)` 路径）。
> 方法：沿数据流逐节点注入故障（上游不可达 / 上游慢 / 客户端中断），
> 观察超时、缓冲与资源清理行为。工具：[mock-upstream.mjs](../gateway/scripts/mock-upstream.mjs)
> （支持 `FIRST_FRAME_DELAY_MS` / `CHUNK_INTERVAL_MS` 延迟注入）。
> 相关文档：[request-flow-log.md](./request-flow-log.md)（链路实录）、[gateway-auth.md](./gateway-auth.md)。

## 一、实验 A：上游不可达（黑洞地址）

**操作**：`ALIBABA_BASE_URL` 指向不可路由地址 `10.255.255.1`，业务超时 `UPSTREAM_TIMEOUT_MS=15000`。

**结果**：`502 @ 10.64s`，错误体：
```json
{"error":{"message":"Upstream alibaba request failed: fetch failed","type":"upstream_error"}}
```

**关键发现**：**10.64s ≠ 配置的 15s**。undici（Node fetch 传输层）默认连接超时约 10s，
先于业务超时触发——**两层超时在赛跑，配置了业务超时 ≠ 超时上限可控**。
要真正钳制上限，业务超时应配得比传输层默认短，或显式使用 `AbortSignal.timeout()`。

**错误分类逻辑**（server.ts）：AbortError → 504 `Upstream timeout`；fetch 自抛 → 502 `request failed`。

## 二、实验 B：上游慢（延迟注入，验证透传质量）

**操作**：deepseek 路由指向 mock 上游，注入首帧延迟 8s + 每帧间隔 200ms。

**结果**：
| 指标 | 实测值 | 说明 |
|---|---|---|
| 首字节到达 | 8.26s | ≈ 首帧延迟 8s，中间层无攒帧 |
| 总耗时 | 10.29s | 11 帧 × 200ms 累计 |
| 帧间隔 | 200-204ms 均匀 | 与注入参数一致 |

**结论**：网关为真·流式透传，无缓冲。网关设置的 `X-Accel-Buffering: no`
用于防止 nginx 默认 4KB 缓冲把流攒成一坨。

## 三、实验 C：客户端中途断开（发现管道泄漏并修复）

**操作**：`curl --max-time 6` 在流中途掐断连接（首帧 2s + 1.5s/帧，断在第 3 帧）。

**发现的问题**：`onEarlyClose` 只做记账（`finish(null, "")` 防 usage 丢失），
**但没有销毁管道**——`pipe` 链继续消费上游响应直到自然结束。
真实影响：用户点"停止生成"后，上游 token 继续消耗。
此类问题不报错、不崩溃，code review 难以发现，只有故障注入可观察到。

**修复**（commit ee8c79f0）：

```ts
const onEarlyClose = () => {
  finish(null, "");       // 记账（原有）
  clearTimeout(timer);    // 清超时句柄
  source.destroy();       // 销毁 Readable → 关闭上游连接
  controller.abort();     // fetch AbortController 兜底
};
reply.raw.on("close", onEarlyClose);
tap.on("end", () => {
  reply.raw.off("close", onEarlyClose);
  clearTimeout(timer);    // 正常路径同样清理
});
```

**验证闭环**（mock 上游补逐帧日志 + `res.on("close")` 停发标志）：

```
修复前：第 1-10 帧全部发出（mock 感知不到客户端断开，持续盲发）
修复后：第 1、2 帧发出 → "连接关闭（已发 2/10 帧），停止发送" → 到此为止
```

**机制说明**：客户端断开后，Node 的 pipe 链不会自动通知上游——
流的生命周期管理是应用层责任。`destroy()` 触发 Readable 销毁并关闭底层 socket，
对端（上游）才会感知断开。

## 四、附带的工程发现

1. **env 同名键先到先得**：`.env` 中同名键出现两次（前空后有值）时，空值先生效——
   "配置了却没生效"类问题的新排查方向；
2. **tsx watch 只监听 .ts 文件**：改 `.env` 必须手动重启进程；
3. **503 错误体设计**：provider 未配置返回 `provider_not_configured` + 修复指引，
   而非裸抛异常——故障路径的可运维性也是设计目标。

## 五、结论

三组注入覆盖了数据流的三个节点（上游挂 / 上游慢 / 客户端跑），
暴露出一个真实缺陷（管道泄漏）并完成修复-验证闭环。
透传质量（无缓冲）与超时行为（两层赛跑）均有量化数据支撑。
