/**
 * Facebook Page Messenger channel (Messenger Platform, Graph API).
 * Webhook: GET /messenger/webhook (Meta's verification) and POST /messenger/webhook (messages),
 * signed with the Meta app secret (X-Hub-Signature-256).
 */
import crypto from "node:crypto";
import { TEXT_ONLY } from "./chat.mjs";

export function createMessenger({ pageToken, pageId, appSecret, verifyToken, appId, apiBase = "https://graph.facebook.com", apiVersion = "v23.0", hub, log }) {
  async function api(body) {
    const r = await fetch(`${apiBase}/${apiVersion}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pageToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`Messenger ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  // Messenger text messages are limited to 2000 characters.
  async function sendText(psid, text) {
    const t = text.trim() || "…";
    for (let i = 0; i < t.length && i < 2000 * 5; i += 2000) {
      await api({ recipient: { id: psid }, messaging_type: "RESPONSE", message: { text: t.slice(i, i + 2000) } });
    }
  }

  const action = (psid, sender_action) => api({ recipient: { id: psid }, sender_action });

  function validSignature(raw, header) {
    const m = /^sha256=([0-9a-f]{64})$/i.exec(String(header || ""));
    if (!m) return false;
    const expected = crypto.createHmac("sha256", appSecret).update(raw).digest();
    const given = Buffer.from(m[1], "hex");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  }

  /** Meta's webhook verification (GET). Returns [status, body]. */
  function verify(query) {
    if (query.get("hub.mode") === "subscribe" && verifyToken && query.get("hub.verify_token") === verifyToken) {
      log("Messenger: webhook verified");
      return [200, query.get("hub.challenge") || ""];
    }
    return [403, "forbidden"];
  }

  async function onMessaging(ev) {
    const msg = ev.message;
    // Echo = a message the Page sent. If it wasn't sent by this app, a staff member replied by hand
    // (e.g. from the Meta Business Suite inbox): let them take over that chat.
    if (msg?.is_echo) {
      if (appId && String(msg.app_id || "") !== String(appId)) hub.pause("messenger", ev.recipient?.id);
      return;
    }
    const psid = ev.sender?.id;
    if (!psid || psid === pageId) return;
    if (ev.postback) {                                   // "Get Started" button and other buttons
      if (!hub.firstTime(`fb:pb:${psid}:${ev.timestamp}`)) return;
      if (ev.postback.payload === "GET_STARTED" || /get started/i.test(ev.postback.title || "")) return sendText(psid, hub.config.greeting);
      return hub.handle({ channel: "messenger", userId: psid, text: ev.postback.title || ev.postback.payload, send: (t) => sendText(psid, t), typing: () => action(psid, "typing_on") });
    }
    if (!msg || !hub.firstTime(`fb:${msg.mid}`)) return;   // delivery/read receipts have no message
    const text = msg.quick_reply?.payload && !msg.text ? msg.quick_reply.payload : msg.text;
    if (!text) {
      if (!hub.isPaused("messenger", psid)) await sendText(psid, TEXT_ONLY);
      return;
    }
    return hub.handle({
      channel: "messenger", userId: psid, text,
      customer: { name: "Facebook user (see Page inbox)" },
      send: (t) => sendText(psid, t),
      typing: async () => { await action(psid, "mark_seen"); await action(psid, "typing_on"); },
    });
  }

  /** HTTP handler for POST requests; returns a status code. */
  function webhook(raw, headers) {
    if (!validSignature(raw, headers["x-hub-signature-256"])) { log("Messenger: rejected webhook (bad signature)"); return 401; }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return 400; }
    if (body.object !== "page") return 200;
    for (const entry of body.entry || []) {
      if (pageId && String(entry.id) !== String(pageId)) continue;           // not our Page
      for (const ev of entry.messaging || []) onMessaging(ev).catch((e) => log("Messenger event error:", e?.message || e));
    }
    return 200;
  }

  return { webhook, verify, sendText };
}
