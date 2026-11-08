/**
 * WhatsApp Business Platform (Cloud API) channel.
 * Webhook: GET /whatsapp/webhook (Meta's verification) and POST /whatsapp/webhook (messages),
 * signed with the Meta app secret (X-Hub-Signature-256).
 */
import crypto from "node:crypto";
import { TEXT_ONLY } from "./chat.mjs";

export function createWhatsApp({ token, phoneNumberId, appSecret, verifyToken, apiBase = "https://graph.facebook.com", apiVersion = "v23.0", hub, log }) {
  async function api(body) {
    const r = await fetch(`${apiBase}/${apiVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`WhatsApp ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }

  // WhatsApp text messages are limited to 4096 characters.
  async function sendText(to, text) {
    const t = text.trim() || "…";
    for (let i = 0; i < t.length && i < 4096 * 3; i += 4096) {
      await api({ recipient_type: "individual", to, type: "text", text: { preview_url: false, body: t.slice(i, i + 4096) } });
    }
  }

  // Marks the customer's message as read (blue ticks) and shows "typing…".
  const typing = (messageId) => api({ status: "read", message_id: messageId, typing_indicator: { type: "text" } });

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
      log("WhatsApp: webhook verified");
      return [200, query.get("hub.challenge") || ""];
    }
    return [403, "forbidden"];
  }

  async function onMessage(m, contacts) {
    if (!hub.firstTime(`wa:${m.id}`)) return;
    const from = m.from;                                    // customer's WhatsApp number (wa_id)
    const name = contacts?.find((c) => c.wa_id === from)?.profile?.name;
    if (m.type !== "text") {
      if (!hub.isPaused("whatsapp", from)) await sendText(from, TEXT_ONLY);
      return;
    }
    return hub.handle({
      channel: "whatsapp", userId: from, text: m.text?.body || "",
      customer: { name, phone: "+" + from },
      send: (t) => sendText(from, t),
      typing: () => typing(m.id),
    });
  }

  /** HTTP handler for POST requests; returns a status code. */
  function webhook(raw, headers) {
    if (!validSignature(raw, headers["x-hub-signature-256"])) { log("WhatsApp: rejected webhook (bad signature)"); return 401; }
    let body;
    try { body = JSON.parse(raw.toString("utf8")); } catch { return 400; }
    if (body.object !== "whatsapp_business_account") return 200;
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const v = change.value || {};
        if (change.field !== "messages" || v.metadata?.phone_number_id !== phoneNumberId) continue;
        for (const m of v.messages || []) onMessage(m, v.contacts).catch((e) => log("WhatsApp message error:", e?.message || e));
        // v.statuses (sent/delivered/read receipts) are ignored.
      }
    }
    return 200;
  }

  return { webhook, verify, sendText };
}
