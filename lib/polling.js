const fetch = require('node-fetch');
const { fetchWithAgent } = require("./fetch");
const telegramHandler = require("../api/telegram");

const POLLING_INTERVAL_MS = Number(process.env.POLLING_INTERVAL_MS || 2000);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

async function getUpdates(offset) {
  const { controller, timeout } = withTimeout(30000);
  try {
    // Используем скачанный node-fetch вместо встроенного
    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&limit=100`,
      { 
        signal: controller.signal,
        method: 'GET'
      }
    );
    const json = await resp.json();
    if (!json.ok) throw new Error(`getUpdates error: ${JSON.stringify(json)}`);
    return json.result || [];
  } catch (err) {
    console.error("[polling] Fetch Failed:", err.message);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function createMockReq(update) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET || "";
  const body = JSON.stringify(update);
  let sent = false;
  return {
    method: "POST",
    url: "/api/telegram",
    headers: {
      "content-type": "application/json",
      ...(secret ? { "x-telegram-bot-api-secret-token": secret } : {}),
      host: "omk-bot.ru"
    },
    on(event, cb) {
      if (event === "data" && !sent) {
        sent = true;
        cb(Buffer.from(body));
      }
      if (event === "end") cb();
      if (event === "error") {
        // no-op
      }
    }
  };
}

function createMockRes() {
  return {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    end() {}
  };
}

async function pollLoop() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("[polling] TELEGRAM_BOT_TOKEN is not set");
    return;
  }

  let offset = 0;
  console.log("[polling] started");

  // Delete webhook so Telegram stops trying to push and we pull instead.
  try {
    const { controller, timeout } = withTimeout(15000);
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, {
      signal: controller.signal
    });
    clearTimeout(timeout);
    console.log("[polling] webhook deleted");
  } catch (err) {
    console.warn("[polling] failed to delete webhook:", err.message);
  }

  while (true) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        const req = createMockReq(update);
        const res = createMockRes();
        try {
          await telegramHandler(req, res);
        } catch (err) {
          console.error("[polling] handle error:", err);
        }
      }
    } catch (err) {
      console.error("[polling] getUpdates error:", err);
    }
    await new Promise((r) => setTimeout(r, POLLING_INTERVAL_MS));
  }
}

module.exports = { pollLoop };
