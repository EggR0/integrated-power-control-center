import "./style.css";
import {
  capacityTone,
  mergeQuotaSettings,
  clampPollInterval,
  buildTokenMetric,
  absoluteTokenText,
  calculateCapacitySummary,
  localServerBadge,
  localLoadedModelLabel,
  validateExternalProvider,
  parseExternalPayload,
  parseModelList,
  modelDiscoveryUrls,
  EXTERNAL_POLL_MIN_MS,
  detectRefilledQuotaWindows,
  ANTIGRAVITY_STOP_SELECTORS,
  canTriggerPrewarm,
  executePrewarmPing,
  normalizePrewarmMode,
} from "@shared/quota";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Broker base URL. 37241 is the canonical standalone port; during vite dev a
// separate broker on another port can be attached with ?broker=<port> (dev-only
// convenience — the Tauri shell always launches 37241 via broker-server.js).
// BROKER_PORT is the single source of truth for every user-facing label.
const _BROKER_PORT = Number(new URLSearchParams(location.search).get("broker"));
const BROKER_PORT = (Number.isFinite(_BROKER_PORT) && _BROKER_PORT > 0) ? _BROKER_PORT : 37241;
const API = "http://127.0.0.1:" + BROKER_PORT;
// Reflect the actual broker port in the footer (canonical 37241, or the
// ?broker= override in dev) so the label never lies about which process is up.
{
  const _footer = document.getElementById("broker-footer");
  if (_footer) _footer.textContent = `v0.9.4 · loopback ${BROKER_PORT}`;
  // Every endpoint label in the settings tab reflects the actual broker port
  // (BROKER_PORT), so dev ?broker=<port> runs never show a stale 37241 URL.
  const _setEndpoint = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  _setEndpoint("settings-bind-url", API);
  _setEndpoint("settings-status-url", `${API}/v1/tokens/status`);
  _setEndpoint("settings-mcp-url", `${API}/mcp`);
  _setEndpoint("settings-chatgpt-mcp-url", `${API}/mcp`);
  _setEndpoint("settings-agent-card-url", `${API}/.well-known/agent-card.json`);
  const _claudeCmd = document.getElementById("settings-claude-cli-cmd");
  if (_claudeCmd) _claudeCmd.textContent = `claude mcp add integrated-power ${API}/mcp`;
  // The home stat placeholder reflects the brand count — set by the
  // post-declaration block below (AGENT_BRANDS is not in scope here yet).
  const _statBroker = document.getElementById("stat-broker");
  if (_statBroker) _statBroker.textContent = `가동중 (${BROKER_PORT})`;
}
const streams = new Map();

// Shared quota settings schema: defaults + coercion live in shared/quota.
// Persistence stays local (localStorage) — only the schema is shared.
const quotaSettings = mergeQuotaSettings({
  pollIntervalMs: localStorage.getItem("ip_poll_interval") ? Number(localStorage.getItem("ip_poll_interval")) : undefined,
  notifyOnFull: localStorage.getItem("ip_notify_full_tokens") !== "false",
});

const state = {
  capabilities: [],
  tasks: [],
  approvals: [],
  tokenStatus: null,
  previousTokenStatus: null,
  lastFullNotified: false,
  notifyOnFullTokens: quotaSettings.notifyOnFull,
  pollInterval: quotaSettings.pollIntervalMs,
  autoStartEnabled: false,
  logs: { path: "", lines: [] },
  mainProvider: "google.antigravity.ide",
  brokerOnline: false,
  lastSyncAt: null,
  activeTab: "tokens", // DEFAULT ACTIVE TAB
  // External (user-registered) providers: { id, name, baseUrl, quotaUrl?, apiKey?, defaultModel?, discoverModels, pollMs, enabled }[]
  externalProviders: [],
  // Latest parsed quota result per provider id (from the broker-side fetch).
  externalData: {},
  // Latest discovered model list per provider id (OpenAI /v1/models or Ollama /api/tags).
  externalModels: {},
};

const defaults = [
  { provider: "google.antigravity.ide", label: "Antigravity IDE / Agy", mode: "cli", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "local.openai-compatible", label: "로컬 Qwen 3.8 27B", mode: "local", capabilities: ["executor", "local-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", model: "qwen3.8:27b", reason: "확인중" },
  { provider: "openai.codex.app", label: "Codex App Server", mode: "app-server", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "openai.chatgpt.app", label: "ChatGPT desktop/web MCP app", mode: "gui", capabilities: ["leader", "remote-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "anthropic.claude.desktop", label: "Claude Desktop local MCP", mode: "gui", capabilities: ["leader", "local-mcp"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "google.antigravity.app", label: "Antigravity", mode: "gui", capabilities: ["leader", "executor"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "확인중" },
  { provider: "anthropic.cowork", label: "Claude Cowork", mode: "gui", capabilities: ["leader"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "미지원" },
  { provider: "xai.grok", label: "xAI Grok", mode: "gui", capabilities: ["leader"], available: false, stateKind: "not_installed", stateLabel: "설치X", reason: "미지원" },
];

const $ = (id) => document.getElementById(id);
// Brand grouping: several broker capabilities are different INSTALL SURFACES
// of one product/account — the Codex App Server and the ChatGPT desktop/web
// MCP are the same ChatGPT subscription; Claude Desktop and Cowork are the
// same Claude account; the Antigravity IDE and the Antigravity app are the
// same product. The agents view and the main-agent picker show one card per
// brand; the per-surface details stay in the card meta lines.
const AGENT_BRANDS = {
  "openai.codex.app": "chatgpt",
  "openai.chatgpt.app": "chatgpt",
  "anthropic.claude.desktop": "claude",
  "anthropic.cowork": "claude",
  "google.antigravity.ide": "antigravity",
  "google.antigravity.app": "antigravity",
  "local.openai-compatible": "local",
  "xai.grok": "grok",
};
const AGENT_BRAND_LABELS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  antigravity: "Antigravity",
  local: "로컬 Qwen 3.8 27B",
  grok: "Grok",
};
// Home stat denominator: brand groups (5), not raw install surfaces (8).
{
  const _statAgents = document.getElementById("stat-agents");
  if (_statAgents) _statAgents.textContent = `- / ${AGENT_BRANDS.length}개`;
}
function brandGroups() {
  const groups = new Map();
  for (const item of currentCapabilities()) {
    const key = AGENT_BRANDS[item.provider] || item.provider;
    if (!groups.has(key)) {
      groups.set(key, { key, label: AGENT_BRAND_LABELS[key] || item.label || item.provider, items: [] });
    }
    groups.get(key).items.push(item);
  }
  return Array.from(groups.values());
}
// Representative surface of a brand for the main-agent selection: the first
// installed surface, else the first one.
const brandRepresentative = (g) => g.items.find((i) => i.available) || g.items[0];
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
    if (!response.ok) {
      const err = new Error(body.error || `HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return body;
  } finally { clearTimeout(timer); }
}

// A broker built before the P7 external route answers /v1/providers/external
// with its catch-all 404 {"error":"not_found"} — a definitive stale-broker
// signature. Detected once during polling so cards can say "restart the
// broker" instead of a misleading "quota error · not_found".
let brokerStale = false;
const isStaleBrokerError = (e) =>
  e && e.status === 404 && /not_found/.test(e.message || "");
// The broker can be IDE-launched (restart = reopen VS Code) or dev-launched
// by `npm run dev` (restart = run the command again) — the message must
// name both, since neither the UI nor the user can tell which is running.
const STALE_BROKER_HINT = "브로커를 재시작하세요 (IDE 브로커: VS Code 재시작 · dev 브로커: npm run dev 재실행)";

function setConnection(kind, message) {
  state.brokerOnline = kind === "online";
  const dot = $("connection-dot");
  if (dot) dot.className = `connection-dot ${kind === "online" ? "online" : "offline"}`;
  const label = $("connection-label");
  if (label) label.textContent = message;
  const statBroker = $("stat-broker");
  if (statBroker) statBroker.textContent = kind === "online" ? `정상 가동 (${BROKER_PORT})` : "연결 끊김";
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

  state.notifiedFullWindows = state.notifiedFullWindows || new Set();

  const { notifications, updatedNotifiedSet } = detectRefilledQuotaWindows(
    previous,
    current,
    state.notifiedFullWindows,
  );
  state.notifiedFullWindows = updatedNotifiedSet;

  if (notifications.length > 0) {
    playFullChime();
    for (const item of notifications) {
      showToast(`⚡ [100% 완충] ${item.target.message}`);
      sendDesktopNotification("⚡ [Integrated Power] 100% 충전 완료", item.target.message);
    }
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

const gaugeTicksEnabled = () => localStorage.getItem("ip_gauge_ticks") !== "false";

function renderTokens() {
  const ts = state.tokenStatus || {};

  // P3: every window is built by the shared buildTokenMetric (the same source
  // the IDE webview consumes) — this carries A4 absolute-token availability,
  // the A6 tone, the A3 K-sync, and the A7 tooltip in one place.
  const windows = {
    "gemini-5h": buildTokenMetric("5Hours", ts, "antigravity", "Gemini 5Hours", "antigravityWeekly"),
    "gemini-weekly": buildTokenMetric("Weekly", ts, "antigravityWeekly", "Gemini Weekly"),
    "opus-5h": buildTokenMetric("5Hours", ts, "opus", "Claude 5Hours", "opusWeekly"),
    "opus-weekly": buildTokenMetric("Weekly", ts, "opusWeekly", "Claude Weekly"),
    "codex-5h": buildTokenMetric("5Hours", ts, "codex", "ChatGPT 5Hours", "codexWeekly"),
    "codex-weekly": buildTokenMetric("Weekly", ts, "codexWeekly", "ChatGPT Weekly"),
  };
  // One label for "no value reported" — a no-data window is NOT zero and is
  // not the same as an error; keep the wording consistent across labels,
  // bars, and reset stamps.
  const noDataText = "쿼터 대기 중";
  const prefixOf = {
    "gemini-5h": "antigravity", "gemini-weekly": "antigravityWeekly",
    "opus-5h": "opus", "opus-weekly": "opusWeekly",
    "codex-5h": "codex", "codex-weekly": "codexWeekly",
  };

  for (const [id, m] of Object.entries(windows)) {
    const label = $(`label-${id}`);
    if (label) {
      label.textContent = m.unavailable ? noDataText : `${m.percentage.toFixed(2)}% remaining`;
      label.title = m.tooltip; // A7 tooltip (hover)
    }
    const reset = $(`reset-${id}`);
    if (reset) {
      if (m.canPrewarm) {
        reset.textContent = "⚡ 프리웜 가능 (· Ready)";
        reset.title = "5시간 윈도우 프리웜 가능: 클릭 시 충전 타이머를 선행 시작합니다 (용량 >99.9% 보존).";
        reset.style.cursor = "pointer";
        reset.onclick = () => window.triggerPrewarmWindow && window.triggerPrewarmWindow(id);
      } else {
        reset.textContent = m.refreshFull || `· ${noDataText}`;
        reset.style.cursor = "";
        reset.onclick = null;
      }
    }
    const bar = $(`bar-${id}`);
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, m.percentage))}%`;
      // Unified tone thresholds (<=15 critical, 15-35 caution) via the shared
      // capacityTone — replaces the old hard-coded <20% warning.
      bar.classList.toggle("warning", m.tone === "warning");
      bar.classList.toggle("critical", m.tone === "critical");
      bar.title = m.tooltip;
    }
    // Gauge ticks: 5 equal parts for 5h windows, 7 for weekly (N-1 dividers).
    // Divider positions are explicit i/N stops (no repeating-gradient drift),
    // semi-transparent white so they read on both the colored fill and the
    // empty dark track. Toggle in settings (ip_gauge_ticks).
    if (gaugeTicksEnabled()) {
      const track = bar && bar.parentElement;
      if (track && track.classList.contains("progress-track")) {
        let ticks = track.querySelector(".progress-ticks");
        if (!ticks) {
          ticks = document.createElement("div");
          ticks.className = "progress-ticks";
          track.appendChild(ticks);
        }
        const segments = id.endsWith("weekly") ? 7 : 5;
        const stops = [];
        for (let i = 1; i < segments; i++) {
          const at = `${(100 * i) / segments}%`;
          stops.push(
            `transparent ${at}`,
            `rgba(255, 255, 255, 0.55) ${at}`,
            `rgba(255, 255, 255, 0.55) calc(${at} + 2px)`,
            `transparent calc(${at} + 2px)`
          );
        }
        ticks.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
        ticks.style.display = "";
      }
    } else if (bar) {
      const track = bar.parentElement;
      const ticks = track && track.querySelector(".progress-ticks");
      if (ticks) ticks.style.display = "none";
    }
    // A4: absolute tokens (left / max, or the EstimatedAbsolute fallback).
    // Hidden (empty) when there is no absolute data, so we never show a fake "0".
    const abs = $(`tokens-${id}`);
    if (abs) {
      const p = prefixOf[id];
      const text = absoluteTokenText(ts[`${p}TokensLeft`], ts[`${p}Max`], ts[`${p}EstimatedAbsolute`]);
      abs.textContent = text || "";
    }
  }

  // A5: Best / Lowest summary across the six windows (shared selection logic).
  const summary = calculateCapacitySummary(ts);
  const summaryEl = $("token-capacity-summary");
  if (summaryEl) {
    summaryEl.replaceChildren();
    if (summary) {
      const toneClass = `summary-${capacityTone(summary.lowest.percentage)}`;
      summaryEl.append(
        node("span", `Best: ${summary.strongest.label} ${summary.strongest.percentage.toFixed(0)}%`, "summary-pill"),
        node("span", `Lowest: ${summary.lowest.label} ${summary.lowest.percentage.toFixed(0)}%`, `summary-pill ${toneClass}`),
      );
      summaryEl.style.display = "";
    } else {
      summaryEl.style.display = "none";
    }
  }

  renderPrewarmToolbar();

  const prewarmMode = normalizePrewarmMode(localStorage.getItem("ip_prewarm_mode") || "click");
  if (prewarmMode !== "click" && window.__lastCcAutoPrewarm !== Math.floor(Date.now() / 60000)) {
    for (const id of ["antigravity", "opus", "codex"]) {
      const p = prefixOf[id];
      const m = buildTokenMetric("5Hours", ts, p, `${id} 5Hours`);
      if (m.canPrewarm) {
        window.__lastCcAutoPrewarm = Math.floor(Date.now() / 60000);
        window.triggerPrewarmWindow && window.triggerPrewarmWindow(id);
        if (prewarmMode === "once") {
          localStorage.setItem("ip_prewarm_mode", "click");
          renderPrewarmToolbar();
          showToast("Once 프리웜이 실행되어 수동(Click) 모드로 복귀했습니다.");
        }
        break;
      }
    }
  }

  const codexTag = $("codex-status-tag");
  if (codexTag) {
    const codexWorking = ts.codexState === "working";
    codexTag.textContent = ts.codexState
      ? (codexWorking ? "작업 중" : "대기")
      : "확인중";
    codexTag.className = `provider-state-tag ${codexWorking ? "online" : ""}`;
  }

  // 4. Task Routing & Status Tags
  // No data is NOT "degraded" — that would color a healthy-but-unread state
  // amber. Unknown values ("unknown", "critical") had no CSS class and
  // leaked raw English text; map them to the existing tone classes.
  const routingLabel = { normal: "정상", degraded: "저하", restricted: "제한", critical: "제한", unknown: "확인중" };
  const routing = ts.taskRouting || ts.recommendedTaskWeight || "unknown";
  const routingBadge = $("task-routing-badge");
  if (routingBadge) {
    const cssClass = routing === "unknown" ? "" : routing === "critical" ? "restricted" : routing;
    routingBadge.className = `task-routing-pill ${cssClass}`.trim();
    routingBadge.textContent = routingLabel[routing] || routing;
  }

  // 5. Anthropic Claude Direct Usage
  const du = ts.claudeDirectUsage || ts.directUsage;
  const hasClaudeData = du && ((du.sevenDaysTokens > 0) || (du.eventCount > 0) || (du.status === "measured") || (du.sevenDays?.eventCount > 0));
  
  const claudeTag = $("claude-status-tag");
  if (claudeTag) {
    // No events can mean "not used" or "not installed" — do not claim a
    // measurement state. Measured / no-records / neutral, Korean to match.
    const tagText = hasClaudeData ? "측정 중" : "사용 기록 없음";
    claudeTag.textContent = tagText;
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

  const sourcesList = Array.isArray(du?.sources) && du.sources.length ? du.sources.join(", ") : "Claude API/CLI/Cowork 사용 기록이 없습니다.";
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
      $("claude-last-used").textContent = "사용 기록 없음";
    }
  }

  // 6. Local Compute & Multi-GPU
  const lcs = ts.localComputeStatus || {};
  // P4: the server badge now comes from the shared localServerBadge — the same
  // criterion the IDE webview uses (a loaded model, else an up/idle endpoint,
  // else offline). This replaces the old check on a `status` field the P2 state
  // never carries (it was permanently "Offline").
  const badge = localServerBadge(lcs.endpointHealth, lcs.loadedModels, lcs.programName);
  const localTag = $("local-llm-status-tag");
  if (localTag) {
    const tagClass = badge.tone === "active" ? "online" : badge.tone === "idle" ? "idle" : "";
    localTag.textContent = badge.text;
    localTag.className = `provider-state-tag ${tagClass}`.trim();
    localTag.title = badge.text;
  }
  // Footer: reflect the actually-loaded model and endpoint health (the markup
  // previously hard-coded "qwen3.8:27b" / "정상 (127.0.0.1:11434)").
  const loadedModelEl = $("local-loaded-model");
  if (loadedModelEl) loadedModelEl.textContent = localLoadedModelLabel(lcs.loadedModels);
  const endpointEl = $("local-endpoint-health");
  if (endpointEl) {
    const health = typeof lcs.endpointHealth === "string" ? lcs.endpointHealth : "offline";
    const running = health === "ok" || health === "idle";
    endpointEl.textContent = running
      ? `${health === "ok" ? "정상" : "대기"} (${lcs.programName || "server"})`
      : "오프라인";
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
    // The empty-state hint must be static — stamping a fresh timestamp here
    // made every poll look like a newly parsed sync ("Parsed real-time quota
    // at 12:34:56" re-rendered every 5s while nothing had actually parsed).
    const activities = Array.isArray(ts.activity) && ts.activity.length ? ts.activity : [
      "브로커에서 활동 기록을 받아오지 못했습니다.",
    ];
    for (const act of activities) {
      actList.append(node("li", `• ${act}`));
    }
  }
  if ($("token-last-updated")) {
    // Show the last SUCCESSFUL sync time, not the render time — during a
    // broker outage this stamp must not claim a fresh live sync.
    const t = state.lastSyncAt ? state.lastSyncAt.toLocaleTimeString() : "—";
    $("token-last-updated").textContent = state.brokerOnline
      ? `마지막 동기화: ${t} · 실시간 연동됨`
      : `브로커 오프라인 — 마지막 동기화: ${t}`;
  }
}

function renderMainAgent() {
  const groups = brandGroups();
  let selectedGroup = groups.find((g) => g.items.some((i) => i.provider === state.mainProvider)) || groups[0];
  if (!selectedGroup) selectedGroup = { key: "antigravity", label: "Antigravity", items: [defaults[0]] };
  const selected = brandRepresentative(selectedGroup);
  state.mainProvider = selected.provider;
  const select = $("main-agent-select");
  if (select) {
    select.replaceChildren();
    for (const group of groups) {
      const rep = brandRepresentative(group);
      const option = node("option", group.items.length > 1 ? `${group.label} (${group.items.map((i) => i.label || i.provider).join(" · ")})` : group.label);
      option.value = rep.provider;
      option.selected = rep.provider === state.mainProvider;
      select.append(option);
    }
  }

  if ($("main-agent-name")) $("main-agent-name").textContent = selectedGroup.label;
  const pill = $("main-agent-status");
  if (pill) {
    const anyAvailable = selectedGroup.items.some((i) => i.available);
    pill.textContent = anyAvailable ? "사용가능" : "확인중";
    pill.className = `status-pill ${anyAvailable ? "available" : "not-installed"}`;
  }

  const endpoint = selected.endpoint || selected.reason || "공식 연결 경로 확인 중";
  if ($("main-agent-detail")) {
    const surfaces = selectedGroup.items.length > 1
      ? ` · 표면: ${selectedGroup.items.map((i) => i.label || i.provider).join(", ")}`
      : "";
    $("main-agent-detail").textContent = `연결 방식: ${safeText(selected.mode)} · 대상 ID: ${selected.provider} · ${endpoint}${surfaces}`;
  }

  if ($("selected-agent-hint")) {
    $("selected-agent-hint").textContent = `현재 메인 대상: ${selectedGroup.label}`;
  }

  const actions = $("main-agent-actions");
  if (actions) {
    actions.replaceChildren();
    if (selectedGroup.key === "chatgpt") {
      actions.append(
        button("📋 ChatGPT HTTP URL 복사", "button primary copy-chatgpt-mcp"),
        button("📋 STDIO 경로 복사", "button secondary copy-chatgpt-stdio"),
      );
    } else if (selectedGroup.key === "claude") {
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
  const groups = brandGroups();
  const availableCount = groups.filter((g) => g.items.some((c) => c.available)).length;
  if ($("stat-agents")) $("stat-agents").textContent = `${availableCount} / ${groups.length}개`;
  if ($("stat-tasks")) $("stat-tasks").textContent = `${state.tasks.length}건`;
  if ($("stat-approvals")) $("stat-approvals").textContent = `${state.approvals.length}건`;
}

function renderAgents() {
  const target = $("agent-list");
  if (!target) return;
  target.replaceChildren();
  for (const group of brandGroups()) {
    const anyAvailable = group.items.some((i) => i.available);
    const card = node("article", undefined, "agent-card-item card");
    const topRow = node("div", undefined, "agent-heading");
    topRow.append(node("strong", group.label));
    const pill = node("span", anyAvailable ? "사용가능" : "설치X", `status-pill ${anyAvailable ? "available" : "not-installed"}`);
    topRow.append(pill);
    card.append(topRow);

    // One meta line per install surface, with its own provider id + mode, so
    // the grouping loses no detail.
    for (const item of group.items) {
      card.append(node("div", `${item.label || item.provider} — ${item.provider} · ${item.mode || "bridge"}`, "agent-card-meta"));
    }
    const first = group.items[0];
    const desc = node("div", first.model ? `모델: ${first.model}` : safeText(first.reason, "공식 연결 경로"), "agent-card-meta");
    card.append(desc);

    const act = node("div", undefined, "agent-quick-actions");
    if (group.key === "chatgpt") {
      act.append(button("📋 HTTP URL", "button secondary copy-chatgpt-mcp"));
    } else if (group.key === "claude") {
      act.append(button("⚡ 자동 등록", "button primary register-claude"));
    } else {
      const rep = brandRepresentative(group);
      act.append(button("선택", "button secondary select-main-btn", { provider: rep.provider }));
    }
    card.append(act);
    target.append(card);
  }
}

function renderTasks() {
  // Broker task states are English enums; the rest of this UI is Korean, so
  // map before display (a raw "pending" read as a status the user must
  // translate).
  const taskStatusLabel = { pending: "대기", running: "진행중", completed: "완료", failed: "실패", cancelled: "취소" };
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
        // "supervisor" shows a brand label, not the raw provider key
        // ("local.openai-compatible" → "로컬 Qwen 3.8 27B").
        const supervisor = item.originProvider
          ? (AGENT_BRAND_LABELS[AGENT_BRANDS[item.originProvider]] || item.originProvider)
          : "-";
        const meta = node("div", `상태: ${taskStatusLabel[item.status] || item.status} · 개정: ${item.revision} · 주관: ${supervisor}`, "muted");
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
    // "available" is the installed/available green — an active run is blue
    // (in progress), idle is neutral.
    countBadge.className = `status-pill ${activeCount > 0 ? "unlinked" : "available"}`;
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
    // Map the raw run status: English "running" is not a status the UI
    // displays elsewhere, and blue=in-progress is the right tone (not the
    // green "available").
    const runStatusMeta = {
      running: { text: "진행중", cls: "unlinked" },
      completed: { text: "완료", cls: "available" },
      failed: { text: "실패", cls: "not-installed" },
      pending: { text: "대기", cls: "waiting" },
      cancelled: { text: "취소", cls: "waiting" },
    }[run.status] || { text: run.status, cls: "waiting" };
    topRow.append(node("span", runStatusMeta.text, `status-pill ${runStatusMeta.cls}`));
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
    td.colSpan = 7;
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
    tdModel.textContent = m.model || "qwen3.8:27b";

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

async function refresh({ force = false } = {}) {
  try {
    await api("/health");
    setConnection("online", `브로커 정상 (${BROKER_PORT})`);
    state.lastSyncAt = new Date();
    if ($("status")) $("status").textContent = `브로커 정상 가동 중 (127.0.0.1:${BROKER_PORT})`;

    // P5: a manual "refresh now" passes ?force=1 so the broker triggers an
    // in-process live IDE refresh (setForceRefreshHandler) before re-reading
    // the token state — bypassing the IDE's 5s TTL cache. Normal polling does
    // not force.
    const tokenPath = force ? "/v1/tokens/status?force=1" : "/v1/tokens/status";
    const [capRes, taskRes, appRes, tokenRes, runsRes, metricsRes] = await Promise.all([
      api("/v1/capabilities").catch(() => ({ capabilities: [] })),
      api("/v1/tasks").catch(() => ({ tasks: [] })),
      api("/v1/approvals").catch(() => ({ approvals: [] })),
      api(tokenPath).catch(() => ({ tokenStatus: null })),
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
    setConnection("offline", `브로커 오프라인 (${BROKER_PORT})`);
    if ($("status")) $("status").textContent =
      `브로커 연결 대기 중 (127.0.0.1:${BROKER_PORT}) — 브로커가 기동하면 자동 복구됩니다`;
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
      await copyToClipboard(`${API}/mcp`, "📋 ChatGPT 맞춤형 MCP SSE URL이 복사되었습니다.");
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
    await refresh({ force: true });
    showToast("AI 모델 쿼터가 최신 상태로 갱신되었습니다.");
  };

  // ── B5: provider block visibility (per-card toggle, persisted) ──────────
  // The four static provider blocks on the tokens tab each carry a header
  // toggle; dynamic external provider cards are discovered via their
  // .provider-toggle[data-provider] button. State lives in the module-scope
  // providerVisibility map so renderers outside bindEvents can apply it.
  const syncProviderVisibility = (k, visible) => {
    providerVisibility[k] = visible;
    persistProviderVisibility();
    applyProviderVisibility();
  };
  document.querySelectorAll(".provider-toggle[data-provider]").forEach((btn) => {
    if (btn.classList.contains("provider-toggle-delete")) return;
    const k = btn.dataset.provider;
    btn.onclick = () => syncProviderVisibility(k, providerVisibility[k] !== false);
  });
  if ($("provider-visibility-reset")) $("provider-visibility-reset").onclick = () => {
    // Reset both the four static keys and any dynamic external-* keys.
    for (const k of Object.keys(providerVisibility)) providerVisibility[k] = true;
    persistProviderVisibility();
    applyProviderVisibility();
    showToast("모든 제공자 블록을 표시합니다.");
  };
  applyProviderVisibility();

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
        showToast(state.autoStartEnabled ? "OS 시작 시 자동 실행이 등록되었습니다." : "OS 시작 시 자동 실행이 해제되었습니다.");
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
      const newInterval = clampPollInterval(Number(e.target.value));
      setPollInterval(newInterval);
    };
  }

  // ── Taskbar visibility (OS-common: Win taskbar / macOS Dock / Linux panel) ──
  // Tauri renders the window; show()/setSkipTaskbar() drive the native window
  // manager on whichever OS runs the app, so one toggle covers every platform.
  // In a plain browser (dev without the Tauri shell) the API is absent and the
  // toggle is a no-op.
  const taskbarToggle = $("setting-taskbar-toggle");
  const isTauriShell = () => {
    try {
      return Boolean(window.__TAURI__ && getCurrentWindow());
    } catch {
      return false;
    }
  };
  if (taskbarToggle) {
    taskbarToggle.checked = localStorage.getItem("ip_taskbar_visible") !== "false";
    taskbarToggle.onchange = async (e) => {
      const show = e.target.checked;
      localStorage.setItem("ip_taskbar_visible", String(show));
      if (!isTauriShell()) {
        showToast(show ? "브라우저에서는 작업표시줄 제어 불가 — Tauri 앱에서 사용하세요." : "작업표시줄 표시 꺼짐 (Tauri 앱에서 적용).");
        return;
      }
      try {
        const win = getCurrentWindow();
        await win.setSkipTaskbar(!show);
        if (!show) await win.hide();
        else await win.show();
        showToast(show ? "창이 작업표시줄에 표시됩니다." : "창이 트레이로 축소되었습니다.");
      } catch (err) {
        showToast(`작업표시줄 설정 실패: ${err.message}`, true);
        e.target.checked = localStorage.getItem("ip_taskbar_visible") !== "false";
      }
    };
  }

  // Gauge ticks toggle (5h 5 segments / weekly 7). Persisted; re-renders the
  // tokens tab immediately.
  const gaugeToggle = $("setting-gauge-ticks");
  if (gaugeToggle) {
    gaugeToggle.checked = gaugeTicksEnabled();
    gaugeToggle.onchange = (e) => {
      localStorage.setItem("ip_gauge_ticks", String(e.target.checked));
      renderTokens();
    };
  }

  // ── External provider form (Hermes custom-endpoint style) ─────────────
  const extErr = $("ext-error");
  const extAdd = $("ext-add");
  const readForm = () => ({
    name: $("ext-name")?.value?.trim() || "",
    baseUrl: $("ext-url")?.value?.trim() || "",
    apiKey: $("ext-apikey")?.value?.trim() || "",
    defaultModel: $("ext-model")?.value?.trim() || "",
    quotaUrl: $("ext-quota")?.value?.trim() || "",
    discoverModels: $("ext-discover")?.checked !== false,
    pollMs: (Number($("ext-poll")?.value || 60) || 60) * 1000,
  });
  if (extAdd) {
    extAdd.onclick = () => {
      if (extErr) extErr.textContent = "";
      const f = readForm();
      const ok = addExternalProvider(f.name, f.baseUrl, f.quotaUrl, f.apiKey, f.defaultModel, f.discoverModels, f.pollMs);
      if (ok) {
        for (const id of ["ext-name", "ext-url", "ext-apikey", "ext-model", "ext-quota"]) {
          const el = $(id);
          if (el) el.value = "";
        }
        const tr = $("ext-test-result");
        if (tr) { tr.style.display = "none"; tr.replaceChildren(); }
      } else if (extErr) {
        const { error } = validateExternalProvider(f);
        extErr.textContent = error || "잘못된 값";
      }
    };
  }
  const extTest = $("ext-test");
  if (extTest) {
    extTest.onclick = () => {
      if (extErr) extErr.textContent = "";
      void testExternalProvider();
    };
  }
  // Clicking the empty-state hint jumps to the settings tab.
  const extToggle = $("external-providers-toggle");
  if (extToggle) {
    extToggle.onclick = () => switchTab("settings");
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
      await copyToClipboard(`${API}/mcp`, "📋 ChatGPT 맞춤형 MCP SSE URL이 복사되었습니다.");
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
        await copyToClipboard(`${API}/mcp`, `ChatGPT 맞춤형 MCP URL ('${API}/mcp')이 복사되었습니다.`);
      } else if (control.classList.contains("copy-chatgpt-stdio")) {
        // Fetch the live launch spec from the broker: the real node runtime and
        // mcp-server.js path for THIS installation (the old snippet hardcoded
        // a path that does not exist).
        const spec = await api("/v1/integrations/chatgpt/spec").catch(() => null);
        const entry = spec?.spec || spec?.snippet || { command: "node", args: [`${API}/mcp`] };
        await copyToClipboard(JSON.stringify({ mcpServers: { "integrated-power": entry } }, null, 2), "ChatGPT STDIO 설정 JSON이 복사되었습니다.");
      } else if (control.classList.contains("register-claude")) {
        const res = await api("/v1/integrations/claude/register", { method: "POST", body: JSON.stringify({ confirm: true }) });
        showToast(`Claude Desktop에 Integrated Power MCP가 등록되었습니다 (${res.changed ? "신규 등록" : "이미 최신"}). Claude를 재시작하세요.`);
        await refresh();
      } else if (control.classList.contains("copy-claude-mcp") || control.classList.contains("copy-generic-mcp")) {
        const res = await api("/v1/integrations/claude/spec").catch(() => null);
        const snippet = res?.snippet || { mcpServers: { "integrated-power": { command: "node", args: [`${API}/mcp`] } } };
        await copyToClipboard(JSON.stringify(snippet, null, 2), "MCP 설정 JSON이 클립보드에 복사되었습니다.");
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

// ── B5: provider block visibility (module scope so all renderers can apply) ──
// The four static provider blocks on the tokens tab each carry a header
// toggle; dynamic external provider cards are discovered via their
// .provider-toggle[data-provider] button. One localStorage key, default all
// visible — mirrors the IDE viewConfig.{showAntigravity,showCodex,showClaude,
// showLocalLlm} semantics (`!== false` means visible).
const PROVIDER_VIS_KEY = "ip_provider_visibility";
const PROVIDER_KEYS = ["antigravity", "openai", "claude", "local"];
const loadProviderVisibility = () => {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(PROVIDER_VIS_KEY) || "{}");
  } catch {
    stored = null;
  }
  const out = {};
  for (const k of PROVIDER_KEYS) out[k] = stored && typeof stored[k] === "boolean" ? stored[k] : true;
  return out;
};
const persistProviderVisibility = () => {
  try {
    localStorage.setItem(PROVIDER_VIS_KEY, JSON.stringify(providerVisibility));
  } catch {
    /* storage unavailable — visibility is non-critical */
  }
};
const providerVisibility = loadProviderVisibility();
const applyProviderVisibility = () => {
  for (const k of PROVIDER_KEYS) {
    const visible = providerVisibility[k] !== false;
    const card = $(`provider-${k}`);
    if (card) card.style.display = visible ? "" : "none";
    const btn = document.querySelector(`.provider-toggle[data-provider="${k}"]`);
    if (btn) {
      btn.textContent = visible ? "숨기기" : "보기";
      btn.classList.toggle("is-off", !visible);
    }
  }
  // Dynamic external provider cards (B5-compatible: hidden cards are simply
  // display:none, so the same "모두 표시" reset restores them).
  document.querySelectorAll(".provider-card-external").forEach((card) => {
    const btn = card.querySelector(".provider-toggle[data-provider]");
    const key = btn?.dataset.provider;
    const visible = !key || providerVisibility[key] !== false;
    card.style.display = visible ? "" : "none";
    if (btn) {
      btn.textContent = visible ? "숨기기" : "보기";
      btn.classList.toggle("is-off", !visible);
    }
  });
};

// ── External (user-registered) quota providers ──────────────────────────
// The UI registers an arbitrary http(s) endpoint (OpenAI usage API, OpenRouter,
// a self-hosted gateway, a local JSON file served over http). The broker fetches
// it server-side at GET /v1/providers/external?url=... (loopback origin, so
// browser CORS never applies); the UI only sees the JSON payload and parses it
// with the shared pure parser (shared/quota/external.ts). Registration lives in
// localStorage; rendering uses the DOM element API only so cards stay
// discoverable by the B5 visibility toggles.
const EXTERNAL_KEY = "ip_external_providers";

const loadExternalProviders = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(EXTERNAL_KEY) || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((p) => p && typeof p === "object" && p.id && p.name && (p.baseUrl || p.url))
      : [];
  } catch {
    return [];
  }
};
const persistExternalProviders = () => {
  try {
    localStorage.setItem(EXTERNAL_KEY, JSON.stringify(state.externalProviders));
  } catch {
    /* non-critical */
  }
};
const externalCard = (p) => {
  const existing = document.getElementById(`provider-external-${p.id}`);
  if (existing) return existing;
  const card = document.createElement("div");
  card.className = "card provider-card provider-card-external";
  card.id = `provider-external-${p.id}`;
  card.dataset.externalId = p.id;
  const header = document.createElement("div");
  header.className = "provider-header";
  const pill = document.createElement("span");
  pill.className = "provider-pill";
  pill.textContent = p.name;
  const pillTitle = [p.baseUrl || p.url].filter(Boolean).join(" · ");
  if (pillTitle) pill.title = pillTitle;
  const statusTag = document.createElement("span");
  statusTag.className = "provider-state-tag";
  statusTag.textContent = "연결 중…";
  statusTag.id = `external-status-${p.id}`;
  const toggle = document.createElement("button");
  toggle.className = "provider-toggle";
  toggle.dataset.provider = `external-${p.id}`;
  toggle.title = "이 블록 표시/숨김";
  toggle.textContent = "숨기기";
  // Bind inline: dynamic cards are created after bindEvents() ran, so the
  // static querySelectorAll pass never reaches them (delete button works
  // because it is inline here).
  toggle.onclick = () => {
    const k = toggle.dataset.provider;
    const visible = providerVisibility[k] !== false;
    providerVisibility[k] = !visible;
    persistProviderVisibility();
    applyProviderVisibility();
    toggle.textContent = visible ? "숨기기" : "표시";
  };
  const del = document.createElement("button");
  del.className = "provider-toggle provider-toggle-delete";
  del.title = "이 외부 provider를 제거합니다";
  del.textContent = "✕";
  del.onclick = (e) => {
    e.stopPropagation();
    deleteExternalProvider(p.id);
  };
  header.append(pill, statusTag, toggle, del);
  const sub = document.createElement("p");
  sub.className = "window-countdown";
  sub.style.margin = "2px 0 6px 0";
  sub.textContent = (p.baseUrl || p.url) + (p.defaultModel ? " · " + p.defaultModel : "");
  const models = document.createElement("div");
  models.className = "provider-models";
  models.id = `external-windows-${p.id}`;
  card.append(header, sub, models);
  const host = $("external-providers-host");
  if (host) host.appendChild(card);
  return card;
};
const renderExternalProviders = () => {
  const host = $("external-providers-host");
  if (!host) return;
  for (const p of state.externalProviders) externalCard(p);
  for (const el of Array.from(host.children)) {
    const id = el.dataset.externalId;
    const stillRegistered = state.externalProviders.some((p) => p.id === id);
    if (!stillRegistered) el.remove();
  }
  for (const p of state.externalProviders) renderExternalCard(p);
  applyProviderVisibility(providerVisibility);
  const toggleBtn = $("external-providers-toggle");
  if (toggleBtn) toggleBtn.style.display = state.externalProviders.length ? "none" : "";
};
const renderExternalCard = (p) => {
  const card = document.getElementById(`provider-external-${p.id}`);
  if (!card) return;
  const data = state.externalData[p.id];
  const models = state.externalModels[p.id];
  const statusTag = document.getElementById(`external-status-${p.id}`);
  const container = document.getElementById(`external-windows-${p.id}`);
  if (container) container.replaceChildren();

  const modelChip = (name, isDefault) => {
    const chip = document.createElement("span");
    chip.className = "model-chip" + (isDefault ? " model-chip-default" : "");
    chip.textContent = name;
    chip.title = isDefault ? `기본 모델: ${name}` : name;
    return chip;
  };
  const renderModels = () => {
    if (!models || models.length === 0) return;
    const wrap = document.createElement("div");
    wrap.className = "external-models";
    const count = document.createElement("span");
    count.className = "external-models-count";
    count.textContent = `모델 ${models.length}개`;
    wrap.appendChild(count);
    const shown = models.slice(0, 12);
    for (const m of shown) wrap.appendChild(modelChip(m, m === p.defaultModel));
    if (models.length > shown.length) {
      const more = document.createElement("span");
      more.className = "model-chip model-chip-more";
      more.textContent = `+${models.length - shown.length}`;
      more.title = models.slice(12).join("\n");
      wrap.appendChild(more);
    }
    if (container) container.appendChild(wrap);
  };

  if (!data) {
    if (statusTag) {
      if (!quotaTargetOf(p)) {
        // Model-only provider: no quota endpoint configured, so no "연결 중" spinner.
        statusTag.textContent = models && models.length ? `정상 · ${models.length}개 모델` : "모델 조회";
        statusTag.className = "provider-state-tag" + (models && models.length ? " online" : "");
      } else {
        statusTag.textContent = "연결 중…";
        statusTag.className = "provider-state-tag";
      }
    }
    renderModels();
    return;
  }
  if (!data.ok) {
    // Broker down is NOT a provider error: a "Failed to fetch" from the
    // broker transport would blame the remote endpoint for our own outage.
    if (!state.brokerOnline) {
      if (statusTag) {
        statusTag.textContent = "브로커 오프라인";
        statusTag.className = "provider-state-tag";
        statusTag.title = `브로커 연결이 끊겨 외부 provider를 조회할 수 없습니다 (127.0.0.1:${BROKER_PORT})`;
      }
      const offErr = document.createElement("p");
      offErr.className = "muted";
      offErr.style.fontSize = "11px";
      offErr.textContent = "브로커 오프라인 — 연결이 복구되면 자동으로 갱신됩니다.";
      if (container) container.appendChild(offErr);
      renderModels();
      return;
    }
    const stale = brokerStale || data.staleBroker;
    if (statusTag) {
      statusTag.textContent = stale ? "브로커 재시작 필요" : "quota 오류";
      statusTag.className = "provider-state-tag critical";
      statusTag.title = stale
        ? `브로커가 외부 provider 기능(P7) 없이 기동 중입니다. ${STALE_BROKER_HINT}`
        : (data.error || "quota fetch failed");
    }
    const err = document.createElement("p");
    err.className = "muted";
    err.style.fontSize = "11px";
    err.textContent = stale
      ? `브로커 재시작 필요 — 구버전 브로커가 외부 provider 라우트를 응답하지 않습니다. ${STALE_BROKER_HINT}`
      : (data.error || "응답을 읽을 수 없습니다");
    if (container) container.appendChild(err);
    renderModels();
    return;
  }
  const okTag = data.windows.length > 1 ? "정상 · " + data.windows.length + "개 윈도우" : "정상";
  if (statusTag) {
    statusTag.textContent = okTag;
    statusTag.className = "provider-state-tag online";
  }
  data.windows.forEach((w) => {
    const row = document.createElement("div");
    row.className = "quota-window-row";
    const info = document.createElement("div");
    info.className = "window-info";
    const name = document.createElement("span");
    name.className = "window-name";
    name.textContent = w.label;
    const val = document.createElement("span");
    val.className = "window-val";
    if (w.unavailable) {
      val.textContent = "데이터 없음";
    } else {
      val.textContent = w.percentage.toFixed(1) + "% remaining";
    }
    info.append(name, val);
    const noteEl = document.createElement("p");
    noteEl.className = "window-countdown";
    noteEl.textContent = w.note ? "· " + w.note : "· 외부 엔드포인트 응답";
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("div");
    fill.className = "progress-fill external" + (w.unavailable ? "" : ` ${w.tone}`);
    fill.style.width = w.unavailable ? "0%" : w.percentage.toFixed(1) + "%";
    track.appendChild(fill);
    row.append(info, noteEl, track);
    if (container) container.appendChild(row);
  });
  renderModels();
  const stamp = document.createElement("p");
  stamp.className = "muted";
  stamp.style.fontSize = "10px";
  stamp.style.marginTop = "6px";
  stamp.textContent = "최근 갱신: " + new Date().toLocaleTimeString("ko-KR");
  if (container) container.appendChild(stamp);
};
const externalDueAt = {};
const externalSeen = new Set();
// Quota endpoint for a stored provider: new providers carry quotaUrl; legacy
// providers (pre-Hermes form) persisted only `url`, which was the quota source.
const quotaTargetOf = (p) => p.quotaUrl || (p.baseUrl ? undefined : p.url);
// Broker-side fetch of an external URL (CORS-free). `key` adds Authorization.
const fetchExternal = (url, key) =>
  api(`/v1/providers/external?url=${encodeURIComponent(url)}${key ? `&key=${encodeURIComponent(key)}` : ""}`);

const pollExternalProviders = async () => {
  const due = state.externalProviders.filter(
    (p) => p.enabled !== false && (!externalDueAt[p.id] || Date.now() >= externalDueAt[p.id]),
  );
  if (!due.length) return;
  for (const p of due) {
    externalDueAt[p.id] = Date.now() + (p.pollMs || 60_000);
    // Quota facet. New providers carry quotaUrl (or none); legacy providers
    // persisted before the Hermes-style form carry only `url` — that URL was
    // the quota source, so it keeps being polled.
    const quotaTarget = quotaTargetOf(p);
    if (quotaTarget) {
      try {
        const res = await fetchExternal(quotaTarget, p.apiKey);
        brokerStale = false; // a real 200 proves the route exists
        state.externalData[p.id] = parseExternalPayload(p.name, res && res.payload !== undefined ? res.payload : res);
      } catch (error) {
        if (isStaleBrokerError(error)) brokerStale = true;
        state.externalData[p.id] = {
          ok: false,
          name: p.name,
          windows: [],
          error: error instanceof Error ? error.message : String(error),
          staleBroker: isStaleBrokerError(error),
        };
      }
    }
    // Model-discovery facet: OpenAI /v1/models (or Ollama /api/tags), same
    // data[].id extraction the IDE TokenManager uses for LM Studio / vLLM.
    if (p.discoverModels !== false && p.baseUrl) {
      const candidates = modelDiscoveryUrls(p.baseUrl);
      let found = undefined;
      for (const candidate of candidates) {
        try {
          const res = await fetchExternal(candidate, p.apiKey);
          brokerStale = false;
          const list = parseModelList(res && res.payload !== undefined ? res.payload : res);
          if (list.length) { found = list; break; }
        } catch (error) {
          if (isStaleBrokerError(error)) brokerStale = true;
          /* try next candidate */
        }
      }
      state.externalModels[p.id] = found || state.externalModels[p.id] || [];
    }
    if (!externalSeen.has(p.id) && (state.externalData[p.id] || state.externalModels[p.id])) {
      externalSeen.add(p.id);
    }
  }
  renderExternalProviders();
};

const addExternalProvider = (name, baseUrl, quotaUrl, apiKey, defaultModel, discoverModels, pollMs) => {
  const { spec, error } = validateExternalProvider({
    name, baseUrl, quotaUrl, apiKey, defaultModel, discoverModels, pollMs,
  });
  if (error || !spec) {
    showToast("외부 provider 등록 실패: " + (error || "잘못된 값"), true);
    return false;
  }
  const dup = state.externalProviders.some(
    (p) => (p.baseUrl || p.url) === spec.baseUrl || (spec.quotaUrl && (p.quotaUrl || p.url) === spec.quotaUrl),
  );
  if (dup) {
    showToast("이미 등록된 엔드포인트입니다.", true);
    return false;
  }
  state.externalProviders.push(spec);
  persistExternalProviders();
  showToast(`외부 provider "${spec.name}"가 등록되었습니다.`);
  externalDueAt[spec.id] = 0; // poll immediately
  void pollExternalProviders();
  renderExternalProviders();
  return true;
};

const deleteExternalProvider = (id) => {
  const target = state.externalProviders.find((p) => p.id === id);
  state.externalProviders = state.externalProviders.filter((p) => p.id !== id);
  delete state.externalData[id];
  delete state.externalModels[id];
  delete externalDueAt[id];
  persistExternalProviders();
  if (target) showToast(`외부 provider "${target.name}"가 제거되었습니다.`);
  renderExternalProviders();
};

// ── Provider test (Hermes-style): connect + model discovery + optional quota ──
const testExternalProvider = async () => {
  const resultBox = $("ext-test-result");
  const name = $("ext-name")?.value?.trim() || "테스트";
  const baseUrl = $("ext-url")?.value?.trim() || "";
  const apiKey = $("ext-apikey")?.value?.trim() || "";
  const quotaUrl = $("ext-quota")?.value?.trim() || "";
  const discover = $("ext-discover")?.checked !== false;
  if (!resultBox) return;
  resultBox.style.display = "";
  resultBox.replaceChildren();
  const line = (text, tone) => {
    const row = document.createElement("p");
    row.style.margin = "2px 0";
    row.style.color = tone === "ok" ? "#34d399" : tone === "err" ? "#f87171" : "#cbd5e1";
    row.textContent = text;
    resultBox.appendChild(row);
  };
  line("테스트 중…", "info");
  if (!baseUrl) {
    line("엔드포인트 URL을 입력하세요.", "err");
    return;
  }
  const { spec, error } = validateExternalProvider({ name, baseUrl, quotaUrl, apiKey, discoverModels: discover });
  if (error || !spec) {
    line("입력값 오류: " + (error || ""), "err");
    return;
  }
  // 0) Guard: a broker built before the external route can't serve the test at
  // all — it answers every /v1/providers/external call with catch-all 404.
  let staleSeen = false;
  // 1) Model discovery: GET /v1/models (OpenAI-compatible) or /api/tags (Ollama).
  if (spec.discoverModels) {
    let discovered = false;
    for (const candidate of modelDiscoveryUrls(spec.baseUrl)) {
      try {
        const res = await fetchExternal(candidate, spec.apiKey);
        staleSeen = false;
        const payload = res && res.payload !== undefined ? res.payload : res;
        const models = parseModelList(payload);
        if (models.length) {
          discovered = true;
          line(`✅ 연결 성공 — ${models.length}개 모델 발견`, "ok");
          const shown = models.slice(0, 8).join(", ");
          line(`   ${shown}${models.length > 8 ? ` … (+${models.length - 8})` : ""}`, "info");
          break;
        }
      } catch (error) {
        if (isStaleBrokerError(error)) staleSeen = true;
        /* try next */
      }
    }
    if (staleSeen) {
      line(`⚠️ 브로커 재시작 필요 — ${STALE_BROKER_HINT}`, "err");
    } else if (!discovered) {
      // If no models found yet, note it (server may not expose /models).
      line("⚠️ 모델 목록 조회 불가 (서버가 /v1/models·/api/tags를 안 열 수 있음)", "info");
    }
  }
  // 2) Quota facet: parse the quota endpoint if one is configured.
  if (spec.quotaUrl) {
    try {
      const res = await fetchExternal(spec.quotaUrl, spec.apiKey);
      staleSeen = false;
      const data = parseExternalPayload(name, res && res.payload !== undefined ? res.payload : res);
      if (data.ok) {
        line(`✅ quota — ${data.windows.length}개 윈도우`, "ok");
        for (const w of data.windows) {
          line(`   ${w.label}: ${w.unavailable ? "데이터 없음" : w.percentage.toFixed(1) + "% remaining"}`, "info");
        }
      } else {
        line(`⚠️ quota 응답 해석 불가 — ${data.error}`, "info");
      }
    } catch (error) {
      if (isStaleBrokerError(error)) {
        line(`⚠️ 브로커 재시작 필요 — ${STALE_BROKER_HINT}`, "err");
      } else {
        line("❌ quota 연결 실패: " + (error instanceof Error ? error.message : String(error)), "err");
      }
    }
  }
  line("테스트 완료. 문제없으면 [💾 등록]을 누르세요.", "info");
};

let pollTimer = null;
function setPollInterval(ms) {
  state.pollInterval = ms;
  localStorage.setItem("ip_poll_interval", String(ms));
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, ms);
  showToast(`데이터 자동 갱신 주기가 ${ms / 1000}초로 설정되었습니다.`);
}

function renderPrewarmToolbar() {
  const el = $("token-prewarm-toolbar");
  if (!el) return;
  const currentMode = normalizePrewarmMode(localStorage.getItem("ip_prewarm_mode") || "click");
  const badgeText = currentMode === "always" ? "항상 실행" : currentMode === "once" ? "1회 실행 대기" : "수동 (클릭)";
  const badgeClass = `prewarm-badge prewarm-mode-${currentMode}`;

  const inner = node("div", undefined, "prewarm-toolbar-inner");
  const titleGroup = node("div", undefined, "prewarm-title-group");
  titleGroup.append(
    node("span", "⚡", "prewarm-icon"),
    node("span", "5시간 프리웜 모드:", "prewarm-label"),
    node("span", badgeText, badgeClass),
  );

  const options = node("div", undefined, "prewarm-mode-options");
  options.setAttribute("role", "radiogroup");
  options.setAttribute("aria-label", "Pre-warm Mode");

  const modes = [
    { key: "click", label: "Click", title: "수동 클릭 모드" },
    { key: "once", label: "Once", title: "다음 100% 도달 시 1회 자동 실행 후 Click 모드로 복귀" },
    { key: "always", label: "Always", title: "100% 완충 시마다 연속 자동 프리웜" },
  ];

  for (const m of modes) {
    const btn = button(m.label, `prewarm-mode-btn ${currentMode === m.key ? "active" : ""}`.trim());
    btn.type = "button";
    btn.title = m.title;
    btn.onclick = () => {
      localStorage.setItem("ip_prewarm_mode", m.key);
      renderPrewarmToolbar();
      showToast(`프리웜 모드가 '${m.key}'(으)로 변경되었습니다.`);
    };
    options.append(btn);
  }

  inner.append(titleGroup, options);
  el.replaceChildren(inner);
}

window.triggerPrewarmWindow = async function(windowId) {
  const prefix = prefixOf[windowId];
  if (!prefix) return;
  showToast(`${prefix} 5시간 윈도우 프리웜 요청 중...`);
  try {
    const res = await fetch(`${API}/prewarm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: prefix, immediateAbort: true }),
    });
    if (res.ok) {
      showToast(`${prefix} 5시간 충전 타이머가 활성화되었습니다.`);
      void refresh();
    }
  } catch (err) {
    showToast(`${prefix} 프리웜 신호 전송 완료 (충전 타이머 시작)`);
  }
};

// Initial setup
state.externalProviders = loadExternalProviders();
bindEvents();
switchTab("tokens"); // DEFAULT ON OPEN
renderTokens();
renderMainAgent();
renderHomeStats();
renderAgents();
renderTasks();
renderExternalProviders();
// Restore the persisted taskbar/tray preference (Tauri shell only).
if (localStorage.getItem("ip_taskbar_visible") === "false") {
  try {
    if (window.__TAURI__) {
      const win = getCurrentWindow();
      void win.setSkipTaskbar(true).then(() => win.hide()).catch(() => {});
    }
  } catch {
    /* browser dev — nothing to do */
  }
}
void refresh();
void refreshAutoStart();
void pollExternalProviders();
pollTimer = setInterval(refresh, state.pollInterval);
setInterval(() => {
  void pollExternalProviders().catch(() => {});
}, 5000);

