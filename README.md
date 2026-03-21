# Fritz's Detail on the Go — Deploy Guide

Your website + payment backend, ready to deploy. No local hosting needed.

## What's in here

```
fritz-deploy/
├── public/
│   └── index.html                 ← Your website (live Stripe key set)
├── api/
│   └── create-payment-intent.js   ← Stripe payment backend
├── package.json
├── vercel.json
└── README.md
```

## Deploy to Vercel (No Local Hosting Needed)

### Option A: GitHub + Vercel (easiest — no terminal)

1. Go to https://github.com — create a free account or log in
2. Click **+** → **New repository** → name it `fritz-detailing` → Create
3. Upload ALL files from this folder to the repo (drag & drop works)
   - Make sure the folder structure stays: public/index.html and api/create-payment-intent.js
4. Go to https://vercel.com — sign up with your GitHub account
5. Click **"Add New Project"** → Import your `fritz-detailing` repo
6. Before clicking Deploy, expand **Environment Variables** and add:
   - Name: `STRIPE_SECRET_KEY`
   - Value: your Stripe secret key (sk_live_... from dashboard.stripe.com/apikeys)
7. Click **Deploy** — done! You get a live URL immediately.

### Option B: Vercel CLI (if you have Node.js)

```bash
npm install -g vercel
cd fritz-deploy
vercel
vercel env add STRIPE_SECRET_KEY
vercel --prod
```

## Connect fritzdetailing.net

1. Vercel dashboard → your project → **Settings** → **Domains**
2. Add `fritzdetailing.net`
3. Change your domain nameservers to:
   - ns1.vercel-dns.com
   - ns2.vercel-dns.com
4. Wait 5-30 min → live at fritzdetailing.net with free SSL!

## Payments are LIVE

Your live Stripe publishable key is already in the site.
Once deployed with your secret key, real charges work immediately.

View all payments at: https://dashboard.stripe.com/payments
