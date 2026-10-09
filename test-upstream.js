// Throwaway upstream for the external-provider E2E: a tiny quota API + an
// OpenAI-compatible server on 39321 (model discovery, model-only, auth-gated).
const http = require("http");
const server = http.createServer((req, res) => {
  const url = req.url;
  if (url === "/quota") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      windows: [
        { name: "5h", limit_tokens: 500000, remaining_tokens: 125000, resets_at: Date.now() + 4 * 3600 * 1000 },
        { name: "Weekly", limit: 100, used: 30, resets_in_ms: 3 * 86400000 },
      ],
      model: "mock-model",
    }));
  } else if (url === "/v1/models") {
    // OpenAI-compatible model list (vLLM/LM Studio/SGLang shape).
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      data: [
        { id: "Qwen3.8-27B-AWQ" },
        { id: "Qwen3.8-27B-Uncensored" },
        { id: "glm-4.5-air" },
      ],
    }));
  } else if (url === "/denied") {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  } else if (url === "/secure/models") {
    // Auth-gated model list: requires `Authorization: ***
    const auth = req.headers["authorization"];
    if (auth === "Bearer test-key-123") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "private-model" }] }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid api key" }));
    }
  } else {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
  }
});
server.listen(39321, "127.0.0.1", () => console.log("upstream ready on 39321"));
