require("dotenv").config();

const http = require("http");
const { URL } = require("url");

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

const port = Number(process.env.PORT || 3000);
server.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});
