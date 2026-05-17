# Privacy Policy

**Standalone Finance Management ("SFM", "the app")**
**Effective date:** 2026-05-16
**Last updated:** 2026-05-16
**Public URL:** https://portfolio.appointer.hu/projects/finance-manager/privacy

## 1. The short version

We do not collect, store, or sell your data. Your bank information lives on your phone and only on your phone. We have no servers that hold your transactions, balances, account numbers, names, or any other personal data.

If you uninstall the app, your data is gone. There is nothing for us to delete on your behalf because we never had it.

## 2. Who we are

SFM is an independent personal-finance application. The data controller for the small set of in-transit traffic described in section 4 is:

- **Operator:** Béla Hajzer
- **Contact:** support@appointer.hu
- **Jurisdiction:** Hungary (EU)

## 3. What data the app handles, and where it lives

| Data | Where it is stored | Who can read it |
|---|---|---|
| Account balances, transactions, categories, recurring detections, income streams, expense profiles, FX snapshots | On your device only, inside the app's encrypted SQLite database | You. Anyone with physical access to your unlocked device. |
| Tink OAuth access token and refresh token | On your device only, inside the platform secure store (iOS Keychain / Android Keystore) | You. |
| Device signing keypair (Ed25519) used to authenticate token-refresh calls to our bridge | On your device only, inside the platform secure store | You. |
| Encrypted backup files you export | The location you choose (iCloud Drive, Google Drive, email, etc.) | Whoever holds the passphrase you set. |

We do **not** maintain any user database. We do **not** assign account identifiers. We do **not** require email, phone number, or any sign-up.

## 4. The one place data crosses our infrastructure

To let you connect a bank through Tink, your device talks to a small stateless Cloudflare Worker we operate ("the bridge"). The bridge does three things:

1. **OAuth callback** — when Tink redirects after you authorise a bank, the bridge exchanges the authorisation code for tokens (this exchange requires a client secret which is why it cannot happen on your device) and 302-redirects the tokens back to your app via a URL fragment.
2. **Token refresh** — when your access token expires, the bridge proxies a signed refresh request to Tink, again because the client secret is needed.
3. **Bank data proxy** — your device's requests to Tink's accounts and transactions endpoints are forwarded through the bridge. This exists because mobile browsers (Expo web) block direct cross-origin calls to Tink. Your bank data flows **through** the bridge in memory for the duration of the HTTP request and is then discarded.

The bridge:

- has no database, no key-value store, no disk;
- writes no logs of token values or response bodies;
- runs on Cloudflare's edge network, which records request-level metrics (timestamps, IP, response size, status code) for abuse prevention.

We treat the bridge as a **data processor**, not a controller. The data we process is limited to whatever is in transit during a single HTTP request, and we retain none of it.

## 5. Third parties your device talks to

- **Tink AB (Sweden, Visa company)** — bank aggregation. Subject to Tink's privacy policy at https://tink.com/legal/. You initiate the relationship explicitly when you tap "Connect bank".
- **Frankfurter (https://www.frankfurter.app)** — open-source exchange-rate service. Your device fetches a daily snapshot of currency rates. The request contains only a base currency code (e.g. "EUR") — no personal information, no transaction data.
- **Cloudflare, Inc.** — operates the network the bridge runs on. Standard request-level metrics as described above.

We do not use analytics, advertising SDKs, crash-reporting services, or any other third-party data processors.

## 6. What we don't do

- We do not run analytics (no Google Analytics, no Firebase, no Mixpanel, no PostHog, no Segment).
- We do not use advertising or attribution SDKs.
- We do not use third-party crash reporting (no Sentry, no Bugsnag, no Crashlytics). Crashes stay on your device.
- We do not sell, rent, or share data with anyone for any purpose.
- We do not profile you, score you, or train machine-learning models on your data.
- We do not place tracking cookies on the landing site.

## 7. Your rights under GDPR

Because we hold no data about you, the standard GDPR requests resolve immediately:

- **Right of access (Art. 15):** we have no data to send you. Your data is on your phone — use the in-app export.
- **Right to rectification (Art. 16):** edit your data inside the app.
- **Right to erasure (Art. 17):** uninstall the app. We have nothing to erase on our side.
- **Right to data portability (Art. 20):** use Settings → Export. You receive an encrypted JSON file that another installation of the app can import.
- **Right to object / restrict (Art. 21, 18):** no processing is happening on our side beyond the in-transit handling in section 4; you can stop it at any time by disconnecting your bank in Settings or uninstalling the app.
- **Right to lodge a complaint:** the supervisory authority for Hungary is the Nemzeti Adatvédelmi és Információszabadság Hatóság (NAIH), https://naih.hu.

For any of the above, you can also email support@appointer.hu and we will respond within 30 days.

## 8. Children

The app is not directed to children under 16 and we do not knowingly process data about them. Because no sign-up data is collected, age verification is not technically meaningful — the app simply has no concept of "user".

## 9. Security

- Bank tokens are stored in the OS-provided secure store (iOS Keychain / Android Keystore).
- The app database lives in the OS-protected app sandbox.
- Token-refresh requests to the bridge are signed by a per-install Ed25519 keypair whose private half never leaves the device.
- App-open is gated by biometric authentication (FaceID / TouchID / fingerprint / device passcode) when your device has it configured.
- The bridge code is open for inspection; deploys are pinned to specific reviewed commits.

No system is perfectly secure. If you discover a security issue, please email support@appointer.hu.

## 10. Data retention

- **On your device:** as long as the app is installed. Removing the app removes the database. Disconnecting a bank in Settings removes the associated tokens.
- **On the bridge:** zero retention. Tokens and bank data exist only for the milliseconds the bridge takes to forward each request.
- **At Cloudflare:** standard edge request metrics (no payload) per Cloudflare's retention schedule.

## 11. International transfers

The bridge runs on Cloudflare's global edge — your traffic may be served by a Cloudflare data centre outside the EU depending on your location. No payload data is stored anywhere; only transient processing happens at the edge. Tink and Frankfurter are EU-based.

## 12. Changes to this policy

If we change the architecture in a way that affects this policy (for example, if a future version offered optional cloud sync), the change will appear in a new app version with an updated "Last updated" date at the top of this document, and material changes will be surfaced in-app on first launch of the affected version.

## 13. Contact

support@appointer.hu
