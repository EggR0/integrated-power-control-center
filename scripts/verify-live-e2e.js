const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

const brokerModulePath = path.resolve(__dirname, "..", "broker-out", "broker");
const {
  createPreferredEventLedger,
  IntegratedPowerBroker,
  createFirstWaveAdapters,
  startBrokerServer,
  legacyLocalRunnerAvailable,
  resolveScriptsRoot,
} = require(brokerModulePath);

async function runEndToEndVerification() {
  console.log("==================================================");
  console.log("   Integrated Power Control Center Live E2E Test   ");
  console.log("==================================================");

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ip-e2e-verify-"));
  const ledgerPath = path.join(tempDir, "events.enc.jsonl");

  let server;
  try {
    // 1. Check Local LLM Script Discovery
    console.log("[1/8] Verifying Local LLM Zero-Config Script Discovery...");
    const scriptsAvailable = legacyLocalRunnerAvailable();
    const scriptsPath = resolveScriptsRoot ? resolveScriptsRoot() : "default";
    console.log(`  -> Scripts Root: ${scriptsPath}`);
    console.log(`  -> Scripts Available: ${scriptsAvailable}`);
    assert.strictEqual(scriptsAvailable, true, "Local LLM runner scripts must be discovered automatically.");

    // 2. Initialize Broker & Encrypted Ledger
    console.log("[2/8] Initializing Encrypted Ledger & Broker Engine...");
    const ledger = createPreferredEventLedger(ledgerPath);
    const adapters = createFirstWaveAdapters();
    const broker = new IntegratedPowerBroker(ledger, adapters);
    await broker.initialize();
    console.log("  -> Broker initialized with first-wave adapters.");

    // 3. Start Live HTTP Server on dynamic loopback port
    console.log("[3/8] Starting Live Loopback Broker Server...");
    server = await startBrokerServer(broker, 0);
    const port = server.port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`  -> Broker listening on ${baseUrl}`);

    // Helper for HTTP requests
    async function request(urlPath, options = {}) {
      const res = await fetch(`${baseUrl}${urlPath}`, options);
      const text = await res.text();
      let body;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: res.status, headers: res.headers, body };
    }

    // 4. Test Health, A2A Agent Card, and Capabilities
    console.log("[4/8] Testing Core Discovery & Integration Endpoints...");
    const health = await request("/health");
    assert.strictEqual(health.status, 200);
    assert.strictEqual(health.body.ok, true);
    console.log("  ✓ /health: OK");

    const agentCard = await request("/.well-known/agent-card.json");
    assert.strictEqual(agentCard.status, 200);
    assert.strictEqual(agentCard.body.name, "Integrated Power Broker");
    console.log("  ✓ /.well-known/agent-card.json (A2A Discovery): OK");

    const capabilities = await request("/v1/capabilities");
    assert.strictEqual(capabilities.status, 200);
    assert.ok(Array.isArray(capabilities.body.capabilities));
    const capProviders = capabilities.body.capabilities.map(c => c.provider);
    console.log(`  ✓ /v1/capabilities returned ${capProviders.length} providers: [${capProviders.join(", ")}]`);

    // Verify ChatGPT & Claude spec endpoints
    const chatgptSpec = await request("/v1/integrations/chatgpt/spec");
    assert.strictEqual(chatgptSpec.status, 200);
    assert.ok(chatgptSpec.body.snippet.mcpServers["integrated-power"]);
    console.log("  ✓ /v1/integrations/chatgpt/spec (1-Click JSON): OK");

    const claudeSpec = await request("/v1/integrations/claude/spec");
    assert.strictEqual(claudeSpec.status, 200);
    assert.ok(claudeSpec.body.spec);
    console.log("  ✓ /v1/integrations/claude/spec: OK");

    // 5. Test MCP Protocol (JSON-RPC initialize, tools/list, tools/call)
    console.log("[5/8] Testing Universal MCP Server Protocol via /mcp...");
    const mcpInit = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    assert.strictEqual(mcpInit.status, 200);
    assert.strictEqual(mcpInit.body.result.protocolVersion, "2025-06-18");
    console.log("  ✓ MCP initialize handshake: OK");

    const mcpTools = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.strictEqual(mcpTools.status, 200);
    const toolNames = mcpTools.body.result.tools.map(t => t.name);
    console.log(`  ✓ MCP tools/list returned ${toolNames.length} tools: [${toolNames.join(", ")}]`);
    assert.ok(toolNames.includes("integrated_power_create_task"));
    assert.ok(toolNames.includes("integrated_power_delegate"));
    assert.ok(toolNames.includes("integrated_power_get_status"));

    // Call MCP tool to create a task
    const mcpCreate = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "integrated_power_create_task",
          arguments: { title: "MCP Live Task", goal: "Verify MCP execution", originProvider: "openai.chatgpt.app", privacy: "private" },
        },
      }),
    });
    assert.strictEqual(mcpCreate.status, 200);
    const mcpTask = JSON.parse(mcpCreate.body.result.content[0].text).task;
    assert.ok(mcpTask.id, "Task ID must be returned from MCP call.");
    console.log(`  ✓ MCP tools/call (integrated_power_create_task) created Task: ${mcpTask.id}`);

    // 6. Test Task Lifecycle (Create, List, AG-UI Stream, Approvals)
    console.log("[6/8] Testing Task Lifecycle, REST API & AG-UI SSE Stream...");
    const restTask = await request("/v1/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "REST Task", goal: "Verify REST API", originProvider: "google.antigravity.ide", privacy: "private" }),
    });
    assert.strictEqual(restTask.status, 201);
    assert.ok(restTask.body.task.id);
    console.log(`  ✓ POST /v1/tasks created Task: ${restTask.body.task.id}`);

    const tasksList = await request("/v1/tasks");
    assert.strictEqual(tasksList.status, 200);
    assert.strictEqual(tasksList.body.tasks.length, 2);
    console.log(`  ✓ GET /v1/tasks returned ${tasksList.body.tasks.length} active tasks.`);

    // AG-UI Stream verification (SSE)
    const sseChunk = await new Promise((resolve, reject) => {
      const sseReq = http.get(`${baseUrl}/v1/tasks/${encodeURIComponent(restTask.body.task.id)}/stream`, (res) => {
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.headers["content-type"], "text/event-stream; charset=utf-8");
        res.on("data", (chunk) => {
          const text = chunk.toString();
          sseReq.destroy();
          resolve(text);
        });
      });
      sseReq.on("error", (err) => {
        if (err.code === "ECONNRESET" || err.message?.includes("socket hang up")) return;
        reject(err);
      });
    });
    assert.ok(sseChunk.includes("RUN_STARTED"));
    console.log("  ✓ GET /v1/tasks/:id/stream (AG-UI SSE stream): OK");

    // Approval Request
    const approvalReq = await request("/v1/approvals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: restTask.body.task.id,
        action: "merge",
        description: "Test merge approval",
        requestedBy: "user",
        expectedRevision: restTask.body.task.revision,
      }),
    });
    assert.strictEqual(approvalReq.status, 201);
    console.log(`  ✓ POST /v1/approvals created approval request: ${approvalReq.body.approval.id}`);

    const approvalsList = await request("/v1/approvals");
    assert.strictEqual(approvalsList.status, 200);
    assert.strictEqual(approvalsList.body.approvals.length, 1);
    console.log(`  ✓ GET /v1/approvals returned ${approvalsList.body.approvals.length} pending approval.`);

    // 7. Test A2A Protocol (/message:send)
    console.log("[7/8] Testing A2A Agent-to-Agent v1 Endpoint...");
    const a2aSend = await request("/message:send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          contextId: "a2a-test-context-123",
          parts: [{ content: { value: "A2A delegation prompt test" } }],
        },
      }),
    });
    assert.strictEqual(a2aSend.status, 200);
    assert.ok(a2aSend.body.task.id);
    console.log(`  ✓ POST /message:send processed A2A task: ${a2aSend.body.task.id}`);

    // 8. Verify Built Frontend Assets
    console.log("[8/8] Verifying Built Frontend Web UI Assets...");
    const distHtml = path.resolve(__dirname, "..", "dist", "index.html");
    assert.ok(fs.existsSync(distHtml), "dist/index.html must exist.");
    const htmlContent = fs.readFileSync(distHtml, "utf8");
    assert.ok(htmlContent.includes("Integrated Power"), "index.html must contain title.");
    assert.ok(htmlContent.includes("main-agent-select"), "index.html must contain main-agent-select.");
    assert.ok(htmlContent.includes("main-agent-actions"), "index.html must contain main-agent-actions.");
    console.log("  ✓ dist/index.html contains all required UI components.");

    console.log("\n==================================================");
    console.log("  🎉 ALL 8/8 END-TO-END VERIFICATION CHECKS PASSED!");
    console.log("  Track 2 is 100% OPERATIONAL and FULLY VERIFIED.   ");
    console.log("==================================================");
  } finally {
    if (server) await server.close();
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

runEndToEndVerification().catch((err) => {
  console.error("\n❌ VERIFICATION FAILED:", err);
  process.exit(1);
});
