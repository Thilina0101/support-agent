/**
 * LINE Messaging API channel.
 * Webhook: POST /webhook (or /line/webhook), signed with the channel secret (x-line-signature).
 */
import crypto from "node:crypto";
import { TEXT_ONLY } from "./chat.mjs";

export function createLine({ secret, token, apiBase = "https://api.line.me", hub, log }) {
  async function api(endpoint, body) {
    const r = await fetch(apiBase + endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`LINE ${endpoint} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  // LINE: max 5000 characters per text message, max 5 messages per reply.
  const toMessages = (text) => {
    const parts = [];
    for (let s = text.trim() || "…"; s.length; s = s.slice(5000)) parts.push({ type: "text", text: s.slice(0, 5000) });
    return parts.slice(0, 5);
  };

  async function reply(userId, replyToken, text) {
    try {
      await api("/v2/bot/message/reply", { replyToken, messages: toMessages(text) });
    } catch (e) {
      // Reply tokens expire; fall back to a push message (counts toward the LINE plan's monthly quota).
      log("LINE reply failed, pushing instead:", e.message);
      await api("/v2/bot/message/push", { to: userId, messages: toMessages(text) });
    }
  }

  const push = (to, text) => api("/v2/bot/message/push", { to, messages: toMessages(text) });

  function validSignature(raw, signature) {
    if (!signature) return false;
    const expected = crypto.createHmac("sha256", secret).update(raw).digest();
    const given = Buffer.from(String(signature), "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  async function onEvent(ev) {
    if (!hub.firstTime(ev.webhookEventId && `line:${ev.webhookEventId}`)) return;
    const userId = ev.source?.userId;
    if (ev.source?.type !== "user" || !userId || ev.mode === "standby") return;   // 1:1 chats only
    if (ev.type === "follow") return reply(userId, ev.replyToken, hub.config.greeting);
    if (ev.type !== "message") return;
    if (ev.message.type !== "text") {
      if (!hub.isPaused("line", userId)) await reply(userId, ev.replyToken, TEXT_ONLY);
      return;
    }
    return hub.handle({
      channel: "line", userId, text: ev.message.text,
      send: (t) => reply(userId, ev.replyToken, t),
      typing: () => api("/v2/bot/chat/loading/start", { chatId: userId, loadingSeconds: 30 }),
    });
  }

  /** HTTP handler for POST requests; returns a status code. */
  function webhook(raw, headers) {
    if (!validSignature(raw, headers["x-line-signature"])) { log("LINE: rejected webhook (bad signature)"); return 401; }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return 400; }
    for (const ev of body.events || []) onEvent(ev).catch((e) => log("LINE event error:", e?.message || e));
    return 200;
  }

  return { webhook, push };
}
