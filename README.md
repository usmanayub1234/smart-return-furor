# Smart Return Furor — Shopify Embedded App

A full-featured Shopify embedded app for intelligent return and refund management, deployable to Railway in minutes.

---

## Features

- **Orders & Returns** — Browse all orders, initiate returns with one click
- **Return Analytics** — 90-day return rate, refund amounts, top returned products, reason breakdown
- **Return Rules Engine** — Visual rule builder (allow / deny / review by age, total, tag)
- **Shopify App Bridge** — Fully embedded inside Shopify Admin (no new window)
- **OAuth flow** — Standard Shopify OAuth install with session storage

---

## Deploy to Railway (Permanent Hosting)

### Prerequisites
- A [Shopify Partners](https://partners.shopify.com) account
- A [Railway](https://railway.app) account
- A GitHub account

---

### Step 1 — Create the Shopify App

1. Go to **partners.shopify.com** → Apps → **Create app**
2. Choose **Custom app** (or Public if distributing)
3. Note your **API key** and **API secret**

---

### Step 2 — Push to GitHub

```bash
cd smart-return-furor
git init
git add .
git commit -m "Initial commit — Smart Return Furor"
git remote add origin https://github.com/YOUR_USERNAME/smart-return-furor.git
git push -u origin main
```

---

### Step 3 — Deploy on Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select your `smart-return-furor` repo
3. Railway auto-detects Node.js and runs `npm start`

#### Set Environment Variables in Railway

In your Railway project → **Variables** tab, add:

| Variable | Value |
|---|---|
| `SHOPIFY_API_KEY` | From Partners dashboard |
| `SHOPIFY_API_SECRET` | From Partners dashboard |
| `HOST` | `https://your-app.railway.app` (Railway provides this) |
| `SCOPES` | `read_orders,write_orders,read_products` |
| `NODE_ENV` | `production` |

> **Note:** Railway sets `PORT` automatically — no need to add it.

---

### Step 4 — Configure URLs in Shopify Partners

Back in the Partners dashboard for your app:

| Field | Value |
|---|---|
| **App URL** | `https://your-app.railway.app/` |
| **Allowed redirection URL(s)** | `https://your-app.railway.app/auth/callback` |
| **Embedded app** | ✅ Yes |

---

### Step 5 — Install on Your Store

Visit this URL in your browser:

```
https://your-app.railway.app/auth?shop=YOUR-STORE.myshopify.com
```

After approving the OAuth flow, the app will load inside Shopify Admin at:

```
https://YOUR-STORE.myshopify.com/admin/apps/smart-return-furor
```

---

## Local Development

```bash
cp .env.example .env
# fill in your .env values
npm run dev
```

Use [ngrok](https://ngrok.com) to expose localhost for Shopify OAuth:

```bash
ngrok http 3000
# then set HOST=https://xxxx.ngrok.io in your .env
```

---

## Architecture

```
smart-return-furor/
├── server.js          # Express server + Shopify OAuth + API routes
├── public/
│   └── index.html     # Single-page embedded app (Polaris-style UI)
├── .env.example       # Environment variable template
├── railway.toml       # Railway deployment config
├── Procfile           # Web process declaration
└── package.json       # ESM, scripts, dependencies
```

### API Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Embedded app SPA |
| `GET` | `/auth` | Begin Shopify OAuth |
| `GET` | `/auth/callback` | OAuth callback |
| `GET` | `/api/orders` | Fetch recent orders |
| `POST` | `/api/returns` | Create return/refund |
| `GET` | `/api/analytics` | 90-day return analytics |
| `GET` | `/health` | Health check |

---

## Production Notes

- **Session storage** uses an in-memory Map — replace with Redis or a database for multi-instance deployments
- Railway's free tier sleeps after inactivity; upgrade to a paid plan for always-on service
- Add a `Content-Security-Policy` header including your Railway domain for full Shopify CSP compliance

---

## License

MIT
