# Fritz site operations

## Local development

Run `node scripts/dev-server.cjs --port 4173`, then open `http://127.0.0.1:4173/`. Clean routes such as `/about` resolve to `public/about.html`. The server accepts JSON API bodies up to 1 MiB, provides `req.query`, and adapts `res.status(...).json(...)` for the existing Vercel handlers.

Local API requests run without deployment credentials and outbound fetches are blocked. Mutating requests return 403 unless both `FRITZ_ALLOW_LOCAL_MUTATIONS=1` and `FRITZ_LOCAL_TEST_MODE=1` are set. In that mode use only dummy values, including `STRIPE_SECRET_KEY_TEST=sk_test_local_dummy`; live Stripe, GitHub, Blob, NowPayments, Expo, and webhook credentials are rejected.

## Checks and backups

Run `node scripts/check-site.cjs` to validate inline JavaScript syntax, duplicate metadata and canonical links, local asset references, and external script references. CI also runs backend tests matching `tests/backend*.cjs` and Lighthouse thresholds.

Run `node scripts/backup.cjs` to create a source bundle beside the project. Use `node scripts/backup.cjs --dry-run` to inspect its file list or `--output path\to\backup.zip` to choose a destination. The bundle excludes `.git`, `node_modules`, environment files, credential-like filenames, and `data/` customer records. Restore by extracting the zip into a fresh checkout, reviewing the files, then running `npm ci` and the checks above; never restore over a live checkout without a review.

## Deployment

Production deployment is manual through the GitHub Actions **Deploy production** workflow. It requires the protected GitHub `production` environment and its `VERCEL_TOKEN`, `VERCEL_ORG_ID`, and `VERCEL_PROJECT_ID` secrets. Pull requests run quality checks only.
