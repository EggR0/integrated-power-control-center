const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ip-hub-e2e-"));
const stateRoot = path.join(tempDir, "state");
fs.mkdirSync(stateRoot, { recursive: true });

async function main() {
  console.log(`[E2E] Starting standalone hub integration tests with stateRoot: ${stateRoot}`);
  const port = await freePort();

  const env = {
    ...process.env,
    INTEGRATED_POWER_STATE_DIR: stateRoot,
    INTEGRATED_POWER_STATE_ROOT: stateRoot,
    INTEGRATED_POWER_BROKER_PORT: String(port),
    LOCALAPPDATA: path.join(tempDir, "localappdata"),
    APPDATA: path.join(tempDir, "appdata"),
    USERPROFILE: tempDir,
    HOME: tempDir,
  };

  const child = spawn(process.execPath, [path.join(root, "broker-server.js")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForHealth(port, child);
    console.log(`[E2E] Broker started and healthy on http://127.0.0.1:${port}`);

    // a) Ecosystem Discovery
    console.log("[E2E] Testing (a) Ecosystem Discovery...");
    const ecosystem = await requestJson(port, "GET", "/v1/hub/ecosystem");
    assert.ok(path.resolve(ecosystem.activeTodoFilePath).startsWith(path.resolve(stateRoot)), "activeTodoFilePath must stay inside isolated stateRoot: " + ecosystem.activeTodoFilePath);
    assert.ok(Array.isArray(ecosystem.connectors), "connectors must be an array");
    const connectorIds = ecosystem.connectors.map((c) => c.id);
    console.log(`[E2E] Discovered connectors: ${connectorIds.join(", ")}`);
    assert.ok(connectorIds.includes("openclaw"), "must include openclaw");
    assert.ok(connectorIds.includes("hermes"), "must include hermes");
    assert.ok(connectorIds.includes("opencodex"), "must include opencodex");
    assert.ok(connectorIds.includes("obsidian"), "must include obsidian");
    assert.ok(connectorIds.includes("docling"), "must include docling");
    assert.ok(connectorIds.includes("mineru"), "must include mineru");
    assert.ok(connectorIds.includes("czkawka"), "must include czkawka");

    // b) Ambiguous Task Ingestion
    console.log("[E2E] Testing (b) Ambiguous Task Ingestion with '장보기'...");
    const ingestB = await requestJson(port, "POST", "/v1/hub/ingest", { text: "장보기" });
    assert.equal(ingestB.ok, true, "ingest response ok");
    const todoB = ingestB.todo;
    assert.equal(todoB.status, "needs_clarification", "장보기 must require clarification");
    assert.ok(
      Array.isArray(todoB.clarificationQuestions) && todoB.clarificationQuestions.length > 0,
      "clarification questions must be returned"
    );
    assert.equal(todoB.category, "purchasing", "category inferred as purchasing");

    const todoMdPath = path.join(stateRoot, "Todo.md");
    assert.ok(fs.existsSync(todoMdPath), "Todo.md must exist in isolated state dir");
    const todoMdContent = fs.readFileSync(todoMdPath, "utf8");
    assert.match(todoMdContent, /- \[\?\] 장보기/, "Todo.md must write - [?] for ambiguous task");

    // c) Interactive Clarification & Playbook Persistence
    console.log("[E2E] Testing (c) Interactive Clarification & Playbook Persistence...");
    const clarifyC = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoB.id)}/clarify`, {
      answers: [
        {
          id: todoB.clarificationQuestions[0]?.id || "q1",
          question: todoB.clarificationQuestions[0]?.question || "품목",
          answer: "식료품: 멸균우유 1L 12팩 구매",
        },
        {
          id: todoB.clarificationQuestions[1]?.id || "q2",
          question: todoB.clarificationQuestions[1]?.question || "예산",
          answer: "11번가 5만원 이상 5천원 쿠폰 적용 확인",
        },
      ],
      learnedPreference: "식료품: 멸균우유 1L 12팩 구매",
      learnedRule: "11번가 5만원 이상 5천원 쿠폰 적용 확인",
    });
    assert.equal(clarifyC.ok, true, "clarify response ok");
    assert.equal(clarifyC.todo.status, "ready", "clarified task status must become ready");

    const updatedTodoMd = fs.readFileSync(todoMdPath, "utf8");
    assert.match(updatedTodoMd, /- \[ \] 장보기/, "Todo.md must update marker to - [ ] for ready task");

    const playbooksRes = await requestJson(port, "GET", "/v1/hub/playbooks");
    assert.ok(Array.isArray(playbooksRes.playbooks), "playbooks must be an array");
    const purchasingPlaybook = playbooksRes.playbooks.find((p) => p.category === "purchasing");
    assert.ok(purchasingPlaybook, "purchasing category playbook must exist");
    assert.ok(
      purchasingPlaybook.procedural.some((rule) => rule.rule.includes("11번가 5만원 이상 5천원 쿠폰 적용 확인")),
      "purchasing playbook must persist learned procedural rule"
    );

    // d) Privacy & Domain Classification
    console.log("[E2E] Testing (d) Privacy & Domain Classification...");
    const ingestD = await requestJson(port, "POST", "/v1/hub/ingest", {
      text: "건강검진 결과 및 연말정산 세금 확인",
    });
    assert.equal(ingestD.ok, true);
    const todoD = ingestD.todo;
    assert.equal(todoD.privacyTier, "strictly_local", "health and tax must classify as strictly_local");
    assert.equal(todoD.domain, "private", "domain must classify as private");

    // Clarify todoD so it is ready for dispatch
    const clarifyD = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoD.id)}/clarify`, {
      answers: [
        {
          id: todoD.clarificationQuestions[0]?.id || "q-goal",
          question: "목표",
          answer: "로컬 PDF 결과 파일 정리",
        },
      ],
    });
    assert.equal(clarifyD.todo.status, "ready");

    // Request dispatch with preferredProvider: "openai.codex.app"
    const dispatchD = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoD.id)}/dispatch`, {
      preferredProvider: "openai.codex.app",
    });
    assert.equal(dispatchD.ok, true);
    assert.equal(
      dispatchD.task?.originProvider,
      "local.openai-compatible",
      "strictly_local task must restrict/force cloud dispatch to local.openai-compatible"
    );
    assert.equal(
      dispatchD.task?.privacy,
      "local",
      "strictly_local task must enforce local privacy envelope"
    );

    // e) Manual Credit Lock (#agya)
    console.log("[E2E] Testing (e) Manual Credit Lock (#agya)...");
    // e1: Task with #agya tag
    const ingestWithAgya = await requestJson(port, "POST", "/v1/hub/ingest", {
      text: "#agya 정밀 코드 리팩토링",
    });
    assert.equal(ingestWithAgya.ok, true);
    const todoWithAgya = ingestWithAgya.todo;
    assert.equal(todoWithAgya.allowManualCredit, true, "#agya tag must enable allowManualCredit");

    const clarifyWithAgya = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoWithAgya.id)}/clarify`, {
      answers: [
        {
          id: todoWithAgya.clarificationQuestions[0]?.id || "q-target",
          question: "대상",
          answer: "모듈 의존성 정리 및 단위 테스트 보강",
        },
        {
          id: todoWithAgya.clarificationQuestions[1]?.id || "q-criteria",
          question: "검증 기준",
          answer: "단위 테스트 전체 통과 확인",
        },
      ],
    });
    assert.equal(clarifyWithAgya.todo.status, "ready");

    const dispatchWithAgya = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoWithAgya.id)}/dispatch`, {
      preferredProvider: "google.antigravity.ide",
    });
    assert.equal(dispatchWithAgya.ok, true);
    assert.equal(
      dispatchWithAgya.task?.originProvider,
      "google.antigravity.ide",
      "with #agya opt-in, dispatching to google.antigravity.ide is permitted"
    );

    // e2: Task without #agya tag
    const ingestWithoutAgya = await requestJson(port, "POST", "/v1/hub/ingest", {
      text: "일반 코드 리팩토링",
    });
    assert.equal(ingestWithoutAgya.ok, true);
    const todoWithoutAgya = ingestWithoutAgya.todo;
    assert.equal(todoWithoutAgya.allowManualCredit, false, "without #agya tag, allowManualCredit must be false");

    const clarifyWithoutAgya = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoWithoutAgya.id)}/clarify`, {
      answers: [
        {
          id: todoWithoutAgya.clarificationQuestions[0]?.id || "q-target",
          question: "대상",
          answer: "모듈 의존성 정리 및 단위 테스트 보강 작업",
        },
        {
          id: todoWithoutAgya.clarificationQuestions[1]?.id || "q-criteria",
          question: "검증 기준",
          answer: "빌드 및 모든 테스트 통과",
        },
      ],
    });
    assert.equal(clarifyWithoutAgya.todo.status, "ready");

    const dispatchWithoutAgya = await requestJson(port, "POST", `/v1/hub/todos/${encodeURIComponent(todoWithoutAgya.id)}/dispatch`, {
      preferredProvider: "google.antigravity.ide",
    });
    assert.equal(dispatchWithoutAgya.ok, true);
    assert.equal(
      dispatchWithoutAgya.task?.originProvider,
      "openai.codex.app",
      "without #agya opt-in, dispatching to google.antigravity.ide must redirect to openai.codex.app"
    );

    console.log("[E2E] All Hub E2E flows passed successfully!");
  } finally {
    await stop(child);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error if file locked temporarily
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitForHealth(port, child) {
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Broker server exited prematurely with code ${child.exitCode}: ${stderr}`);
    }
    try {
      const value = await requestJson(port, "GET", "/health");
      if (value && value.service === "integrated-power-broker") return;
    } catch {
      /* broker still starting */
    }
    await delay(150);
  }
  throw new Error(`Broker server did not become healthy within 15s: ${stderr}`);
}

function requestJson(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const postData = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method,
        headers: {
          ...(postData
            ? {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Length": Buffer.byteLength(postData),
              }
            : {}),
        },
        timeout: 5000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            const parsed = raw ? JSON.parse(raw) : null;
            if (res.statusCode >= 400) {
              const err = new Error(`HTTP ${res.statusCode}: ${raw}`);
              err.status = res.statusCode;
              err.data = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse response from ${pathname}: ${raw}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request to ${pathname} timed out`));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function stop(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timeout = setTimeout(() => child.kill(), 3000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

main().catch((error) => {
  console.error("[E2E FAILED]", error);
  process.exitCode = 1;
});
