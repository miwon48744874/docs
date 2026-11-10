<!-- coderabbit-ai-generated:v1 -->

# Flash Lab demo

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:dea94706239ea4af9a093af58175e2a280b407c52abc76903ae183dafd9687ca -->

A separate local application for reviewing simulated blockchain testing requests. Administrators can create products, set USD prices, and control availability. Requests retain the product name and price recorded at submission. The free demo remains free, available, and limited to one request per account. All prices are simulated: the application does not create token balances or transactions, accept payments, send tokens, or connect to an external wallet provider.

<!-- /coderabbit-ai-generated:v1 -->

## Run

Node.js 24 is required. From the repository root, set a unique administrator email and password (at least 12 characters) in your shell and run:

```sh
export FLASH_ADMIN_EMAIL='admin@example.test'
read -rs -p 'Administrator password: ' FLASH_ADMIN_PASSWORD; echo
export FLASH_ADMIN_PASSWORD
node flash-app/server.mjs
```

Open `http://localhost:4173`. The first start creates the administrator when that email has no account. Existing accounts are never promoted or reset by changing environment variables; retain the database and credentials securely. For the current sandbox preview, a generated local administrator credential is stored in `/home/vercel-sandbox/runtime/flash-app-preview.env` with owner-only permissions. Do not use that preview credential for a public deployment.

The application stores accounts, sessions, and requests in `flash-app/data/app.sqlite`; set `FLASH_DATA_DIR` to use another persistent directory. Customer registration cannot grant administrator access. Set `FLASH_SECURE_COOKIE=1` when serving through HTTPS.

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:0f67c4ccd90c66e8c1c5980dc957d07ec4c0c3ccc73478e696179b0bc47d2983 -->

## Render deployment preparation

<!-- coderabbit-ai-generated:v1 -->

<!-- coderabbit-ai-generated-section:v1:ed28092407d38167e868ee4d538972b28f9aecd6ad463e172e1241675a3dc54d -->

The root `render.yaml` configures a free Render web service and requires a separately created Neon PostgreSQL database. The free server can sleep and take time to wake; Neon may suspend access if its free usage limits are reached. Check each provider's current free plan limits before deploying. Render's local filesystem is temporary, so the service refuses to start when its required `DATABASE_URL` is absent.

Create a Neon project on its free plan and enter its TLS-enabled PostgreSQL connection string directly in Render as `DATABASE_URL`; never paste it into chat or commit it. During initial Blueprint creation, enter a new administrator email and a new password of at least 12 characters directly into Render as `FLASH_ADMIN_EMAIL` and `FLASH_ADMIN_PASSWORD`. Do not reuse the sandbox preview credential. Neon starts with a fresh database; local SQLite accounts and orders are not automatically transferred.

Run `npm ci` in `flash-app/` before starting the application locally. When `DATABASE_URL` is omitted locally, the app retains its SQLite behavior.

This configuration is for the testing demo only. It does not add actual payments or token transfers, and public deployment still requires review of authentication, account recovery, rate limiting, and operations.

<!-- /coderabbit-ai-generated:v1 -->

## Verify

<!-- /coderabbit-ai-generated:v1 -->

```sh
node --test flash-app/test.mjs
```

This is a local demonstration, not a production-ready service. Deployment would require a persistent database and a review of authentication, account recovery, rate limiting, security, and operational controls.
