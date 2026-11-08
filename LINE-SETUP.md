# Karena Curry Rice: LINE assistant setup

Customers chat with your LINE Official Account, and the AI assistant answers in Thai or English:

- **Menu and prices.** It reads the live menu from your POS Google Sheet, including sold-out items.
- **Shop info.** Opening hours, location, payment and so on come from `business-karena/knowledge/shop-info.md`.
- **QR order status.** A customer can send "QR-00012" and get its status (waiting / being prepared / paid).
- **Hand-off to staff.** It hands over for complaints, allergies, reservations, or when someone asks for a person.
  The bot then **stops replying to that customer for 12 hours** so your staff can answer in LINE OA Manager.

```
Customer ──► LINE ──► line-server.mjs (/webhook) ──► Claude ──► reply in LINE
                              ├── live menu + QR status: your POS Google Apps Script
                              └── hand-off: ticket + LINE alert to staff, bot pauses
```

## Step 1: Fill in the shop information

Open `business-karena/knowledge/shop-info.md` and replace every **TODO**: address, hours, phone,
delivery apps, payment methods, spice level, allergens. The assistant treats TODO as "I don't know", so
anything left as TODO gets passed to staff instead of answered.

## Step 2: Test it in the terminal first

```powershell
cd C:\Users\Dell\support-agent
copy .env.example .env        # then fill in ANTHROPIC_API_KEY and MENU_API_URL
$env:BUSINESS_DIR="business-karena"; node support.mjs
```
Try: `เมนูมีอะไรบ้าง`, `ราคาข้าวแกงกะหรี่หมูเท่าไหร่`, `QR-00001 ได้หรือยัง`, `ขอคุยกับพนักงาน`.

`MENU_API_URL` is the same Web App URL that's in your POS Settings (ends in `/exec`). Your Google Sheet script needs **Code.gs version 3 or newer**.

## Step 3: Connect your LINE Official Account

1. Open **LINE Official Account Manager** (https://manager.line.biz) and choose your account (or create one).
2. Go to **Settings → Messaging API → Enable Messaging API** and pick or create a provider.
3. Open **LINE Developers Console** (https://developers.line.biz/console/) → your provider → the channel for your OA:
   - **Basic settings** tab: copy the **Channel secret** to `LINE_CHANNEL_SECRET`.
     On the same page, **Your user ID** (starts with `U…`) can go in `STAFF_LINE_ID` to get hand-off alerts.
     You must also add the OA as a friend.
   - **Messaging API** tab: under **Channel access token (long-lived)** click **Issue**, then copy it to `LINE_CHANNEL_ACCESS_TOKEN`.
4. Back in **OA Manager → Settings → Response settings**:
   - **Chat: ON** so staff can still reply by hand.
   - **Webhooks: ON**
   - **Greeting message: OFF** and **Auto-response messages: OFF**, so customers don't get two replies.

## Step 4: Run the server somewhere LINE can reach (HTTPS)

LINE needs a public **https** address. Two options:

**A. Quick test from this computer (free).** The computer must stay on.
1. Install Cloudflare Tunnel: `winget install Cloudflare.cloudflared`
2. In one terminal: `cd C:\Users\Dell\support-agent; node line-server.mjs`
3. In another terminal: `cloudflared tunnel --url http://localhost:3000`
   It prints an address like `https://something.trycloudflare.com`. The address changes every time you restart it.

**B. Always on: a hosting service** such as Render, Railway or Fly.io.
1. Put this project in a **private** GitHub repo and connect it to the host as a Node web service.
2. Start command: `node line-server.mjs`. Build command: `npm install`.
3. Add the values from your `.env` as **environment variables** in the host's dashboard. Don't upload `.env`.
4. Choose a plan that doesn't "sleep". On free plans that sleep after inactivity, the first message after
   a quiet period can take a minute to answer. Also note that on many hosts files in `data/` (tickets,
   transcripts) are wiped when the app restarts.

Then, in **LINE Developers Console → Messaging API → Webhook settings**:
- **Webhook URL:** `https://<your address>/webhook`, then click **Update** and then **Verify** (it should say Success).
- **Use webhook: ON**

Send your OA a message from your phone. You should see the "…" typing animation, then the answer.

## Day to day

- **A customer was handed to staff.** You get a LINE alert (if `STAFF_LINE_ID` is set). Reply in **OA Manager → Chats**.
  The bot stays quiet with that customer for `HANDOFF_HOURS` (default 12), then helps again.
- **Tickets and conversations** are in `data/tickets.json` and `data/transcripts/`. Read a few each week
  to see what customers ask, then add the answers to `shop-info.md`.
- **Change the menu or prices** in the POS as usual. The assistant reads the live menu (refreshed every minute).
- **Cost:** each customer message costs roughly ฿0.3–1.5 in Claude usage. The server logs the cost of each reply.
  LINE: replies are free. Staff alerts and the occasional late reply are "push" messages, which count toward your LINE plan's monthly message quota.

## Privacy and safety

- The server only accepts messages signed by LINE, using your Channel secret.
- It answers in 1-to-1 chats only, not group chats.
- `data/` contains customers' LINE IDs and messages. Keep it private (it's excluded from git).
- Keep `.env` secret. If a key or token leaks, issue a new one in the LINE / Claude console.
