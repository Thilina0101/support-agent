# Karena Curry Rice: Facebook Page (Messenger) assistant setup

The same assistant that answers on LINE and WhatsApp can answer messages sent to your **Facebook Page**:
live menu and prices, shop info, QR order status, and hand-off to staff. One server (`server.mjs`) runs all channels.

```
Customer ──► Messenger (your Facebook Page) ──► server.mjs (/messenger/webhook) ──► Claude ──► reply
                         └── staff can still reply in Meta Business Suite → Inbox; the bot then goes quiet for that customer
```

## What you need
- The shop's **Facebook Page**. You must be an admin of it.
- A **Meta developer app**. If you set up WhatsApp, you can use the **same app**.

## Step 1: Connect the Page to your Meta app

1. Go to https://developers.facebook.com → **My Apps**. Open your app, or **Create App** and choose the
   Messenger / "Engage with customers on Messenger" use case.
2. Add the **Messenger** product if it isn't there yet, then open **Messenger → Messenger API Settings**
   (in newer dashboards: *Use cases → Messenger → Customize*).
3. Under **Generate access tokens**, click **Add Page / Connect**, choose your Page, and approve.
   - Copy the **Page ID** to `MESSENGER_PAGE_ID`.
   - Click **Generate** next to the Page and copy the token to `MESSENGER_PAGE_TOKEN`.
4. **App settings → Basic:**
   - **App ID**: copy it to `MESSENGER_APP_ID`. This lets the bot notice when staff reply by hand.
   - **App secret**: copy it to `MESSENGER_APP_SECRET`. If it's the same app as WhatsApp, the server uses `WHATSAPP_APP_SECRET` automatically.
5. **Verify token:** make up any password-like text and put it in `MESSENGER_VERIFY_TOKEN`.

```
MESSENGER_PAGE_TOKEN=EAAB...
MESSENGER_PAGE_ID=1234567890
MESSENGER_APP_ID=987654321
MESSENGER_APP_SECRET=abc123...
MESSENGER_VERIFY_TOKEN=karena-fb-xyz
```

## Step 2: Run the server and connect the webhook

1. Start the server at an **https** address (Cloudflare Tunnel for testing, or a hosting service; see **LINE-SETUP.md → Step 4**):
   ```powershell
   node server.mjs
   ```
   It should print `Messenger webhook: GET+POST /messenger/webhook`.
2. In **Messenger API Settings → Configure webhooks**:
   - **Callback URL:** `https://<your address>/messenger/webhook`
   - **Verify token:** the same text as `MESSENGER_VERIFY_TOKEN`
   - Click **Verify and save**. The server log shows `Messenger: webhook verified`.
3. Next to your Page, under **Webhook subscriptions**, click **Add subscriptions** and tick:
   **messages**, **messaging_postbacks**, **message_echoes**.

## Step 3: Turn off Facebook's own automatic replies

In **Meta Business Suite → Inbox → Automations** (or Page settings → Messaging), turn **off**
"Instant reply", "Away message" and FAQ automations, so customers don't get two answers.

## Step 4: Test

While the app is in **Development mode**, the bot only answers people who have a role on the app:
you and anyone you add under **App roles → Roles** (admin, developer or tester).
Send your Page a message from your own Facebook account, e.g. "เมนูมีอะไรบ้าง". You'll see "seen", "typing…", then the answer.

## Step 5: Go live for all customers

To answer everyone, Meta must approve your app:
1. Complete **Business verification** in Meta Business Settings (business.facebook.com/settings → Security Center).
2. In the app: **App Review → Permissions and features**. Request **Advanced access** for `pages_messaging`
   (and `pages_manage_metadata` if it's listed as required). Meta asks for a short screen recording
   of the bot answering a message, plus how you use it. Approval usually takes a few days.
3. Add a **Privacy policy URL** in App settings → Basic. A simple page on your website is enough.
4. Switch the app to **Live** mode.

**Token tip:** a token generated on the Messenger settings page can stop working if the admin who made it
changes their password or leaves the Page. For something more permanent, use **Business Settings → System users**
(the same as in WHATSAPP-SETUP.md) and give the system user access to the Page with `pages_messaging`.

## Hand-off to staff on Messenger

- When the assistant hands over (complaint, allergy, reservation, "talk to a person"), it tells the customer
  someone will contact them soon and **stops replying to them for 12 hours**. Staff get an alert on LINE
  (`STAFF_LINE_ID`) and/or WhatsApp (`STAFF_WHATSAPP`).
- Staff answer in **Meta Business Suite → Inbox** (or the Pages Manager app).
- **Automatic quiet mode:** if a staff member replies to any customer by hand from the Inbox, the bot
  notices and stays quiet in that chat for 12 hours. This needs `MESSENGER_APP_ID` and the `message_echoes` subscription.

## Good to know
- Facebook only allows replies within **24 hours** of the customer's last message. The bot always replies immediately, so this isn't a problem.
  For staff, the Inbox handles late replies.
- Only text messages are read. Photos, voice notes and stickers get a polite "please type your question".
- The server only accepts webhooks signed with your App secret, and only for your Page ID.
- Cost: Messenger messages are free. Claude costs about ฿0.3–1.5 per customer message.
- **Instagram DMs** can be added the same way later (Instagram business account linked to the Page).
