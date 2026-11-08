/**
 * Channel-independent chat handling, shared by LINE and WhatsApp:
 * one conversation per customer, answers in order, hand-off pauses, transcripts, error apology.
 */
import fs from "node:fs";
import path from "node:path";
import { saveTranscript, readJson } from "./core.mjs";

const SORRY = "ขออภัยค่ะ ระบบขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้ง หรือรอพนักงานตอบกลับนะคะ 🙏\nSorry, something went wrong. Please try again in a moment.";
export const TEXT_ONLY = "ขอบคุณค่ะ 😊 ตอนนี้น้องตอบได้เฉพาะข้อความตัวอักษร พิมพ์คำถามมาได้เลยนะคะ\nThanks! I can only read text messages for now, please type your question.";

export function createChatHub({ agent, dataDir, handoffHours = 12, sessionMinutes = 60, maxTurns = 40, notifyStaff, log }) {
  const { config } = agent;
  const transcripts = path.join(dataDir, "transcripts");
  const pausedFile = path.join(dataDir, "paused.json");
  const sessions = new Map();     // key -> { messages, session, id, last }
  const queues = new Map();       // key -> promise chain (one answer at a time per customer)
  const seen = new Set();         // event/message ids already handled (platforms may redeliver)
  const paused = readJson(pausedFile, {});   // "channel:userId" -> ISO time the bot may answer again

  const savePaused = () => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(pausedFile, JSON.stringify(paused, null, 2)); };

  function isPaused(key) {
    const until = paused[key];
    if (!until) return false;
    if (Date.parse(until) > Date.now()) return true;
    delete paused[key]; savePaused();
    return false;
  }

  function firstTime(id) {
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > 5000) seen.delete(seen.values().next().value);
    return true;
  }

  function getSession(key) {
    let s = sessions.get(key);
    if (s && (Date.now() - s.last > sessionMinutes * 60_000 || s.messages.length >= maxTurns)) {
      saveTranscript(transcripts, s.id, config, s.messages);
      s = null;
    }
    if (!s) {
      s = { messages: [], session: {}, id: `${key.replace(/[^\w-]/g, "_").slice(0, 40)}-${Date.now()}` };
      sessions.set(key, s);
    }
    s.last = Date.now();
    return s;
  }

  /**
   * handle({ channel, userId, text, customer, send, typing })
   *   customer: { name?, phone? } shown to staff on hand-off
   *   send(text): delivers the reply; typing(): optional "…" indicator
   */
  function handle(msg) {
    const key = `${msg.channel}:${msg.userId}`;
    const prev = queues.get(key) || Promise.resolve();
    const next = prev.then(() => answer(key, msg)).catch((e) => log("handler error:", e?.message || e));
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
    return next;
  }

  async function answer(key, { channel, userId, text, customer = {}, send, typing }) {
    const tag = `[${channel}:${String(userId).slice(-6)}]`;
    if (isPaused(key)) { log(tag, "paused for staff; not replying"); return; }
    const s = getSession(key);
    s.messages.push({ role: "user", content: text.slice(0, 4000) });
    typing?.().catch?.(() => {});
    let handedOff = false;
    try {
      const r = await agent.respond(s.messages, {
        channel, userId, conversationId: s.id, session: s.session, dataDir,
        log: (m) => log(tag, m),
        onHandoff: async (ticket) => {
          handedOff = true;
          paused[key] = new Date(Date.now() + handoffHours * 3600_000).toISOString();
          savePaused();
          await notifyStaff?.(ticket, { channel, userId, ...customer }).catch((e) => log("staff alert failed:", e.message));
        },
      });
      log(tag, `replied (≈$${r.cost.toFixed(4)})${handedOff ? " — handed over to staff" : ""}`);
      await send(r.text);
    } catch (e) {
      log(tag, "error:", e?.message || e);
      // Drop the unanswered message so the conversation stays valid, then apologise.
      if (s.messages.at(-1)?.role === "user" && typeof s.messages.at(-1).content === "string") s.messages.pop();
      await send(SORRY).catch(() => {});
    } finally {
      saveTranscript(transcripts, s.id, config, s.messages);
    }
  }

  function saveAll() { for (const s of sessions.values()) saveTranscript(transcripts, s.id, config, s.messages); }

  // Pause the bot for one customer (e.g. a staff member started replying by hand).
  function pause(channel, userId, hours = handoffHours) {
    const key = `${channel}:${userId}`;
    const until = new Date(Date.now() + hours * 3600_000).toISOString();
    if (!paused[key] || paused[key] < until) { paused[key] = until; savePaused(); log(`[${channel}:${String(userId).slice(-6)}] staff replied by hand; bot paused`); }
  }

  return { handle, isPaused: (channel, userId) => isPaused(`${channel}:${userId}`), pause, firstTime, saveAll, config };
}
