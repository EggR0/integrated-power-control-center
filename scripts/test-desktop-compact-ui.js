const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const chrome = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => candidate && fs.existsSync(candidate));
if (!chrome) throw new Error("Set CHROME_BIN to run the desktop compact-width regression.");
if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build the desktop UI before running this test.");

const capabilities = ["tasks.read", "tasks.write", "approvals.read", "tokens.read", "workspaces.read", "runs.read", "metrics.localLlm.read", "quota.settings.read", "quota.settings.write", "quota.notifications.claim", "quota.prewarm"];
const tokenStatus = {
  antigravityPercentage: 100, antigravityTokensLeft: 1000, antigravityMax: 1000, antigravityResetTime: "2020-01-01T00:00:00Z",
  antigravityWeeklyPercentage: 100, antigravityWeeklyTokensLeft: 10000, antigravityWeeklyMax: 10000, antigravityWeeklyResetTime: "2020-01-01T00:00:00Z",
  argonWeeklyPercentage: 100, argonWeeklyResetTime: "2020-01-01T00:00:00Z",
  opusPercentage: 100, opusTokensLeft: 1000, opusMax: 1000, opusResetTime: "2020-01-01T00:00:00Z",
  opusWeeklyPercentage: 100,
  codexPercentage: 100, codexTokensLeft: 1000, codexMax: 1000, codexResetTime: "2020-01-01T00:00:00Z",
  codexWeeklyPercentage: 100, codexWeeklyTokensLeft: 10000, codexWeeklyMax: 10000, codexWeeklyResetTime: "2020-01-01T00:00:00Z",
  claudePercentage: 45, claudeTokensLeft: 450, claudeMax: 1000, claudeWeeklyPercentage: 62, claudeWeeklyTokensLeft: 6200, claudeWeeklyMax: 10000,
  lastSync: new Date().toISOString(), localComputeStatus: { endpointHealth: "offline", loadedModels: [], gpus: [] }, activity: [],
};
const settings = {
  ok: true, revision: 1, initialized: true, source: "fixture", errors: [],
  settings: { pollIntervalMs: 60000, notifyOnFull: true, prewarmModes: { antigravity: "click", opus: "click", codex: "click" }, notifications: Object.fromEntries(["antigravityGemini5h", "antigravityGeminiWeekly", "antigravityClaude5h", "antigravityClaudeWeekly", "chatgpt5h", "chatgptWeekly", "claude5h", "claudeWeekly"].map((key) => [key, true])) },
};
const hubOverview = {
  schemaVersion: 1,
  config: { customVaultPath: "", customTodoFilePath: "", disabledConnectors: [], autoSyncMarkdown: true },
  ecosystem: {
    scannedAt: new Date().toISOString(), platform: "win32",
    connectors: [
      { id: "openclaw", label: "OpenClaw (Discord/Telegram Bridge)", category: "messenger", state: "ready", protocol: "acp", enabled: true, details: "ACP 127.0.0.1:37241" },
      { id: "hermes-agent", label: "Hermes Agent (NousResearch)", category: "harness", state: "ready", protocol: "openai-v1", enabled: true, details: "Reasoning harness" },
      { id: "opencodex", label: "OpenCodex (Writer-Critic Harness)", category: "harness", state: "ready", protocol: "cli", enabled: true, details: "Codex CLI" },
      { id: "obsidian-local-rest-api", label: "Obsidian Local REST API", category: "knowledge_vault", state: "ready", protocol: "rest", endpoint: "https://127.0.0.1:27124", enabled: true },
      { id: "docling", label: "Docling / MinerU (OCR Ingestion)", category: "document_media", state: "ready", protocol: "cli", enabled: true },
    ],
    vaults: [
      { path: "D:\\obsidian\\vault", name: "vault", source: "obsidian_registry", installedPlugins: ["smart-connections", "obsidian-linter"], enabledPlugins: ["smart-connections", "obsidian-linter"] },
    ],
    activeTodoFilePath: "D:\\obsidian\\vault\\Todo.md",
  },
  todos: [
    {
      id: "todo-1", blockId: "^todo1", title: "통합 관제 테스트 작업", rawText: "- [ ] 통합 관제 테스트 작업",
      status: "ready", domain: "core", privacyTier: "strictly_local", category: "coding", urgencyScore: 1, ambiguityScore: 0.1,
      clarificationQuestions: [], contextNotes: [], allowManualCredit: false, originChannel: "dashboard",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
    {
      id: "todo-2", blockId: "^todo2", title: "모호한 요청 검증", rawText: "- [?] 모호한 요청 검증",
      status: "needs_clarification", domain: "private", privacyTier: "strictly_local", category: "research", urgencyScore: 2, ambiguityScore: 0.6,
      clarificationQuestions: [{ id: "q1", question: "검증 대상 모델은 무엇입니까?", options: ["Gemini", "Codex", "Claude"] }],
      contextNotes: [], allowManualCredit: true, originChannel: "markdown",
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    },
  ],
  playbooks: [
    {
      category: "coding", label: "소프트웨어 엔지니어링",
      episodic: [{ id: "ep-1", summary: "UI 컴팩트 레이아웃 안정화", recordedAt: new Date().toISOString() }],
      semantic: [{ id: "sem-1", preference: "No innerHTML", rationale: "XSS 방지 및 테스트 무결성", recordedAt: new Date().toISOString() }],
      procedural: [{ id: "proc-1", trigger: "UI 컴포넌트 추가", rule: "120px 너비 회귀 테스트 필수", recordedAt: new Date().toISOString() }],
      updatedAt: new Date().toISOString(),
    },
  ],
};
const prewarmRequests = [];
let tokenFixtureMode = "normal";

const broker = http.createServer(async (request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Headers", "content-type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/__fixture/tokens/fail") { tokenFixtureMode = "failed"; response.writeHead(200).end("{}"); return; }
  if (url.pathname === "/__fixture/tokens/recover") { tokenFixtureMode = "zero"; response.writeHead(200).end("{}"); return; }
  if (url.pathname === "/v1/tokens/status" && tokenFixtureMode === "failed") { response.writeHead(500).end(JSON.stringify({ ok: false, errors: ["fixture quota source failed"] })); return; }
  let body;
  if (request.method === "POST") {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { body = {}; }
  }
  let result = {};
  if (url.pathname === "/health") result = { ok: true, service: "integrated-power-broker", schemaVersion: 2, capabilities };
  else if (url.pathname === "/v1/capabilities") result = { capabilities };
  else if (url.pathname === "/v1/tasks") result = { ok: true, tasks: [], activeCount: 0, errors: [], source: "fixture" };
  else if (url.pathname === "/v1/approvals") result = { ok: true, approvals: [], errors: [], source: "fixture" };
  else if (url.pathname === "/v1/tokens/status") result = { ok: true, forced: url.searchParams.has("force"), tokenStatus: tokenFixtureMode === "zero" ? { ...tokenStatus, codexPercentage: 0, codexTokensLeft: 0, lastSync: new Date().toISOString() } : tokenStatus };
  else if (url.pathname === "/v1/runs") result = { ok: true, runs: [], activeCount: 0, errors: [], source: "fixture" };
  else if (url.pathname === "/v1/metrics/local-llm") result = { ok: true, metrics: [], errors: [], source: "fixture" };
  else if (url.pathname === "/v1/workspaces") result = { ok: true, workspaces: [], errors: [], source: "fixture" };
  else if (url.pathname === "/v1/settings/quota" && request.method === "GET") result = settings;
  else if (url.pathname === "/v1/settings/quota" && request.method === "POST") result = { ...settings, revision: settings.revision + 1, settings: body?.settings || settings.settings };
  else if (url.pathname === "/v1/notifications/quota-refill") result = { ok: true, notifications: [], source: "fixture", errors: [] };
  else if (url.pathname === "/v1/tokens/prewarm") { if (request.method === "POST") prewarmRequests.push(body); result = { ok: true }; }
  else if (url.pathname === "/v1/autostart") result = { ok: true, enabled: false };
  else if (url.pathname === "/v1/logs") result = { ok: true, lines: [], path: "" };
  else if (url.pathname === "/v1/hub/overview") result = hubOverview;
  else if (url.pathname === "/v1/hub/ecosystem") result = hubOverview.ecosystem;
  else if (url.pathname === "/v1/hub/todos") result = { todos: hubOverview.todos };
  else if (url.pathname === "/v1/hub/playbooks") result = { playbooks: hubOverview.playbooks };
  else if (url.pathname === "/v1/hub/config" && request.method === "GET") result = hubOverview.config;
  else if (url.pathname === "/v1/hub/config" && (request.method === "PUT" || request.method === "POST")) result = { ...hubOverview.config, ...(body || {}) };
  else if (url.pathname === "/v1/hub/ingest" && request.method === "POST") result = { ok: true, todo: { id: "todo-new", ...body } };
  else if (url.pathname === "/v1/hub/todos/sync") result = { ok: true, synced: hubOverview.todos.length };
  else if (url.pathname.match(/^\/v1\/hub\/todos\/[^/]+\/clarify$/)) result = { ok: true, todo: hubOverview.todos[1] };
  else if (url.pathname.match(/^\/v1\/hub\/todos\/[^/]+\/dispatch$/)) result = { ok: true, taskId: "task-dispatched" };
  response.writeHead(200).end(JSON.stringify(result));
});

let fixtureHtml = "";
const web = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
  if (pathname === "/__compact") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(fixtureHtml); return; }
  const file = path.resolve(dist, `.${pathname === "/" ? "/index.html" : pathname}`);
  if (!file.startsWith(`${dist}${path.sep}`) && file !== path.join(dist, "index.html")) { response.writeHead(403).end(); return; }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(response);
});

async function listen(server) {
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  return server.address().port;
}

function captureDom(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(chrome, args, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks = [];
    const timeout = setTimeout(() => child.kill(), 20000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks).toString("utf8");
      if (code !== 0) reject(new Error(`Chromium exited ${code}; stdout: ${output.slice(-1200)}`));
      else resolve(output);
    });
  });
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "ip-desktop-compact-"));
  try {
    const brokerPort = await listen(broker);
    const webPort = await listen(web);
    const appUrl = `http://127.0.0.1:${webPort}/?broker=${brokerPort}`;
    const tabs = ["tokens", "home", "agents", "tasks", "logs", "settings"];
    fixtureHtml = `<!doctype html><html><head><meta charset="utf-8"><title>pending</title><style>html,body{margin:0;padding:0;width:100vw;height:100vh;overflow:hidden}iframe{border:0;height:100vh;display:block}</style></head><body><iframe id="app" src="${appUrl}"></iframe><script>
const tabs=${JSON.stringify(tabs)}; const frame=document.getElementById("app"); const waits=(ms)=>new Promise(r=>setTimeout(r,ms));
(async()=>{await new Promise(resolve=>frame.addEventListener("load",resolve,{once:true})); await waits(1200); const doc=frame.contentDocument; const results=[];
for(const width of [199,160,120]){frame.style.width=width+"px"; await waits(120); for(const tab of tabs){doc.getElementById("nav-"+tab)?.click(); await waits(40); const visible=[...doc.querySelectorAll("body *")].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=="hidden"); const outside=visible.filter(e=>{const r=e.getBoundingClientRect();return r.left < -1 || r.right > width+1;}).map(e=>({tag:e.tagName,cls:String(e.className||""),text:(e.innerText||"").slice(0,50),left:Math.round(e.getBoundingClientRect().left),right:Math.round(e.getBoundingClientRect().right)})); const controls=[...doc.querySelectorAll("button,input,textarea,select,a")].filter(e=>e.getClientRects().length); const clipped=controls.flatMap(e=>{const r=e.getBoundingClientRect();for(let p=e.parentElement;p&&p!==doc.body;p=p.parentElement){const ov=getComputedStyle(p).overflowX,pr=p.getBoundingClientRect();if((ov==="hidden"||ov==="clip")&&(r.left<pr.left-1||r.right>pr.right+1))return [{label:(e.innerText||e.getAttribute("aria-label")||e.value||"").slice(0,40),ancestor:String(p.className||p.tagName)}]}return []}); const buttonOverflow=controls.filter(e=>e.tagName==="BUTTON"&&e.scrollWidth>e.clientWidth+1).map(e=>({label:e.innerText,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})); const multilineButtons=controls.filter(e=>e.classList.contains("prewarm-action")).flatMap(button=>{const range=doc.createRange();range.selectNodeContents(button);const lines=[...new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)))];return lines.length>1?[{label:button.innerText,lines}]:[]}); const prewarmTitle=tab==="tokens"?doc.getElementById("prewarm-gemini-5h")?.title:""; const gaugeIds=["gemini-5h","gemini-weekly","opus-5h","opus-weekly","codex-5h","codex-weekly"]; const gauges=tab==="tokens"?gaugeIds.map(id=>{const track=doc.getElementById("bar-"+id)?.parentElement;const ticks=track?.querySelector(".progress-ticks");return {segments:Number(ticks?.dataset.segments),trackClientWidth:track?.clientWidth,tickWidth:ticks?.getBoundingClientRect().width,fillWidth:track?.querySelector(".progress-fill")?.getBoundingClientRect().width,unavailable:doc.getElementById("label-"+id)?.textContent==="쿼터 대기 중",background:getComputedStyle(ticks).backgroundImage}}):[]; results.push({width,tab,scrollWidth:doc.documentElement.scrollWidth,clientWidth:doc.documentElement.clientWidth,outside,clipped,buttonOverflow,multilineButtons,controls:controls.length,prewarmTitle,gauges});}}
doc.getElementById("nav-tokens")?.click(); await waits(80); doc.querySelector(".prewarm-mode-btn")?.click(); await waits(100); const actionButtons=[...doc.querySelectorAll("[data-prewarm-window]")]; const actionStates=actionButtons.map(button=>({model:button.dataset.prewarmWindow,disabled:button.disabled,title:button.title})); actionButtons.forEach(button=>button.click()); await waits(300); const legacyToast=doc.getElementById("toast")?.textContent||""; const codexCountdown=doc.getElementById("reset-codex-5h")?.textContent||"";
frame.style.width="900px"; doc.getElementById("nav-tokens")?.click(); await waits(120);
const wideLabels=[...doc.querySelectorAll(".provider-toggle,.provider-state-tag,.status-pill,.prewarm-action")].filter(e=>e.getClientRects().length).map(e=>{const range=doc.createRange();range.selectNodeContents(e);const lines=[...new Set([...range.getClientRects()].map(rect=>Math.round(rect.top)))];return {label:(e.innerText||"").trim(),overflow:e.tagName==="BUTTON"&&e.scrollWidth>e.clientWidth+1,lines};}).filter(item=>item.overflow||item.lines.length>1);
const title=doc.querySelector(".banner-left h2"); const titleWordBreak=title?getComputedStyle(title).wordBreak:"";
doc.getElementById("toast")?.style.setProperty("display","none");
await fetch('http://127.0.0.1:${brokerPort}/__fixture/tokens/fail'); doc.getElementById("token-refresh-btn")?.click(); await waits(450);
const failedQuota={label:doc.getElementById("label-codex-5h")?.textContent||"",actions:[...doc.querySelectorAll("[data-prewarm-window]")].map(b=>({disabled:b.disabled,title:b.title})),gaugeTicks:doc.getElementById("bar-codex-5h")?.parentElement?.querySelector(".progress-ticks")?.dataset.segments};
await fetch('http://127.0.0.1:${brokerPort}/__fixture/tokens/recover'); doc.getElementById("token-refresh-btn")?.click(); await waits(450);
const recoveredQuota={label:doc.getElementById("label-codex-5h")?.textContent||"",disabled:doc.getElementById("prewarm-codex-5h")?.disabled};
document.title=JSON.stringify({results,legacyToast,actionStates,codexCountdown,wideLabels,titleWordBreak,failedQuota,recoveredQuota});})();</script></body></html>`;
    const launcher = [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--allow-file-access-from-files", "--no-first-run",
      "--disable-default-apps", "--disable-background-networking", "--password-store=basic", "--window-size=900,1000", "--virtual-time-budget=8000", "--run-all-compositor-stages-before-draw", "--dump-dom", `--user-data-dir=${temp}`,
      `http://127.0.0.1:${webPort}/__compact`,
    ];
    if (process.env.IP_PARITY_SCREENSHOT_PATH) {
      fs.mkdirSync(path.dirname(process.env.IP_PARITY_SCREENSHOT_PATH), { recursive: true });
      launcher.splice(launcher.length - 1, 0, `--screenshot=${process.env.IP_PARITY_SCREENSHOT_PATH}`);
    }
    const dom = await captureDom(launcher);
    const raw = dom.match(/<title>(.*?)<\/title>/s)?.[1];
    assert(raw, "Chromium returned no desktop layout report.");
    const { results: report, legacyToast, actionStates, codexCountdown, wideLabels, titleWordBreak, failedQuota, recoveredQuota } = JSON.parse(raw.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
    assert.equal(report.length, 18, "all six tabs must be measured at all three widths");
    for (const item of report) {
      assert(item.scrollWidth <= item.clientWidth, `horizontal page overflow: ${JSON.stringify(item)}`);
      assert.equal(item.outside.length, 0, `visible leaf/control bounds exceed ${item.width}px on ${item.tab}: ${JSON.stringify(item.outside)}`);
      assert.equal(item.clipped.length, 0, `control is clipped at ${item.width}px on ${item.tab}: ${JSON.stringify(item.clipped)}`);
      assert.equal(item.buttonOverflow.length, 0, `button text overflows at ${item.width}px on ${item.tab}: ${JSON.stringify(item.buttonOverflow)}`);
      assert.equal(item.multilineButtons.length, 0, `button label wraps at ${item.width}px on ${item.tab}: ${JSON.stringify(item.multilineButtons)}`);
    }
    for (const item of report.filter((entry) => entry.tab === "tokens")) {
      assert(item.prewarmTitle.includes("요청합니다") && item.prewarmTitle.includes("확인되지 않습니다"), `prewarm tooltip must describe dispatch without promising timer confirmation: ${item.prewarmTitle}`);
      assert(!item.prewarmTitle.includes("보존"), `prewarm tooltip must not promise a quota preservation percentage: ${item.prewarmTitle}`);
      assert.equal(item.gauges.length, 6, "desktop must render all six quota gauges");
      for (const [index, gauge] of item.gauges.entries()) {
        const segments = index % 2 === 1 ? 7 : 5;
        assert.equal(gauge.segments, segments, `desktop gauge ${index} must have ${segments} segments`);
        assert(Math.abs(gauge.trackClientWidth - gauge.tickWidth) < 1, `desktop gauge ${index} ticks must cover the full track: ${JSON.stringify(gauge)}`);
        assert(gauge.background.includes("linear-gradient") && (gauge.background.match(/rgba\(255, 255, 255, 0\.55\)/g) || []).length === (segments - 1) * 2, `desktop gauge ${index} computed gradient must retain the shared ${segments}-segment positions`);
      }
    }
    assert.equal(actionStates.length, 4, `desktop must render a separate trigger button for each canonical model: ${JSON.stringify(actionStates)}`);
    assert.deepEqual(actionStates.map((button) => button.model).sort(), ["antigravity", "argon", "codex", "opus"]);
    assert(actionStates.every((button) => !button.disabled && button.title.includes("확인되지 않습니다")), `Ready model action buttons must be enabled with truthful titles: ${JSON.stringify(actionStates)}`);
    assert.deepEqual(prewarmRequests.map((request) => request.model).sort(), ["antigravity", "argon", "codex", "opus"], "mode selection must not trigger prewarm; each separate action button must call its model through the fake broker");
    assert(codexCountdown.includes("Ready") || codexCountdown.includes("Refreshes in"), `ChatGPT 5h countdown/status element must be restored: ${codexCountdown}`);
    assert.equal(wideLabels.length, 0, `provider controls and status labels must remain single-line at the normal 900px desktop viewport: ${JSON.stringify(wideLabels)}`);
    assert.equal(titleWordBreak, "keep-all", "Korean token heading must wrap between words, not split Korean words");
    assert(legacyToast.includes("구형 브로커가 요청을 접수했습니다") && legacyToast.includes("확인되지 않습니다"), `legacy prewarm response must be acknowledged without claiming execution: ${legacyToast}`);
    assert(!failedQuota.label.includes("100%") && !failedQuota.label.includes("100.00%"), `quota HTTP 500 must not retain a fresh-looking prior percentage: ${JSON.stringify(failedQuota)}`);
    assert(failedQuota.actions.every((button) => button.disabled), `quota HTTP 500 must disable prewarm actions: ${JSON.stringify(failedQuota)}`);
    assert.equal(failedQuota.gaugeTicks, "5", "unavailable quota must retain its gauge track and ticks");
    assert.match(recoveredQuota.label, /\b0(?:\.0+)?%/, `a fresh exhausted value must recover as actual 0%: ${JSON.stringify(recoveredQuota)}`);
    assert.equal(recoveredQuota.disabled, true, "fresh exhausted quota must not allow prewarm");
    console.log(JSON.stringify({ checks: report.length, widths: [199, 160, 120], tabs, violations: 0 }));
  } finally {
    await Promise.all([new Promise((resolve) => broker.close(resolve)), new Promise((resolve) => web.close(resolve))]);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
