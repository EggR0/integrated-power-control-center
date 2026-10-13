export function classifyCollectionResponse({ response, error, key }) {
  if (error) {
    if (error.kind === "unselected") return { kind: "unselected", message: error.message };
    const errorText = [error.message, ...(Array.isArray(error.body?.errors) ? error.body.errors.map((item) => typeof item === "string" ? item : item?.message || item?.error || item?.code || "") : []), error.body?.error].filter(Boolean).join(" · ");
    const unsupported = error.status === 404 && /not[_ -]?found/i.test(errorText);
    return { kind: unsupported ? "unsupported" : "unavailable", message: errorText || "요청 실패" };
  }
  if (response?.ok === false) {
    return { kind: "unavailable", message: formatErrors(response.errors) || "브로커가 요청을 완료하지 못했습니다." };
  }
  const items = response?.[key];
  if (!Array.isArray(items)) {
    return { kind: "unavailable", message: "브로커 응답에 기록 목록이 없습니다." };
  }
  const message = formatErrors(response.errors);
  if (message) return { kind: items.length ? "partial" : "unavailable", message };
  return { kind: items.length ? "available" : "empty", message: "" };
}

export function classifyBrokerHealth(health, requiredCapabilities) {
  if (!health || health.ok !== true || health.service !== "integrated-power-broker") {
    return { kind: "unavailable", message: "브로커 상태를 확인할 수 없습니다." };
  }
  const capabilities = Array.isArray(health.capabilities) ? health.capabilities : [];
  const missing = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  if (!Number.isInteger(health.schemaVersion) || health.schemaVersion < 2 || missing.length) {
    return {
      kind: "unsupported",
      message: `현재 브로커는 실행 기록 API를 지원하지 않습니다${missing.length ? ` (${missing.join(", ")})` : ""}.`,
    };
  }
  return { kind: "supported", message: "" };
}

function formatErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) return "";
  return errors.map((error) => {
    if (typeof error === "string") return error;
    if (error && typeof error === "object") return error.message || error.error || error.code || JSON.stringify(error);
    return String(error);
  }).join(" · ");
}
