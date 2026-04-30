const crypto = require("crypto");
const { fetchWithAgent } = require("../lib/fetch");
const kie = require("../lib/kie");
const creditsStore = require("../lib/credits-store");

function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1024 * 1024) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

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

function getPublicBaseUrl(req) {
  const publicBase = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (publicBase) return publicBase;

  const host = req?.headers?.["x-forwarded-host"] || req?.headers?.host;
  const proto = (req?.headers?.["x-forwarded-proto"] || "https").toString().split(",")[0].trim() || "https";
  if (host) return `${proto}://${host}`;

  return "";
}

function mainMenuReplyMarkup() {
  return {
    keyboard: [[{ text: "Сгенерировать" }, { text: "Партнеры" }]],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function generationVariantsReplyMarkup() {
  return {
    keyboard: [
      [{ text: "Без текста" }, { text: "С Первомаем!" }],
      [{ text: "Работа работой, май — по расписанию" }, { text: "Товарищи-металлурги, с праздником!" }],
      [{ text: "Назад" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function backOnlyReplyMarkup() {
  return {
    keyboard: [[{ text: "Назад" }]],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

function isGenerationVariant(text) {
  return Object.values(TEXT_VARIANTS).includes(String(text).trim());
}


const TEXT_VARIANTS = {
  NO_TEXT: "Без текста",
  MAY_DAY: "С Первомаем!",
  LABOR:   "Работа работой, май — по расписанию",
  SPRING:  "Товарищи-металлурги, с праздником!",
};

// ── Базовые блоки промптов ────────────────────────────────────────────────────

const SOVIET_STYLE_BASE =
  "Authentic Soviet May Day postcard illustration, USSR 1950s–1970s, International Workers' Day, socialist realism, " +
  "праздничная демонстрация, весенний оптимизм. " +
  "Visual cues of May Day: red flags, banners without text, flowers (especially spring bouquets), bright sky, doves, " +
  "festive crowd atmosphere, feeling of unity, labor celebration, peace and optimism. " +
  "Semi-realistic Soviet painting style, simplified forms, clean edges, soft idealization of faces, slightly heroic but natural look. " +
  "Color palette: dominant reds with balanced sky blue, warm beige skin tones, fresh spring greens, warm sunlight tones, harmonious vintage palette. " +
  "Bright daylight, soft and optimistic, no dramatic shadows, no dark mood. ";

const SOVIET_SUBJECT =
  "Preserve original identity, facial features, proportions, and likeness of all people. Maintain recognizability. No distortion. " +
  "Slightly enhance composition to resemble a May Day parade or celebratory scene, uplifting and forward-looking, but keep original structure. ";

const SOVIET_FINISH =
  "Subtle print texture, light grain, soft vintage finish, no heavy aging. " +
  "Strictly May Day theme only, no other holidays, no modern elements, no photorealism. ";

const SOVIET_LETTERING_BASE =
  "authentic Soviet hand-lettered brush display type — thick uneven strokes, bold characters, " +
  "slightly imperfect hand-crafted feel, reminiscent of 1950s–1960s Soviet poster brush lettering. " +
  "NOT a modern font. NOT digital. ";

const OUTPUT_FORMAT =
  "Output format: 16:9 landscape. " +
  "Thin uniform border, strictly equal on all four sides — top = bottom = left = right = 12px. " +
  "No extra padding at bottom. No footer zone. No watermark area. No AI signatures anywhere. ";

const SOVIET_NEGATIVE =
  "Negative: text, typography, letters, slogans, numbers, holiday greetings, new year, christmas, snow, winter, santa, gifts, " +
  "fireworks, 8 march, women's day, balloons with text, birthday, confetti, modern posters, photorealism, cinematic lighting, " +
  "dark tones, distorted faces, caricature, anime, oversaturated colors, heavy textures. ";

const SOVIET_COMMON_BASE =
  "Transform this photo into an authentic Soviet May Day postcard illustration. " +
  SOVIET_STYLE_BASE +
  SOVIET_SUBJECT +
  SOVIET_FINISH +
  SOVIET_REPAINT +
  OUTPUT_FORMAT;

const SOVIET_REPAINT =
  "REPAINT this photo entirely as a painted illustration. " +
  "Do NOT paste or cut out the original face/person onto a new background. " +
  "Fully redraw all people in the same painting style as the background. NO photo collage. NO photorealistic face pasted over illustration. ";


// ── Промпты ───────────────────────────────────────────────────────────────────

// 1. Без текста
function buildMayDayPromptNoText() {
  return (
    SOVIET_COMMON_BASE +
    "NO TEXT. NO letters. NO typography anywhere. All banners and flags must be blank. " +
    SOVIET_NEGATIVE
  );
}

// 2. «С Первомаем!»
function buildMayDayPromptMayDay() {
  return (
    SOVIET_COMMON_BASE +
    "LETTERING REQUIREMENT — CRITICAL: Large bold Cyrillic text 'С Первомаем!' rendered in " +
    SOVIET_LETTERING_BASE +
    "Bright yellow or white fill with red or gold outline. " +
    "Placed at top center, postcard header style. DO NOT repeat text anywhere else. Bottom area must be completely clean. "
  );
}

// 3. «Работа работой, май — по расписанию»
function buildMayDayPromptLabor() {
  return (
    SOVIET_COMMON_BASE +
    "LETTERING REQUIREMENT — CRITICAL: Large bold Cyrillic text 'Работа работой, май — по расписанию' rendered in " +
    SOVIET_LETTERING_BASE +
    "Red fill with gold or yellow outline. " +
    "Placed at top center, postcard header style. DO NOT repeat text anywhere else. Bottom area must be completely clean. "
  );
}

// 4. «Товарищи-металлурги, с праздником!»
function buildMayDayPromptSpring() {
  return (
    "Transform this photo into an authentic Soviet May Day postcard illustration. " +
    "1950s Soviet industrial poster aesthetic, socialist realism, monumental and heroic. " +
    "Powerful metallurgical background: blast furnace silhouettes, glowing molten metal, sparks, combined with May Day red banners. " +
    SOVIET_SUBJECT +
    SOVIET_FINISH +
    "Subjects should look proud and strong, fitting the heroic metallurgist archetype. " +
    "Dominant deep reds, molten gold accents, strong industrial blues and greys. " +
    OUTPUT_FORMAT +
    "LETTERING REQUIREMENT — CRITICAL: Large monumental Cyrillic text 'Товарищи-металлурги, с праздником!' rendered in " +
    SOVIET_LETTERING_BASE +
    "Red fill with gold or yellow outline. " +
    "Placed at top center, postcard header style. DO NOT repeat text anywhere else. Bottom area must be completely clean. " +
    "Strictly metallurgical and May Day theme, no modern technology, no English text. " +
    "Extra style hint: " + (process.env.IMG_STYLE_PROMPT || "") + ". "
  );
}

function isStartCommand(text) {
  if (!text) return false;
  return /^\/start(\s|$|@)/i.test(text.trim());
}

let botInfoCache = null;
async function getBotInfo() {
  if (botInfoCache) return botInfoCache;
  botInfoCache = await telegramApi("getMe", {});
  return botInfoCache;
}

function getStartRulesText() {
  const rules = (process.env.START_RULES_TEXT || "").trim();
  if (rules) return rules;
  return "Правила:\n1) Не спамить\n2) Не отправлять запрещенный контент";
}

function parseCommand(text, command) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(new RegExp(`^\\/${command}(?:@[^\\s]+)?(?:\\s+([\\s\\S]+))?$`, "i"));
  if (!match) return null;
  return (match[1] ?? "").trim();
}

const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingByChatId = new Map();

function prunePending(now) {
  for (const [chatId, entry] of pendingByChatId.entries()) {
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) pendingByChatId.delete(chatId);
  }
}

function setPending(chatId, now, data) {
  prunePending(now);
  pendingByChatId.set(String(chatId), {
    expiresAt: now + PENDING_TTL_MS,
    ...(data && typeof data === "object" ? data : {})
  });
}

function getPending(chatId, now) {
  prunePending(now);
  const entry = pendingByChatId.get(String(chatId));
  if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) return null;
  return entry;
}

function clearPending(chatId) {
  pendingByChatId.delete(String(chatId));
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessionByChatId = new Map();

function pruneSessions(now) {
  for (const [chatId, entry] of sessionByChatId.entries()) {
    if (!entry || typeof entry.expiresAt !== "number" || entry.expiresAt <= now) sessionByChatId.delete(chatId);
  }
}

function getSession(chatId, now) {
  pruneSessions(now);
  const key = String(chatId);
  const existing = sessionByChatId.get(key);
  if (existing && typeof existing === "object") {
    existing.expiresAt = now + SESSION_TTL_MS;
    if (!Array.isArray(existing.stack)) existing.stack = [];
    if (!Array.isArray(existing.cleanupMessageIds)) existing.cleanupMessageIds = [];
    return existing;
  }
  const fresh = {
    expiresAt: now + SESSION_TTL_MS,
    stack: [],
    current: { screen: "main_menu" },
    cleanupMessageIds: []
  };
  sessionByChatId.set(key, fresh);
  return fresh;
}

async function safeDeleteMessage(chatId, messageId) {
  if (!chatId || !messageId) return;
  try {
    await telegramApi("deleteMessage", { chat_id: chatId, message_id: messageId }, { retries: 0 });
  } catch (_) {
    // ignore (no rights / already deleted / too old)
  }
}

async function cleanupScreenMessages(chatId, session) {
  const ids = Array.isArray(session?.cleanupMessageIds) ? session.cleanupMessageIds.slice(0, 20) : [];
  session.cleanupMessageIds = [];
  for (const id of ids) await safeDeleteMessage(chatId, id);
}

async function sendScreenMessage(chatId, session, payload) {
  const sent = await telegramApi("sendMessage", { chat_id: chatId, ...payload });
  if (sent?.message_id) session.cleanupMessageIds = [sent.message_id];
  return sent;
}

async function renderScreen({ chatId, session, screen, variantText }) {
  if (screen === "main_menu") {
    session.current = { screen: "main_menu" };
    await sendScreenMessage(chatId, session, { text: "Выберите действие:", reply_markup: mainMenuReplyMarkup() });
    return;
  }

  if (screen === "generation_variants") {
    session.current = { screen: "generation_variants" };
    await sendScreenMessage(chatId, session, { text: "Выбери вариант генерации:", reply_markup: generationVariantsReplyMarkup() });
    return;
  }

  if (screen === "variant_photo_request") {
    session.current = { screen: "variant_photo_request", variantText: String(variantText || "").trim() };
    await sendScreenMessage(chatId, session, { text: "Отправьте вашу фотографию.", reply_markup: backOnlyReplyMarkup() });
    return;
  }

  if (screen === "style_photo_request") {
    const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
    session.current = { screen: "style_photo_request" };
    await sendScreenMessage(chatId, session, {
      text:
        "Пришли фото, я обработаю его в стиле:\n" +
        stylePrompt +
        "\n\nМожно просто отправить фото следующим сообщением.",
      reply_markup: mainMenuReplyMarkup()
    });
    return;
  }

  if (screen === "partners") {
    session.current = { screen: "partners" };
    await sendScreenMessage(chatId, session, { text: partnersText(), reply_markup: mainMenuReplyMarkup() });
    return;
  }
}

function parseRequiredChannels() {
  const raw = (process.env.REQUIRED_CHANNELS || "").trim();
  if (!raw) return [];
  const blocked = new Set(["@uecrus_official"]);
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("@") ? s : `@${s}`))
    .filter((s) => !blocked.has(s));
}

function getRequiredPartnerChannels() {
  // Keep this list in sync with partnersText(), so the UI matches the real checks.
  const staticPartners = ["@codeeeeeeeeasd"];
  return Array.from(new Set([...staticPartners, ...parseRequiredChannels()]));
}

async function checkRequiredSubscriptions(userId) {
  const required = getRequiredPartnerChannels();
  if (!required.length) return { ok: true, missing: [] };

  const missing = [];
  for (const chatId of required) {
    try {
      const member = await telegramApi("getChatMember", { chat_id: chatId, user_id: userId });
      const status = String(member?.status || "").toLowerCase();
      const ok = status === "member" || status === "administrator" || status === "creator";
      if (!ok) missing.push(chatId);
    } catch (err) {
      // If we can't verify (bot isn't admin / chat not accessible), treat as missing to be safe.
      missing.push(chatId);
    }
  }

  return { ok: missing.length === 0, missing };
}

function partnersText() {
  const channels = getRequiredPartnerChannels();
  const lines = ["Партнеры:"];

  if (!channels.length) return lines.join("\n");
  for (const ch of channels) lines.push(`- ${ch}`);
  return lines.join("\n");
}

function pleaseSubscribeText() {
  return "Пожалуйста, подпишитесь на всех партнеров и попробуйте снова.\n\n" + partnersText();
}

const INITIAL_GENERATIONS = Number(process.env.INITIAL_GENERATIONS || 3);

async function ensureGenerationCredits(userId) {
  return await creditsStore.ensureUserCredits(userId, Number.isFinite(INITIAL_GENERATIONS) ? INITIAL_GENERATIONS : 3);
}

async function getGenerationCredits(userId) {
  return await creditsStore.getCredits(userId);
}

async function spendGenerationCredit(userId) {
  return await creditsStore.spendCredit(userId);
}

async function refundGenerationCredit(userId) {
  return await creditsStore.refundCredit(userId);
}

function noCreditsText() {
  return "У вас закончились генерации. Доступно максимум 3 генерации на пользователя.";
}

function guessFileNameFromMime(mimeType) {
  const t = (mimeType || "").toLowerCase();
  if (t.includes("png")) return "image.png";
  if (t.includes("jpeg") || t.includes("jpg")) return "image.jpg";
  if (t.includes("webp")) return "image.webp";
  return "image.bin";
}

function formatHttpError(err) {
  const status = err?.httpStatus;
  const url = err?.httpUrl;
  const body = err?.httpBody;
  const msg = typeof err?.message === "string" ? err.message : String(err);

  let bodyText = "";
  if (typeof body === "string") bodyText = body;
  else if (body && typeof body === "object") bodyText = JSON.stringify(body);

  const header = `${typeof status === "number" ? `HTTP ${status}` : ""}${url ? ` | ${url}` : ""}`.trim();
  const extra = bodyText ? `\n${bodyText}` : "";
  return `${header ? header + "\n" : ""}${msg}${extra}`.slice(0, 3500);
}

function signProxyUrl({ req, fileId }) {
  const secret = (process.env.TG_PROXY_SECRET || "").trim();
  if (!secret) throw new Error("TG_PROXY_SECRET is not set");

  const exp = Math.floor(Date.now() / 1000) + 5 * 60;
  const sig = crypto.createHmac("sha256", secret).update(`${fileId}.${exp}`).digest("base64url");

  const base = getPublicBaseUrl(req);
  if (!base) throw new Error("PUBLIC_BASE_URL is not set");

  // Some KIE models validate file type by URL extension, so we expose a `.jpg` route.
  return `${base}/api/tg-proxy.jpg?file_id=${encodeURIComponent(fileId)}&exp=${exp}&sig=${encodeURIComponent(sig)}`;
}

function signKieCallbackUrl({ req, chatId, userId, variantText, creditsLeft }) {
  const secret = (process.env.KIE_CALLBACK_SECRET || "").trim();
  if (!secret) throw new Error("KIE_CALLBACK_SECRET is not set");

  const exp = Math.floor(Date.now() / 1000) + 30 * 60;
  const creditsLeftStr = creditsLeft === undefined || creditsLeft === null ? "" : String(creditsLeft);
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${chatId}.${userId}.${variantText}.${creditsLeftStr}.${exp}`)
    .digest("base64url");

  const base = getPublicBaseUrl(req);
  if (!base) throw new Error("PUBLIC_BASE_URL is not set");

  const url =
    `${base}/api/kie-callback` +
    `?chat_id=${encodeURIComponent(String(chatId))}` +
    `&user_id=${encodeURIComponent(String(userId))}` +
    `&variant=${encodeURIComponent(String(variantText))}` +
    `&credits_left=${encodeURIComponent(String(creditsLeftStr))}` +
    `&exp=${encodeURIComponent(String(exp))}` +
    `&sig=${encodeURIComponent(String(sig))}`;
  return url;
}

async function submitKieEditTask({ req, chatId, userId, fileId, variantText, creditsLeft }) {
  const v = String(variantText || TEXT_VARIANTS.MAY_DAY).trim();

  const inputUrl = signProxyUrl({ req, fileId });
  const callBackUrl = signKieCallbackUrl({ req, chatId, userId, variantText: v, creditsLeft });
  if (String(process.env.DEBUG_KIE_CALLBACK_URL || "").trim() === "1") {
    console.log("[kie] callback url:", callBackUrl.replace(/sig=[^&]+/, "sig=***"));
  }

  const submitNoText = async () => {
    const prompt = buildMayDayPromptNoText();
    const nanoBananaModel = (process.env.KIE_NANO_BANANA_MODEL || "google/nano-banana-edit").trim();
    const extraInput = { output_format: "png", image_size: "1:1" };
    return await kie.createTask({
      model: nanoBananaModel,
      input: {
        prompt: String(prompt || "").trim(),
        image_urls: [String(inputUrl || "").trim()].filter(Boolean),
        ...extraInput
      },
      callBackUrl
    });
  };

  const submitMayDay = async () => {
    const prompt = buildMayDayPromptMayDay();
    return await kie.createTask({
      model: (process.env.KIE_I2I_MODEL || "grok-imagine/image-to-image").trim(),
      input: {
        prompt: String(prompt || "").trim(),
        image_urls: [String(inputUrl || "").trim()].filter(Boolean)
      },
      callBackUrl
    });
  };

  const submitLabor = async () => {
    const prompt = buildMayDayPromptLabor();
    return await kie.createTask({
      model: (process.env.KIE_I2I_MODEL || "grok-imagine/image-to-image").trim(),
      input: {
        prompt: String(prompt || "").trim(),
        image_urls: [String(inputUrl || "").trim()].filter(Boolean)
      },
      callBackUrl
    });
  };

  const submitSpring = async () => {
    const prompt = buildMayDayPromptSpring();
    return await kie.createTask({
      model: (process.env.KIE_I2I_MODEL || "grok-imagine/image-to-image").trim(),
      input: {
        prompt: String(prompt || "").trim(),
        image_urls: [String(inputUrl || "").trim()].filter(Boolean)
      },
      callBackUrl
    });
  };

  const submitByVariant = {
    [TEXT_VARIANTS.NO_TEXT]: submitNoText,
    [TEXT_VARIANTS.MAY_DAY]: submitMayDay,
    [TEXT_VARIANTS.LABOR]: submitLabor,
    [TEXT_VARIANTS.SPRING]: submitSpring
  };

  const submitFn = submitByVariant[v] || submitMayDay;
  return await submitFn();
}

async function stylizePhoto({ req, fileId }) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const prompt =
    "Отредактируй изображение в стилистике: " +
    stylePrompt +
    ". Сохрани композицию, но сделай общий стиль соответствующим.";

  const inputUrl = signProxyUrl({ req, fileId });

  const { urls } = await kie.generateImageFromImage({ prompt, imageUrl: inputUrl });
  return await kie.fetchImageAsBlob(urls[0]);
}

async function submitKieStylizeTask({ req, chatId, userId, fileId, creditsLeft }) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const prompt =
    "Отредактируй изображение в стилистике: " +
    stylePrompt +
    ". Сохрани композицию, но сделай общий стиль соответствующим.";

  const inputUrl = signProxyUrl({ req, fileId });
  const callBackUrl = signKieCallbackUrl({ req, chatId, userId, variantText: stylePrompt || "IMG", creditsLeft });
  if (String(process.env.DEBUG_KIE_CALLBACK_URL || "").trim() === "1") {
    console.log("[kie] callback url:", callBackUrl.replace(/sig=[^&]+/, "sig=***"));
  }

  return await kie.createTask({
    model: (process.env.KIE_I2I_MODEL || "grok-imagine/image-to-image").trim(),
    input: {
      prompt: String(prompt || "").trim(),
      image_urls: [String(inputUrl || "").trim()].filter(Boolean)
    },
    callBackUrl
  });
}

module.exports = async (req, res) => {
  try {
    if (req.method === "GET") {
      return sendJson(res, 200, { ok: true, service: "telegram-webhook" });
    }

    if (req.method !== "POST") {
      return sendJson(res, 405, { ok: false, error: "Method not allowed" });
    }

    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const gotSecret = req.headers["x-telegram-bot-api-secret-token"];
      if (gotSecret !== expectedSecret) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }
    }

    const update = await getJsonBody(req);
    const message = update?.message ?? update?.edited_message;

    if (message?.chat?.id) {
      const chatId = message.chat.id;
      const now = Date.now();
      const userId = message?.from?.id;
      const session = getSession(chatId, now);

      // Text handling
      if (typeof message.text === "string") {
        const text = message.text;

        if (isStartCommand(text)) {
          const botInfo = await getBotInfo();
          const botName = botInfo?.first_name || botInfo?.username || "бот";
          const rulesText = getStartRulesText();
          const sent = await telegramApi("sendMessage", {
            chat_id: chatId,
            text:
              `<b>Привет! Это ОМК 🤍</b>\n\n` +
              `Поздравляем вас с праздником весны и труда! 🌸\n\n` +
              `Мы приготовили кое-что особенное: загружай своё фото, и нейросеть превратит его в настоящий праздничный портрет. Попробуй — и сохрани на память о празднике.`,
            parse_mode: "HTML",
            reply_markup: mainMenuReplyMarkup()
          });
          session.stack = [];
          session.current = { screen: "main_menu" };
          session.cleanupMessageIds = sent?.message_id ? [sent.message_id] : [];
        } else if (text.trim() === "Сгенерировать") {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: pleaseSubscribeText(), reply_markup: mainMenuReplyMarkup() });
            } else {
              const { granted } = await ensureGenerationCredits(userId);
              if (granted) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: "Вы подписались на всех партнеров. Вам начислено 3 генерации изображений.",
                  reply_markup: mainMenuReplyMarkup()
                });
              }

              if ((await getGenerationCredits(userId)) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              session.stack.push(session.current);
              await renderScreen({ chatId, session, screen: "generation_variants" });
            }
          }
        } else if (parseCommand(text, "img") !== null) {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: pleaseSubscribeText(), reply_markup: mainMenuReplyMarkup() });
            } else {
              await ensureGenerationCredits(userId);
              if ((await getGenerationCredits(userId)) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              setPending(chatId, now, { mode: "style_photo" });
              session.stack.push(session.current);
              await renderScreen({ chatId, session, screen: "style_photo_request" });
            }
          }
        } else if (text.trim() === "Партнеры") {
          session.stack.push(session.current);
          await renderScreen({ chatId, session, screen: "partners" });
        } else if (text.trim() === "Назад") {
          clearPending(chatId);
          await safeDeleteMessage(chatId, message?.message_id);

          // Delete bot's current "screen message" ONLY on Back, and only if we actually go back.
          const canGoBack = Array.isArray(session.stack) && session.stack.length > 0;
          if (canGoBack) await cleanupScreenMessages(chatId, session);

          const prev = canGoBack ? session.stack.pop() : null;
          const target = prev?.screen ? prev : { screen: "main_menu" };

          // Restore pending flow depending on the screen we return to.
          if (target.screen === "variant_photo_request") {
            setPending(chatId, now, { mode: "variant_photo", variantText: String(target.variantText || "").trim() });
          } else if (target.screen === "style_photo_request") {
            setPending(chatId, now, { mode: "style_photo" });
          }

          await renderScreen({ chatId, session, screen: target.screen, variantText: target.variantText });
        } else if (isGenerationVariant(text)) {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: pleaseSubscribeText(), reply_markup: mainMenuReplyMarkup() });
            } else {
              await ensureGenerationCredits(userId);
              if ((await getGenerationCredits(userId)) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              setPending(chatId, now, { mode: "variant_photo", variantText: String(text).trim() });
              session.stack.push(session.current);
              await renderScreen({ chatId, session, screen: "variant_photo_request", variantText: String(text).trim() });
            }
          }
        } else {
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text:
              "Я выполняю команды только в режиме генерации: нажмите «Сгенерировать», выберите вариант и отправьте фото.\n\n" +
              "Генерации доступны только если вы подписаны на всех партнеров и у вас остались генерации (до 3 на пользователя).",
            reply_markup: mainMenuReplyMarkup()
          });
        }
      }

      // Photo handling for pending flow
      const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
      const pending = hasPhoto ? getPending(chatId, now) : null;
      if (hasPhoto && pending) {
        clearPending(chatId);

        const bestPhoto = message.photo[message.photo.length - 1];
        const fileId = bestPhoto?.file_id;
        if (!fileId) {
          await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу file_id у фото :(" });
        } else {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
            return sendJson(res, 200, { ok: true });
          }

          // Async flow: submit task to KIE and return immediately; result will be delivered by /api/kie-callback.
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text:
              pending.mode === "variant_photo"
                ? "Принял фото. Делаю открытку — пришлю, как будет готово. Примерное время ожидания: 1-2 минуты."
                : "Принял фото. Обрабатываю — пришлю, как будет готово. Примерное время ожидания: 1-2 минуты."
          });

          let left = null;
          try {
            left = await spendGenerationCredit(userId);
            if (pending.mode === "variant_photo") {
              await submitKieEditTask({
                req,
                chatId,
                userId,
                fileId,
                variantText: pending.variantText,
                creditsLeft: left
              });
            } else {
              // /img flow (style prompt) via callback to avoid timeouts.
              await submitKieStylizeTask({ req, chatId, userId, fileId, creditsLeft: left });
            }
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: "Задача запущена. Совсем скоро пришлю изображение."
            });
          } catch (err) {
            console.error("kie submit failed:", err);
            try {
              // refund only if we computed creditsLeft (meaning we successfully decremented or at least attempted to).
              if (left !== null) await refundGenerationCredit(userId);
            } catch (_) {}
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: "Не смог запустить обработку фото.\n\n" + `Ошибка: ${formatHttpError(err)}`
            });
          }
        }
      }
    }

    return sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error(err);
    return sendJson(res, 200, { ok: false });
  }
};
