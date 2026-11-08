#!/usr/bin/env node
/**
 * LINE Official Account webhook server for the support agent.
 *
 *   node line-server.mjs
 *
 * LINE sends every customer message to  https://<your-server>/webhook
 * The server checks LINE's signature, asks Claude for a reply, and answers in the same chat.
 * When the agent hands a customer over to staff, the bot stays quiet in that chat for HANDOFF_HOURS
 * so staff can answer in LINE Official Account Manager.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(HERE, ".env")); } catch { /* env vars can also come from the host */ }
const { createAgent, saveTranscript, readJson } = await import("./core.mjs");

/* ---------------------------------------------------------------- settings */
const env = (k, d) => process.env[k] ?? d;
const PORT = Number(env("PORT", 3000));
const CHANNEL_SECRET = env("LINE_CHANNEL_SECRET");
const ACCESS_TOKEN = env("LINE_CHANNEL_ACCESS_TOKEN");
const LINE_API = env("LINE_API_BASE", "https://api.line.me");
const STAFF_LINE_ID = env("STAFF_LINE_ID");                         // optional: user/group ID to notify on hand-over
const HANDOFF_HOURS = Number(env("HANDOFF_HOURS", 12));
const SESSION_MINUTES = Number(env("SESSION_MINUTES", 60));         // a chat idle this long starts fresh
const MAX_TURNS = 40;                                               // start fresh after this many messages
const BUSINESS_DIR = path.resolve(HERE, env("BUSINESS_DIR", "business-karena"));
const DATA_DIR = path.join(HERE, "data");
const PAUSED_FILE = path.join(DATA_DIR, "line-paused.json");

for (const [k, v] of Object.entries({ LINE_CHANNEL_SECRET: CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN: ACCESS_TOKEN, ANTHROPIC_API_KEY: env("ANTHROPIC_API_KEY") })) {
  if (!v) { console.error(`Missing ${k}. Add it to .env or the host's environment variables (see LINE-SETUP.md).`); process.exit(1); }
}

const agent = createAgent({
  businessDir: BUSINESS_DIR,
  model: env("SUPPORT_MODEL", "claude-opus-5-5"),
  effort: env("LINE_EFFORT", "low"),                                // low = quick replies, good for chat
});
const { config } = agent;
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------------------------------------------------------------- LINE API */
async function lineApi(endpoint, body) {
  const r = await fetch(LINE_API + endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ACCESS_TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`LINE ${endpoint} ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// LINE text messages are limited to 5000 characters and 5 messages per reply.
function toMessages(text) {
  const parts = [];
  for (let s = text.trim() || "…"; s.length; s = s.slice(5000)) parts.push({ type: "text", text: s.slice(0, 5000) });
  return parts.slice(0, 5);
}

async function send(userId, replyToken, text) {
  try {
    await lineApi("/v2/bot/message/reply", { replyToken, messages: toMessages(text) });
  } catch (e) {
    // Reply tokens expire; fall back to a push message (counts toward the LINE plan's monthly message quota).
    log("reply failed, pushing instead:", e.message);
    await lineApi("/v2/bot/message/push", { to: userId, messages: toMessages(text) });
  }
}

const showLoading = (userId) =>
  lineApi("/v2/bot/chat/loading/start", { chatId: userId, loadingSeconds: 30 }).catch(() => {});

/* ---------------------------------------------------------------- state */
const sessions = new Map();                       // userId -> { messages, session, id, last }
const queues = new Map();                         // userId -> promise chain, so one customer gets answers in order
const seenEvents = new Set();                     // LINE may redeliver events
const paused = readJson(PAUSED_FILE, {});         // userId -> ISO time the bot may answer again

function isPaused(userId) {
  const until = paused[userId];
  if (!until) return false;
  if (Date.parse(until) > Date.now()) return true;
  delete paused[userId];
  savePaused();
  return false;
}
function savePaused() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PAUSED_FILE, JSON.stringify(paused, null, 2));
}

function getSession(userId) {
  let s = sessions.get(userId);
  const stale = s && (Date.now() - s.last > SESSION_MINUTES * 60_000 || s.messages.length >= MAX_TURNS);
  if (!s || stale) {
    if (s) saveTranscript(path.join(DATA_DIR, "transcripts"), s.id, config, s.messages);
    s = { messages: [], session: {}, id: `line-${userId.slice(-8)}-${Date.now()}` };
    sessions.set(userId, s);
  }
  s.last = Date.now();
  return s;
}

/* ---------------------------------------------------------------- handling one customer message */
async function handleText(userId, replyToken, text) {
  if (isPaused(userId)) { log(`[${userId.slice(-6)}] paused for staff; not replying`); return; }
  const s = getSession(userId);
  s.messages.push({ role: "user", content: text.slice(0, 4000) });
  showLoading(userId);
  let handedOff = false;
  try {
    const r = await agent.respond(s.messages, {
      channel: "line", userId, conversationId: s.id, session: s.session, dataDir: DATA_DIR,
      log: (m) => log(`[${userId.slice(-6)}]`, m),
      onHandoff: async (ticket) => {
        handedOff = true;
        paused[userId] = new Date(Date.now() + HANDOFF_HOURS * 3600_000).toISOString();
        savePaused();
        if (STAFF_LINE_ID) {
          await lineApi("/v2/bot/message/push", {
            to: STAFF_LINE_ID,
            messages: toMessages(`🙋 ${ticket.urgent ? "URGENT — " : ""}A LINE customer needs staff (${ticket.id})\n`
              + `${ticket.summary}\n\nReply to them in LINE Official Account Manager → Chats.`),
          }).catch((e) => log("staff notify failed:", e.message));
        }
      },
    });
    log(`[${userId.slice(-6)}] replied (≈$${r.cost.toFixed(4)})${handedOff ? " — handed over to staff" : ""}`);
    await send(userId, replyToken, r.text);
  } catch (e) {
    log(`[${userId.slice(-6)}] error:`, e?.message || e);
    // Remove the unanswered message so the conversation stays valid, then apologise.
    if (s.messages.at(-1)?.role === "user" && typeof s.messages.at(-1).content === "string") s.messages.pop();
    await send(userId, replyToken,
      "ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือรอพนักงานตอบกลับนะคะ 🙏\nSorry, something went wrong. Please try again in a moment.").catch(() => {});
  } finally {
    saveTranscript(path.join(DATA_DIR, "transcripts"), s.id, config, s.messages);
  }
}

async function handleEvent(ev) {
  if (ev.webhookEventId) {
    if (seenEvents.has(ev.webhookEventId)) return;
    seenEvents.add(ev.webhookEventId);
    if (seenEvents.size > 2000) seenEvents.delete(seenEvents.values().next().value);
  }
  const userId = ev.source?.userId;
  if (ev.source?.type !== "user" || !userId) return;            // only 1:1 chats, not groups
  if (ev.mode === "standby") return;

  if (ev.type === "follow") return send(userId, ev.replyToken, config.greeting);
  if (ev.type !== "message") return;
  if (ev.message.type !== "text") {
    if (isPaused(userId)) return;
    return send(userId, ev.replyToken,
      "ขอบคุณค่ะ 😊 ตอนนี้น้องตอบได้เฉพาะข้อความตัวอักษร พิมพ์คำถามมาได้เลยนะคะ\nThanks! I can only read text messages for now, please type your question.");
  }
  // One customer at a time, in order (LINE can deliver a burst of messages).
  const prev = queues.get(userId) || Promise.resolve();
  const next = prev.then(() => handleText(userId, ev.replyToken, ev.message.text)).catch((e) => log("handler error:", e));
  queues.set(userId, next);
  next.finally(() => { if (queues.get(userId) === next) queues.delete(userId); });
}

/* ---------------------------------------------------------------- HTTP server */
function validSignature(raw, signature) {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", CHANNEL_SECRET).update(raw).digest();
  let given;
  try { given = Buffer.from(signature, "base64"); } catch { return false; }
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(`ok — ${config.business_name} LINE assistant`);
  }
  if (req.method !== "POST" || req.url !== "/webhook") { res.writeHead(404); return res.end(); }

  const chunks = [];
  let size = 0;
  req.on("data", (d) => { size += d.length; if (size > 1_000_000) req.destroy(); else chunks.push(d); });
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    if (!validSignature(raw, req.headers["x-line-signature"])) {
      log("rejected webhook: bad signature");
      res.writeHead(401); return res.end();
    }
    res.writeHead(200); res.end();                    // answer LINE right away; work happens after
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return; }
    for (const ev of body.events || []) handleEvent(ev).catch((e) => log("event error:", e?.message || e));
  });
});

server.listen(PORT, () => {
  log(`${config.business_name} LINE assistant listening on port ${PORT} (webhook path /webhook)`);
  if (!process.env.MENU_API_URL && (config.tools || []).includes("get_menu")) log("warning: MENU_API_URL not set — live menu unavailable");
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    for (const s of sessions.values()) saveTranscript(path.join(DATA_DIR, "transcripts"), s.id, config, s.messages);
    process.exit(0);
  });
}
