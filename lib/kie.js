const { fetchWithAgent } = require("./fetch");

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

function getKieBaseUrl() {
  return (process.env.KIE_BASE_URL || "https://api.kie.ai").trim().replace(/\/+$/, "");
}

function getKieApiKey() {
  const key = (process.env.KIE_API_KEY || process.env.KIE_API || "").trim();
  if (!key) throw new Error("KIE_API_KEY (or KIE_API) is not set");
  return key;
}

async function kieFetchJson(path, { method = "GET", body, timeoutMs } = {}) {
  const baseUrl = getKieBaseUrl();
  const url = `${baseUrl}${path.startsWith("/") ? "" : "/"}${path}`;

  const { controller, timeout } = withTimeout(timeoutMs ?? Number(process.env.KIE_HTTP_TIMEOUT_MS || 45000));
  try {
    const resp = await fetchWithAgent(url, {
      method,
      headers: {
        authorization: `Bearer ${getKieApiKey()}`,
        ...(body ? { "content-type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const err = new Error(`KIE HTTP error: ${resp.status}`);
      err.httpStatus = resp.status;
      err.httpUrl = url;
      err.httpBody = json ?? (await resp.text().catch(() => ""));
      throw err;
    }

    // docs.kie.ai typically uses { code: 200, data: ... }
    if (json && typeof json === "object" && "code" in json && Number(json.code) !== 200) {
      const err = new Error(`KIE API error: ${JSON.stringify(json)}`);
      err.httpStatus = 200;
      err.httpUrl = url;
      err.httpBody = json;
      throw err;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function createTask({ model, input, callBackUrl } = {}) {
  if (!model) throw new Error("KIE model is required");
  const payload = { model, input: input ?? {} };
  if (callBackUrl) payload.callBackUrl = callBackUrl;

  const json = await kieFetchJson("/api/v1/jobs/createTask", { method: "POST", body: payload });
  const taskId = json?.data?.taskId;
  if (!taskId) throw new Error(`KIE createTask: missing taskId (${JSON.stringify(json)})`);
  return taskId;
}

async function getTask(taskId) {
  if (!taskId) throw new Error("taskId is required");
  const json = await kieFetchJson(`/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, { method: "GET" });
  return json?.data ?? null;
}

function parseResultUrls(taskData) {
  const raw = taskData?.resultJson;
  if (!raw) return [];
  if (typeof raw === "object") {
    return Array.isArray(raw?.resultUrls) ? raw.resultUrls : [];
  }
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.resultUrls) ? parsed.resultUrls : [];
  } catch {
    return [];
  }
}

function isTerminalStatus(status) {
  const s = String(status || "").toLowerCase();
  return s === "success" || s === "fail" || s === "failed" || s === "canceled" || s === "cancelled";
}

function getTaskState(taskData) {
  if (!taskData || typeof taskData !== "object") return "";
  // Market common uses `state` (waiting/queuing/generating/success/fail)
  if (typeof taskData.state === "string") return taskData.state;
  // Some older/other responses may use `status`
  if (typeof taskData.status === "string") return taskData.status;
  return "";
}

async function waitForTask(taskId, { timeoutMs, pollIntervalMs } = {}) {
  const start = Date.now();
  const maxWait = timeoutMs ?? Number(process.env.KIE_POLL_TIMEOUT_MS || 55000);
  const interval = pollIntervalMs ?? Number(process.env.KIE_POLL_INTERVAL_MS || 1500);

  let last = null;
  while (Date.now() - start < maxWait) {
    last = await getTask(taskId);
    const state = getTaskState(last);
    if (isTerminalStatus(state)) return last;
    await new Promise((r) => setTimeout(r, interval));
  }

  const err = new Error(`KIE task timeout after ${maxWait}ms`);
  err.taskId = taskId;
  err.task = last;
  throw err;
}

async function generateImageFromText(prompt, opts = {}) {
  const model = (opts.model || process.env.KIE_T2I_MODEL || "grok-imagine/text-to-image").trim();
  const aspectRatio = (opts.aspect_ratio || process.env.KIE_T2I_ASPECT_RATIO || "1:1").trim();

  const input = { prompt: String(prompt || "").trim() };
  if (model.includes("grok-imagine/") && !("aspect_ratio" in input)) input.aspect_ratio = aspectRatio;

  // Optional raw JSON override for edge cases / new models.
  const extra = (opts.extra_input_json || process.env.KIE_T2I_EXTRA_INPUT_JSON || "").trim();
  if (extra) {
    try {
      Object.assign(input, JSON.parse(extra));
    } catch {
      // ignore
    }
  }

  const taskId = await createTask({ model, input });
  const task = await waitForTask(taskId, opts.wait || {});

  const state = String(getTaskState(task) || "").toLowerCase();
  if (state !== "success") {
    const err = new Error(`KIE task failed: ${state || "unknown"}`);
    err.taskId = taskId;
    err.task = task;
    throw err;
  }

  const urls = parseResultUrls(task);
  if (!urls.length) {
    const err = new Error("KIE task success but no resultUrls");
    err.taskId = taskId;
    err.task = task;
    throw err;
  }
  return { taskId, urls, task };
}

async function generateImageFromImage({ prompt, imageUrl }, opts = {}) {
  const model = (opts.model || process.env.KIE_I2I_MODEL || "grok-imagine/image-to-image").trim();
  const input = {
    prompt: String(prompt || "").trim(),
    image_urls: [String(imageUrl || "").trim()].filter(Boolean)
  };

  const extra = (opts.extra_input_json || process.env.KIE_I2I_EXTRA_INPUT_JSON || "").trim();
  if (extra) {
    try {
      Object.assign(input, JSON.parse(extra));
    } catch {
      // ignore
    }
  }

  if (!input.prompt) throw new Error("prompt is required");
  if (!input.image_urls.length) throw new Error("imageUrl is required");

  const taskId = await createTask({ model, input });
  const task = await waitForTask(taskId, opts.wait || {});

  const state = String(getTaskState(task) || "").toLowerCase();
  if (state !== "success") {
    const err = new Error(`KIE task failed: ${state || "unknown"}`);
    err.taskId = taskId;
    err.task = task;
    throw err;
  }

  const urls = parseResultUrls(task);
  if (!urls.length) {
    const err = new Error("KIE task success but no resultUrls");
    err.taskId = taskId;
    err.task = task;
    throw err;
  }

  return { taskId, urls, task };
}

async function fetchImageAsBlob(url) {
  const { controller, timeout } = withTimeout(Number(process.env.KIE_ASSET_TIMEOUT_MS || 45000));
  try {
    const resp = await fetchWithAgent(url, { signal: controller.signal });
    if (!resp.ok) {
      const err = new Error("KIE asset fetch failed");
      err.httpStatus = resp.status;
      err.httpUrl = url;
      err.httpBody = await resp.text().catch(() => "");
      throw err;
    }
    return await resp.blob();
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  createTask,
  getTask,
  waitForTask,
  parseResultUrls,
  getTaskState,
  generateImageFromText,
  generateImageFromImage,
  fetchImageAsBlob
};
