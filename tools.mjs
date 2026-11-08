/**
 * Tools the support agent can use. A business turns them on with "tools" in its config.json.
 * Each tool has: the API definition, a zod schema to validate input, prompt rules, and run(input, ctx).
 */
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return fallback; }
}

/* ---------------------------------------------------------------- tickets (shared by create_ticket and handoff_to_staff) */
function saveTicket(ctx, fields) {
  fs.mkdirSync(ctx.dataDir, { recursive: true });
  const file = path.join(ctx.dataDir, "tickets.json");
  const tickets = readJson(file, []);
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const id = `T-${day}-${String(tickets.filter((t) => t.id.startsWith(`T-${day}`)).length + 1).padStart(3, "0")}`;
  const ticket = { id, created: new Date().toISOString(), status: "open", channel: ctx.channel || "terminal",
    customer_ref: ctx.userId || null, conversation: ctx.conversationId || null, ...fields };
  tickets.push(ticket);
  fs.writeFileSync(file, JSON.stringify(tickets, null, 2));
  return ticket;
}

/* ---------------------------------------------------------------- POS (Google Apps Script) helpers */
const menuCache = { at: 0, data: null };
async function posGet(params) {
  const base = process.env.MENU_API_URL;
  if (!base) throw new Error("MENU_API_URL is not set, so the live menu isn't available.");
  const url = base + (base.includes("?") ? "&" : "?") + new URLSearchParams(params);
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "POS returned an error");
  return j;
}

/* ---------------------------------------------------------------- the tool library */
export const TOOL_LIBRARY = {
  lookup_order: {
    def: {
      name: "lookup_order",
      description: "Look up an online order. Needs both the order number and the email address used for the order; returns details only if both match.",
      input_schema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order number, e.g. BS-10421" },
          email: { type: "string", description: "Email address used for the order" },
        },
        required: ["order_id", "email"],
      },
    },
    schema: z.object({ order_id: z.string().min(1).max(50), email: z.string().min(3).max(200) }),
    rules: `Orders:
- To look up an order, ask for both the order number and the email address used for the order, then use lookup_order.
- Only share order details that lookup_order returned. If no order matches, say so and ask the customer to double-check; don't hint whether the order number exists.`,
    run({ order_id, email }, ctx) {
      if (ctx.session.failedLookups >= 5) {
        return { error: "Too many unsuccessful lookups in this conversation. Offer to hand over to staff instead." };
      }
      const orders = readJson(path.join(ctx.businessDir, "orders.json"), []);
      const norm = (s) => String(s || "").trim().toLowerCase();
      const order = orders.find((o) => norm(o.order_id) === norm(order_id) && norm(o.email) === norm(email));
      if (!order) { ctx.session.failedLookups = (ctx.session.failedLookups || 0) + 1; return { found: false, message: "No order matches that order number and email." }; }
      const { email: _hidden, ...safe } = order;
      ctx.log?.(`🔎 lookup_order ${order_id} → found`);
      return { found: true, order: safe };
    },
  },

  create_ticket: {
    def: {
      name: "create_ticket",
      description: "Hand the conversation to a staff member by creating a support ticket. Returns the ticket number to give the customer.",
      input_schema: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["refund", "damaged_or_wrong_item", "delivery", "order_change", "complaint", "business_quote", "other"] },
          priority: { type: "string", enum: ["low", "normal", "urgent"], description: "urgent: angry customer, safety issue, or time-critical" },
          customer_name: { type: "string" },
          contact: { type: "string", description: "Customer's email or phone number" },
          order_id: { type: "string", description: "Related order number, if any" },
          summary: { type: "string", description: "What happened and what the customer wants, written for staff" },
        },
        required: ["category", "priority", "customer_name", "contact", "summary"],
      },
    },
    schema: z.object({
      category: z.enum(["refund", "damaged_or_wrong_item", "delivery", "order_change", "complaint", "business_quote", "other"]),
      priority: z.enum(["low", "normal", "urgent"]),
      customer_name: z.string().min(1).max(100),
      contact: z.string().min(3).max(200),
      order_id: z.string().max(50).optional(),
      summary: z.string().min(5).max(3000),
    }),
    rules: (config) => `Handing over to staff (create_ticket):
- Create a ticket when the customer asks for a person, the issue needs staff action (refund approval, damaged or wrong item, cancellation, address change, complaint, business quote), or the customer is upset and you can't resolve it.
- Before creating it, make sure you have the customer's name, a way to contact them (email or phone), and the details staff will need. Ask for anything missing.
- After creating it, give the customer the ticket number and say staff will reply. Customers can also reach staff directly: ${config.human_contact}.`,
    run(input, ctx) {
      const t = saveTicket(ctx, input);
      ctx.log?.(`🎫 Ticket ${t.id} created [${input.priority}] ${input.category}: ${input.summary.slice(0, 120)}`);
      return { created: true, ticket_id: t.id };
    },
  },

  get_menu: {
    def: {
      name: "get_menu",
      description: "Get the restaurant's live menu from the shop's POS: dish names, prices, categories, descriptions, and which items are sold out right now.",
      input_schema: { type: "object", properties: {} },
    },
    schema: z.object({}).passthrough(),
    rules: `Menu:
- Use get_menu for any question about dishes, prices or what's available. It's the live menu from the shop's POS, so always check it rather than guessing a price.
- Items with "available": false are sold out right now.`,
    async run(_input, ctx) {
      if (Date.now() - menuCache.at > 60_000 || !menuCache.data) {
        const j = await posGet({ action: "menu" });
        menuCache.data = {
          shop: j.shop,
          items: (j.items || []).map(({ name, price, category, available, description }) =>
            ({ name, price, category, available, ...(description ? { description } : {}) })),
        };
        menuCache.at = Date.now();
      }
      ctx.log?.(`📋 get_menu → ${menuCache.data.items.length} items`);
      return menuCache.data;
    },
  },

  check_qr_order: {
    def: {
      name: "check_qr_order",
      description: "Check the status of an order the customer placed by scanning the QR code at their table. Order numbers look like QR-00012.",
      input_schema: {
        type: "object",
        properties: { order_id: { type: "string", description: "QR order number, e.g. QR-00012" } },
        required: ["order_id"],
      },
    },
    schema: z.object({ order_id: z.string().max(20) }),
    rules: `QR table orders:
- Customers who order by scanning the QR code on their table get an order number like QR-00012. Use check_qr_order when they ask about it.
- Status meanings: NEW = sent, waiting for staff to accept; ACCEPTED = accepted and being prepared; PAID = paid; REJECTED = staff couldn't accept it (suggest they speak to a staff member); UNKNOWN = number not found (ask them to check it).`,
    async run({ order_id }, ctx) {
      const id = order_id.trim().toUpperCase();
      if (!/^QR-\d{1,6}$/.test(id)) return { error: "That doesn't look like a QR order number (format: QR-00012)." };
      const j = await posGet({ action: "status", id });
      ctx.log?.(`🔎 check_qr_order ${id} → ${j.status}`);
      return { order_id: id, status: j.status };
    },
  },

  handoff_to_staff: {
    def: {
      name: "handoff_to_staff",
      description: "Pass this chat to a human staff member. The assistant stops replying to this customer and staff will answer in the same chat.",
      input_schema: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["asked_for_staff", "complaint", "food_or_order_problem", "payment_problem", "reservation_or_large_order", "unanswered_question", "other"] },
          urgent: { type: "boolean", description: "true if the customer is very upset, it's a safety/allergy issue, or they're waiting in the shop now" },
          summary: { type: "string", description: "Short summary for staff: what the customer needs" },
          customer_name: { type: "string", description: "If the customer gave it" },
          contact: { type: "string", description: "Phone number, if the customer gave it" },
        },
        required: ["reason", "urgent", "summary"],
      },
    },
    schema: z.object({
      reason: z.enum(["asked_for_staff", "complaint", "food_or_order_problem", "payment_problem", "reservation_or_large_order", "unanswered_question", "other"]),
      urgent: z.boolean(),
      summary: z.string().min(3).max(2000),
      customer_name: z.string().max(100).optional(),
      contact: z.string().max(100).optional(),
    }),
    rules: (config) => `Handing over to staff (handoff_to_staff):
- Hand over when the customer asks for a person, has a complaint, a problem with their food, order or payment, wants a reservation, a large or catering order, or asks something you can't answer from the information you have.
- You don't need their name or phone number to hand over; the chat itself is the contact. Write a clear summary for staff.
- After handing over, tell the customer a staff member will contact them soon${config.staff_hours ? ` (${config.staff_hours})` : ""}, and stop answering.`,
    async run(input, ctx) {
      const t = saveTicket(ctx, input);
      ctx.log?.(`🙋 Handed over to staff: ticket ${t.id}${input.urgent ? " [URGENT]" : ""} — ${input.summary.slice(0, 120)}`);
      await ctx.onHandoff?.(t);
      return { handed_off: true, ticket_id: t.id, note: "Bot is now paused for this customer; staff will reply in this chat." };
    },
  },
};
