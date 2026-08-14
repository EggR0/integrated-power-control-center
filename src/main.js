import "./style.css";

const API = "http://127.0.0.1:37241";
const streams = new Map();
const state = {
  capabilities: [],
  mainProvider: "google.antigravity.ide",
  brokerOnline: false,
  retryTimer: undefined,
  refreshPromise: undefined,
};

const defaults = [
  { provider: "google.antigravity.ide", label: "Antigravity IDE / Agy", mode: "cli", capabilities: ["leader", "executor"], available: false, reason: "연결 대기중" },
  { provider: "local.openai-compatible", label: "로컬 Qwen 3.6 27B", mode: "local", capabilities: ["executor", "local-mcp"], available: false, model: "qwen3.6:27b", reason: "연결 대기중" },
  { provider: "openai.codex.app", label: "Codex App Server", mode: "app-server", capabilities: ["leader", "executor"], available: false, reason: "연결 대기중" },
];

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = String(text); if (className) value.className = className; return value; };
const button = (text, className, data = {}) => { const value = node("button", text, className); Object.assign(value.dataset, data); return value; };
const safeText = (value, fallback = "-") => value === undefined || value === null || value === "" ? fallback : String(value);

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 12000);
  try {
    const response = await fetch(`${API}${path}`, { ...options, signal: controller.signal, headers: { "content-type": "application/json", ...(options.headers || {}) } });
    const text = await response.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    return body;
  } finally { clearTimeout(timer); }
}

function setConnection(kind, message) {
  state.brokerOnline = kind === "online";
  const dot = $("connection-dot");
  dot.className = `connection-dot ${kind === "online" ? "online" : "offline"}`;
  $("connection-label").textContent = message;
}

function preferredCapability(capabilities) {
  const order = ["google.antigravity.ide", "local.openai-compatible", "openai.codex.app"];
  return order.map((provider) => capabilities.find((item) => item.provider === provider)).find(Boolean) || capabilities[0] || defaults[0];
}

function currentCapabilities() {
  const values = state.capabilities.length ? state.capabilities : defaults;
  return defaults.map((fallback) => values.find((item) => item.provider === fallback.provider) || fallback)
    .concat(values.filter((item) => !defaults.some((fallback) => fallback.provider === item.provider)));
}

let toastTimer;
function showToast(message, isError = false) {
  const toast = $("toast");
  if (!toast) return;
  toast.textContent = message;
  toast.style.borderColor = isError ? "#f59f8e" : "#50a8d8";
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4000);
}

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch (error) {
    showToast("클립보드 복사 실패: " + error.message, true);
  }
}

async function getMcpSnippet(kind = "mcp") {
  try {
    const res = await api(`/v1/integrations/${kind}/spec`);
    return JSON.stringify(res.snippet || { mcpServers: { "integrated-power": res.spec } }, null, 2);
  } catch (error) {
    return JSON.stringify({
      mcpServers: {
        "integrated-power": {
          command: "node",
          args: ["control-center/mcp-server.js"]
        }
      }
    }, null, 2);
  }
}

function renderMainAgent() {
  const capabilities = currentCapabilities();
  let selected = capabilities.find((item) => item.provider === state.mainProvider);
  if (!selected) { selected = preferredCapability(capabilities); state.mainProvider = selected.provider; }
  const select = $("main-agent-select");
  select.replaceChildren();
  for (const capability of capabilities) {
    const option = node("option", capability.label || capability.provider);
    option.value = capability.provider;
    option.selected = capability.provider === state.mainProvider;
    select.append(option);
  }
  $("main-agent-name").textContent = selected.label || selected.provider;
  const pill = $("main-agent-status");
  pill.textContent = selected.available ? "연결 가능" : "연결 대기중";
  pill.className = `status-pill ${selected.available ? "online" : "waiting"}`;
  const endpoint = selected.endpoint || selected.reason || "공식 연결 경로 확인 중";
  $("main-agent-detail").textContent = `연결 방식: ${safeText(selected.mode)} · 대상 ID: ${selected.provider} · ${endpoint}`;
  $("selected-agent-hint").textContent = `현재 메인 대상: ${selected.label || selected.provider}`;

  const actions = $("main-agent-actions");
  if (actions) {
    actions.replaceChildren();
    if (selected.provider === "openai.chatgpt.app") {
      actions.append(button("📋 ChatGPT MCP 설정 복사", "button primary copy-chatgpt-mcp"));
    } else if (selected.provider === "anthropic.claude.desktop") {
      actions.append(button("⚡ Claude Desktop 자동 등록", "button primary register-claude"), button("📋 설정 JSON 복사", "button secondary copy-claude-mcp"));
    } else {
      actions.append(button("📋 MCP 설정 JSON 복사", "button secondary copy-generic-mcp"));
    }
  }
}

function renderAgents() {
  const target = $("agent-list");
  target.replaceChildren();
  for (const item of currentCapabilities()) {
    const card = node("article", undefined, "agent-card card");
    const heading = node("div", undefined, "agent-heading");
    heading.append(node("strong", item.label || item.provider));
    const pill = node("span", item.available ? "사용 가능" : "대기중", `status-pill ${item.available ? "online" : "waiting"}`);
    heading.append(pill);
    card.append(heading);
    card.append(node("div", `${item.provider} · ${item.mode || "bridge"}`, "agent-meta"));
    card.append(node("div", item.model ? `모델: ${item.model}` : safeText(item.reason, "공식 연결 경로"), "agent-meta"));
    if (item.provider === "openai.chatgpt.app") {
      const act = node("div", undefined, "agent-quick-actions");
      act.append(button("📋 MCP 복사", "button secondary copy-chatgpt-mcp"));
      card.append(act);
    } else if (item.provider === "anthropic.claude.desktop") {
      const act = node("div", undefined, "agent-quick-actions");
      act.append(button("⚡ 자동 등록", "button primary register-claude"));
      card.append(act);
    }
    target.append(card);
  }
}

function renderTasks(tasks) {
  const target = $("tasks");
  target.replaceChildren();
  if (!tasks.length) { target.append(node("div", "아직 등록된 작업이 없습니다.", "empty-card")); return; }
  for (const task of tasks) {
    const card = node("article", undefined, "task-card");
    card.append(node("strong", task.title));
    card.append(node("p", task.goal));
    card.append(node("div", `${task.status} · rev ${task.revision} · ${task.originProvider}`, "muted"));
    const actions = node("div", undefined, "task-actions");
    actions.append(button("선택 에이전트에 위임", "button primary delegate", { task: task.id, revision: task.revision }));
    if (task.status === "running") actions.append(button("중단", "button secondary cancel", { task: task.id, revision: task.revision }));
    if (task.isolatedWorkspacePath) actions.append(button("병합 승인 요청", "button secondary request-merge", { task: task.id, revision: task.revision }));
    card.append(actions);
    target.append(card);
  }
}

function renderApprovals(approvals) {
  const target = $("approvals");
  target.replaceChildren();
  if (!approvals.length) { target.append(node("div", "현재 승인 요청이 없습니다.", "empty-card")); return; }
  for (const approval of approvals) {
    const card = node("article", undefined, "approval-card");
    card.append(node("strong", approval.action));
    card.append(node("p", approval.description));
    card.append(button("승인", "button primary approve", { approval: approval.id, revision: approval.expectedRevision }));
    target.append(card);
  }
}

function showError(error) {
  $("status").textContent = `오류: ${error instanceof Error ? error.message : String(error)}`;
  $("status").className = "off";
}

async function refresh() {
  if (state.refreshPromise) return state.refreshPromise;
  state.refreshPromise = (async () => {
    setConnection("offline", "브로커 연결 확인 중…");
    try {
      const capabilities = await api("/v1/capabilities");
      state.capabilities = capabilities.capabilities || [];
      setConnection("online", "브로커 연결됨");
      renderMainAgent();
      renderAgents();
      const [tasks, approvals] = await Promise.all([api("/v1/tasks"), api("/v1/approvals")]);
      renderTasks(tasks.tasks || []);
      renderApprovals(approvals.approvals || []);
      $("status").textContent = `마지막 동기화 ${new Date().toLocaleTimeString()} · ${state.capabilities.filter((item) => item.available).length}개 연결 가능`;
      $("status").className = "muted";
      for (const task of tasks.tasks || []) attachAgUiStream(task.id);
    } catch (error) {
      state.capabilities = [];
      renderMainAgent();
      renderAgents();
      setConnection("offline", "브로커 연결 대기중");
      $("status").textContent = "브로커가 아직 시작되지 않았습니다. 잠시 후 자동으로 다시 연결합니다.";
      $("status").className = "off";
      if (!state.retryTimer) state.retryTimer = setTimeout(() => { state.retryTimer = undefined; void refresh(); }, 3500);
    } finally { state.refreshPromise = undefined; }
  })();
  return state.refreshPromise;
}

async function loadLogs() {
  $("log-lines").textContent = "로그를 불러오는 중…";
  try {
    const result = await api("/v1/logs?lines=220");
    $("log-path").textContent = result.path ? `저장 위치: ${result.path}` : "loopback 브로커 로그";
    $("log-lines").textContent = result.lines?.length ? result.lines.join("\n") : "아직 기록된 로그가 없습니다.";
  } catch (error) { $("log-path").textContent = "브로커 연결 대기중"; $("log-lines").textContent = `로그를 열 수 없습니다.\n${error.message}`; }
}

function toggleLogs(open) {
  $("log-panel").classList.toggle("hidden", !open);
  $("log-panel").setAttribute("aria-hidden", String(!open));
  if (open) void loadLogs();
}

function bindEvents() {
  $("connection-refresh").onclick = () => void refresh();
  $("agent-refresh").onclick = () => void refresh();
  $("main-agent-connect").onclick = () => void refresh();
  $("main-agent-select").onchange = (event) => { state.mainProvider = event.target.value; renderMainAgent(); };
  $("log-button").onclick = () => toggleLogs(true);
  $("nav-logs").onclick = () => toggleLogs(true);
  $("close-logs").onclick = () => toggleLogs(false);
  $("log-refresh").onclick = () => void loadLogs();
  $("log-panel").onclick = (event) => { if (event.target === $("log-panel")) toggleLogs(false); };
  for (const control of document.querySelectorAll(".nav-link")) control.onclick = () => { for (const item of document.querySelectorAll(".nav-link")) item.classList.toggle("active", item === control); $(control.dataset.section)?.scrollIntoView({ behavior: "smooth", block: "start" }); };
  $("create").onclick = async () => { try { await api("/v1/tasks", { method: "POST", body: JSON.stringify({ title: $("title").value, goal: $("goal").value, workspacePath: $("workspace").value || undefined, originProvider: state.mainProvider, privacy: "private" }) }); await refresh(); } catch (error) { showError(error); } };
  document.addEventListener("click", async (event) => {
    const control = event.target.closest("button");
    if (!control) return;
    try {
      if (control.classList.contains("delegate")) await api("/v1/tasks/delegate", { method: "POST", body: JSON.stringify({ taskId: control.dataset.task, provider: state.mainProvider, prompt: $("goal").value, expectedRevision: Number(control.dataset.revision) }) });
      else if (control.classList.contains("cancel")) await api(`/v1/tasks/${encodeURIComponent(control.dataset.task)}/cancel`, { method: "POST", body: JSON.stringify({ expectedRevision: Number(control.dataset.revision) }) });
      else if (control.classList.contains("approve")) await api(`/v1/approvals/${encodeURIComponent(control.dataset.approval)}/approve`, { method: "POST", body: JSON.stringify({ expectedRevision: Number(control.dataset.revision) }) });
      else if (control.classList.contains("request-merge")) await api("/v1/approvals", { method: "POST", body: JSON.stringify({ taskId: control.dataset.task, action: "merge", description: "격리 작업공간 변경사항을 기본 브랜치에 병합", requestedBy: "user", expectedRevision: Number(control.dataset.revision) }) });
      else if (control.classList.contains("copy-chatgpt-mcp")) {
        const text = await getMcpSnippet("chatgpt");
        await copyToClipboard(text, "ChatGPT용 MCP 설정 JSON이 복사되었습니다! ChatGPT Settings > Connectors에 붙여넣으세요.");
      } else if (control.classList.contains("copy-claude-mcp")) {
        const text = await getMcpSnippet("claude");
        await copyToClipboard(text, "Claude용 MCP 설정 JSON이 복사되었습니다.");
      } else if (control.classList.contains("copy-generic-mcp")) {
        const text = await getMcpSnippet("mcp");
        await copyToClipboard(text, "표준 MCP 설정 JSON이 복사되었습니다.");
      } else if (control.classList.contains("register-claude")) {
        try {
          const res = await api("/v1/integrations/claude/register", { method: "POST", body: JSON.stringify({ confirm: true }) });
          showToast(`Claude Desktop에 Integrated Power MCP가 등록되었습니다 (${res.changed ? "신규 등록" : "이미 최신"}). Claude를 재시작하세요.`);
          await refresh();
        } catch (err) {
          showToast(`Claude 자동 등록 실패: ${err.message}`, true);
        }
      } else return;
      await refresh();
    } catch (error) { showError(error); }
  });
}

function attachAgUiStream(taskId) {
  if (streams.has(taskId) || !state.brokerOnline) return;
  const source = new EventSource(`${API}/v1/tasks/${encodeURIComponent(taskId)}/stream`);
  streams.set(taskId, source);
  source.onerror = () => { source.close(); streams.delete(taskId); };
}

bindEvents();
renderMainAgent();
renderAgents();
void refresh();
