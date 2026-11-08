# support-agent

An AI customer support agent for **any business**, powered by Claude (Claude Opus 5.5).
You give it the business's information as plain text files. It answers customers, looks up orders,
and hands difficult cases to staff by creating tickets.

This version runs in the terminal so you can **test it**. You play the customer.

```
Sunny: Hi! I'm Sunny, the virtual assistant for Brightside Home Goods. How can I help you today?

You: my pan arrived dented, order BS-10421
Sunny: I'm sorry about that! To check your order, could you tell me the email address you used?

You: nina@example.com
  🔎 lookup_order BS-10421 → found
Sunny: Thanks, Nina. I found your order. Damaged items are replaced or refunded for free. Can I
pass this to our team with a photo of the dent? What's the best way for them to contact you?
```

## Setup (one time)

1. Get a Claude API key at https://platform.claude.com → *API Keys*.
2. Create a file **`.env`** in this folder containing:
   ```
   ANTHROPIC_API_KEY=sk-ant-...your key...
   ```
3. Dependencies are already installed. If you copy the folder somewhere else, run `npm install`.

## Run it

```powershell
cd C:\Users\Dell\support-agent
node support.mjs
```

| Command | What it does |
|---|---|
| (type a message) | Chat as a customer |
| `/new` | Start a conversation as a new customer |
| `/tickets` | Staff view: the latest tickets |
| `/exit` | Quit |
| `Ctrl+C` | Stop a reply mid-way |

Try the sample orders: `BS-10421` + `nina@example.com`, `BS-10457` + `somchai@example.com`, `BS-10388` + `alex@example.com`.

## Make it yours

Everything about the business is in the **`business/`** folder:

| File | What to put in it |
|---|---|
| `config.json` | Business name, assistant name, greeting, tone, how customers reach a human, and `"order_lookup": true/false` |
| `knowledge/*.md` | Everything the agent should know: about the company, opening hours, prices, shipping, returns, FAQ. Add as many `.md` or `.txt` files as you like, written in plain language. |
| `orders.json` | Orders the agent can look up (sample format included). Later this can be swapped for your real order system. |

The agent **only answers from these files**. If something isn't covered, it says it doesn't know and offers to pass the question to staff.
It never invents prices or policies and never promises refunds. It creates a ticket for staff instead.

To run a different business without changing these files, make a copy of the folder (e.g. `business-karena/`) and start it with
`$env:BUSINESS_DIR="business-karena"; node support.mjs`.

## What it can do

| Tool | When it's used |
|---|---|
| `lookup_order` | Customer asks about an order. It needs **both** the order number and the email on the order. After 5 wrong tries in one chat it stops, so nobody can guess other people's orders. |
| `create_ticket` | Customer wants a person, needs a refund or exception, has a damaged item, or is unhappy. It collects their name and contact first. |

## Where things are saved

| Folder | Contents |
|---|---|
| `data/tickets.json` | Tickets for staff (category, priority, customer contact, summary) |
| `data/transcripts/` | Every conversation, one file each, for review |

`data/` holds customer personal details, so it's excluded from git (see `.gitignore`).

## Settings (in `.env`)

```
SUPPORT_MODEL=claude-opus-5-5   # default
SUPPORT_EFFORT=medium           # low | medium | high (low = faster/cheaper replies)
SHOW_TOOLS=true                 # false = hide tool activity and token counts (customer view)
BUSINESS_DIR=business           # which business folder to use
```

## Cost

With `SHOW_TOOLS=true`, each reply shows tokens and a running cost estimate.
The business information is sent with every message but **prompt caching** makes repeats ~95% cheaper.
A typical support chat costs about 1–5 US cents with the default settings.

## LINE Official Account (Karena Curry Rice)

`line-server.mjs` connects the same agent to a LINE Official Account, using the `business-karena/` folder:
live menu from the POS, QR order status, and hand-off to staff. **Setup guide: [LINE-SETUP.md](LINE-SETUP.md).**

| File | Role |
|---|---|
| `core.mjs` | The agent: system prompt, Claude calls, tool loop (shared) |
| `tools.mjs` | All tools: `lookup_order`, `create_ticket`, `get_menu`, `check_qr_order`, `handoff_to_staff` |
| `support.mjs` | Terminal tester |
| `line-server.mjs` | LINE webhook server |

A business picks its tools with `"tools": [...]` in its `config.json`.
