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

function isPublicFigureBlock(reason) {
  const r = String(reason || "").toLowerCase();
  return r.includes("public figure") || r.includes("публичн") || r.includes("знаменит");
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

  // Footer + logo sizing based on real output dimensions.
  // Target: when image width ≈ 1398px -> logo ≈ 600x183 (as in Figma).
  const PAD_Y = 10;
  const PAD_X = 12;
  const MAX_LOGO_W = Math.max(1, width - PAD_X * 2);
  const LOGO_W_RATIO = 600 / 1398; // ≈0.429
  const LOGO_ASPECT = 183 / 600;   // ≈0.305
  const LOGO_W = Math.max(220, Math.min(MAX_LOGO_W, Math.round(width * LOGO_W_RATIO)));
  const LOGO_H = Math.max(40, Math.round(LOGO_W * LOGO_ASPECT));
  const FOOTER_H = LOGO_H + PAD_Y * 2;

  // Render SVG -> PNG, trim transparent padding, resize, then trim again.
  // Second trim helps remove anti-aliased transparent edges after resize.
  const logoPng = await sharp(Buffer.from(svg), { density: 700 })
    .png()
    .trim({ threshold: 12 })
    .resize({ width: LOGO_W, height: LOGO_H, fit: "inside", withoutEnlargement: true })
    .trim({ threshold: 28 })
    .toBuffer();

  const logoMeta = await sharp(logoPng).metadata();
  const logoW = logoMeta.width || Math.min(MAX_LOGO_W, width);
  const logoH = logoMeta.height || LOGO_H;

  // Extend canvas with a white footer.
  const extended = base.extend({
    top: 0,
    bottom: FOOTER_H,
    left: 0,
    right: 0,
    background: { r: 255, g: 255, b: 255, alpha: 1 }
  });

  // Place logo centered within footer.
  const logoLeft = Math.max(PAD_X, Math.round((width - logoW) / 2));
  const logoTop = Math.round(height + Math.max(0, Math.floor((FOOTER_H - logoH) / 2)));

  const composed = await extended
    .composite([{ input: logoPng, top: logoTop, left: logoLeft }])
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
        const extraHelp = isPublicFigureBlock(reason)
          ? "\n\nПохоже, на фото есть публичная персона (знаменитость) — такие запросы KIE блокирует. " +
            "Попробуйте другое фото (своё/не знаменитость) или кадрируйте/замажьте лицо публичной персоны и отправьте снова."
          : "";
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text:
            `Не смог обработать фото.\n\n` +
            `Статус задачи: ${state || "unknown"}` +
            (reason ? `\nПричина: ${reason.slice(0, 800)}` : "") +
            extraHelp +
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
