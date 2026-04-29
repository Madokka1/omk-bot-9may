require("dotenv").config();

const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const http = require("http");
const { URL } = require("url");

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[fatal] unhandledRejection at:", promise, "reason:", reason);
});

const telegramHandler = require("./api/telegram");
const tgProxyHandler = require("./api/tg-proxy");
const kieCallbackHandler = require("./api/kie-callback");

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(text);
}

function normalizePathname(reqUrl) {
  try {
    const u = new URL(reqUrl || "/", "http://localhost");
    return u.pathname || "/";
  } catch {
    return "/";
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const pathname = normalizePathname(req.url);

    if (pathname === "/health" || pathname === "/") {
      return sendText(res, 200, "ok");
    }

    if (pathname === "/api/telegram") return await telegramHandler(req, res);
    if (pathname === "/api/tg-proxy" || pathname === "/api/tg-proxy.jpg") return await tgProxyHandler(req, res);
    if (pathname === "/api/kie-callback") return await kieCallbackHandler(req, res);

    return sendText(res, 404, "Not found");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return sendText(res, 500, "Internal error");
    try {
      res.end();
    } catch {
      // ignore
    }
  }
});

server.on("error", (err) => {
  console.error("[server] error:", err);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});

if (String(process.env.USE_POLLING || "").trim() === "1") {
  const { pollLoop } = require("./lib/polling");
  pollLoop();
}
