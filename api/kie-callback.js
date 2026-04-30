const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { fetchWithAgent } = require("../lib/fetch");
const kie = require("../lib/kie");
const creditsStore = require("../lib/credits-store");
let sharp = null;
try {
  // optional at runtime, but installed in this repo
  sharp = require("sharp");
} catch (_) {}

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

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function getSecret() {
  const secret = (process.env.KIE_CALLBACK_SECRET || "").trim();
  if (!secret) throw new Error("KIE_CALLBACK_SECRET is not set");
  return secret;
}

function sign(secret, chatId, userId, variantText, exp, creditsLeftRaw) {
  // Backward compatibility: old callback signed without credits_left.
  const creditsPart = creditsLeftRaw === undefined ? "" : String(creditsLeftRaw);
  const signed =
    creditsLeftRaw === undefined
      ? `${chatId}.${userId}.${variantText}.${exp}`
      : `${chatId}.${userId}.${variantText}.${creditsPart}.${exp}`;

  return crypto
    .createHmac("sha256", secret)
    .update(signed)
    .digest("base64url");
}

function getTaskIdFromPayload(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.taskId === "string") return body.taskId;
  if (typeof body?.data?.taskId === "string") return body.data.taskId;
  if (typeof body?.data?.id === "string") return body.data.id;
  return "";
}

function getResultUrlFromPayload(body) {
  if (!body || typeof body !== "object") return "";
  const direct =
    body?.data?.info?.resultImageUrl ||
    body?.data?.resultImageUrl ||
    body?.data?.result_url ||
    body?.resultImageUrl ||
    body?.result_url;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const arr =
    body?.data?.info?.resultUrls ||
    body?.data?.resultUrls ||
    body?.resultUrls;
  if (Array.isArray(arr) && typeof arr[0] === "string") return arr[0];
  return "";
}

const REFUND_GUARD_TTL_MS = 6 * 60 * 60 * 1000;
const refundedTaskIds = new Map();

function pruneRefundGuards(now) {
  for (const [taskId, exp] of refundedTaskIds.entries()) {
    if (!exp || exp <= now) refundedTaskIds.delete(taskId);
  }
}

function extractFailureReason(task) {
  if (!task || typeof task !== "object") return "";

  const directCandidates = [
    task.failReason,
    task.fail_reason,
    task.failMsg,
    task.fail_msg,
    task.error,
    task.errorMsg,
    task.error_msg,
    task.message,
    task.msg
  ];
  for (const c of directCandidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }

  const raw = task.resultJson;
  if (raw && typeof raw === "object") {
    const maybe = raw.error || raw.errorMsg || raw.error_msg || raw.message || raw.msg;
    if (typeof maybe === "string" && maybe.trim()) return maybe.trim();
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      const maybe = parsed?.error || parsed?.errorMsg || parsed?.error_msg || parsed?.message || parsed?.msg;
      if (typeof maybe === "string" && maybe.trim()) return maybe.trim();
    } catch (_) {}
  }

  return "";
}

async function refundOnFailureOnce({ taskId, userId }) {
  if (!taskId || !userId) return;
  const now = Date.now();
  pruneRefundGuards(now);
  const key = String(taskId);
  if (refundedTaskIds.has(key)) return;
  refundedTaskIds.set(key, now + REFUND_GUARD_TTL_MS);
  try {
    await creditsStore.refundCredit(userId);
  } catch (err) {
    console.warn("[kie-callback] refund failed:", err?.message || err);
  }
}

async function telegramApi(method, payload, { retries = 2 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { controller, timeout } = withTimeout(Number(process.env.TELEGRAM_API_TIMEOUT_MS || 60000));
    try {
      const resp = await fetchWithAgent(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        const details = json ? JSON.stringify(json) : String(resp.status);
        const err = new Error(`Telegram API error: ${details}`);
        err.httpStatus = resp.status;
        err.httpBody = json ?? details;
        throw err;
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

async function telegramApiMultipart(method, formData, { retries = 2 } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  for (let attempt = 0; attempt <= retries; attempt++) {
    const { controller, timeout } = withTimeout(Number(process.env.TELEGRAM_API_TIMEOUT_MS || 60000));
    try {
      const resp = await fetchWithAgent(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: formData,
        signal: controller.signal
      });

      const json = await resp.json().catch(() => null);
      if (!resp.ok || !json?.ok) {
        const details = json ? JSON.stringify(json) : String(resp.status);
        const err = new Error(`Telegram API error: ${details}`);
        err.httpStatus = resp.status;
        err.httpBody = json ?? details;
        throw err;
      }
      return json.result;
    } catch (err) {
      clearTimeout(timeout);
      if (attempt < retries && isRetryableError(err)) {
        console.warn(`[telegram] ${method} multipart attempt ${attempt + 1} failed (${err.code || err.name}), retrying...`);
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

// Use __dirname so PM2 cwd doesn't break logo path.
const CLIENT_LOGO_DEFAULT_PATH = path.join(__dirname, "..", "assets", "client-logo.svg");

let cachedLogoSvg = null;
async function getClientLogoSvg() {
  if (cachedLogoSvg !== null) return cachedLogoSvg; // may be null if missing
  const p = (process.env.CLIENT_LOGO_PATH || CLIENT_LOGO_DEFAULT_PATH).trim();
  try {
    const svg = await fs.readFile(p, "utf8");
    cachedLogoSvg = svg && svg.trim() ? svg : null;
    return cachedLogoSvg;
  } catch (_) {
    cachedLogoSvg = null;
    return null;
  }
}

async function overlayClientLogo(blob) {
  if (!sharp) return blob;
  const svg = await getClientLogoSvg();
  if (!svg) return blob;

  const baseBuf = Buffer.from(await blob.arrayBuffer());
  const base = sharp(baseBuf);
  const meta = await base.metadata();
  const width = meta.width || 0;
  const height = meta.height || 0;
  if (!width || !height) return blob;

  // Logo sizing: 22% of image width, max 320px, min 160px.
  const targetW = Math.max(160, Math.min(320, Math.round(width * 0.22)));
  const margin = Math.max(18, Math.round(Math.min(width, height) * 0.03));

  const logoPng = await sharp(Buffer.from(svg), { density: 300 })
    .resize({ width: targetW, withoutEnlargement: true })
    .png()
    .toBuffer();

  // Add subtle white plate behind to keep visibility on dark areas.
  const logoMeta = await sharp(logoPng).metadata();
  const logoW = logoMeta.width || targetW;
  const logoH = logoMeta.height || Math.round(targetW * 0.3);
  const platePad = Math.round(logoW * 0.14);
  const plateRadius = Math.round(logoW * 0.08);
  const plateW = logoW + platePad * 2;
  const plateH = logoH + platePad * 2;
  const plateSvg = Buffer.from(
    `<svg width="${plateW}" height="${plateH}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect x="0" y="0" width="${plateW}" height="${plateH}" rx="${plateRadius}" ry="${plateRadius}" fill="white" fill-opacity="0.75"/>` +
    `</svg>`
  );

  const plateLeft = Math.max(0, Math.round((width - plateW) / 2));
  const plateTop = Math.max(0, Math.round(height - margin - plateH));
  const logoLeft = plateLeft + platePad;
  const logoTop = plateTop + platePad;

  const composed = await base
    .composite([
      { input: plateSvg, top: plateTop, left: plateLeft },
      { input: logoPng, top: logoTop, left: logoLeft }
    ])
    .png()
    .toBuffer();

  return new Blob([composed], { type: "image/png" });
}

module.exports = async (req, res) => {
  try {
    console.log("[kie-callback] hit", req.method, req.url);
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method not allowed" });

    const url = new URL(req.url, "http://localhost");
    const chatId = url.searchParams.get("chat_id") || "";
    const userId = url.searchParams.get("user_id") || "";
    const variantText = url.searchParams.get("variant") || "";
    const creditsLeftRaw = url.searchParams.get("credits_left");
    const expRaw = url.searchParams.get("exp") || "";
    const sig = url.searchParams.get("sig") || "";

    const exp = Number(expRaw);
    const now = Math.floor(Date.now() / 1000);
    if (!chatId || !userId || !variantText || !Number.isFinite(exp) || exp <= now || !sig) {
      return sendJson(res, 401, { ok: false, error: "Unauthorized" });
    }

    const expectedSig =
      creditsLeftRaw === null
        ? sign(getSecret(), chatId, userId, variantText, expRaw)
        : sign(getSecret(), chatId, userId, variantText, expRaw, creditsLeftRaw);
    if (!timingSafeEqual(sig, expectedSig)) return sendJson(res, 401, { ok: false, error: "Unauthorized" });

    // Read json body (small)
    const body = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => {
        data += c;
        if (data.length > 1024 * 1024) {
          reject(new Error("Body too large"));
          req.destroy();
        }
      });
      req.on("end", () => {
        if (!data) return resolve(null);
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
      req.on("error", reject);
    });

    const taskId = getTaskIdFromPayload(body);
    const resultUrl = getResultUrlFromPayload(body);
    if (!taskId && !resultUrl) return sendJson(res, 200, { ok: true, ignored: true });

    const maxCredits = Number(process.env.INITIAL_GENERATIONS || 3);
    const creditsLeft = creditsLeftRaw === undefined || creditsLeftRaw === null || String(creditsLeftRaw).trim() === "" ? NaN : Number(creditsLeftRaw);

    function afterSendPhotoMessage() {
      if (!Number.isFinite(creditsLeft)) {
        return "Ваше изображение готово.";
      }

      if (creditsLeft > 0) {
        return `Ваше изображение готово! Осталось генераций: ${creditsLeft} из ${maxCredits}.`;
      }

      return `Ваше изображение готово! У вас закончились генерации. Следите за обновлениями в нашем телеграм-канале.`;
    }

    if (!resultUrl) {
      const task = await kie.getTask(taskId);
      const state = String(kie.getTaskState(task) || "").toLowerCase();
      if (state !== "success") {
        const reason = extractFailureReason(task);
        await refundOnFailureOnce({ taskId, userId });
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text:
            `Не смог обработать фото.\n\n` +
            `Статус задачи: ${state || "unknown"}` +
            (reason ? `\nПричина: ${reason.slice(0, 800)}` : "") +
            "\n\nКредит за генерацию возвращён."
        });
        return sendJson(res, 200, { ok: true });
      }

      const urls = kie.parseResultUrls(task);
      if (!urls.length) {
        await telegramApi("sendMessage", { chat_id: chatId, text: "Не смог получить результат генерации (нет ссылки на изображение)." });
        return sendJson(res, 200, { ok: true });
      }

      // prefer recordInfo resultUrls
      const blob = await overlayClientLogo(await kie.fetchImageAsBlob(urls[0]));
      const fileName = guessFileNameFromMime(blob.type);
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("photo", blob, fileName);
      await telegramApiMultipart("sendPhoto", form);
      await telegramApi("sendMessage", { chat_id: chatId, text: afterSendPhotoMessage() });

      return sendJson(res, 200, { ok: true });
    }

    const blob = await overlayClientLogo(await kie.fetchImageAsBlob(resultUrl));
    const fileName = guessFileNameFromMime(blob.type);
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("photo", blob, fileName);
    await telegramApiMultipart("sendPhoto", form);
    await telegramApi("sendMessage", { chat_id: chatId, text: afterSendPhotoMessage() });

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    // Always 200 so KIE doesn't retry forever (if it retries).
    return sendJson(res, 200, { ok: false });
  }
};
