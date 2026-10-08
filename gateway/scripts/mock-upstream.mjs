/**
 * 联调自测用的极简 OpenAI 兼容上游（不参与生产）。
 *
 * 用途：在不消耗真实 API 额度的情况下，验证网关的第二家 provider 转发链路
 * （含 SSE 流式透传）是否正常工作。
 *
 *   node scripts/mock-upstream.mjs     # 默认监听 127.0.0.1:3700
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 3700);

const server = http.createServer(async (req, res) => {
  if (req.url?.endsWith("/chat/completions") && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    await new Promise((r) => req.on("end", r));

    let parsed = {};
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {}

    console.log(
      `[mock upstream] model=${parsed.model} stream=${!!parsed.stream} auth=${(
        req.headers.authorization || ""
      ).slice(0, 24)}`,
    );

    if (parsed.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunks = ["你", "好", "，", "这", "是", "第", "二", "家", "上", "游"];
      // 是否按 OpenAI 规范在最后一个分片里带 usage（用于验证网关的真实值抓取路径）
      const withUsage = parsed.stream_options?.include_usage === true;
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          if (withUsage) {
            // 真实 provider 的做法：末尾补一个 usage 分片（choices 为空）
            res.write(
              "data: " +
                JSON.stringify({
                  id: "mockupstream",
                  object: "chat.completion.chunk",
                  created: Date.now(),
                  model: parsed.model,
                  choices: [],
                  usage: {
                    prompt_tokens: 7,
                    completion_tokens: 11,
                    total_tokens: 18,
                  },
                }) +
                "\n\n",
            );
          }
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(
          "data: " +
            JSON.stringify({
              id: "mockupstream",
              object: "chat.completion.chunk",
              created: Date.now(),
              model: parsed.model,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: chunks[i] },
                  finish_reason: null,
                },
              ],
            }) +
            "\n\n",
        );
        i += 1;
      }, 40);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mockupstream",
        object: "chat.completion",
        created: Date.now(),
        model: parsed.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "来自第二家上游的回复" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
      }),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock upstream listening on http://127.0.0.1:${PORT}`);
});
