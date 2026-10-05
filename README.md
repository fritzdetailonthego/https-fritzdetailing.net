# Fritz's Detail on the Go

This repository contains the Fritz mobile detailing site and its Vercel serverless handlers. It is prepared for review and preview work; this checkout does not prove a live production deployment, payment readiness, or access to production Vercel resources.

The public site has 12 HTML pages in `public/`, including home, service, booking, checkout, invoice, admin, and privacy pages. The API includes booking and availability flows, Stripe payment intents and sale logging, optional crypto invoices, admin verification, pricing/gallery/configuration updates, and sales or fee reporting. Customer and operational JSON storage requires exactly one configured private backend: Vercel Blob or a dedicated private GitHub repository. Production never falls back to local disk.

## Local setup

Use Node 24 and install the locked dependencies:

```powershell
npm ci
npm run dev
```

Open `http://127.0.0.1:4173/`. Clean routes such as `/about` resolve to their `.html` files. The local server removes deployment credentials, blocks outbound network access, caps JSON request bodies at 1 MiB, and rejects mutating API requests unless both `FRITZ_ALLOW_LOCAL_MUTATIONS=1` and `FRITZ_LOCAL_TEST_MODE=1` are set. Local mutation testing uses dummy values only.

Useful checks:

```powershell
npm test                 # backend tests
npm run check            # HTML, inline script, metadata, and asset checks
npm run backup -- --dry-run
```

## Environment matrix

| Variable | Used for | Required when |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Live Stripe server operations | Production live card payments |
| `STRIPE_SECRET_KEY_TEST` | Stripe test operations | Test-mode card flows |
| `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PUBLISHABLE_KEY_TEST` | Browser Stripe configuration | Matching live or test card mode |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET_TEST` | Stripe webhook verification | Corresponding webhook flow |
| `ADMIN_PASSWORD` | Admin authentication | Admin API access |
| `MANAGER_SESSION_SECRET` | Manager session tokens | Manager login/session APIs |
| `GITHUB_DATA_TOKEN`, `GITHUB_DATA_REPO` | Private JSON data store | When choosing private GitHub for bookings, orders, sales, and settings |
| `GITHUB_DATA_BRANCH` | Data branch | Optional; defaults to `data-store` |
| `BLOB_READ_WRITE_TOKEN` | Private Vercel Blob storage | When choosing Blob; do not also configure GitHub data storage |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Public config/gallery/pricing writes | Admin content editing |
| `NOWPAYMENTS_API_KEY` | Crypto invoice creation | Crypto payments |
| `EXPO_ACCESS_TOKEN` | Push notifications | Manager notification delivery |
| `COMMISSION_RATE` | Sales fee calculation | Optional; defaults to `0.10` |
| `ALLOW_LEGACY_PUBLIC_BLOB_READS` | Temporary public Blob read fallback | Explicit migration compatibility only |

Keep secrets in Vercel or another secret manager. Do not place them in this repository or local backup bundles. The public Stripe identifier, phone number, and pricing content remain site content; their presence does not demonstrate that secret-backed payments are configured.

## Preview and production handoff

Run the quality workflow on a branch or fork before requesting deployment. The production workflow is manual and requires a protected GitHub `production` environment with `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID`. The original GitHub account available for this handoff is read-only and does not provide production Vercel access, so the safe route is a fork, draft PR, and separate Vercel preview. Do not describe that preview as production.

See [docs/OPERATIONS.md](docs/OPERATIONS.md), [docs/VALIDATION.md](docs/VALIDATION.md), and [docs/STORAGE-MIGRATION.md](docs/STORAGE-MIGRATION.md) for operating, validation, and release-gate details.
