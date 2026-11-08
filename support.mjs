#!/usr/bin/env node
/**
 * support-agent — terminal tester. You play the customer.
 *
 *   node support.mjs
 *   $env:BUSINESS_DIR="business-karena"; node support.mjs     (test the Karena LINE setup in the terminal)
 */
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(path.join(HERE, ".env")); } catch { /* no .env file is fine */ }
const { createAgent, saveTranscript, readJson } = await import("./core.mjs");

const MODEL = process.env.SUPPORT_MODEL || "claude-opus-5-5";
const EFFORT = process.env.SUPPORT_EFFORT || "medium";
const SHOW_TOOLS = process.env.SHOW_TOOLS !== "false";
const BUSINESS_DIR = path.resolve(HERE, process.env.BUSINESS_DIR || "business");
const DATA_DIR = path.join(HERE, "data");

const c = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const dim = c(2), red = c(31), green = c(32), yellow = c(33), cyan = c(36), bold = c(1);

let agent;
try { agent = createAgent({ businessDir: BUSINESS_DIR, model: MODEL, effort: EFFORT }); }
catch (e) { console.error(red(e.message)); process.exit(1); }
const { config } = agent;

let messages = [], session = {}, conversationId = null, current = null, interrupted = false, totalCost = 0, paused = false;

function newConversation() {
  saveTranscript(path.join(DATA_DIR, "transcripts"), conversationId, config, messages);
  messages = []; session = {}; paused = false;
  conversationId = "terminal-" + new Date().toISOString().replace(/[:.]/g, "-");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("SIGINT", () => {
  if (current) { interrupted = true; current.abort(); return; }
  saveTranscript(path.join(DATA_DIR, "transcripts"), conversationId, config, messages);
  console.log("\nBye!");
  process.exit(0);
});

function showTickets() {
  const tickets = readJson(path.join(DATA_DIR, "tickets.json"), []);
  if (!tickets.length) return console.log(dim("No tickets yet."));
  for (const t of tickets.slice(-10)) {
    const who = [t.customer_name, t.contact].filter(Boolean).join(" ");
    console.log(`${bold(t.id)} [${t.priority || (t.urgent ? "urgent" : "normal")}] ${t.category || t.reason}${who ? ` · ${who}` : ""}${t.order_id ? ` · ${t.order_id}` : ""}\n  ${dim(t.summary)}`);
  }
}

console.log(bold(cyan(`${config.business_name} — support chat`)) + dim(` · ${MODEL} · effort ${EFFORT}`));
if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
  console.log(yellow(`No ANTHROPIC_API_KEY found. Put it in ${path.join(HERE, ".env")} (see README.md).`));
}
console.log(dim("You are the customer. Commands: /new (new customer), /tickets (staff view), /exit\n"));
newConversation();
console.log(bold(cyan(`${config.assistant_name}: `)) + config.greeting);

while (true) {
  let input;
  try { input = (await rl.question(bold(green("\nYou: ")))).trim(); } catch { break; }
  if (!input) continue;
  if (input === "/exit" || input === "/quit") break;
  if (input === "/new") { newConversation(); console.log(dim("— new customer —")); console.log(bold(cyan(`${config.assistant_name}: `)) + config.greeting); continue; }
  if (input === "/tickets") { showTickets(); continue; }
  if (paused) { console.log(dim("(Handed over to staff — the bot doesn't reply in this chat any more. Type /new to start over.)")); continue; }

  messages.push({ role: "user", content: input });
  process.stdout.write(bold(cyan(`\n${config.assistant_name}: `)));
  try {
    const r = await agent.respond(messages, {
      channel: "terminal", userId: "terminal", conversationId, session, dataDir: DATA_DIR,
      onText: (t) => process.stdout.write(t),
      onStream: (s) => { current = s; },
      log: SHOW_TOOLS ? (s) => console.log(dim(`\n  ${s}`)) : null,
      onHandoff: () => { paused = true; },
    });
    totalCost += r.cost;
    if (r.refused || r.error) process.stdout.write(r.text);
    console.log(SHOW_TOOLS ? dim(`\n  [session ≈ $${totalCost.toFixed(3)}]`) : "");
  } catch (err) {
    if (interrupted) { interrupted = false; console.log(yellow(" (stopped)")); }
    else if (err instanceof Anthropic.AuthenticationError) console.log(red("\nThe API key was rejected. Check ANTHROPIC_API_KEY in .env."));
    else if (err instanceof Anthropic.RateLimitError) console.log(red("\nToo many requests right now. Please wait a moment and try again."));
    else if (err instanceof Anthropic.BadRequestError) console.log(red(`\nRequest rejected: ${err.message}`));
    else if (err instanceof Anthropic.APIConnectionError) console.log(red("\nCould not reach the Claude API. Check the internet connection."));
    else if (err instanceof Anthropic.APIError) console.log(red(`\nAPI error ${err.status ?? ""}: ${err.message}`));
    else console.log(red(`\nUnexpected error: ${err?.stack || err}`));
  } finally {
    current = null;
  }
  saveTranscript(path.join(DATA_DIR, "transcripts"), conversationId, config, messages);
}
saveTranscript(path.join(DATA_DIR, "transcripts"), conversationId, config, messages);
rl.close();
