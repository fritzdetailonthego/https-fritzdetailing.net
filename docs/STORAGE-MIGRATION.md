# Runtime storage migration

Production does not write customer records to local disk or fall back to local files after a remote storage failure. Choose exactly one private runtime store. Partial configuration, unverifiable repository privacy, and simultaneous Blob/GitHub data configuration fail closed.

## Private Vercel Blob

Set `BLOB_READ_WRITE_TOKEN` for a store that accepts objects created with `access: "private"`. The installed SDK supports private objects; the destination store and token must also permit private writes. Leave `GITHUB_DATA_REPO` and `GITHUB_DATA_TOKEN` unset.

All new runtime writes and ordinary reads use private access. `ALLOW_LEGACY_PUBLIC_BLOB_READS=true` temporarily permits reading old public objects after private lookup during an operator-controlled migration. Remove it after migration. Errors do not cause a switch to another backend or local disk.

## Private GitHub data repository

Set `GITHUB_DATA_REPO` to a dedicated private `owner/name` repository and `GITHUB_DATA_TOKEN` to a token with contents read/write permission for it. Optionally set `GITHUB_DATA_BRANCH`; the default is `data-store`. Leave `BLOB_READ_WRITE_TOKEN` unset. Initialize the data branch before enabling writes.

The runtime verifies repository metadata through the GitHub API, caching successful privacy verification for five minutes. Public or unverifiable repositories are rejected before customer records are read or written.

`GITHUB_REPO` and `GITHUB_TOKEN` remain the public site-content settings for configuration, gallery and pricing updates. They are deliberately not runtime customer-data credentials. Never assign the public website repository to `GITHUB_DATA_REPO`.

## Existing Blob records

Inventory `orders-data.json`, `bookings-data.json`, `availability-config.json`, `manager-devices.json`, `manager-support-tickets.json`, `sales-data.json`, `fees-data.json`, and `pricing-revisions-data.json`.

1. Pause production writes for migration. Export every record through an authenticated operator session, record hashes and counts, and retain a restricted recovery copy.
2. Verify the destination accepts a private test object. If a current store cannot change a pathname from public to private, use a new private-capable store and token.
3. Copy JSON without changing its content or object pathname. If temporary legacy reads are needed, explicitly enable the migration flag only during this window.
4. Compare counts and hashes, then exercise read-only manager/admin views. Test write/conflict/recovery behavior with isolated fixtures rather than real customer transactions.
5. Remove the migration flag and verify the destination's anonymous URLs deny access.
6. Separately revoke or remove old public objects after the private copy and recovery copy are verified, then check every former public URL anonymously.

Deploying this code or copying records does not revoke old public Blob URLs. They remain exposed until the owner removes or otherwise revokes them. No existing production records were accessed, moved, or deleted during this rework.

## Existing public GitHub data branch

Pause runtime writes. Copy only the current JSON records into a dedicated private repository and initialized data branch, configure the new data credentials, verify privacy checks and record counts, and preserve a restricted recovery copy. Removal of public records and refs requires a separate migration operation. Treat previously published customer records as exposed: rewriting history cannot revoke copies already fetched.

## Production release gate

- Exactly one private data backend is configured and its privacy checks pass.
- Existing records, counts and hashes are reconciled; recovery is documented.
- Every former public Blob URL denies anonymous access.
- The backend mock tests and read-only deployed smoke checks pass.
- Payment configuration matches the intended Stripe account and mode. No real charge, refund, booking, email or push notification was sent for this rework.

The available account cannot administer the original production Vercel project. The separate review deployment contains no payment or customer-data credentials. Production migration remains an owner operation; a draft PR and review deployment do not satisfy this release gate.
