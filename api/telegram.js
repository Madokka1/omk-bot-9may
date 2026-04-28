const crypto = require("crypto");
const kie = require("../lib/kie");

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

async function telegramApi(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
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
}

async function telegramApiMultipart(method, formData) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const resp = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: formData
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
  const partnersEnabled = String(process.env.PARTNERS_UI_ENABLED || "").trim() === "1";
  return {
    keyboard: partnersEnabled ? [[{ text: "Сгенерировать" }, { text: "Партнеры" }]] : [[{ text: "Сгенерировать" }]],
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
  const t = String(text || "").trim();
  return (
    t === "Без текста" ||
    t === "С Первомаем!" ||
    t === "Работа работой, май — по расписанию" ||
    t === "Товарищи-металлурги, с праздником!"
  );
}

function buildMayDayPostcardPrompt(variantText) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const v = String(variantText || "").trim();

  if (v === "Без текста") {
    return (
      "Сгенерируй праздничную открытку к 1 Мая (День труда). " +
      "Без надписей и без букв вообще. " +
      "Высокое качество, красивый свет, чистая композиция. " +
      "Стилистика: " +
      stylePrompt +
      "."
    );
  }

  return (
    "Сгенерируй праздничную открытку к 1 Мая (День труда). " +
    "Добавь на изображение ровно эту надпись (как на открытке), без изменений: " +
    `"${v}". ` +
    "Текст должен быть читабельным и аккуратно вписанным в композицию. " +
    "Высокое качество, красивый свет, чистая композиция. " +
    "Стилистика: " +
    stylePrompt +
    "."
  );
}

function buildMayDayPhotoEditPrompt(variantText) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const v = String(variantText || "").trim();

  if (v === "Без текста") {
    return (
      "Authentic Soviet May Day postcard illustration, USSR 1950s–1970s, International Workers' Day, socialist realism, праздничная демонстрация, весенний оптимизм. " +
      "Visual cues of May Day: red flags, banners without text, flowers (especially spring bouquets), bright sky, doves, festive crowd atmosphere, feeling of unity, labor celebration, peace and optimism. " +
      "Preserve original identity, facial features, proportions, and likeness of all people. Maintain recognizability. No distortion. " +
      "Semi-realistic Soviet painting style, simplified forms, clean edges, soft idealization of faces, slightly heroic but natural look. " +
      "Dominant reds with balanced sky blue, warm beige skin tones, fresh spring greens, warm sunlight tones, harmonious vintage palette. " +
      "Bright daylight, soft and optimistic, no dramatic shadows, no dark mood. " +
      "Slightly enhance composition to resemble a May Day parade or celebratory scene, uplifting and forward-looking, but keep original structure. " +
      "Subtle print texture, light grain, soft vintage finish, no heavy aging. " +
      "Strictly May Day theme only, no other holidays, no text, no typography, no modern elements, no photorealism. " +
      "Extra style hint: " +
      stylePrompt +
      "."
    );
  }

  if (v === "С Первомаем!") {
    return (
      "Authentic Soviet May Day postcard illustration, USSR 1950s–1970s, International Workers' Day, socialist realism, праздничная демонстрация, весенний оптимизм. " +
      "Visual cues of May Day: red flags, banners, flowers, bright sky, festive crowd atmosphere, feeling of unity, labor celebration. " +
      "Integrated festive lettering 'С Первомаем!' in classic Soviet poster bold sans-serif font, slightly arched or horizontal, bright yellow or white color with thin red stroke, looking like hand-painted holiday calligraphy. " +
      "Preserve original identity, facial features, proportions, and likeness of all people. Maintain recognizability. " +
      "Semi-realistic Soviet painting style, simplified forms, clean edges, soft idealization of faces. " +
      "Dominant reds with balanced sky blue, warm beige skin tones, fresh spring greens. " +
      "Bright daylight, soft and optimistic, no dark mood. " +
      "Slightly enhance composition to resemble a May Day celebratory scene with the text 'С Первомаем!' logically placed. " +
      "Subtle print texture, light grain, soft vintage finish. " +
      "Strictly May Day theme only, no other holidays, no modern elements, no photorealism. " +
      "Extra style hint: " +
      stylePrompt +
      "."
    );
  }

  return (
    "Отредактируй фотографию в стиле праздничной открытки к 1 Мая (День труда). " +
    "Добавь на изображение ровно эту надпись (как на открытке), без изменений: " +
    `"${v}". ` +
    "Текст должен быть читабельным и аккуратно вписанным в композицию. " +
    "Сохрани композицию, но добавь праздничную атмосферу. " +
    "Высокое качество, красивый свет, чистая композиция. " +
    "Стилистика: " +
    stylePrompt +
    "."
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

// Temporarily disabled (as requested): always allow.
async function checkRequiredSubscriptions(userId) {
  if (String(process.env.PARTNERS_UI_ENABLED || "").trim() !== "1") {
    return { ok: true, missing: [] };
  }
  const required = Array.from(new Set(["@omk_official", ...parseRequiredChannels()]));
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
  const channels = parseRequiredChannels();
  const lines = ["Партнеры:"];

  // Static partner link (always shown)
  lines.push(`Официальный телеграм-канал ОМК - @omk_official`);
  lines.push(`108digital - @team108`);
  lines.push(`NN - @naebnet`);

  if (!channels.length) return lines.join("\n");
  for (const ch of channels) {
    const link = `https://t.me/${ch.replace(/^@/, "")}`;
    lines.push(`- ${ch} — ${link}`);
  }
  return lines.join("\n");
}

function pleaseSubscribeText() {
  return "Пожалуйста, подпишитесь на всех партнеров и попробуйте снова.\n\n" + partnersText();
}

const INITIAL_GENERATIONS = Number(process.env.INITIAL_GENERATIONS || 3);
const generationCreditsByUserId = new Map();

function ensureGenerationCredits(userId) {
  const key = String(userId);
  if (!generationCreditsByUserId.has(key)) {
    generationCreditsByUserId.set(key, Number.isFinite(INITIAL_GENERATIONS) ? INITIAL_GENERATIONS : 3);
    return { granted: true, credits: generationCreditsByUserId.get(key) };
  }
  return { granted: false, credits: generationCreditsByUserId.get(key) };
}

function getGenerationCredits(userId) {
  return generationCreditsByUserId.get(String(userId)) ?? 0;
}

function spendGenerationCredit(userId) {
  const key = String(userId);
  const current = getGenerationCredits(key);
  if (current <= 0) return 0;
  const next = current - 1;
  generationCreditsByUserId.set(key, next);
  return next;
}

function noCreditsText() {
  return "У вас закончились генерации. Подпишитесь на партнеров или попробуйте позже.";
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

function signKieCallbackUrl({ req, chatId, userId, variantText }) {
  const secret = (process.env.KIE_CALLBACK_SECRET || "").trim();
  if (!secret) throw new Error("KIE_CALLBACK_SECRET is not set");

  const exp = Math.floor(Date.now() / 1000) + 30 * 60;
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${chatId}.${userId}.${variantText}.${exp}`)
    .digest("base64url");

  const base = getPublicBaseUrl(req);
  if (!base) throw new Error("PUBLIC_BASE_URL is not set");

  const url =
    `${base}/api/kie-callback` +
    `?chat_id=${encodeURIComponent(String(chatId))}` +
    `&user_id=${encodeURIComponent(String(userId))}` +
    `&variant=${encodeURIComponent(String(variantText))}` +
    `&exp=${encodeURIComponent(String(exp))}` +
    `&sig=${encodeURIComponent(String(sig))}`;
  return url;
}

async function submitKieEditTask({ req, chatId, userId, fileId, variantText }) {
  const v = String(variantText || "").trim();
  const prompt = buildMayDayPhotoEditPrompt(v);
  const inputUrl = signProxyUrl({ req, fileId });
  const callBackUrl = signKieCallbackUrl({ req, chatId, userId, variantText: v });
  if (String(process.env.DEBUG_KIE_CALLBACK_URL || "").trim() === "1") {
    console.log("[kie] callback url:", callBackUrl.replace(/sig=[^&]+/, "sig=***"));
  }

  if (v === "Без текста") {
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

async function submitKieStylizeTask({ req, chatId, userId, fileId }) {
  const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
  const prompt =
    "Отредактируй изображение в стилистике: " +
    stylePrompt +
    ". Сохрани композицию, но сделай общий стиль соответствующим.";

  const inputUrl = signProxyUrl({ req, fileId });
  const callBackUrl = signKieCallbackUrl({ req, chatId, userId, variantText: stylePrompt || "IMG" });
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

async function generateImage(prompt) {
  const { urls } = await kie.generateImageFromText(prompt);
  return await kie.fetchImageAsBlob(urls[0]);
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

      // Text handling
      if (typeof message.text === "string") {
        const text = message.text;

        if (isStartCommand(text)) {
          const botInfo = await getBotInfo();
          const botName = botInfo?.first_name || botInfo?.username || "бот";
          const rulesText = getStartRulesText();
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: `<b>Привет! Это бот Объединённой металлургической компании</b>\n\n` +
        `Этот бот создан специально к празднику весны и труда! С помощью нейросетей мы поможем вам преобразить ваши снимки: просто загрузите фото, и искусственный интеллект мгновенно перерисует его в уникальной <b>первомайской стилистике</b>.`,
            parse_mode: "HTML",
            reply_markup: mainMenuReplyMarkup()
          });
        } else if (text.trim() === "Сгенерировать") {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: pleaseSubscribeText(), reply_markup: mainMenuReplyMarkup() });
            } else {
              const { granted } = ensureGenerationCredits(userId);
              if (granted) {
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text: "Вы подписались на всех партнеров. Вам начислено 3 генерации изображений.",
                  reply_markup: mainMenuReplyMarkup()
                });
              }

              if (getGenerationCredits(userId) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: "Выбери вариант генерации:",
                reply_markup: generationVariantsReplyMarkup()
              });
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
              ensureGenerationCredits(userId);
              if (getGenerationCredits(userId) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              setPending(chatId, now, { mode: "style_photo" });
              const stylePrompt = (process.env.IMG_STYLE_PROMPT || "В мире дикой природы").trim();
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text:
                  "Пришли фото, я обработаю его в стиле:\n" +
                  stylePrompt +
                  "\n\nМожно просто отправить фото следующим сообщением.",
                reply_markup: mainMenuReplyMarkup()
              });
            }
          }
        } else if (text.trim() === "Партнеры") {
          if (String(process.env.PARTNERS_UI_ENABLED || "").trim() !== "1") {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Ок.", reply_markup: mainMenuReplyMarkup() });
            return;
          }
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: partnersText(),
            reply_markup: mainMenuReplyMarkup()
          });
        } else if (text.trim() === "Назад") {
          const pending = getPending(chatId, now);
          clearPending(chatId);
          if (pending?.mode === "variant_photo") {
            await telegramApi("sendMessage", {
              chat_id: chatId,
              text: "Выбери вариант генерации:",
              reply_markup: generationVariantsReplyMarkup()
            });
          } else {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Ок.", reply_markup: mainMenuReplyMarkup() });
          }
        } else if (isGenerationVariant(text)) {
          if (!userId) {
            await telegramApi("sendMessage", { chat_id: chatId, text: "Не вижу user_id :(" });
          } else {
            const subs = await checkRequiredSubscriptions(userId);
            if (!subs.ok) {
              await telegramApi("sendMessage", { chat_id: chatId, text: pleaseSubscribeText(), reply_markup: mainMenuReplyMarkup() });
            } else {
              ensureGenerationCredits(userId);
              if (getGenerationCredits(userId) <= 0) {
                await telegramApi("sendMessage", { chat_id: chatId, text: noCreditsText(), reply_markup: mainMenuReplyMarkup() });
                return;
              }
              setPending(chatId, now, { mode: "variant_photo", variantText: String(text).trim() });
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: "Отправьте вашу фотографию.",
                reply_markup: backOnlyReplyMarkup()
              });
            }
          }
        } else {
          const t2iPrompt = parseCommand(text, "t2i");
          if (t2iPrompt !== null) {
            if (!t2iPrompt) {
              await telegramApi("sendMessage", {
                chat_id: chatId,
                text: "Использование: /t2i <что нарисовать>"
              });
            } else {
              await telegramApi("sendMessage", { chat_id: chatId, text: "Генерирую изображение…" });
              try {
                const imageBlob = await generateImage(t2iPrompt);
                const fileName = guessFileNameFromMime(imageBlob.type);
                const form = new FormData();
                form.append("chat_id", String(chatId));
                form.append("photo", imageBlob, fileName);
                form.append("caption", t2iPrompt.slice(0, 1024));
                await telegramApiMultipart("sendPhoto", form);
              } catch (err) {
                console.error("text-to-image failed:", err);
                await telegramApi("sendMessage", {
                  chat_id: chatId,
                  text:
                    "Не смог сгенерировать изображение.\n\n" +
                    `Ошибка: ${formatHttpError(err)}`
                });
              }
            }
          }
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
                ? "Принял фото. Делаю открытку — пришлю, как будет готово."
                : "Принял фото. Обрабатываю — пришлю, как будет готово."
          });

          try {
            if (pending.mode === "variant_photo") {
              await submitKieEditTask({ req, chatId, userId, fileId, variantText: pending.variantText });
            } else {
              // /img flow (style prompt) via callback to avoid timeouts.
              await submitKieStylizeTask({ req, chatId, userId, fileId });
            }
          } catch (err) {
            console.error("kie submit failed:", err);
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
