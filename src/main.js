import "./style.css";

const API = "http://127.0.0.1:37241";
const streams = new Map();

const state = {
  capabilities: [],
  tasks: [],
  approvals: [],
  tokenStatus: null,
  previousTokenStatus: null,
  lastFullNotified: false,
  notifyOnFullTokens: localStorage.getItem("ip_notify_full_tokens") !== "false",
  pollInterval: Number(localStorage.getItem("ip_poll_interval")) || 5000,
  autoStartEnabled: false,
  logs: { path: "", lines: [] },
  mainProvider: "google.antigravity.ide",
  brokerOnline: false,
  activeTab: "tokens", // DEFAULT ACTIVE TAB
};

const defaults = [
  { provider: "google.antigravity.ide", label: "Antigravity IDE / Agy", mode: "cli", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "local.openai-compatible", label: "로컬 Qwen 3.6 27B", mode: "local", capabilities: ["executor", "local-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", model: "qwen3.6:27b", reason: "확인중" },
  { provider: "openai.codex.app", label: "Codex App Server", mode: "app-server", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "openai.chatgpt.app", label: "ChatGPT desktop/web MCP app", mode: "gui", capabilities: ["leader", "remote-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "anthropic.claude.desktop", label: "Claude Desktop local MCP", mode: "gui", capabilities: ["leader", "local-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "google.antigravity.app", label: "Antigravity", mode: "gui", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "anthropic.cowork", label: "Claude Cowork", mode: "gui", capabilities: ["leader"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "미지원" },
  { provider: "xai.grok", label: "xAI Grok", mode: "gui", capabilities: ["leader"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "미지원" },
];

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const value = document.createElement(tag);
  if (text !== undefined) value.textContent = String(text);
  if (className) value.className = className;
  return value;
};
const button = (text, className, data = {}) => {
  const value = node("button", text, className);
  Object.assign(value.dataset, data);
  return value;
};
const safeText = (value, fallback = "-") => (value === undefined || value === null || value === "" ? fallback : String(value));

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? 10000);
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(options.headers || {}) },
    });
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
  if (dot) dot.className = `connection-dot ${kind === "online" ? "online" : "offline"}`;
  const label = $("connection-label");
  if (label) label.textContent = message;
  const statBroker = $("stat-broker");
  if (statBroker) statBroker.textContent = kind === "online" ? "정상 가동 (37241)" : "연결 끊김";
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
  toast.style.borderColor = isError ? "#f43f5e" : "#38bdf8";
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 3800);
}

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg);
  } catch (error) {
    showToast("클립보드 복사 실패: " + error.message, true);
  }
}

function requestNotificationPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

function sendDesktopNotification(title, body) {
  if (!state.notifyOnFullTokens) return;
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, {
        body,
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚡</text></svg>",
      });
    } catch {
      // Fallback
    }
  }
}

function playFullChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();
    osc1.type = "sine";
    osc2.type = "triangle";
    osc1.frequency.setValueAtTime(587.33, ctx.currentTime);
    osc1.frequency.setValueAtTime(880, ctx.currentTime + 0.15);
    osc2.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(ctx.destination);
    osc1.start();
    osc2.start();
    osc1.stop(ctx.currentTime + 0.85);
    osc2.stop(ctx.currentTime + 0.85);
  } catch {
    // ignore
  }
}

function checkTokenFullNotification(previous, current) {
  if (!current || !state.notifyOnFullTokens) return;

  const agy = current.antigravityPercentage ?? 100;
  const opus = current.opusPercentage ?? 100;
  const codex = current.codexWeeklyPercentage ?? 100;

  const isAllFull = agy >= 100 && opus >= 100 && codex >= 100;
  const wasAnyDepleted = previous
    ? (previous.antigravityPercentage !== undefined && previous.antigravityPercentage < 100) ||
      (previous.opusPercentage !== undefined && previous.opusPercentage < 100) ||
      (previous.codexWeeklyPercentage !== undefined && previous.codexWeeklyPercentage < 100)
    : false;

  if (isAllFull) {
    if (wasAnyDepleted && !state.lastFullNotified) {
      state.lastFullNotified = true;
      playFullChime();
      const msg = "모든 AI 모델 쿼터(Gemini, Claude, Codex)가 100%로 완충되었습니다! 작업을 최대 속도로 진행할 수 있습니다.";
      showToast(`🎉 [100% 완충] ${msg}`);
      sendDesktopNotification("🎉 [Integrated Power] AI 토큰 100% 충전 완료", msg);
    }
  } else {
    state.lastFullNotified = false;
  }
}

function switchTab(targetTab) {
  state.activeTab = targetTab;
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.classList.toggle("active", link.dataset.section === targetTab);
  });
  document.querySelectorAll(".view-section").forEach((sec) => {
    sec.classList.toggle("active", sec.id === `view-${targetTab}`);
  });

  const titles = {
    tokens: { eyebrow: "AI 쿼터 및 토큰 실시간 관제", title: "AI 모델 쿼터 현황 및 리셋 주기" },
    home: { eyebrow: "통합 관제 센터", title: "PC 상태와 AI 작업을 한곳에서" },
    agents: { eyebrow: "에이전트 관리", title: "연결된 AI 에이전트 현황 및 진단" },
    tasks: { eyebrow: "작업 및 승인", title: "멀티 에이전트 작업 위임 및 승인 관리" },
    logs: { eyebrow: "실시간 진단", title: "Integrated Power 브로커 로그" },
    settings: { eyebrow: "환경 설정", title: "네트워크, 시작 프로그램 및 알림 설정" },
  };

  const current = titles[targetTab] || titles.tokens;
  if ($("page-eyebrow")) $("page-eyebrow").textContent = current.eyebrow;
  if ($("page-title")) $("page-title").textContent = current.title;

  if (targetTab === "logs") void refreshLogs();
}

function formatCountdown(resetTimeStr) {
  if (!resetTimeStr) return "";
  const target = Date.parse(resetTimeStr);
  if (Number.isNaN(target)) return `· ${resetTimeStr}`;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "· Refreshes soon (100%)";
  const totalMinutes = Math.floor(diffMs / (1000 * 60));
  const totalHours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (totalHours >= 48) {
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return `· Refreshes in ${days}d ${remHours}h`;
  }
  return `· Refreshes in ${totalHours}h ${mins}m`;
}

function renderTokens() {
  const ts = state.tokenStatus || {};
  const agy5h = ts.antigravityPercentage;
  const agyWeekly = ts.antigravityWeeklyPercentage;
  const opus5h = ts.opusPercentage;
  const opusWeekly = ts.opusWeeklyPercentage;
  const codex5h = ts.codexPercentage;
  const codexWeekly = ts.codexWeeklyPercentage;

  // 1. Antigravity IDE - Gemini 3.1 Pro
  if ($("label-gemini-5h")) $("label-gemini-5h").textContent = agy5h !== undefined ? `${agy5h.toFixed(2)}% remaining` : "Waiting for quota";
  if ($("reset-gemini-5h")) $("reset-gemini-5h").textContent = formatCountdown(ts.antigravityResetTime);
  if ($("bar-gemini-5h")) $("bar-gemini-5h").style.width = `${Math.max(0, Math.min(100, agy5h ?? 0))}%`;

  if ($("label-gemini-weekly")) $("label-gemini-weekly").textContent = agyWeekly !== undefined ? `${agyWeekly.toFixed(2)}% remaining` : "Waiting for quota";
  if ($("reset-gemini-weekly")) $("reset-gemini-weekly").textContent = formatCountdown(ts.antigravityWeeklyResetTime);
  if ($("bar-gemini-weekly")) $("bar-gemini-weekly").style.width = `${Math.max(0, Math.min(100, agyWeekly ?? 0))}%`;

  // 2. Antigravity IDE - Opus 4.6 Thinking
  if ($("label-opus-5h")) $("label-opus-5h").textContent = opus5h !== undefined ? `${opus5h.toFixed(2)}% remaining` : "Waiting for quota";
  if ($("reset-opus-5h")) $("reset-opus-5h").textContent = formatCountdown(ts.opusResetTime);
  if ($("bar-opus-5h")) $("bar-opus-5h").style.width = `${Math.max(0, Math.min(100, opus5h ?? 0))}%`;

  if ($("label-opus-weekly")) $("label-opus-weekly").textContent = opusWeekly !== undefined ? `${opusWeekly.toFixed(2)}% remaining` : "Waiting for quota";
  if ($("reset-opus-weekly")) $("reset-opus-weekly").textContent = formatCountdown(ts.opusWeeklyResetTime);
  if ($("bar-opus-weekly")) $("bar-opus-weekly").style.width = `${Math.max(0, Math.min(100, opusWeekly ?? 0))}%`;

  // 3. OpenAI (ChatGPT + Codex)
  if ($("label-codex-5h")) $("label-codex-5h").textContent = codex5h !== undefined ? `${codex5h.toFixed(2)}% remaining` : "Waiting for quota data";
  if ($("reset-codex-5h")) $("reset-codex-5h").textContent = formatCountdown(ts.codexResetTime);
  if ($("bar-codex-5h")) $("bar-codex-5h").style.width = codex5h !== undefined ? `${Math.max(0, Math.min(100, codex5h))}%` : "0%";

  if ($("label-codex-weekly")) $("label-codex-weekly").textContent = codexWeekly !== undefined ? `${codexWeekly.toFixed(2)}% remaining` : "Waiting for quota data";
  if ($("reset-codex-weekly")) $("reset-codex-weekly").textContent = formatCountdown(ts.codexWeeklyResetTime);
  if ($("bar-codex-weekly")) {
    const pct = codexWeekly ?? 0;
    $("bar-codex-weekly").style.width = codexWeekly !== undefined ? `${Math.max(0, Math.min(100, pct))}%` : "0%";
    if (codexWeekly !== undefined && pct < 20) $("bar-codex-weekly").classList.add("warning");
    else $("bar-codex-weekly").classList.remove("warning");
  }

  const codexTag = $("codex-status-tag");
  if (codexTag) {
    codexTag.textContent = ts.codexState || "Idle";
    codexTag.className = `provider-state-tag ${ts.codexState === "working" ? "online" : ""}`;
  }

  // 4. Task Routing & Status Tags
  const routing = ts.taskRouting || ts.recommendedTaskWeight || "degraded";
  const routingBadge = $("task-routing-badge");
  if (routingBadge) {
    routingBadge.className = `task-routing-pill ${routing}`;
    routingBadge.textContent = routing;
  }

  // 5. Anthropic Claude Direct Usage
  const du = ts.claudeDirectUsage || ts.directUsage;
  const hasClaudeData = du && ((du.sevenDaysTokens > 0) || (du.eventCount > 0) || (du.status === "measured") || (du.sevenDays?.eventCount > 0));
  
  const claudeTag = $("claude-status-tag");
  if (claudeTag) {
    claudeTag.textContent = hasClaudeData ? "Measured" : "No data";
    claudeTag.className = `provider-state-tag ${hasClaudeData ? "online" : ""}`;
  }

  const todayTok = du?.todayTokens ?? du?.today?.totalTokens ?? 0;
  const todayBillable = du?.todayPaidTokens ?? du?.today?.outputTokens ?? 0;
  const sevenDayTok = du?.sevenDaysTokens ?? du?.sevenDays?.totalTokens ?? 0;
  const sevenDayEvents = du?.eventCount ?? du?.sevenDays?.eventCount ?? 0;

  if ($("claude-today-tokens")) {
    const el = $("claude-today-tokens");
    el.replaceChildren();
    el.append(
      document.createTextNode(`${todayTok.toLocaleString()} `),
      node("span", "tokens", "unit-label")
    );
  }
  if ($("claude-today-billable")) $("claude-today-billable").textContent = todayBillable.toLocaleString();
  if ($("claude-7d-tokens")) {
    const el = $("claude-7d-tokens");
    el.replaceChildren();
    el.append(
      document.createTextNode(`${sevenDayTok.toLocaleString()} `),
      node("span", "tokens", "unit-label")
    );
  }
  if ($("claude-7d-events")) $("claude-7d-events").textContent = `${sevenDayEvents}건`;

  const sourcesList = Array.isArray(du?.sources) && du.sources.length ? du.sources.join(", ") : "No Claude API, CLI, or Cowork events found";
  if ($("claude-sources-text")) $("claude-sources-text").textContent = sourcesList;

  const lastUsedStr = du?.lastUsedAt || du?.lastMeasuredAt;
  if ($("claude-last-used")) {
    if (lastUsedStr) {
      try {
        const d = new Date(lastUsedStr);
        $("claude-last-used").textContent = Number.isNaN(d.getTime()) ? lastUsedStr : d.toLocaleTimeString();
      } catch {
        $("claude-last-used").textContent = lastUsedStr;
      }
    } else {
      $("claude-last-used").textContent = "Waiting for data";
    }
  }

  // 6. Local Compute & Multi-GPU
  const lcs = ts.localComputeStatus;
  const localTag = $("local-llm-status-tag");
  if (localTag) {
    const isOnline = lcs?.status === "online" || lcs?.status === "busy";
    localTag.textContent = isOnline ? (lcs.status === "busy" ? "Busy" : "Online") : "Offline";
    localTag.className = `provider-state-tag ${isOnline ? "online" : ""}`;
  }

  const gpuContainer = $("gpu-status-container");
  if (gpuContainer && lcs && Array.isArray(lcs.gpus) && lcs.gpus.length) {
    gpuContainer.replaceChildren();
    lcs.gpus.forEach((gpu) => {
      const vramPct = gpu.vramTotalMb > 0 ? Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 1000) / 10 : 0;
      const card = document.createElement("div");
      card.className = "gpu-block";
      card.style.marginTop = "8px";
      card.style.padding = "8px";
      card.style.background = "#0f172a";
      card.style.borderRadius = "8px";
      card.style.border = "1px solid rgba(255, 255, 255, 0.05)";

      const title = node("div", `GPU ${gpu.id}: ${gpu.name}`);
      title.style.fontWeight = "700";
      title.style.fontSize = "12px";
      title.style.color = "#f8fafc";
      title.style.marginBottom = "6px";
      card.append(title);

      const utilBox = node("div");
      utilBox.style.display = "flex";
      utilBox.style.flexDirection = "column";
      utilBox.style.gap = "2px";
      utilBox.style.marginBottom = "6px";

      const utilRow = node("div");
      utilRow.style.display = "flex";
      utilRow.style.justifyContent = "space-between";
      utilRow.style.fontSize = "11.5px";
      const utilLabel = node("span", "GPU Utilization");
      utilLabel.style.color = "#94a3b8";
      const utilVal = node("span", `${gpu.utilizationPercentage}% current load · `);
      utilVal.style.color = "#e2e8f0";
      utilVal.style.fontWeight = "600";
      const pwr = node("span", `${gpu.powerDrawW !== undefined ? gpu.powerDrawW.toFixed(2) + "W" : "-"} / ${gpu.powerLimitW !== undefined ? gpu.powerLimitW.toFixed(1) + "W" : "-"}`);
      pwr.style.color = "#38bdf8";
      utilVal.append(pwr);
      utilRow.append(utilLabel, utilVal);

      const utilTrack = node("div", undefined, "progress-track");
      utilTrack.style.height = "5px";
      const utilFill = node("div", undefined, "progress-fill local");
      utilFill.style.width = `${Math.max(0, Math.min(100, gpu.utilizationPercentage))}%`;
      utilTrack.append(utilFill);
      utilBox.append(utilRow, utilTrack);
      card.append(utilBox);

      const vramBox = node("div");
      vramBox.style.display = "flex";
      vramBox.style.flexDirection = "column";
      vramBox.style.gap = "2px";

      const vramRow = node("div");
      vramRow.style.display = "flex";
      vramRow.style.justifyContent = "space-between";
      vramRow.style.fontSize = "11.5px";
      const vramLabel = node("span", "VRAM Usage");
      vramLabel.style.color = "#94a3b8";
      const vramVal = node("span", `${vramPct}% used `);
      vramVal.style.color = "#e2e8f0";
      vramVal.style.fontWeight = "600";
      const vramSub = node("span", `(${(gpu.vramUsedMb / 1024).toFixed(1)} GB / ${(gpu.vramTotalMb / 1024).toFixed(1)} GB)`);
      vramSub.style.color = "#94a3b8";
      vramSub.style.fontSize = "10.5px";
      vramVal.append(vramSub);
      vramRow.append(vramLabel, vramVal);

      const vramTrack = node("div", undefined, "progress-track");
      vramTrack.style.height = "5px";
      const vramFill = node("div", undefined, "progress-fill local");
      vramFill.style.width = `${Math.max(0, Math.min(100, vramPct))}%`;
      vramTrack.append(vramFill);
      vramBox.append(vramRow, vramTrack);
      card.append(vramBox);

      gpuContainer.append(card);
    });
  }

  // 7. Activity Log
  const actList = $("token-activity-list");
  if (actList) {
    actList.replaceChildren();
    const activities = Array.isArray(ts.activity) && ts.activity.length ? ts.activity : [
      "Token manager initialized.",
      `Parsed real-time quota at ${new Date().toLocaleTimeString()}`,
    ];
    for (const act of activities) {
      actList.append(node("li", `• ${act}`));
    }
  }
  if ($("token-last-updated")) $("token-last-updated").textContent = `마지막 동기화: ${new Date().toLocaleTimeString()} · 실시간 연동됨`;
}

function renderMainAgent() {
  const capabilities = currentCapabilities();
  let selected = capabilities.find((item) => item.provider === state.mainProvider);
  if (!selected) {
    selected = capabilities[0] || defaults[0];
    state.mainProvider = selected.provider;
  }
  const select = $("main-agent-select");
  if (select) {
    select.replaceChildren();
    for (const capability of capabilities) {
      const option = node("option", `${capability.label || capability.provider}`);
      option.value = capability.provider;
      option.selected = capability.provider === state.mainProvider;
      select.append(option);
    }
  }

  if ($("main-agent-name")) $("main-agent-name").textContent = selected.label || selected.provider;
  const pill = $("main-agent-status");
  if (pill) {
    pill.textContent = selected.available ? "사용가능" : "확인중";
    pill.className = `status-pill ${selected.available ? "available" : "not-installed"}`;
  }

  const endpoint = selected.endpoint || selected.reason || "공식 연결 경로 확인 중";
  if ($("main-agent-detail")) {
    $("main-agent-detail").textContent = `연결 방식: ${safeText(selected.mode)} · 대상 ID: ${selected.provider} · ${endpoint}`;
  }
  if ($("selected-agent-hint")) {
    $("selected-agent-hint").textContent = `현재 메인 대상: ${selected.label || selected.provider}`;
  }

  const actions = $("main-agent-actions");
  if (actions) {
    actions.replaceChildren();
    if (selected.provider === "openai.chatgpt.app") {
      actions.append(
        button("📋 ChatGPT HTTP URL 복사", "button primary copy-chatgpt-mcp"),
        button("📋 STDIO 경로 복사", "button secondary copy-chatgpt-stdio"),
      );
    } else if (selected.provider === "anthropic.claude.desktop") {
      actions.append(
        button("⚡ Claude Desktop 자동 등록", "button primary register-claude"),
        button("📋 설정 JSON 복사", "button secondary copy-claude-mcp"),
      );
    } else {
      actions.append(button("📋 MCP 설정 JSON 복사", "button secondary copy-generic-mcp"));
    }
  }
}

function renderHomeStats() {
  const capabilities = currentCapabilities();
  const availableCount = capabilities.filter((c) => c.available).length;
  if ($("stat-agents")) $("stat-agents").textContent = `${availableCount} / ${capabilities.length}개`;
  if ($("stat-tasks")) $("stat-tasks").textContent = `${state.tasks.length}건`;
  if ($("stat-approvals")) $("stat-approvals").textContent = `${state.approvals.length}건`;
}

function renderAgents() {
  const target = $("agent-list");
  if (!target) return;
  target.replaceChildren();
  for (const item of currentCapabilities()) {
    const card = node("article", undefined, "agent-card-item card");
    const topRow = node("div", undefined, "agent-heading");
    topRow.append(node("strong", item.label || item.provider));
    const pill = node("span", item.available ? "사용가능" : "설치X", `status-pill ${item.available ? "available" : "not-installed"}`);
    topRow.append(pill);
    card.append(topRow);

    const meta = node("div", `${item.provider} · ${item.mode || "bridge"}`, "agent-card-meta");
    card.append(meta);

    const desc = node("div", item.model ? `모델: ${item.model}` : safeText(item.reason, "공식 연결 경로"), "agent-card-meta");
    card.append(desc);

    const act = node("div", undefined, "agent-quick-actions");
    if (item.provider === "openai.chatgpt.app") {
      act.append(button("📋 HTTP URL", "button secondary copy-chatgpt-mcp"));
    } else if (item.provider === "anthropic.claude.desktop") {
      act.append(button("⚡ 자동 등록", "button primary register-claude"));
    } else {
      act.append(button("선택", "button secondary select-main-btn", { provider: item.provider }));
    }
    card.append(act);
    target.append(card);
  }
}

function renderTasks() {
  const taskTarget = $("tasks");
  if (taskTarget) {
    taskTarget.replaceChildren();
    if (!state.tasks.length) {
      taskTarget.append(node("div", "진행 중인 작업이 없습니다.", "empty-card"));
    } else {
      for (const item of state.tasks) {
        const itemCard = node("div", undefined, "card task-card");
        itemCard.append(node("strong", item.title || item.id));
        itemCard.append(node("p", item.goal || ""));
        const meta = node("div", `상태: ${item.status} · 개정: ${item.revision} · 주관: ${item.originProvider}`, "muted");
        itemCard.append(meta);
        const actions = node("div", undefined, "task-actions");
        actions.append(
          button("위임", "button secondary delegate", { task: item.id, revision: String(item.revision) }),
          button("취소", "button secondary cancel", { task: item.id, revision: String(item.revision) }),
        );
        itemCard.append(actions);
        taskTarget.append(itemCard);
      }
    }
  }

  const approvalTarget = $("approvals");
  if (approvalTarget) {
    approvalTarget.replaceChildren();
    if (!state.approvals.length) {
      approvalTarget.append(node("div", "승인 대기 중인 요청이 없습니다.", "empty-card"));
    } else {
      for (const item of state.approvals) {
        const appCard = node("div", undefined, "card approval-card");
        appCard.append(node("strong", `[${item.action}] ${item.description || item.id}`));
        appCard.append(node("p", `요청자: ${item.requestedBy} · 작업: ${item.taskId}`));
        const actions = node("div", undefined, "task-actions");
        actions.append(button("✓ 승인", "button primary approve", { approval: item.id, revision: String(item.expectedRevision ?? 1) }));
        appCard.append(actions);
        approvalTarget.append(appCard);
      }
    }
  }
}

function renderRuns(runsData) {
  const listTarget = $("runs-timeline-list");
  const countBadge = $("runs-active-count");
  if (!listTarget) return;

  const runs = runsData?.runs || [];
  const activeCount = runsData?.activeCount || 0;
  if (countBadge) {
    countBadge.textContent = `${activeCount}개 실행중`;
    countBadge.className = `status-pill ${activeCount > 0 ? "status-ok" : "available"}`;
  }

  listTarget.replaceChildren();
  if (!runs.length) {
    listTarget.append(node("div", "기록된 워크스페이스 에이전트 실행이 없습니다.", "empty-card"));
    return;
  }

  for (const run of runs.slice(0, 15)) {
    const itemCard = node("div", undefined, "card task-card");
    const topRow = node("div", undefined, "agent-heading");
    topRow.append(node("strong", run.title || run.id));
    const statusClass = run.status === "completed" ? "available" : run.status === "failed" ? "not-installed" : "waiting";
    topRow.append(node("span", run.status, `status-pill ${statusClass}`));
    itemCard.append(topRow);

    const metaParts = [
      run.model ? `모델: ${run.model}` : undefined,
      run.taskScale ? `규모: ${run.taskScale}` : undefined,
      run.elapsedSeconds !== undefined ? `소요: ${run.elapsedSeconds.toFixed(1)}초` : undefined,
      run.tokensUsed !== undefined ? `토큰: ${run.tokensUsed.toLocaleString()}개` : undefined,
      run.exitCode !== undefined ? `종료코드: ${run.exitCode}` : undefined,
    ].filter(Boolean);

    if (metaParts.length) {
      itemCard.append(node("p", metaParts.join(" · "), "muted"));
    }

    if (Array.isArray(run.artifacts) && run.artifacts.length) {
      const artRow = node("div", undefined, "agent-card-meta");
      artRow.append(node("span", `산출물 (${run.artifacts.length}개): `));
      run.artifacts.forEach((art) => {
        const link = node("span", art.path, "code-box");
        link.style.display = "inline-block";
        link.style.margin = "2px 4px";
        link.style.fontSize = "11px";
        artRow.append(link);
      });
      itemCard.append(artRow);
    }

    listTarget.append(itemCard);
  }
}

function renderLocalLlmMetrics(metricsData) {
  const tbody = $("local-metrics-tbody");
  const summary = $("local-metrics-summary");
  if (!tbody) return;

  const metrics = metricsData?.metrics || [];
  if (summary) {
    summary.textContent = `총 ${metrics.length}건 기록`;
  }

  tbody.replaceChildren();
  if (!metrics.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 8;
    td.style.padding = "12px";
    td.style.textAlign = "center";
    td.style.color = "#64748b";
    td.textContent = "기록된 로컬 LLM 실행 데이터가 없습니다.";
    tr.append(td);
    tbody.append(tr);
    return;
  }

  for (const m of metrics.slice(-10).reverse()) {
    const tr = document.createElement("tr");
    tr.style.borderBottom = "1px solid #1e293b";
    const statusColor = m.success ? "#34d399" : "#f43f5e";
    const statusText = m.success ? "성공" : "실패";
    const timeStr = m.timestamp ? m.timestamp.split("T")[1]?.slice(0, 8) || m.timestamp : "-";

    const tdTime = document.createElement("td");
    tdTime.style.padding = "6px 8px";
    tdTime.style.color = "#94a3b8";
    tdTime.textContent = timeStr;

    const tdTitle = document.createElement("td");
    tdTitle.style.padding = "6px 8px";
    tdTitle.style.fontWeight = "600";
    tdTitle.style.color = "#e2e8f0";
    tdTitle.textContent = m.taskTitle || "-";

    const tdModel = document.createElement("td");
    tdModel.style.padding = "6px 8px";
    tdModel.style.color = "#38bdf8";
    tdModel.textContent = m.model || "qwen3.6:27b";

    const tdScale = document.createElement("td");
    tdScale.style.padding = "6px 8px";
    tdScale.style.color = "#94a3b8";
    tdScale.textContent = m.taskScale || "-";

    const tdElapsed = document.createElement("td");
    tdElapsed.style.padding = "6px 8px";
    tdElapsed.style.color = "#e2e8f0";
    tdElapsed.textContent = m.actualElapsedSeconds ? `${m.actualElapsedSeconds.toFixed(1)}초` : "-";

    const tdTokens = document.createElement("td");
    tdTokens.style.padding = "6px 8px";
    tdTokens.style.color = "#e2e8f0";
    tdTokens.textContent = m.totalTokens ? m.totalTokens.toLocaleString() : "-";

    const tdSpeed = document.createElement("td");
    tdSpeed.style.padding = "6px 8px";
    tdSpeed.style.color = "#a78bfa";
    tdSpeed.textContent = m.tokensPerSecond ? `${m.tokensPerSecond.toFixed(1)} t/s` : "-";

    const tdStatus = document.createElement("td");
    tdStatus.style.padding = "6px 8px";
    tdStatus.style.fontWeight = "600";
    tdStatus.style.color = statusColor;
    tdStatus.textContent = statusText;

    tr.append(tdTime, tdTitle, tdModel, tdScale, tdElapsed, tdTokens, tdSpeed, tdStatus);
    tbody.append(tr);
  }
}

async function refreshLogs() {
  try {
    const res = await api("/v1/logs?lines=160");
    if ($("log-path")) $("log-path").textContent = `로그 경로: ${res.path || "%LOCALAPPDATA%\\IntegratedPower\\state\\broker.log"}`;
    if ($("log-lines")) $("log-lines").textContent = Array.isArray(res.lines) && res.lines.length ? res.lines.join("\n") : "기록된 브로커 로그가 없습니다.";
  } catch (error) {
    if ($("log-lines")) $("log-lines").textContent = `로그 조회 실패: ${error.message}`;
  }
}

async function refreshAutoStart() {
  try {
    const res = await api("/v1/system/autostart");
    state.autoStartEnabled = Boolean(res.enabled);
    const toggle = $("setting-autostart-toggle");
    if (toggle) toggle.checked = state.autoStartEnabled;
  } catch {
    // ignore
  }
}

async function refresh() {
  try {
    await api("/health");
    setConnection("online", "브로커 정상 (37241)");
    if ($("status")) $("status").textContent = "브로커 정상 가동 중 (127.0.0.1:37241)";

    const [capRes, taskRes, appRes, tokenRes, runsRes, metricsRes] = await Promise.all([
      api("/v1/capabilities").catch(() => ({ capabilities: [] })),
      api("/v1/tasks").catch(() => ({ tasks: [] })),
      api("/v1/approvals").catch(() => ({ approvals: [] })),
      api("/v1/tokens/status").catch(() => ({ tokenStatus: null })),
      api("/v1/runs").catch(() => ({ runs: [], activeCount: 0 })),
      api("/v1/metrics/local-llm").catch(() => ({ metrics: [] })),
    ]);

    if (Array.isArray(capRes.capabilities)) state.capabilities = capRes.capabilities;
    if (Array.isArray(taskRes.tasks)) state.tasks = taskRes.tasks;
    if (Array.isArray(appRes.approvals)) state.approvals = appRes.approvals;

    if (tokenRes && tokenRes.tokenStatus) {
      state.previousTokenStatus = state.tokenStatus;
      state.tokenStatus = tokenRes.tokenStatus;
      checkTokenFullNotification(state.previousTokenStatus, state.tokenStatus);
    }

    renderTokens();
    renderMainAgent();
    renderHomeStats();
    renderAgents();
    renderTasks();
    renderRuns(runsRes);
    renderLocalLlmMetrics(metricsRes);
    if (state.activeTab === "logs") void refreshLogs();
  } catch (error) {
    setConnection("offline", "브로커 오프라인");
    if ($("status")) $("status").textContent = "브로커 연결 대기 중…";
    renderTokens();
    renderMainAgent();
    renderHomeStats();
    renderAgents();
    renderTasks();
  }
}

function bindEvents() {
  // Sidebar navigation
  document.querySelectorAll(".nav-link").forEach((link) => {
    link.onclick = () => switchTab(link.dataset.section);
  });

  // Quick nav buttons on home tab
  document.addEventListener("click", async (e) => {
    const quickBtn = e.target.closest(".quick-nav-btn");
    if (quickBtn && quickBtn.dataset.target) switchTab(quickBtn.dataset.target);

    // Host integrations one-click buttons
    const claudeBtn = e.target.closest(".register-claude");
    if (claudeBtn) {
      try {
        await api("/v1/integrations/claude/register", { method: "POST", body: JSON.stringify({ confirm: true }) });
        showToast("⚡ Claude Desktop에 Integrated Power MCP가 등록되었습니다.");
      } catch (err) {
        showToast(`Claude 등록 실패: ${err.message}`, true);
      }
    }

    const chatgptBtn = e.target.closest(".copy-chatgpt-mcp");
    if (chatgptBtn) {
      await copyToClipboard("http://127.0.0.1:37241/mcp", "📋 ChatGPT 맞춤형 MCP SSE URL이 복사되었습니다.");
    }

    const claudeCopyBtn = e.target.closest(".copy-claude-mcp");
    if (claudeCopyBtn) {
      try {
        const spec = await api("/v1/integrations/claude/spec");
        await copyToClipboard(spec.snippet || JSON.stringify(spec.spec, null, 2), "📋 Claude 설정 JSON이 복사되었습니다.");
      } catch (err) {
        showToast("설정 복사 실패: " + err.message, true);
      }
    }

    const genericMcpBtn = e.target.closest(".copy-generic-mcp");
    if (genericMcpBtn) {
      try {
        const spec = await api("/v1/integrations/mcp/spec");
        await copyToClipboard(spec.snippet || JSON.stringify(spec.spec, null, 2), "📋 MCP 설정 JSON이 복사되었습니다.");
      } catch (err) {
        showToast("설정 복사 실패: " + err.message, true);
      }
    }
  });

  // Refresh buttons
  if ($("connection-refresh")) $("connection-refresh").onclick = () => void refresh();
  if ($("token-refresh-btn")) $("token-refresh-btn").onclick = async () => {
    showToast("실시간 쿼터를 갱신 중입니다…");
    await refresh();
    showToast("AI 모델 쿼터가 최신 상태로 갱신되었습니다.");
  };

  // Notification Toggles (Quick and Settings)
  const syncNotifyToggles = (checked) => {
    state.notifyOnFullTokens = checked;
    localStorage.setItem("ip_notify_full_tokens", String(checked));
    if ($("token-notify-quick-toggle")) $("token-notify-quick-toggle").checked = checked;
    if ($("setting-token-notify-toggle")) $("setting-token-notify-toggle").checked = checked;
    if (checked) {
      requestNotificationPermission();
      showToast("토큰 100% 완충 시 알림이 켜졌습니다.");
    } else {
      showToast("토큰 100% 완충 시 알림이 꺼졌습니다.");
    }
  };

  if ($("token-notify-quick-toggle")) {
    $("token-notify-quick-toggle").checked = state.notifyOnFullTokens;
    $("token-notify-quick-toggle").onchange = (e) => syncNotifyToggles(e.target.checked);
  }
  if ($("setting-token-notify-toggle")) {
    $("setting-token-notify-toggle").checked = state.notifyOnFullTokens;
    $("setting-token-notify-toggle").onchange = (e) => syncNotifyToggles(e.target.checked);
  }

  // Test Notification Button
  if ($("btn-test-notification")) {
    $("btn-test-notification").onclick = () => {
      requestNotificationPermission();
      playFullChime();
      showToast("🔔 [테스트 알림] 토큰 100% 완충 알림 및 차임벨이 정상적으로 작동합니다.");
      sendDesktopNotification("🎉 [테스트] Integrated Power 토큰 완충 알림", "AI 모델 토큰이 100% 충전되었을 때 이와 같은 알림과 사운드가 재생됩니다.");
    };
  }

  // Autostart Toggle
  if ($("setting-autostart-toggle")) {
    $("setting-autostart-toggle").onchange = async (e) => {
      const enabled = e.target.checked;
      try {
        const res = await api("/v1/system/autostart", {
          method: "POST",
          body: JSON.stringify({ enabled }),
        });
        state.autoStartEnabled = Boolean(res.enabled);
        showToast(state.autoStartEnabled ? "Windows 시작 시 자동 실행이 등록되었습니다." : "Windows 시작 시 자동 실행이 해제되었습니다.");
      } catch (err) {
        showToast(`자동 실행 설정 실패: ${err.message}`, true);
        e.target.checked = state.autoStartEnabled;
      }
    };
  }

  // Poll Interval Selector
  const pollSelect = $("setting-poll-interval-select");
  if (pollSelect) {
    pollSelect.value = String(state.pollInterval);
    pollSelect.onchange = (e) => {
      const newInterval = Number(e.target.value) || 5000;
      setPollInterval(newInterval);
    };
  }

  // Settings integration buttons
  if ($("btn-settings-claude")) {
    $("btn-settings-claude").onclick = async () => {
      try {
        await api("/v1/integrations/claude/register", { method: "POST", body: JSON.stringify({ confirm: true }) });
        showToast("⚡ Claude Desktop 설정에 Integrated Power MCP가 등록되었습니다.");
      } catch (err) {
        showToast("Claude 등록 실패: " + err.message, true);
      }
    };
  }
  if ($("btn-settings-claude-copy")) {
    $("btn-settings-claude-copy").onclick = async () => {
      try {
        const spec = await api("/v1/integrations/claude/spec");
        await copyToClipboard(spec.snippet || JSON.stringify(spec.spec, null, 2), "📋 Claude 설정 JSON이 복사되었습니다.");
      } catch (err) {
        showToast("설정 복사 실패: " + err.message, true);
      }
    };
  }
  if ($("btn-settings-chatgpt")) {
    $("btn-settings-chatgpt").onclick = async () => {
      await copyToClipboard("http://127.0.0.1:37241/mcp", "📋 ChatGPT 맞춤형 MCP SSE URL이 복사되었습니다.");
    };
  }

  // Log tab buttons
  if ($("log-refresh-btn")) $("log-refresh-btn").onclick = () => void refreshLogs();
  if ($("log-copy-btn")) {
    $("log-copy-btn").onclick = async () => {
      const content = $("log-lines")?.textContent || "";
      await copyToClipboard(content, "브로커 로그가 클립보드에 복사되었습니다.");
    };
  }

  // Main agent selection change
  if ($("main-agent-select")) {
    $("main-agent-select").onchange = (e) => {
      state.mainProvider = e.target.value;
      renderMainAgent();
    };
  }

  // Task creation
  if ($("create")) {
    $("create").onclick = async () => {
      try {
        await api("/v1/tasks", {
          method: "POST",
          body: JSON.stringify({
            title: $("title").value,
            goal: $("goal").value,
            workspacePath: $("workspace").value || undefined,
            originProvider: state.mainProvider,
            privacy: "private",
          }),
        });
        showToast("새 작업이 성공적으로 등록되었습니다.");
        await refresh();
      } catch (error) {
        showToast(`작업 생성 실패: ${error.message}`, true);
      }
    };
  }

  // Global action delegations
  document.addEventListener("click", async (event) => {
    const control = event.target.closest("button");
    if (!control) return;

    try {
      if (control.classList.contains("select-main-btn") && control.dataset.provider) {
        state.mainProvider = control.dataset.provider;
        renderMainAgent();
        switchTab("home");
      } else if (control.classList.contains("copy-chatgpt-mcp")) {
        await copyToClipboard("http://127.0.0.1:37241/mcp", "ChatGPT 맞춤형 MCP URL ('http://127.0.0.1:37241/mcp')이 복사되었습니다.");
      } else if (control.classList.contains("copy-chatgpt-stdio")) {
        const stdioSnippet = `{\n  "mcpServers": {\n    "integrated-power": {\n      "command": "node",\n      "args": ["D:\\\\Workspace\\\\integrated-power-control-center\\\\mcp-server.js"]\n    }\n  }\n}`;
        await copyToClipboard(stdioSnippet, "ChatGPT STDIO 설정 JSON이 복사되었습니다.");
      } else if (control.classList.contains("register-claude")) {
        const res = await api("/v1/integrations/claude/register", { method: "POST", body: JSON.stringify({ confirm: true }) });
        showToast(`Claude Desktop에 Integrated Power MCP가 등록되었습니다 (${res.changed ? "신규 등록" : "이미 최신"}). Claude를 재시작하세요.`);
        await refresh();
      } else if (control.classList.contains("copy-claude-mcp") || control.classList.contains("copy-generic-mcp")) {
        const res = await api("/v1/integrations/claude/spec").catch(() => null);
        const snippet = JSON.stringify(res?.snippet || { mcpServers: { "integrated-power": { command: "node", args: ["mcp-server.js"] } } }, null, 2);
        await copyToClipboard(snippet, "MCP 설정 JSON이 클립보드에 복사되었습니다.");
      } else if (control.classList.contains("delegate")) {
        await api("/v1/tasks/delegate", {
          method: "POST",
          body: JSON.stringify({ taskId: control.dataset.task, provider: state.mainProvider, prompt: $("goal")?.value || "작업 위임", expectedRevision: Number(control.dataset.revision) }),
        });
        showToast("작업이 성공적으로 위임되었습니다.");
        await refresh();
      } else if (control.classList.contains("cancel")) {
        await api(`/v1/tasks/${encodeURIComponent(control.dataset.task)}/cancel`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision: Number(control.dataset.revision) }),
        });
        showToast("작업이 취소되었습니다.");
        await refresh();
      } else if (control.classList.contains("approve")) {
        await api(`/v1/approvals/${encodeURIComponent(control.dataset.approval)}/approve`, {
          method: "POST",
          body: JSON.stringify({ expectedRevision: Number(control.dataset.revision) }),
        });
        showToast("요청이 승인되었습니다.");
        await refresh();
      }
    } catch (err) {
      showToast(`동작 실패: ${err.message}`, true);
    }
  });
}

let pollTimer = null;
function setPollInterval(ms) {
  state.pollInterval = ms;
  localStorage.setItem("ip_poll_interval", String(ms));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, ms);
  showToast(`데이터 자동 갱신 주기가 ${ms / 1000}초로 설정되었습니다.`);
}

// Initial setup
bindEvents();
switchTab("tokens"); // DEFAULT ON OPEN
renderTokens();
renderMainAgent();
renderHomeStats();
renderAgents();
renderTasks();
void refresh();
void refreshAutoStart();
pollTimer = setInterval(refresh, state.pollInterval);

