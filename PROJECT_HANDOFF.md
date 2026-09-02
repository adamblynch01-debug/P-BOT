# ZEROPOINT / P-BOT Project Handoff

Last updated: 2026-09-01 (America/Chicago) — stopping point after todo review

This file is the durable handoff for continuing work in a new thread after a
computer failure or context reset. Do not put secrets, tokens, passwords, or
`.env` values in this file.

## Project locations

- Website source: `C:\Users\VENOM-NODE\nullpoint-index.html`
- Backend repository: `C:\Users\VENOM-NODE\Documents\P-BOT-main\P-BOT-main\backend`
- Backend repo root: `C:\Users\VENOM-NODE\Documents\P-BOT-main\P-BOT-main`
- Production website: `/var/www/html/index.html`
- Production backend: `/var/www/P-BOT/backend`
- Production host: `root@74.0.42.63`
- Production website domain: `https://nullpoint.top`

Use `C:\Users\VENOM-NODE\.ssh\transition_ed25519` for the existing deployment
SSH connection. Never print or expose its contents.

## Crash-recovery record and recovered request

The PC shutdown did not lose the previous prompt or implementation work. The
full request is preserved in the local Codex history/session records, including
the five referenced screenshots. The durable implementation record is this
file. The recovered request was:

- Correct Software Tracker entries that incorrectly said `LIFETIME KEY`; show
  the actual purchased subscription term instead.
- Show the purchase date immediately, while activation remains unknown until
  the customer explicitly activates the key.
- Put newer accounts and software keys at the top of Vault lists.
- Make the Vault tab open faster and stop the site from making duplicate or
  blocking data loads.
- Make generated-account `VIEW IN VAULT` work, show the generated result in a
  popup, and clear the stale bottom-page `GENERATING ...` message after the
  result is already displayed.
- Improve the general slow website behavior.
- Generator pricing: EUR 1 per individual account, EUR 1 per individual phone
  number, EUR 15/month for 30 accounts, EUR 15/month for 30 phone numbers, or
  EUR 25/month for both (30 accounts + 30 phone numbers = 60 typed uses).
- Keep the website generator and Discord bot inventory synchronized through
  shared stock so an account cannot be reused or delivered twice.
- Add an admin option to grant a user a one-time free account use, phone use,
  or both.
- Add a private role-gated `Movie Night` tab where approved users can browse
  live TV, movies, and series and optionally stream to Discord; keep a playback
  log showing what played and who played it. Use Luminary's IPTV credentials,
  playlist/M3U backup, and control API without exposing provider credentials to
  website users.

The previous agent completed the code, staged a deployment, and this recovery
turn completed production activation and verification. No reset/clean operation
was run against the intentionally dirty backend worktree.

## Current generator pricing and allowances

- EUR 1: one account generation.
- EUR 1: one phone-number generation.
- EUR 15/month: 30 account generations per month.
- EUR 15/month: 30 phone-number generations per month.
- EUR 25/month: 30 account generations plus 30 phone-number generations per
  month (60 total uses).

These are typed entitlements. An account credit/plan cannot be spent on a
phone number, and vice versa. Existing historic combined credits/plans still
work as a shared pool so no prior purchase is lost.

## Historical pricing/allowance decision (superseded — do not restore)

The live GEN MEMBER plan is €15/month for 30 days and 30 **combined** uses.
Account generations and SMS number purchases consume the same pool. A single
SMS number does not consume extra uses when requesting another code; resends
are unlimited while that number remains active.

It is intentionally **not** 30 accounts plus 30 numbers. If the owner later
confirms separate quotas, update the backend constants, access calculations,
pricing copy, purchase descriptions, and tests together.

## Implemented, validated, and deployed to production

### Software Tracker and Vault

- Tracker records now derive and display the purchased tier duration instead of
  treating every key as Lifetime.
- Tracker records show the purchase date. Activation remains "Not activated"
  until the customer explicitly activates the key; only then is an activation
  date shown.
- Account and software-key Vault lists sort newest first.
- Vault Discord membership checks use a short shared cache for the access
  precheck, load, save, and per-game update paths. This removes duplicate
  Discord API calls when opening the tab.
- Generated-account results open in a popup, clear their loading state, and
  the View in Vault action passes the current authenticated session correctly.

### Shared generator inventory and access

- Website and Discord generator account claims use the same Postgres `stock`
  rows with atomic `DELETE ... FOR UPDATE SKIP LOCKED` claims. One account
  cannot be delivered twice across the two platforms.
- The admin Generator panel can grant one account use, one phone-number use,
  or both to a user as typed one-time credits.
- Applied in production:
  `generator_access_v3_typed_plans.sql` and `generator_unified_stock.sql`.

### Movie Night

- The private, role-gated Movie Night website tab, admin role configuration,
  catalog/search UI, and playback audit log are implemented.
- The P-BOT endpoint deliberately proxies Luminary: users receive catalog
  metadata only; playlist/provider credentials and stream URLs stay private
  in Luminary.
- Applied in production: `movie_night.sql` (feature remains disabled until the
  private Luminary control link is explicitly configured).
- Luminary's control API was added locally, but the `streaming-bot` is stopped
  in production and must not be deployed or started without explicit approval.
- Before enabling Movie Night, configure matching private
  `MOVIE_NIGHT_CONTROL_TOKEN` values plus the P-BOT control URL/token. Never
  write those values in this handoff file.

### Validation completed

- Node syntax checks passed for Generator, Vault, Delivery, Movie Night,
  server, and Luminary control files.
- All 25 inline website scripts parse successfully.
- `test_2fa_server_side.js`: 26 passed.
- `test_delivery_game_label.js`: 29 passed.

## Previously completed and deployed

### Generator UX

- Visible pricing cards and access status.
- Clicking any generator category now opens an explicit confirmation dialog;
  the API is not called until “GENERATE ACCOUNT” is confirmed.
- Generated accounts open in a centered result popup instead of appearing only
  at the bottom of the long generator page.
- Result popup retains copy and Game Vault actions.
- “VIEW IN VAULT” / “OPEN GAME VAULT” now synchronizes the live
  `ghostAuthToken` into the Vault session instead of relying on a stale
  `SESSION_TOKEN`.
- Existing account generation remains server-authoritative and saves the
  generated account into `vault_data` transactionally.

### Free website 2FA generator

- Added a free “2FA CODE GENERATOR” section in the website generator UI.
- UI function: `generateGenerator2FA()`.
- Backend endpoint: `POST /api/generator/2fa`.
- Requires normal website authentication, but does not require GEN MEMBER,
  consume generator credits, or decrement the monthly pool.
- Accepts a base32 TOTP secret, generates the current RFC 6238 6-digit code,
  returns remaining validity seconds, and never persists/logs the secret.
- Rate limited to 60 requests per IP per 15 minutes.
- Shared TOTP helper is in `backend/utils/totp.js` (`generateTOTP`).
- Behavior matches the Discord `/postgensteam` “Get 2FA Code” action: current
  30-second TOTP code, with no account secret echoed back.

### Purchased products / Software Tracker

- `backend/utils/delivery.js` now synchronizes successfully delivered license
  keys into the customer’s `vault_data.sw` Software Tracker records.
- Entries include product, tier duration, order/invoice number, date, payment
  method, price, key, source, and purchased/website tags.
- Synchronization is idempotent by order plus key, so retries do not duplicate
  tracker entries.
- `GET /api/vault` performs a best-effort backfill for the customer’s previous
  delivered orders, so older purchases can appear without rebuying.
- Delivery sync failures do not hide or erase the paid order; they are logged
  and alerted for staff.

### Other previously completed website/admin work

- Generator access popup for users without access.
- Admin Updates/news publishing tab.
- Admin Product Guide/instructions editor.
- Restyled Downloads Manager and Status Manager cards.
- Users tab loads All Users correctly.
- 150 clearly marked fake test accounts seeded live (10 per generator type,
  `example.invalid` addresses/test credentials).
- Discord role helper/role creation and assignment features deployed.
- Vault category support expanded and Vault writes use row locking.
- `getDiscordMemberRoles` compatibility issue was addressed by the Discord
  access helper changes.

## Database/deployment changes

- Generator access migration was applied in production:
  `backend/migrations/generator_access_v2.sql`.
- This widened generator user IDs to BIGINT and added missing `sms_orders`
  lifecycle columns (`completed`, `cancelled`, `channel_id`).
- Production backup created on 2026-08-31 at:
  `/var/backups/nullpoint/20260831-150558/` (website, generator route,
  TOTP helper, delivery helper; a later backup also contains Vault/delivery
  updates).
- Only `pbot-backend` was restarted. `superbot` stayed online and
  `streaming-bot` stayed stopped as requested.

## Current production verification

- `https://nullpoint.top/health` returns HTTP 200 and
  `{"status":"ok","store":"ZEROPOINT"}`.
- `https://nullpoint.top/api/updates` returns HTTP 200.
- Production `pbot-backend` status: online.
- Production `streaming-bot` status: stopped.
- Production `superbot` status: online.
- Final deployment completed on 2026-09-01: only `pbot-backend` was stopped
  briefly for migrations and then restarted. `superbot` was never stopped or
  modified; `streaming-bot` remains stopped.
- Deployment backup: `/var/backups/nullpoint/20260831-184919/`.
- Deployment staging directory (temporary):
  `/tmp/nullpoint-deploy-20260831-184919/`.
- Local and production SHA-256 hashes matched for `index.html`, `server.js`,
  Generator/Vault/Movie Night routes, and delivery/access utilities.
- Shared `stock` inventory after migration: 345 existing Discord rows and 142
  imported unclaimed website rows. Claims are atomic and cross-platform.
- Unauthenticated Movie Night access correctly returns `Not logged in`; the
  feature is intentionally disabled until role policy and the private Luminary
  control connection are configured.
- Backend syntax checks passed for generator, Vault, delivery, and TOTP files.
- All 24 inline website scripts compile successfully with Node VM parsing.
- `test_2fa_server_side.js`: 26 passed, 0 failed.
- `test_delivery_game_label.js`: 29 passed, 0 failed.
- Two older storefront tests could not run because their harness references a
  missing historical path:
  `C:\Users\VENOM-NODE\Documents\GHOSTEXE FINAL\UHSERVICES OG\index.html`.

## Important files/functions

- Generator frontend: `nullpoint-index.html`, around lines 36900–37750.
- `requestAccountGeneration`, `showGeneratorConfirm`,
  `confirmAccountGeneration`, `showGeneratorResultPopup`,
  `generateGenerator2FA`, `saveGeneratedToVault`.
- Generator backend: `backend/routes/generator.js`.
- TOTP helper: `backend/utils/totp.js`.
- Delivery/tracker sync: `backend/utils/delivery.js`.
- Vault API/backfill: `backend/routes/vault.js`.
- Order checkout: `backend/routes/orders.js`.
- Discord reference implementation: `Documents/NULLPOINT_LATEST/bots/SUPERBOT/index.js`,
  `/postgensteam`, `gensteam_get_2fa`, and `gensteam_2fa_modal` sections.

## Working-tree/deployment cautions

- The backend Git worktree intentionally contains many existing modified and
  untracked files from the earlier recovery/development work. Preserve them;
  do not reset or clean the tree blindly.
- Use `apply_patch` for edits.
- Back up remote files before deployment.
- Re-run Node syntax checks and all 24 inline website script checks before a
  future deployment.
- Restart only `pbot-backend`; leave `streaming-bot` stopped unless explicitly
  requested.
- Never expose tokens, API keys, passwords, SSH private keys, or `.env` values.

## Follow-up verification (2026-09-02)

- Re-ran `test_auth_hardening.js` (49 assertions), `test_2fa_server_side.js`
  (26 passed), and `test_delivery_game_label.js` (29 passed); all passed.
- Re-ran Node syntax checks for Generator, Movie Night, Chat, and server routes.
  All 25 inline scripts in `nullpoint-index.html` parse successfully.
- Hardened browser Movie Night playback: native `<video>` requests cannot send
  the storefront bearer header, so `/api/movie-night/stream/:token` now
  authenticates the short-lived, user-bound stream capability and re-checks
  the owner's current Discord role before proxying MP4/HLS data. Expired token
  entries are pruned as new playlist/segment tokens are issued.
- Movie Night admin settings now distinguish browser IPTV configuration from
  the optional Luminary/Discord control fallback, so the admin panel reports
  the correct readiness state.
- Generated-account COPY preserves the exact four-field order (Steam username,
  Steam password, Email, Email password), retaining empty slots for legacy
  rows instead of shifting fields.
- Exported the generated-result copy handlers to `window`, so the inline COPY
  button can invoke them reliably after the Vault IIFE initializes.
- Browser Movie Night playback now returns an explicit `stream_type` (`hls` or
  `file`). The player uses that value because the secure proxy URL has no
  provider filename/extension to inspect.
- Added and passed the offline `backend/test_movie_night_stream.js` contract
  test. It exercises a native media request with no bearer header, verifies the
  short-lived capability is sufficient, and confirms HLS child URLs are
  rewritten through the proxy.
- Xtream live catalog links now default to the browser-compatible `.m3u8`
  variant (override with the private `MOVIE_NIGHT_XTREAM_LIVE_EXTENSION`
  environment variable if the provider requires another extension).
- Read-only production audit of the `Virus` account found web user ID `43`,
  created `2026-08-31T18:49:36Z`, with no email/password, Discord ID
  `1374069014157988001`, and `discord_verified=true`. It had no sessions,
  orders, generator logs, or Vault row, and the Discord ID is no longer in the
  guild. The row is already quarantined (`banned=true`) from the prior audit;
  no deletion or restoration was performed.
- Production health and public updates endpoints still return HTTP 200. The
  new local Movie Night stream/UI changes have not been deployed yet; perform
  browser playback checks, backup, and a controlled `pbot-backend` restart
  before deploying. Keep `superbot` online and `streaming-bot` stopped.
- A fresh remote pre-change backup for this follow-up was created at
  `/var/backups/nullpoint/20260901-224225-todo2-followup/` (production
  `index.html` and `movieNight.js`). No production files were changed and no
  process was restarted.

## Suggested next steps

1. Verify health and the generator/Vault flows with a real linked user.
2. Verify a delivered key shows its actual duration, purchase date, and "Not
   activated" until activated.
3. Verify the website and Discord cannot claim the same shared stock row.
4. Configure and browser-test Movie Night only after explicit approval to
   deploy/start Luminary's streaming bot and to set its private control token.

## New-thread continuation state (2026-09-01 stopping point)

The latest user todo was re-read from `C:\Users\VENOM-NODE\Documents\todo.txt`.
It still reports these unresolved symptoms/requests: clicking generated-account
`VIEW IN VAULT` appears to do nothing until closing/reopening/refreshing; account
credential output must match Discord order exactly `(Steam username, Steam
password, Email, Email password)`; Discord stock must all be present on the
website (including roughly 300+ phone-verified and 100+ standard Steam rows);
one Discord bot command is failing; generator monthly counters must show typed
remaining uses; remove the permanent generator access/pricing section but keep
pricing only inside the `GENERATOR ACCESS REQUIRED` popup; Movie Night role/setup
still needs owner clarification/configuration; investigate and lock down any
website users not linked to Discord; remove only the public Features and FAQ
navigation tabs; add a store-focused AI live chat; fix currency switching so all
prices update; improve speed and browser/dev-tools security.

Work performed in this continuation was read-only diagnosis plus validation; no
new source edits, deployment, restart, database mutation, or user deletion was
made. The local source remains intentionally dirty with the existing backend
changes listed by `git -C C:\Users\VENOM-NODE\Documents\P-BOT-main\P-BOT-main status
--short`; preserve them and do not reset/clean.

## Final verification and deployment (2026-09-01)

- Re-ran the core offline suites: `test_auth_hardening.js` (49 assertions),
  `test_2fa_server_side.js` (26 passed), and `test_delivery_game_label.js`
  (29 passed). All 115 backend JavaScript files and all 24 inline website
  scripts pass Node syntax checks.
- Corrected the shared-stock parser so legacy `user:password` rows do not
  invent an Email field; true Discord-format rows remain Steam username,
  Steam password, Email, Email password. Deployed
  `backend/routes/generator.js` with a pre-change copy in
  `/var/backups/nullpoint/20260901-final/generator.js.pre`.
- Deployed the validated `nullpoint-index.html` and `backend/routes/auth.js`.
  Pre-change copies are in `/var/backups/nullpoint/20260901-final/`.
  Local/production SHA-256 hashes match for all three deployed files.
- Restarted only `pbot-backend`. Final PM2 state: `pbot-backend` online,
  `superbot` online, `streaming-bot` stopped. `https://nullpoint.top/health`
  returns HTTP 200 with `{"status":"ok","store":"ZEROPOINT"}`.
- The historical `test_google_oauth.js` still expects standalone Google-only
  account creation and therefore reports failures by design; production now
  intentionally requires an existing verified Discord link/current guild
  membership for Google login. `test_discord_claim.js` remains un-runnable
  because its harness references the missing historical storefront path.

## Follow-up completed (2026-09-01 continuation)

- Re-verified and deployed the current website, backend server, Generator/Vault/
  Chat routes, auth helper, and `stock.email_password` migration. A remote
  backup is stored at `/var/backups/nullpoint/20260901-continue2/`.
- Applied `ALTER TABLE stock ADD COLUMN IF NOT EXISTS email_password TEXT`.
- Restarted only `pbot-backend`; health is HTTP 200. `superbot` was later
  restarted in a controlled operation after deploying the `postsmsgen` alias;
  it registered both `post-smsgen` and `postsmsgen`. `streaming-bot` remains
  stopped.
- Generator stock parsing now follows Discord's exact order:
  Steam username, Steam password, Email, Email password. A trailing phone
  suffix is treated as metadata, and plain `user:password` rows do not invent
  an email value.
- Password/email signup is now disabled at the backend (`discord_signup_required`)
  and the form redirects to Discord OAuth; this closes the path that created
  unlinked member rows in the first place. A no-op signup probe returns 403.
- The permanent Generator dashboard access/pricing status is hidden; pricing
  remains in the `GENERATOR ACCESS REQUIRED` dialog. Public Features/FAQ nav
  links are absent from the current website source.
- `VIEW IN VAULT` now forces the outer Vault overlay active/visible before the
  lazy Vault bridge refreshes, preventing the result from appearing only after
  closing/reopening the tab.
- Audited all linked Discord IDs. Five legacy password-only website rows had no
  Discord link and no vault/generator records (IDs 18, 24, 29, 30, 36;
  usernames Howtoai, Ebk_Fizzle, NayDino, TESTA1234, xSpike123). They were
  quarantined by setting `banned=true`; the pre-change audit is saved as
  `unlinked-audit.json`. Restore only after owner confirmation and a verified
  Discord link.
- Validation: 25 inline website scripts parse; backend route syntax checks pass;
  `test_2fa_server_side.js` (26 passed), `test_delivery_game_label.js`
  (29 passed), and `test_auth_hardening.js` (49 assertions) pass. The older
  `test_discord_claim.js` harness still references a missing historical website
  path and cannot run.

Validation completed during this continuation:

- All 24 inline `<script>...</script>` blocks in `nullpoint-index.html` parse with
  `node --check --input-type=commonjs` (external `src` script excluded).
- Existing backend checks from the previous thread remain green:
  `node --check backend/routes/generator.js`, `test_2fa_server_side.js` (26
  passed), and `test_delivery_game_label.js` (29 passed).

Important Vault diagnosis for the next thread:

- `nullpoint-index.html` has the outer storefront `openSection('vault')` at
  approximately line 20168, and a later Vault IIFE wraps/replaces
  `window.openSection` around line 34510. The IIFE lazily calls `initVault()`
  after 200 ms and exposes `window._vaultInitPromise`.
- The generator modal is `#vault-generator-modal` (around line 9040), and the
  generated result button calls `saveGeneratedToVault()` (around line 37462).
- Current `saveGeneratedToVault()` removes `#generatorResultModal`, closes the
  generator, waits for `_vaultInitPromise` (or calls `openSection('vault')`),
  calls inner `switchApp('vault')`, paints, then forces
  `loadAllDataFromBackend(true)`. This is syntactically valid, but the reported
  behavior likely persists because `switchApp()` only changes inner app panels
  and does not guarantee the outer `#overlay-vault` is active/visible. Next
  thread should browser-test and likely explicitly call the outer section open
  path before/while switching the inner app, then await the backend refresh.
- `closeVaultGenerator()` hides the generator and clears `#gen-output`; the
  result modal is nested inside the generator modal. Ensure the result is not
  removed before the click handler has captured state, and verify the outer
  overlay is visible after the handoff.
- Vault backend is `backend/routes/vault.js`: `GET /api/vault` and POST/PATCH
  require `requireAuth` plus `requireCurrentDiscordMember`. Generated accounts
  are saved transactionally by `saveGeneratedVaultAccount()` in
  `backend/routes/generator.js` before the `/api/generator/account` response.

Credential-order diagnosis:

- `displayGeneratedAccount()` currently renders labels in the requested order:
  Steam username/username, password, email, email password, then optional
  additional info.
- `copyLatestGeneratedAccount()` currently joins
  `[account.username, account.password, account.email, account.emailPassword]`
  with newlines, which is the requested order. Backend parsing is in
  `parseSharedStockAccount()` near the top of `backend/routes/generator.js` and
  supports structured columns plus legacy `account_data`; compare directly with
  `Documents\NULLPOINT_LATEST\bots\SUPERBOT\index.js` delivery formatting before
  changing it.

Generator quota/currency/navigation notes:

- Generator access status UI is `updateGeneratorAccessStatus()` around line
  37172 and already displays typed `accountRemaining`/`phoneRemaining` for
  `planType` account/phone/both. Backend constants are in generator.js:
  `MONTHLY_ACCOUNT_PRICE_CENTS=1500`, `MONTHLY_PHONE_PRICE_CENTS=1500`,
  `MONTHLY_BOTH_PRICE_CENTS=2500`, `MONTHLY_USE_LIMIT=30`.
- The permanent dashboard pricing section is rendered by
  `ensureGeneratorDashboard()` around line 37046; the access-required popup is
  `showPaymentGate()` around line 37213. The todo asks to remove the former
  pricing/access display while preserving the latter.
- Currency audit still has suspicious hardcoded paths, especially
  `updateDropdownPrice()` around line 21275 and legacy Vault/admin pricing.
- Public Features/FAQ navigation must be removed without deleting product
  feature arrays or Guide FAQ content. Search nav markup near the top and keep
  `gxFaqToggle()`/guide content if still used.

Safety/operations for the next thread:

- Never expose credentials, tokens, API keys, `.env`, or SSH key contents.
- Do not delete production users blindly. First identify users lacking
  `discord_id`/verified linkage and compare against current guild membership;
  prefer disable/quarantine or an owner-confirmed migration before deletion.
- Do not start `streaming-bot`; keep it stopped unless the owner explicitly
  approves private Luminary control configuration and deployment.
- Deploy only after browser/functional verification, back up remote files first,
  and restart only `pbot-backend` by default. `superbot` should remain online.

- Final auth cleanup deployment: removed unreachable standalone Google account-creation branch after enforcing Discord-linked Google login. Backup: /var/backups/nullpoint/20260901-final/auth.js.pre-cleanup. Production auth SHA-256 now matches local: 25c8a2b71e40910f5f21f34404a4aed6b5c2ed3608358dc20783ed9033cc6a53.

## Transition stop — 2026-09-01 continuation

- Recovery validation completed locally: 116 project backend JavaScript files and all 24 inline website scripts parse successfully; auth hardening (49), server-side 2FA (26), delivery labels (29), and Movie Night stream contract tests pass.
- A local recovery commit was created: `0e47c1d Recover generator vault movie night and access changes`.
- `git push origin main` was rejected because GitHub `origin/main` advanced to `f681662` and contains 23 commits not present in this checkout (including later generator/SMS fixes).
- A merge was attempted only locally, exposed add/add/content conflicts in `backend/routes/generator.js`, `backend/server.js`, and `backend/utils/discordAccess.js`, and was immediately aborted. No force-push was performed.
- Current local branch is clean at `0e47c1d`, ahead of the old base by one commit and behind current `origin/main` by 23 commits. Production was not changed in this continuation; health remains HTTP 200, `pbot-backend` and `superbot` are online, and `streaming-bot` is stopped.
- Production still has older copies of `index.html`, `backend/routes/generator.js`, `backend/routes/movieNight.js`, and `backend/routes/chat.js`; their local SHA-256 hashes differ. The local website is `C:\Users\VENOM-NODE\nullpoint-index.html` and is outside this Git repository.
- Next thread: merge `origin/main` into the recovery commit carefully, preserving the remote generator/SMS fixes and the local Vault/access/Movie Night/chat hardening; rerun all validation; then back up and deploy only after explicit approval. Do not force-push, reset, clean, start `streaming-bot`, or expose secrets.

## Merge continuation — 2026-09-01

- Merged the 23-commit `origin/main` update locally as `a5e6be3` (`Merge remote-tracking branch 'origin/main'`).
- Kept the recovery versions of `backend/routes/generator.js`, `backend/server.js`, and `backend/utils/discordAccess.js` during conflict resolution because they contain the authenticated generator, Vault/Movie Night/chat mounts, and Discord-role helpers. The recovery generator already includes the upstream Axios/USA catalog/channel-id SMS fixes.
- The local branch is clean and is three commits ahead of `origin/main`; no force-push was attempted and production was not changed.
- Validation passed: all 116 backend JavaScript files parse; all 24 inline scripts in `nullpoint-index.html` parse; `test_auth_hardening.js` (49 assertions), `test_2fa_server_side.js` (26), `test_delivery_game_label.js` (29), and `backend/test_movie_night_stream.js` pass.
- Deployment remains intentionally pending explicit approval. Before deployment, back up remote files, browser-test the Vault handoff and Movie Night playback, restart only `pbot-backend`, and keep `superbot` online and `streaming-bot` stopped.
