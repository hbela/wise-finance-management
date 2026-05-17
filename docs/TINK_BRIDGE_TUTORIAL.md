# Mobile ↔ Cloudflare Worker ↔ Tink: how the bank connection actually works

A practical walkthrough of the three-piece system that lets a phone in the user's pocket pull
transactions from their bank — without ever exposing a Tink `client_secret`, and without us
running a backend that holds user data.

This is a tutorial, not a spec. If you only want the contract, jump to the bridge contract
section in [CLAUDE.md](../CLAUDE.md). If you want to understand *why* the system looks like it
does, read on.

---

## 1. The three boxes

```
┌────────────────────┐        ┌──────────────────────────┐        ┌────────────────┐
│   Expo / RN app    │        │  Cloudflare Worker       │        │   Tink         │
│   (apps/mobile)    │ ─────▶ │  (apps/bridge)           │ ─────▶ │   api.tink.com │
│                    │        │  workers.dev / appointer │        │                │
│  SQLite ledger     │        │  STATELESS               │        │  OAuth + data  │
│  SecureStore creds │ ◀───── │  • OAuth code exchange   │ ◀───── │                │
│  Biometric gate    │        │  • Token refresh         │        │                │
│                    │        │  • Data proxy (CORS)     │        │                │
└────────────────────┘        └──────────────────────────┘        └────────────────┘
```

Three rules you can quote back at the architecture:

1. **The phone is the system of record.** Accounts, transactions, categories, recurring
   detection results — all live in Expo SQLite. No cloud database. No user accounts.
2. **The bridge holds exactly one secret: `TINK_CLIENT_SECRET`.** Everything else passes
   through unchanged. The bridge never writes anything — no KV, no D1, no logs of token bodies.
3. **The mobile app talks to Tink *only through the bridge*.** Even on native, where there is
   no CORS wall, we route through the worker so there's a single code path for web and native,
   and so the refresh endpoint can sign with the protected client secret.

---

## 2. Why a bridge at all?

Tink's OAuth flow requires you to exchange the authorization code for tokens using your
`client_secret`. You cannot ship that secret in an Expo bundle — anyone can pull the JS out
of an app and read it. So you need *something* server-side that holds the secret.

We picked a Cloudflare Worker because:

- It can be stateless. No database, no migrations, no backups, no GDPR scope.
- It auto-scales and has a free tier that fits this workload.
- CORS-friendly: required for Expo web during development.
- `crypto.subtle` supports Ed25519 verification natively — important for the refresh endpoint.

The legacy alternative we had in the repo was a full Convex + Fastify backend (see the
historical [THE_TINK_LAYER.md](THE_TINK_LAYER.md)). We collapsed it to a Worker in M6 because
the only thing the backend really *had* to do was hold one secret.

---

## 3. Bridge routes at a glance

| Method | Path                                       | Purpose                                              | Auth                  |
|--------|--------------------------------------------|------------------------------------------------------|-----------------------|
| GET    | `/health`                                  | Liveness probe                                       | none                  |
| GET    | `/oauth/tink/callback`                     | Tink redirects here after the user authorizes a bank | none (state param)    |
| POST   | `/oauth/tink/refresh`                      | Refresh an expiring access token                     | Ed25519 signed request|
| GET    | `/tink/data/v2/accounts`                   | Proxy → `api.tink.com/data/v2/accounts`              | Bearer access token   |
| GET    | `/tink/data/v2/transactions`               | Proxy → `api.tink.com/data/v2/transactions`          | Bearer access token   |
| GET    | `/oauth/tink`                              | Universal Link hand-off HTML (fallback page)         | none                  |
| GET    | `/.well-known/apple-app-site-association`  | iOS Universal Link verification                      | none                  |
| GET    | `/.well-known/assetlinks.json`             | Android App Links verification                       | none                  |

Look in [apps/bridge/src/index.ts](../apps/bridge/src/index.ts) to see them mounted.

---

## 4. The OAuth dance, step by step

This is the longest path in the system. Read it once, refer back when something looks weird.

### 4.1 Mobile builds the Tink Link URL

In [apps/mobile/src/integrations/tinkBridge.ts](../apps/mobile/src/integrations/tinkBridge.ts)
`buildTinkSandboxLink`:

1. Generate a random `state` nonce (32 bytes, base64url). On Expo web, append the local
   `window.location.origin/oauth/tink` as a base64url-encoded payload — so the bridge knows
   where to bounce the browser back to.
2. Persist `state` in SecureStore (native) or `localStorage` (web) under
   `tink.sandbox.pendingState`. This is what we'll compare against on return — anything that
   didn't originate on this device should be rejected.
3. Construct the URL:

   ```
   https://link.tink.com/1.0/transactions/connect-accounts
     ?client_id=...
     &redirect_uri=https://standalone-finance-bridge.hajzerbela.workers.dev/oauth/tink/callback
     &response_type=code
     &scope=accounts:read,balances:read,transactions:read,...,credentials:refresh
     &state=<nonce>[.<base64url web_redirect_uri>]
     &market=GB
     &locale=en_US
     &test=true                              # sandbox
     &input_provider=uk-demobank-...         # optional, skips picker
   ```

4. Open it in the system browser (Expo `WebBrowser.openAuthSessionAsync` on native, regular
   navigation on web).

### 4.2 User authorizes the bank inside Tink Link

Tink's flow handles all bank UI, SCA, OTPs, and consent. We never see the credentials. Tink
issues an authorization code and 302-redirects back to our bridge:

```
https://standalone-finance-bridge.hajzerbela.workers.dev/oauth/tink/callback
  ?code=<authorization_code>
  &state=<the same state we sent>
```

### 4.3 Bridge exchanges code for tokens

[apps/bridge/src/routes/oauth.ts](../apps/bridge/src/routes/oauth.ts) `GET /callback`:

1. Validate `code` and `state` are present. (We do *not* verify the state on the bridge —
   that's the device's job. We just have to round-trip it intact.)
2. Call `exchangeTinkAuthorizationCode(env, code)`, which POSTs to Tink's `/oauth/token`
   endpoint with `client_id`, `client_secret`, the code, and `redirect_uri`. Tink replies with
   `{ access_token, refresh_token, expires_in, ... }`.
3. Pick a return target:
   - **Web flow** (state contains a localhost `web_redirect_uri`) → 302 to that localhost URL
     with tokens in the fragment. Only `http://localhost` / `127.0.0.1` is allowed; anything
     else gets ignored to prevent the bridge from being weaponized into an open redirector.
   - **Production native** (`APP_UNIVERSAL_LINK_HOST` is set) → 302 to
     `https://finance.appointer.hu/oauth/tink#access_token=...`. iOS / Android intercept this
     URL via Universal Links / App Links and route it straight to the installed app.
   - **Dev / fallback** (no universal host configured) → 302 to
     `standalone-finance://oauth/tink#access_token=...`. The custom scheme is hijackable in
     theory (any app on the device can claim it) which is exactly why we prefer Universal
     Links in production.

### 4.4 The Universal Link hand-off (production)

When the OS intercepts `https://finance.appointer.hu/oauth/tink#...`, the bridge route never
runs — iOS opens the app directly. But if the user has the app uninstalled, or follows the
link in a browser that doesn't trust the AASA file yet (Apple caches it heavily), the bridge
*does* serve the URL. In that case we render a tiny HTML page from
[apps/bridge/src/routes/oauthHandoff.ts](../apps/bridge/src/routes/oauthHandoff.ts) that does
a `window.location.replace("standalone-finance://oauth/tink#...")` client-side. The fragment
is preserved by the browser across the redirect, and the custom scheme fires the app.

### 4.5 App processes the callback

Back in [tinkBridge.ts](../apps/mobile/src/integrations/tinkBridge.ts)
`handleTinkBridgeCallback`:

1. Parse the URL. Match by *path* (`oauth/tink`), so all three return shapes (custom scheme,
   universal link, localhost) hit the same code path.
2. Pull `state` from the fragment, compare to the pending state we wrote in step 4.1.2. If
   they don't match, reject — except for two narrow recovery cases:
   - The fragment's `access_token` matches what we already have stored → user came back
     through a second tab; idempotent, just return the stored tokens.
   - We're on web and `state` decodes to *this* origin's `/oauth/tink` URL → accept it. (This
     covers double-mount and reload during Expo web dev.)
3. Save `{ accessToken, refreshToken, expiresIn, receivedAt: Date.now() }` to SecureStore
   (native) or `localStorage` (web) under `tink.sandbox.tokens`.

The user is now connected.

---

## 5. Pulling accounts and transactions

This is the boring half — almost the whole interesting part is OAuth.

The mobile client at
[apps/mobile/src/integrations/tinkMobileClient.ts](../apps/mobile/src/integrations/tinkMobileClient.ts)
issues `GET ${bridge}/tink/data/v2/accounts` with `Authorization: Bearer <access_token>`. The
bridge's `createTinkDataProxyRoutes` (see
[apps/bridge/src/routes/tinkProxy.ts](../apps/bridge/src/routes/tinkProxy.ts)):

1. Sets `Access-Control-Allow-Origin: *` (required for Expo web; native ignores it).
2. Reads the `Authorization` header. If missing → 401. The bridge does *not* validate the
   token contents — Tink will reject a bad token and the error flows through.
3. Forwards to `${TINK_API_BASE_URL}/data/v2/accounts`, copying through query string
   parameters (`from`, `to`).
4. Streams the upstream body back verbatim. No logging, no caching, no rewriting.

Transactions work the same way at `/tink/data/v2/transactions`.

### Quirks worth knowing

- **`accounts[].identifiers` is an object, not an array.** Tink v2 returns
  `{ iban: { iban: "GB..." }, bban: { bban: "..." } }`. `extractAccountIdentifiers` tolerates
  both shapes — the array form is kept defensively in case Tink reverts.
- **`amount.value` can be a scaled integer.** Tink sometimes serializes amounts as
  `{ unscaledValue: "12345", scale: "2" }` meaning `123.45`. `parseTinkAmountValue` handles
  both raw numbers and the scaled form.
- **Currencies outside `HUF | EUR | USD | GBP` are silently dropped** during normalization in
  [tinkMobileSync.ts](../apps/mobile/src/integrations/tinkMobileSync.ts). If you add a new
  currency, update `Currency`, `eurRates`, `STATIC_RATES_PER_EUR`, `normalizeCurrency`, and
  `normalizeFxCurrency` — that's the whole list.

---

## 6. Token refresh: the only signed endpoint

Access tokens expire (Tink sandbox gives ~2 hours). The phone has a long-lived refresh token
and uses it to get a fresh access token. The refresh endpoint *speaks to Tink with the
`client_secret`*, so it's the only place where a malicious caller could try to spend our
secret. Hence Ed25519 signatures.

### 6.1 How the phone signs

On first use,
[tinkBridge.ts](../apps/mobile/src/integrations/tinkBridge.ts) `getOrCreateSigningKeyPair`
generates a 32-byte Ed25519 secret key, persists it to SecureStore, and uses it for every
refresh from then on. The public key is *not* registered anywhere — it travels with each
request.

For each refresh request, the phone builds:

```
message  = `${timestamp}\n${method}\n${path}\n${sha256_hex(body)}`
signature = ed25519.sign(message, secret_key)

headers:
  X-Public-Key: base64(public_key)
  X-Timestamp:  <unix seconds>
  X-Signature:  base64(signature)
```

### 6.2 How the bridge verifies

[apps/bridge/src/lib/signature.ts](../apps/bridge/src/lib/signature.ts)
`verifySignedRequest`:

1. Check `Math.abs(now - timestamp) <= SIGNATURE_TIMESTAMP_TOLERANCE_SECONDS` (default 300s).
   This stops replays from being useful for more than five minutes.
2. Re-build the same `${timestamp}\n${method}\n${path}\n${sha256_hex(body)}` message and
   verify the signature against the request's public key, using `crypto.subtle.verify`.
3. On success, the route handler runs and POSTs the refresh token to Tink with the secret.

**What this does and doesn't buy you.** Because the public key is presented per-request, this
isn't authentication — anyone can mint a valid signature. What it *does* prevent is naive
replay (the timestamp window) and accidental misuse by tools that don't know to sign. The
real protection of `client_secret` is that the bridge code never exposes it; the signature
gate is the lock on the door, not the safe inside.

The refresh response body is the same shape as the initial exchange and the phone updates its
stored tokens — see
[tinkBridge.ts](../apps/mobile/src/integrations/tinkBridge.ts) `refreshTinkBridgeTokens`.

### 6.3 When refresh fires

The scheduler in
[apps/mobile/src/services/tokenRefreshScheduler.ts](../apps/mobile/src/services/tokenRefreshScheduler.ts):

- Computes `expiresAtMs = receivedAt + expiresIn * 1000`, schedules a `setTimeout` for
  `expiresAtMs - 60_000` (1 min before expiry).
- Re-evaluates on every `AppState → "active"` transition. This is important: the OAuth deep
  link bringing the app to the foreground triggers a re-check for free, so a freshly stored
  token gets armed immediately.
- On refresh failure, *stops*. Doesn't retry — bad refresh tokens don't get better. The user
  reconnects from Settings; the foreground transition rearms the scheduler.

It's mounted in `<UnlockedAppShell>`, *after* the biometric gate, so we never prompt for a
refresh while the app is locked.

---

## 7. Why CORS is `*`

Sometimes worth defending in code review, so let's say it once: the bridge has nothing to
steal. It holds no tokens, no transactions, no PII. The only meaningful endpoint is
`/oauth/tink/refresh`, which is signature-gated and uses `client_secret` to talk upstream —
none of which can be replayed cross-origin from a browser anyway. Restricting CORS would just
break Expo web during development without buying any real protection.

---

## 8. The web fallback gate

Expo web is real, but only as a *development convenience*. SQLite-on-web requires
`SharedArrayBuffer`, which requires cross-origin isolation (COOP/COEP headers + HTTPS or
localhost). When that isn't available,
[apps/mobile/src/db/webFallbackStore.ts](../apps/mobile/src/db/webFallbackStore.ts)
`isWebFallbackStorageEnabled()` returns true and we fall back to `localStorage`.

Two consequences:
- **PFM heuristics no-op on the fallback path.** Recurring detection, income streams,
  expense profiles — none of those run if you're on plain web. Test PFM behavior on a phone
  or in a cross-origin-isolated context.
- **The gate checks both `SharedArrayBuffer === undefined` *and* `crossOriginIsolated`.**
  Some browsers leak `SharedArrayBuffer` as a global but throw at construction. Checking only
  the identifier is too permissive — the wa-sqlite worker references it directly.

---

## 9. End-to-end: a request's worth of life

To make the whole thing concrete, here's what happens when a user taps "Sync" on the
Dashboard:

```
1. React Query mutation fires `syncTink()` in tinkMobileSync.ts.
2. Read stored tokens from SecureStore. If access token expired more than the lead window
   ago, the scheduler has probably already refreshed; if not, refresh inline.
3. fetch(`${bridge}/tink/data/v2/accounts`, { Authorization: Bearer <token> })
       │
       ▼  worker proxies to api.tink.com, streams back
4. Normalize accounts: extract identifiers, map type to "checking" | "savings" | "card",
   filter unsupported currencies.
5. fetch(`${bridge}/tink/data/v2/transactions?from=...&to=...`, { Authorization: Bearer ... })
       │
       ▼
6. Normalize transactions: map Tink category code → app Category name via
   tinkCategoryMapping.ts, compute `baseCurrencyAmount` via fxRates.ts.
7. Upsert accounts + transactions into Expo SQLite via Drizzle.
8. Run PFM heuristics over the fresh data (recurring detection, income streams, expense
   profiles, balance forecast).
9. React Query invalidates `sqliteFinanceQueryKeys.root` → every screen refetches.
```

If any of those steps fail, the failure is local to the device. The bridge logs nothing. The
worst case is the user sees an error toast and retries.

---

## 10. How-tos

### How to deploy a bridge change

Any edit to `apps/bridge/src/*` needs to be pushed before it's live:

```sh
npm run typecheck -w @standalone-finance/bridge
npm run test -w @standalone-finance/bridge
npm run deploy:bridge
```

For a faster local loop:

```sh
npm run dev -w @standalone-finance/bridge   # wrangler dev on :8787
```

…and point `EXPO_PUBLIC_TINK_BRIDGE_URL` at `http://localhost:8787` while iterating.

### How to rotate the Tink client secret

The secret only lives in Cloudflare. Rotate it without touching the app:

```sh
cd apps/bridge
npx wrangler secret put TINK_CLIENT_SECRET
```

Paste the new value; wrangler stores it encrypted. No client release required.

### How to add a new currency

You need to touch four places — there's no central registry, just a tight cluster:

1. [packages/shared](../packages/shared/) — extend the `Currency` union.
2. [apps/mobile/src/utils/finance.ts](../apps/mobile/src/utils/finance.ts) — add a fallback
   rate to `eurRates`.
3. [apps/mobile/src/integrations/tinkMobileSync.ts](../apps/mobile/src/integrations/tinkMobileSync.ts)
   — let it through `normalizeCurrency`.
4. [apps/mobile/src/services/fxRates.ts](../apps/mobile/src/services/fxRates.ts) — add the
   pair to `STATIC_RATES_PER_EUR` and `normalizeFxCurrency`.

The Frankfurter cache will pick up live rates automatically once the currency is recognized.

### How to enable Universal Links on a fresh deployment

1. Set bridge secrets via `wrangler secret put`:
   - `APP_UNIVERSAL_LINK_HOST=finance.appointer.hu`
   - `IOS_TEAM_ID=<team_id>` (the bundle id stays in `[vars]` so it's auditable)
   - `ANDROID_PACKAGE_NAME=com.elyscom.standalonefinancemanagement`
   - `ANDROID_SHA256_FINGERPRINTS=<colon-separated hex, comma between fingerprints>`
2. In the Cloudflare dashboard, bind `finance.appointer.hu` to the worker as a custom domain.
   The AASA file *must* be served from the deep-link host, not from `*.workers.dev`.
3. `npm run deploy:bridge`.
4. Smoke-test both well-known endpoints (commands in CLAUDE.md "Sandbox & smoke checks").
5. Reinstall the iOS dev build so AASA is fetched fresh. Apple caches aggressively — expect
   up to ~24 h on production installs to fully propagate.

### How to debug "Tink authorization state did not match this device"

That message comes from
[handleTinkBridgeCallback](../apps/mobile/src/integrations/tinkBridge.ts) and almost always
means one of:

- The user started the flow on one device and ended on another (e.g., scanned the redirect
  on a different phone). The pending state lives on-device only.
- SecureStore was cleared between the open and the return (rare; app reinstall, "Clear
  data").
- On web, the dev server reloaded mid-flow and lost `localStorage` somehow.

Recovery: tell the user to start over from Settings → Connect bank.

### How to verify the bridge end-to-end without a bank

```sh
# Liveness
curl --ssl-no-revoke -i https://standalone-finance-bridge.hajzerbela.workers.dev/health

# CORS + 401 (proves the proxy runs and rejects missing auth)
curl --ssl-no-revoke -i https://standalone-finance-bridge.hajzerbela.workers.dev/tink/data/v2/accounts
```

The Windows `--ssl-no-revoke` is because schannel can't always reach Cloudflare's CRL — it's
not a security shortcut.

### How to add a brand new bridge route

1. Add the handler under `apps/bridge/src/routes/`, exported as a `createXxxRoutes()`
   function that returns a `Hono<{ Bindings: Env }>`.
2. Mount it in [apps/bridge/src/index.ts](../apps/bridge/src/index.ts) with
   `app.route("/your-prefix", createYourRoutes())`.
3. If it talks to a new upstream that requires a secret, extend
   [apps/bridge/src/env.ts](../apps/bridge/src/env.ts) and provision via
   `wrangler secret put`.
4. Write a vitest smoke test under `apps/bridge/test/`. Use the Cloudflare Workers pool — the
   existing tests are good copy-paste templates.

---

## 11. What this design deliberately doesn't do

A few "why isn't there X?" answers, because the absence is the point:

- **No server-side user accounts.** Biometric on-device is the entire auth model. Losing the
  phone means losing the data, which is why the Settings export exists.
- **No cloud sync.** Two devices = two ledgers. There is no merge protocol; we'd need an
  account system for that.
- **No analytics on the bridge.** It has no telemetry pipeline. Crash and analytics live in
  the mobile app (Sentry was considered for M7 and dropped — see memory).
- **No retry / fallback provider.** Tink is the only aggregator wired up; TrueLayer was
  designed for in the historical doc but never built. Recovery is "tell the user to reconnect."

These are deliberate scope choices. Adding any one of them turns this from a stateless proxy
into a real backend — that's the line.

---

## 12. Where to look next

- **Configuration:** [CLAUDE.md](../CLAUDE.md) — environment variables, smoke checks, ops
  notes.
- **Sandbox testing:** [TINK_SANDBOX_TEST_SCENARIOS.md](TINK_SANDBOX_TEST_SCENARIOS.md) and
  [TINK_TESTING.md](TINK_TESTING.md).
- **An incident worth reading:**
  [TINK_CONNECTION_ISSUE_REPORT.md](TINK_CONNECTION_ISSUE_REPORT.md) — what we actually hit in
  production and how the fixes worked their way back into this design.
- **Historical context:** [THE_TINK_LAYER.md](THE_TINK_LAYER.md) — the original
  Convex+Fastify+Wise+TrueLayer design, kept for the "why we collapsed it" trail.
