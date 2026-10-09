// One-shot E2E: starts the 39321 mock upstream AND a throwaway 37242 broker
// (fresh compiled out/broker) as a child process, then probes: quota parse,
// model discovery, auth-gated discovery (key forwarding), 502 propagation.
const http = require("http");
const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");

const upstream = http.createServer((req, res) => {
  if (req.url === "/quota") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ windows: [{ name: "5h", limit_tokens: 500000, remaining_tokens: 125000 }, { name: "Weekly", limit: 100, used: 30 }] }));
  } else if (req.url === "/v1/models") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "Qwen3.8-27B-AWQ" }, { id: "glm-4.5-air" }] }));
  } else if (req.url === "/secure/models") {
    if (req.headers["authorization"] === "Bearer test-key-123") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "private-model" }] }));
    } else {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
    }
  } else if (req.url === "/denied") {
    res.writeHead(401);
    res.end("{}");
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});

(async () => {
  await new Promise((r) => upstream.listen(39321, "127.0.0.1", r));
  // Fresh broker on 37242 (isolated state root — never touches the IDE's 37241).
  const stateRoot = path.join(process.env.LOCALAPPDATA || ".", "IntegratedPower", "state-e2e-test");
  const broker = spawn(process.execPath, [path.join(__dirname, "broker-server.js")], {
    env: {
      ...process.env,
      INTEGRATED_POWER_BROKER_PORT: "37242",
      INTEGRATED_POWER_BROKER_MODULE: path.join(__dirname, "..", "vscode-extension", "out", "broker"),
      INTEGRATED_POWER_STATE_ROOT: stateRoot,
    },
    stdio: "ignore",
  });
  await new Promise((resolve, reject) => {
    const tryHealth = async () => {
      try {
        const res = await fetch("http://127.0.0.1:37242/health");
        if (res.ok) return resolve();
      } catch { /* not up yet */ }
      setTimeout(tryHealth, 250);
    };
    const t = setTimeout(() => reject(new Error("broker did not come up on 37242")), 10000);
    tryHealth().then(() => clearTimeout(t));
  });
  const get = async (url) => {
    const res = await fetch(url);
    let body;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  };
  const base = "http://127.0.0.1:37242/v1/providers/external";
  try {
    // 1) quota payload (legacy url = quota source)
    const quota = await get(`${base}?url=${encodeURIComponent("http://127.0.0.1:39321/quota")}`);
    assert.strictEqual(quota.status, 200, "quota 200");
    assert.strictEqual(quota.body.payload.windows[0].name, "5h");
    console.log("ok - quota endpoint fetch + payload");

    // 2) OpenAI-compatible model discovery
    const models = await get(`${base}?url=${encodeURIComponent("http://127.0.0.1:39321/v1/models")}`);
    assert.strictEqual(models.status, 200, "models 200");
    assert.deepStrictEqual(models.body.payload.data.map((m) => m.id), ["Qwen3.8-27B-AWQ", "glm-4.5-air"]);
    console.log("ok - /v1/models discovery payload");

    // 3) auth-gated discovery WITHOUT key → 502 (upstream 401)
    const noKey = await get(`${base}?url=${encodeURIComponent("http://127.0.0.1:39321/secure/models")}`);
    assert.strictEqual(noKey.status, 502, "no key → 502");
    console.log("ok - no key → 502");

    // 4) auth-gated discovery WITH key → 200 + models
    const withKey = await get(`${base}?url=${encodeURIComponent("http://127.0.0.1:39321/secure/models")}&key=${encodeURIComponent("test-key-123")}`);
    assert.strictEqual(withKey.status, 200, "with key → 200");
    assert.deepStrictEqual(withKey.body.payload.data.map((m) => m.id), ["private-model"]);
    console.log("ok - key forwarded as Authorization: Bearer");

    // 5) upstream 401 propagates as 502
    const denied = await get(`${base}?url=${encodeURIComponent("http://127.0.0.1:39321/denied")}`);
    assert.strictEqual(denied.status, 502);
    console.log("ok - 401 → 502");

    console.log("E2E external provider: all passed");
  } finally {
    broker.kill();
    upstream.close();
  }
})().catch((err) => {
  console.error("E2E FAILED:", err.message);
  upstream.close();
  process.exit(1);
});
