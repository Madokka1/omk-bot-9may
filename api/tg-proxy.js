const crypto = require("crypto");

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

function isRetryableError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code || "";
  const msg = typeof err.message === "string" ? err.message : "";
  return (
    code === "ETIMEDOUT" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    err.name === "AbortError" ||
    msg.includes("fetch failed")
  );
}

function send(res, statusCode, body, headers = {}) {
  res.statusCode = statusCode;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function sign(secret, fileId, exp) {
  const mac = crypto.createHmac("sha256", secret).update(`${fileId}.${exp}`).digest();
  return base64Url(mac);
}

async function telegramApi(method, payload, { retries = 2 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { controller, timeout } = withTimeout(Number(process.env.TELEGRAM_API_TIMEOUT_MS || 60000));
    try {
      const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        const details = json ? JSON.stringify(json) : String(resp.status);
        throw new Error(`Telegram API error: ${details}`);
      }
      return json.result;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < retries && isRetryableError(err)) {
        console.warn(`[telegram] ${method} attempt ${attempt + 1} failed (${err.code || err.name}), retrying...`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== "GET") {
      return send(res, 405, "Method not allowed", { "content-type": "text/plain; charset=utf-8" });
    }

    const url = new URL(req.url, "http://localhost");
    const fileId = url.searchParams.get("file_id") || "";
    const expRaw = url.searchParams.get("exp") || "";
    const sig = url.searchParams.get("sig") || "";

    const secret = (process.env.TG_PROXY_SECRET || "").trim();
    if (!secret) {
      return send(res, 500, "TG_PROXY_SECRET is not set", { "content-type": "text/plain; charset=utf-8" });
    }

    const exp = Number(expRaw);
    const now = Math.floor(Date.now() / 1000);
    if (!fileId || !Number.isFinite(exp) || exp <= now) {
      return send(res, 401, "Unauthorized", { "content-type": "text/plain; charset=utf-8" });
    }

    const expectedSig = sign(secret, fileId, expRaw);
    if (!sig || !timingSafeEqual(sig, expectedSig)) {
      return send(res, 401, "Unauthorized", { "content-type": "text/plain; charset=utf-8" });
    }

    const file = await telegramApi("getFile", { file_id: fileId });
    const filePath = file?.file_path;
    if (!filePath) {
      return send(res, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    const tgUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileTimeoutMs = Number(process.env.TELEGRAM_FILE_TIMEOUT_MS || 60000);
    for (let attempt = 0; attempt <= 2; attempt++) {
      const { controller, timeout } = withTimeout(fileTimeoutMs);
      try {
        const resp = await fetch(tgUrl, { signal: controller.signal });
        if (!resp.ok) {
          return send(res, 502, "Bad gateway", { "content-type": "text/plain; charset=utf-8" });
        }

        const contentType = resp.headers.get("content-type") || "application/octet-stream";
        const bytes = Buffer.from(await resp.arrayBuffer());
        return send(res, 200, bytes, { "content-type": contentType, "cache-control": "public, max-age=60" });
      } catch (err) {
        clearTimeout(timeout);
        if (attempt < 2 && isRetryableError(err)) {
          console.warn(`[tg-proxy] file fetch attempt ${attempt + 1} failed (${err.code || err.name}), retrying...`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  } catch (err) {
    console.error(err);
    return send(res, 500, "Internal error", { "content-type": "text/plain; charset=utf-8" });
  }
};

