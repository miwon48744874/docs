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

The root `render.yaml` describes a paid Render web service with a 1 GB persistent disk. It builds the `flash-app/` directory using Node 24, enables secure cookies, and stores SQLite data on the disk. A paid service and disk incur charges; verify the current price in Render before creating the service.

During initial Blueprint creation, enter a new administrator email and a new password of at least 12 characters directly into Render for `FLASH_ADMIN_EMAIL` and `FLASH_ADMIN_PASSWORD`. Do not reuse the sandbox preview credential. Render creates a fresh database; local preview accounts and orders do not move automatically.

This configuration is for the testing demo only. It does not add actual payments or token transfers, and public deployment still requires review of authentication, account recovery, rate limiting, and operations.

## Verify

<!-- /coderabbit-ai-generated:v1 -->

```sh
node --test flash-app/test.mjs
```

This is a local demonstration, not a production-ready service. Deployment would require a persistent database and a review of authentication, account recovery, rate limiting, security, and operational controls.
