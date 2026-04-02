# NyayAI — Full Stack Platform

India's Legal & Tax AI Chatbot Platform — 8 specialised bots, Razorpay payments, 3-day free trial, JWT auth.

---

## Project Structure

```
nyayai-backend/
├── server.js               ← Express app entry point
├── db.js                   ← JSON file database (swap for PostgreSQL in prod)
├── .env.example            ← Copy to .env and fill values
├── config/
│   └── bots.js             ← All 8 bot system prompts + pricing config
├── middleware/
│   └── auth.js             ← JWT auth + access control middleware
├── routes/
│   ├── auth.js             ← Register, Login, Change Password
│   ├── chat.js             ← AI chat endpoint (Claude API)
│   ├── payments.js         ← Razorpay order, verify, webhook
│   └── user.js             ← Profile, stats, admin dashboard
├── public/
│   └── index.html          ← Full frontend (served by Express)
└── data/                   ← Auto-created — JSON files (users, orders, conversations)
    ├── users.json
    ├── orders.json
    └── conversations.json
```

---

## Quick Start (5 minutes)

### 1. Install dependencies
```bash
npm install
```

### 2. Create your .env file
```bash
cp .env.example .env
```

Edit `.env` and fill in:

```env
PORT=3000
JWT_SECRET=change_this_to_a_random_64_char_string

# Get from console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-api03-xxxxx

# Get from dashboard.razorpay.com
RAZORPAY_KEY_ID=rzp_test_xxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx

# Your email for admin access
ADMIN_EMAILS=you@gmail.com
```

### 3. Start the server
```bash
# Development (auto-restart on changes)
npm run dev

# Production
npm start
```

### 4. Open in browser
```
http://localhost:3000
```

That's it. The frontend is served from `/public/index.html`.

---

## API Endpoints

All endpoints are at `http://localhost:3000/api/`

### Auth
| Method | Endpoint | Body | Auth? |
|--------|----------|------|-------|
| POST | `/auth/register` | `{name, email, phone, password}` | No |
| POST | `/auth/login` | `{identifier, password}` | No |
| GET | `/auth/me` | — | Yes |
| POST | `/auth/change-password` | `{currentPassword, newPassword}` | Yes |

### Chat
| Method | Endpoint | Body | Auth? |
|--------|----------|------|-------|
| POST | `/chat/:botKey` | `{messages: [{role, content}]}` | Yes |
| GET | `/chat/history/:botKey` | — | Yes |

**botKey** values: `labour`, `tenant`, `itr`, `freelancer`, `regime`, `fir`, `rera`, `startup`

### Payments
| Method | Endpoint | Body | Auth? |
|--------|----------|------|-------|
| GET | `/payments/plans` | — | No |
| POST | `/payments/create-order` | `{planKey}` | Yes |
| POST | `/payments/verify` | `{razorpayOrderId, razorpayPaymentId, razorpaySignature}` | Yes |
| POST | `/payments/webhook` | Razorpay webhook body | No (signature check) |
| GET | `/payments/history` | — | Yes |

**planKey** values: `all_access`, `annual`, `cat_labour`, `cat_itr`, `cat_freelancer`, etc.

### User
| Method | Endpoint | Auth? |
|--------|----------|-------|
| GET | `/user/profile` | Yes |
| PUT | `/user/profile` | Yes |
| GET | `/user/stats` | Yes |
| GET | `/user/admin/stats` | Yes (admin only) |

---

## Razorpay Setup (Step by Step)

### 1. Create account
Go to [dashboard.razorpay.com](https://dashboard.razorpay.com) → Sign up → Complete KYC

### 2. Get API keys
- Settings → API Keys → Generate Test Key
- Copy `Key ID` and `Key Secret` to `.env`

### 3. Set up webhook (for payment failure recovery)
- Dashboard → Webhooks → Add new webhook
- URL: `https://yourdomain.com/api/payments/webhook`
- Events to select: `payment.captured`, `payment.failed`
- Copy the Webhook Secret → add as `RAZORPAY_WEBHOOK_SECRET` in `.env`

### 4. Test payment
Use these test card details:
- Card: `4111 1111 1111 1111`
- Expiry: Any future date
- CVV: Any 3 digits
- OTP: `1234` (in test mode)

### 5. Go live
- Complete Razorpay KYC
- Replace test keys with live keys in `.env`
- Set `NODE_ENV=production`

---

## Pricing Configuration

Edit `config/bots.js` to change prices:

```js
labour: {
  price: 4900,  // ₹49 in paise (always multiply ₹ by 100)
  ...
}
```

Edit the `PLANS` object for bundle pricing:
```js
all_access: { amount: 34900 }  // ₹349
annual:     { amount: 299900 } // ₹2,999
```

---

## Deploying to Production

### Option A — Railway (Recommended, free tier available)
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway init
railway up

# Set environment variables in Railway dashboard
```

### Option B — Render
1. Push code to GitHub
2. Go to render.com → New Web Service
3. Connect your GitHub repo
4. Set environment variables in Render dashboard
5. Build command: `npm install`
6. Start command: `node server.js`

### Option C — VPS (DigitalOcean / AWS EC2)
```bash
# On your server
git clone your-repo
cd nyayai-backend
npm install
cp .env.example .env
nano .env  # fill in values

# Run with PM2 (keeps alive after SSH disconnect)
npm install -g pm2
pm2 start server.js --name nyayai
pm2 startup  # auto-start on reboot
pm2 save
```

### Option D — Docker
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```

---

## Upgrading to PostgreSQL (Production Database)

The current `db.js` uses JSON files. For 1000+ users, swap to PostgreSQL:

```bash
npm install pg
```

Replace `db.js` with a PostgreSQL version using `pg` pool. The interface is identical — same `Users.create()`, `Users.findById()` etc., just with SQL queries instead.

**Recommended: Supabase** (free PostgreSQL, hosted)
1. Create project at supabase.com
2. Get connection string
3. Add `DATABASE_URL=postgresql://...` to `.env`

---

## Adding Email Notifications

Already configured in `.env`. To activate:

1. Create a Gmail App Password:
   - Google Account → Security → 2-Step Verification → App Passwords
   - Generate password for "Mail"
   
2. Fill `.env`:
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx  # the app password
```

3. Uncomment the nodemailer calls in `routes/auth.js`

---

## Admin Dashboard

Visit: `GET /api/user/admin/stats`

The first registered user is automatically the admin. Or set:
```env
ADMIN_EMAILS=you@gmail.com,partner@gmail.com
```

Returns: total users, pro users, trial users, revenue, recent orders.

---

## Revenue Model

| Plan | Price | Revenue |
|------|-------|---------|
| Per category | ₹49–₹99/mo | If 100 users × avg ₹60 = ₹6,000/mo |
| All Access | ₹349/mo | 100 users = ₹34,900/mo |
| Annual | ₹2,999/yr | Upfront cash, loyal users |
| CA Referral | ₹500–₹5,000/referral | Highest margin |

---

## Support

- Health check: `GET /api/health`
- Logs: `pm2 logs nyayai` (if using PM2)
- Data: check `./data/*.json` files
