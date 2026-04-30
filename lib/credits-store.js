const fs = require("fs/promises");
const path = require("path");

const DEFAULT_FILE = path.join(process.cwd(), "data", "credits.json");
const STORE_PATH = (process.env.CREDITS_STORE_PATH || DEFAULT_FILE).trim();

let cache = null;
let cacheLoaded = false;
let writeChain = Promise.resolve();

async function ensureDirExists(filePath) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

async function readFileJson(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return {};
    throw err;
  }
}

async function atomicWriteJson(filePath, obj) {
  await ensureDirExists(filePath);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const data = JSON.stringify(obj, null, 2);
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, filePath);
}

async function load() {
  if (cacheLoaded) return cache;
  cache = await readFileJson(STORE_PATH);
  if (!cache || typeof cache !== "object") cache = {};
  if (!cache.users || typeof cache.users !== "object") cache.users = {};
  cacheLoaded = true;
  return cache;
}

function withWriteLock(fn) {
  writeChain = writeChain.then(fn, fn);
  return writeChain;
}

async function getUserEntry(userId) {
  const store = await load();
  const key = String(userId);
  const entry = store.users[key];
  if (entry && typeof entry === "object") return entry;
  return null;
}

async function setUserEntry(userId, entry) {
  return withWriteLock(async () => {
    const store = await load();
    const key = String(userId);
    store.users[key] = entry;
    await atomicWriteJson(STORE_PATH, store);
    return store.users[key];
  });
}

async function ensureUserCredits(userId, initialCredits) {
  const key = String(userId);
  const store = await load();
  if (store.users[key] && typeof store.users[key] === "object" && Number.isFinite(store.users[key].credits)) {
    return { granted: false, credits: Number(store.users[key].credits) };
  }

  const init = Number.isFinite(initialCredits) ? Number(initialCredits) : 0;
  const entry = { credits: init, updatedAt: Date.now() };
  await setUserEntry(key, entry);
  return { granted: true, credits: init };
}

async function getCredits(userId) {
  const entry = await getUserEntry(userId);
  if (!entry) return 0;
  const v = Number(entry.credits);
  return Number.isFinite(v) ? v : 0;
}

async function setCredits(userId, credits) {
  const next = Number(credits);
  const safe = Number.isFinite(next) ? next : 0;
  await setUserEntry(userId, { credits: safe, updatedAt: Date.now() });
  return safe;
}

async function spendCredit(userId) {
  return withWriteLock(async () => {
    const store = await load();
    const key = String(userId);
    const currentRaw = store.users[key]?.credits;
    const current = Number.isFinite(Number(currentRaw)) ? Number(currentRaw) : 0;
    if (current <= 0) return 0;
    const next = current - 1;
    store.users[key] = { credits: next, updatedAt: Date.now() };
    await atomicWriteJson(STORE_PATH, store);
    return next;
  });
}

async function refundCredit(userId) {
  return withWriteLock(async () => {
    const store = await load();
    const key = String(userId);
    const currentRaw = store.users[key]?.credits;
    const current = Number.isFinite(Number(currentRaw)) ? Number(currentRaw) : 0;
    const next = current + 1;
    store.users[key] = { credits: next, updatedAt: Date.now() };
    await atomicWriteJson(STORE_PATH, store);
    return next;
  });
}

module.exports = {
  STORE_PATH,
  ensureUserCredits,
  getCredits,
  setCredits,
  spendCredit,
  refundCredit
};

