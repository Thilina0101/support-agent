#!/usr/bin/env node
/**
 * Chat server for the support agent: LINE and/or WhatsApp.
 *
 *   node server.mjs
 *
 * Each channel switches on when its settings are in .env (or the host's environment variables):
 *   LINE      → POST https://<server>/webhook            (see LINE-SETUP.md)
 *   WhatsApp  → GET+POST https://<server>/whatsapp/webhook (see WHATSAPP-SETUP.md)
 *   Messenger → GET+POST https://<server>/messenger/webhook (see MESSENGER-SETUP.md)
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(HERE, ".env")); } catch { /* env vars can also come from the host */ }
const { createAgent } = await import("./core.mjs");
const { createChatHub } = await import("./chat.mjs");
const { createLine } = await import("./line.mjs");
const { createWhatsApp } = await import("./whatsapp.mjs");
const { createMessenger } = await import("./messenger.mjs");

const env = (k, d) => process.env[k] || d;
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!env("ANTHROPIC_API_KEY") && !env("ANTHROPIC_AUTH_TOKEN")) { console.error("Missing ANTHROPIC_API_KEY (see .env.example)."); process.exit(1); }
const lineOn = !!(env("LINE_CHANNEL_SECRET") && env("LINE_CHANNEL_ACCESS_TOKEN"));
const waOn = !!(env("WHATSAPP_TOKEN") && env("WHATSAPP_PHONE_NUMBER_ID") && env("WHATSAPP_APP_SECRET") && env("WHATSAPP_VERIFY_TOKEN"));
const FB_SECRET = env("MESSENGER_APP_SECRET", env("WHATSAPP_APP_SECRET"));    // same Meta app can serve both
const fbOn = !!(env("MESSENGER_PAGE_TOKEN") && env("MESSENGER_PAGE_ID") && FB_SECRET && env("MESSENGER_VERIFY_TOKEN"));
if (!lineOn && !waOn && !fbOn) {
  console.error("No chat channel configured. Add the LINE_*, WHATSAPP_* and/or MESSENGER_* settings (see .env.example).");
  process.exit(1);
}

const agent = createAgent({
  businessDir: path.resolve(HERE, env("BUSINESS_DIR", "business-karena")),
  model: env("SUPPORT_MODEL", "claude-opus-5-5"),
  effort: env("CHAT_EFFORT", env("LINE_EFFORT", "low")),          // low = quick replies, good for chat
});

let line, wa, fb;
const STAFF_LINE_ID = env("STAFF_LINE_ID");
const STAFF_WHATSAPP = env("STAFF_WHATSAPP", "").replace(/\D/g, "");

// Alert staff when a customer is handed over (to LINE and/or WhatsApp, whichever is set up).
async function notifyStaff(ticket, who) {
  const where = who.channel === "whatsapp" ? `WhatsApp ${who.name ? `${who.name} ` : ""}${who.phone}`
    : who.channel === "messenger" ? "Facebook Messenger (reply in Meta Business Suite → Inbox)"
    : "LINE (reply in LINE Official Account Manager → Chats)";
  const text = `🙋 ${ticket.urgent ? "URGENT — " : ""}A customer needs staff (${ticket.id})\nChannel: ${where}\n\n${ticket.summary}`;
  const jobs = [];
  if (STAFF_LINE_ID && line) jobs.push(line.push(STAFF_LINE_ID, text));
  // WhatsApp only delivers free-form messages to people who messaged the business in the last 24 hours.
  if (STAFF_WHATSAPP && wa) jobs.push(wa.sendText(STAFF_WHATSAPP, text));
  for (const r of await Promise.allSettled(jobs)) if (r.status === "rejected") log("staff alert failed:", r.reason?.message);
}

const hub = createChatHub({
  agent,
  dataDir: path.join(HERE, "data"),
  handoffHours: Number(env("HANDOFF_HOURS", 12)),
  sessionMinutes: Number(env("SESSION_MINUTES", 60)),
  notifyStaff,
  log,
});

if (lineOn) line = createLine({ secret: env("LINE_CHANNEL_SECRET"), token: env("LINE_CHANNEL_ACCESS_TOKEN"), apiBase: env("LINE_API_BASE"), hub, log });
if (waOn) wa = createWhatsApp({
  token: env("WHATSAPP_TOKEN"), phoneNumberId: env("WHATSAPP_PHONE_NUMBER_ID"), appSecret: env("WHATSAPP_APP_SECRET"),
  verifyToken: env("WHATSAPP_VERIFY_TOKEN"), apiBase: env("WHATSAPP_API_BASE"), apiVersion: env("WHATSAPP_API_VERSION"), hub, log,
});
if (fbOn) fb = createMessenger({
  pageToken: env("MESSENGER_PAGE_TOKEN"), pageId: env("MESSENGER_PAGE_ID"), appSecret: FB_SECRET,
  verifyToken: env("MESSENGER_VERIFY_TOKEN"), appId: env("MESSENGER_APP_ID"),
  apiBase: env("MESSENGER_API_BASE"), apiVersion: env("MESSENGER_API_VERSION"), hub, log,
});

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const done = (status, body = "") => { res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }); res.end(body); };

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    return done(200, `ok — ${agent.config.business_name} assistant (${[lineOn && "LINE", waOn && "WhatsApp", fbOn && "Messenger"].filter(Boolean).join(" + ")})`);
  }
  if (req.method === "GET" && url.pathname === "/whatsapp/webhook" && wa) return done(...wa.verify(url.searchParams));
  if (req.method === "GET" && url.pathname === "/messenger/webhook" && fb) return done(...fb.verify(url.searchParams));

  const channel = (url.pathname === "/webhook" || url.pathname === "/line/webhook") ? line
    : url.pathname === "/whatsapp/webhook" ? wa
    : url.pathname === "/messenger/webhook" ? fb : null;
  if (req.method !== "POST" || !channel) return done(404);

  const chunks = [];
  let size = 0;
  req.on("data", (d) => { size += d.length; if (size > 2_000_000) req.destroy(); else chunks.push(d); });
  req.on("end", () => done(channel.webhook(Buffer.concat(chunks), req.headers)));   // answer at once; replies are sent afterwards
});

const PORT = Number(env("PORT", 3000));
server.listen(PORT, () => {
  log(`${agent.config.business_name} assistant listening on port ${PORT}`);
  if (lineOn) log("LINE webhook:     POST /webhook");
  if (waOn) log("WhatsApp webhook: GET+POST /whatsapp/webhook");
  if (fbOn) log("Messenger webhook: GET+POST /messenger/webhook" + (env("MESSENGER_APP_ID") ? "" : " (set MESSENGER_APP_ID to auto-pause when staff reply by hand)"));
  if (!process.env.MENU_API_URL && (agent.config.tools || []).includes("get_menu")) log("warning: MENU_API_URL not set — live menu unavailable");
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { hub.saveAll(); process.exit(0); });
