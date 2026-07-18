# H8ED Shop — Payment System

Full payment automation: website checkout → bot confirms → auto-delivers goods.

## Architecture

```
Website (Cloudflare) → Backend API (Railway) → Discord Bot (Railway)
                              ↕
                        Supabase DB
                              ↕
              BlockCypher (BTC/LTC) + Gmail IMAP (Cash App/PayPal)
```

---

## Setup Steps

### 1. Supabase
1. Create a free project at supabase.com
2. Go to SQL Editor and run the contents of `SUPABASE_SCHEMA.sql`
3. Copy your Project URL and service_role key

### 2. Gmail Setup (for Cash App + PayPal emails)
1. Use a dedicated Gmail account for receiving payment notifications
2. Enable 2FA on the account
3. Go to Google Account → Security → App Passwords
4. Generate an app password for "Mail"
5. Use that 16-char password as `GMAIL_PASSWORD`
6. Set up Cash App + PayPal to send payment notifications to this Gmail

### 3. BlockCypher (BTC/LTC)
1. Sign up free at blockcypher.com
2. Get your API token
3. Add as `BLOCKCYPHER_TOKEN`

### 4. Discord Bot
1. Go to discord.dev → New Application → Bot
2. Copy the bot token → `DISCORD_BOT_TOKEN`
3. Copy the Application ID → `DISCORD_CLIENT_ID`
4. Enable: Server Members Intent + Message Content Intent
5. Invite bot to your server with `applications.commands` + `bot` scopes

### 5. Railway Deployment

Deploy TWO services in one Railway project:

**Service 1: Backend**
- Root: `/backend`
- Start: `node server.js`
- Environment variables (from backend/.env.example)

**Service 2: Bot**
- Root: `/bot`  
- Start: `node index.js`
- Environment variables (from bot/.env.example)
- Set `BACKEND_URL` to the internal Railway URL of Service 1

After deploying backend, run in bot directory:
```
node deploy-commands.js
```

### 6. Website Integration
Add to your existing HTML site before `</body>`:
```html
<script src="checkout.js"></script>
```

Update `BACKEND_URL` in `checkout.js` to your Railway backend URL.

To open checkout from your buy button:
```javascript
window._h8edCart = [
  { id: 'product-uuid', name: 'Product Name', price: 10.00, qty: 1 }
];
H8EDCheckout.open(window._h8edCart);
```

---

## Bot Commands

All commands are admin-only.

### /config set
Update any payment setting without restarting:
- `/config set setting:cashapp value:$YourTag`
- `/config set setting:paypal value:you@paypal.com`
- `/config set setting:gmail value:payments@gmail.com`
- `/config set setting:gmailpw value:xxxx xxxx xxxx xxxx`
- `/config set setting:cashfee value:10`
- `/config set setting:cryptodc value:5`
- `/config set setting:logchan value:CHANNEL_ID`

### /config view
See all current settings.

### /stock add
```
/stock add product_id:uuid items:KEY1,KEY2,KEY3
```

### /stock check
```
/stock check product_id:uuid
```

### /order lookup
```
/order lookup order_id:uuid
```

### /order forceconfirm
Manually confirm a payment (for manual verification):
```
/order forceconfirm order_id:uuid
```

---

## Payment Flow

### Cash App / PayPal
1. User checks out → unique note generated (e.g. `redwolf`)
2. User sends payment with note in memo field
3. Gmail watcher detects payment email → parses note + amount
4. Matches pending order → triggers delivery
5. Bot DMs goods to user's Discord

### BTC / LTC
1. User checks out → unique wallet address generated via BlockCypher
2. BlockCypher webhook fires on payment detection
3. After 1 confirmation → triggers delivery
4. Bot DMs goods to user's Discord

---

## Environment Variables

### Backend
| Variable | Description |
|---|---|
| SUPABASE_URL | Supabase project URL |
| SUPABASE_KEY | Supabase service_role key |
| CASHAPP_CASHTAG | Your $cashtag |
| PAYPAL_EMAIL | PayPal receiving email |
| GMAIL_USER | Gmail for payment notifications |
| GMAIL_PASSWORD | Gmail app password |
| BLOCKCYPHER_TOKEN | BlockCypher API token |
| BTC_XPUB | BTC extended public key (optional) |
| LTC_XPUB | LTC extended public key (optional) |
| API_SECRET | Random string for internal auth |
| BACKEND_URL | Public URL of this service |
| CASHAPP_FEE_PERCENT | Default: 10 |
| PAYPAL_FEE_PERCENT | Default: 10 |
| CRYPTO_DISCOUNT_PERCENT | Default: 5 |

### Bot
| Variable | Description |
|---|---|
| DISCORD_BOT_TOKEN | Bot token from discord.dev |
| DISCORD_CLIENT_ID | Application ID from discord.dev |
| DISCORD_GUILD_ID | Your server ID |
| ORDER_LOG_CHANNEL_ID | Channel for order logs |
| BACKEND_URL | Internal Railway URL to backend |
| API_SECRET | Same secret as backend |
| BOT_PORT | Default: 3001 |
