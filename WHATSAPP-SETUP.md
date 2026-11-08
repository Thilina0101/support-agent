# Karena Curry Rice: WhatsApp assistant setup

The same assistant that answers on LINE can answer on **WhatsApp** too: live menu and prices, shop info,
QR order status, and hand-off to staff. One server (`server.mjs`) runs both. Each channel switches on
when its settings are in `.env`.

```
Customer ──► WhatsApp ──► server.mjs (/whatsapp/webhook) ──► Claude ──► reply on WhatsApp
                                  └── hand-off: ticket + alert to staff (LINE and/or WhatsApp), bot pauses 12h
```

It uses Meta's official **WhatsApp Business Platform (Cloud API)**. You need a Meta (Facebook) account and
a phone number for the business.

## Step 1: Create the Meta app

1. Go to https://developers.facebook.com → **My Apps → Create App**. Choose the WhatsApp / "Business" use case
   and connect it to your **Meta Business portfolio** (create one if asked).
2. In the app, open **WhatsApp → API Setup**. Meta gives you a free **test number** to start with.
   Copy the **Phone number ID** to `WHATSAPP_PHONE_NUMBER_ID`.
3. **App secret:** go to **App settings → Basic → App secret → Show**, then copy it to `WHATSAPP_APP_SECRET`.
   The server uses it to check that messages really come from Meta.
4. **Access token:** the token on the API Setup page expires after 24 hours. That's fine for a first test,
   but for daily use make a permanent one:
   - **Business Settings** (business.facebook.com/settings) → **Users → System users → Add** (role: Admin)
   - **Assign assets**: your app (full control) and your WhatsApp account
   - **Generate token** for your app with the permissions `whatsapp_business_messaging` and `whatsapp_business_management`
   - Copy it to `WHATSAPP_TOKEN`
5. **Verify token:** make up any password-like text (e.g. `karena-2026-xyz`) and put it in `WHATSAPP_VERIFY_TOKEN`.

Your `.env` should now include:
```
WHATSAPP_TOKEN=EAAG...
WHATSAPP_PHONE_NUMBER_ID=1234567890
WHATSAPP_APP_SECRET=abc123...
WHATSAPP_VERIFY_TOKEN=karena-2026-xyz
```

## Step 2: Run the server and connect the webhook

1. Start the server where Meta can reach it over **https**. The options are the same as for LINE
   (Cloudflare Tunnel for testing, or a hosting service). See **LINE-SETUP.md → Step 4**.
   ```powershell
   node server.mjs
   ```
   It prints which channels are on, e.g. `LINE webhook: POST /webhook` and `WhatsApp webhook: GET+POST /whatsapp/webhook`.
2. In the Meta app: **WhatsApp → Configuration → Webhook → Edit**
   - **Callback URL:** `https://<your address>/whatsapp/webhook`
   - **Verify token:** the same text as `WHATSAPP_VERIFY_TOKEN`
   - Click **Verify and save**. The server log shows `WhatsApp: webhook verified`.
3. Under **Webhook fields**, **Subscribe** to `messages`.

## Step 3: Test

On **WhatsApp → API Setup**, add your own phone number as a test recipient. Then send a WhatsApp message
to the test number, for example "เมนูมีอะไรบ้าง". You'll see the blue ticks, "typing…", then the answer.

## Step 4: Go live with your real number

1. **WhatsApp → API Setup → Add phone number.** Enter the shop's number and display name ("Karena Curry Rice"),
   then verify it by SMS or a call. Meta reviews the display name.
   - A number already used in the normal WhatsApp or WhatsApp Business **app** can't simply be added.
     Either use a new number, or connect your existing WhatsApp Business app number through Meta's
     **"coexistence"** onboarding, if it's offered for your number. Then staff can keep replying from the
     WhatsApp Business app while the assistant answers too.
2. Copy the new number's **Phone number ID** to `WHATSAPP_PHONE_NUMBER_ID` and restart the server.
3. Complete **Business verification** in Business Settings if Meta asks, to raise your messaging limits.
4. Switch the app to **Live** mode (top bar of the app dashboard).

## Hand-off to staff on WhatsApp

When the assistant hands a customer over (complaint, allergy, reservation, "talk to a person"):
- It tells the customer a staff member will contact them soon, and **stops replying to them for 12 hours** (`HANDOFF_HOURS`).
- Staff get an alert with the customer's **name and WhatsApp number** and a summary:
  - on **LINE** if `STAFF_LINE_ID` is set (recommended, always delivered), and/or
  - on **WhatsApp** if `STAFF_WHATSAPP` is set (e.g. `+66812345678`). WhatsApp only delivers this when that staff
    phone has messaged the business number in the last 24 hours, so LINE is the more reliable option.
- Staff then contact the customer: reply from the WhatsApp Business app (if you use coexistence) or call or message them from the shop phone.
- The ticket is saved in `data/tickets.json` either way.

## Costs

- **Meta:** under Meta's current pricing, replies to a customer within 24 hours of their last message are free.
  The assistant only ever replies, so normal use should cost nothing on Meta's side. Messages you start
  yourself (marketing, reminders) need paid templates. Check Meta's WhatsApp pricing page for your country.
- **Claude:** about ฿0.3–1.5 per customer message, the same as LINE.

## Good to know

- Only text messages are read. Photos, voice notes and stickers get a polite "please type your question".
- The server only accepts webhooks signed with your App secret, and only for your Phone number ID.
- If Meta sends the same message twice, it's answered once.
- `WHATSAPP_API_VERSION` (default `v23.0`) is the Graph API version. If Meta retires it, set a newer one, e.g. `v24.0`.
