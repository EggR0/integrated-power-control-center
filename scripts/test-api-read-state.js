const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  const { classifyCollectionResponse, classifyBrokerHealth } = await import("../src/api-read-state.mjs");
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /classifyCollectionResponse/, "the desktop renderer must use API state classification");
  assert.doesNotMatch(source, /api\("\/v1\/runs"\)\.catch\(\(\) => \(\{ runs: \[\], activeCount: 0 \}\)\)/, "a failed runs request must not become an empty history");
  assert.doesNotMatch(source, /api\("\/v1\/metrics\/local-llm"\)\.catch\(\(\) => \(\{ metrics: \[\] \}\)\)/, "a failed metrics request must not become an empty history");
  assert.match(source, /\/v1\/workspaces/, "the desktop must load canonical workspace IDs");
  assert.match(source, /workspacePath/, "the desktop must support an explicit workspace path");
  assert.match(source, /\/v1\/settings\/quota/, "quota settings must use the broker-owned settings API");
  assert.doesNotMatch(source, /window\.__lastCcAutoPrewarm/, "server-owned prewarm scheduling must not be duplicated in the desktop");
  assert.match(source, /quota-refill/, "new brokers must claim refill notifications through the server owner");
  const unsupported = classifyCollectionResponse({ error: Object.assign(new Error("not_found"), { status: 404 }), key: "runs" });
  assert.equal(unsupported.kind, "unsupported");
  const unsupportedEnvelope = classifyCollectionResponse({ error: Object.assign(new Error("HTTP 404"), { status: 404, body: { errors: [{ code: "not_found" }] } }), key: "runs" });
  assert.equal(unsupportedEnvelope.kind, "unsupported");
  const unavailable = classifyCollectionResponse({ error: Object.assign(new Error("permission denied"), { status: 500 }), key: "runs" });
  assert.equal(unavailable.kind, "unavailable");
  assert.equal(classifyCollectionResponse({ error: Object.assign(new Error("선택 필요"), { kind: "unselected" }), key: "runs" }).kind, "unselected");
  const empty = classifyCollectionResponse({ response: { ok: true, runs: [], errors: [] }, key: "runs" });
  assert.equal(empty.kind, "empty");
  const malformed = classifyCollectionResponse({ response: { ok: false, runs: [], errors: ["malformed JSONL"] }, key: "runs" });
  assert.equal(malformed.kind, "unavailable");
  assert.match(malformed.message, /malformed JSONL/);
  const partial = classifyCollectionResponse({ response: { ok: true, runs: [{ id: "run-1" }], errors: ["one line skipped"] }, key: "runs" });
  assert.equal(partial.kind, "partial");
  assert.match(partial.message, /one line skipped/);
  assert.equal(classifyBrokerHealth({ ok: true, service: "integrated-power-broker" }, ["runs.read"]).kind, "unsupported");
  assert.equal(classifyBrokerHealth({ ok: true, service: "integrated-power-broker", schemaVersion: 2, capabilities: ["runs.read"] }, ["runs.read"]).kind, "supported");
  console.log("API read-state tests passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
