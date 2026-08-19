# Handbill Tests

A local, single-user sandbox for testing **Synerise** APIs against a real workspace — promotions, handbills, vouchers, POS, events and Brickworks — through a simple browser UI.

What you can do with it:

- **Fetch** promotions and handbills for a profile ([GetAllClientPromotionsV2](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotions/operation/GetAllClientPromotionsV2) with multi-attribute sorting, single handbill, handbills + promotions, handbill configuration), then **activate** or **redeem** a promotion straight from the results.
- **Handbill configuration**: [get](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Handbills/operation/getHandbillConfig_GET) a handbill campaign's workspace configuration and [PATCH it back](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Handbills/operation/updateHandbill_PATCH) — the fetched JSON prefills the editor (with an explicit **⤵ insert fetched** button), so updates start from the current values and don't null anything.
- **Promotion settings**: [get](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotion-settings/operation/endpointSettingsGetSettingsGET) and [update](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotion-settings/operation/endpointSettingsUpdateSettingsPUT) the workspace promotion settings, with the same fetch → insert → edit → send flow.
- **Promotion: get / create / update** — one card for a single promotion's lifecycle: [get](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotions/operation/GetPromotionDetailsAsBusinessProfile) by uuid/code, [create](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotions/operation/CreateAPromotion) from a JSON editor, [update](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotions/operation/UpdateAPromotion) (partial PUT) — the fetched promotion prefills the editor trimmed to writable fields, so updates don't null anything.
- **Preview Brickworks output** for a profile ([previewObject](https://hub.synerise.com/api-reference/brickworks#tag/Brickworks:-Records/operation/previewObject)) with a schema picker, an optional record picker (previews that record's values), and optional `context` JSON, or **generate it for real** from a published record ([generateObjectForProfile](https://hub.synerise.com/api-reference/brickworks#tag/Brickworks:-Content-generation/operation/generateObjectForProfile) — emits the `brickwork.generated` event).
- **Create** test promotions (placeholders, tags, custom fields), **batch-overwrite** them by `code`, and **clean up** by `headerName` prefix.
- **Add events or transactions** to a profile — send custom `noun.verb` events ([CustomEvent](https://hub.synerise.com/api-reference/data-management#tag/Events/operation/CustomEvent), with optional `params` JSON, `time` and `eventSalt`) or full transactions ([CreateATransaction](https://hub.synerise.com/api-reference/data-management#tag/Events/operation/CreateATransaction), which additionally emit `transaction.charge` plus one `product.buy` per item) to the client's activity log, `count` at a time, to simulate profile behaviour for Analytics, segmentations and automations.
- **Vouchers**: [create](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/CreateAVoucher) voucher codes in a pool (with a pool picker), optionally assigned to a profile by `clientId` or `clientUuid`; [check a voucher](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/ViewVoucherDetailsBySearchKey) by code/uuid; [redeem](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/RedeemAVoucher) it by code; [batch-redeem](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Promotions/operation/BatchRedeemVouchersForProfile) up to 100 codes for a profile; [list vouchers assigned to a profile](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/GetVouchersAssignedToAClientByIdentifier) by id/uuid/email/custom identifier.
- **Voucher pools**: a separate card for pool-level listing — [list the pools](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/ListPools) defined in the workspace with their full definitions, and [list every voucher inside one pool](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/Vouchers/operation/ListVouchersFromPool) whatever its status. Both share `limit` / `page` / `includeMeta`; with `includeMeta: false` the totals arrive in `X-Pagination-*` headers, which the server reads and reports as `pagination`.
- **POS flows** — evaluate a basket against the profile's promotions ([processSale](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/POS/operation/processSale)) and finalize it with a payments report ([processCheckout](https://hub.synerise.com/api-reference/loyalty-and-engagement#tag/POS/operation/processCheckout)), from an editable JSON payload with ready-made templates.
- **Copy curl** for every action — each button can reproduce its exact Synerise call with a live bearer token.
- **Readable results** — responses render as colored, collapsible JSON trees (with a `{ } Raw` toggle for copy-pasting), and every section collapses by clicking its title (persisted per browser).
- **`?` tooltips** everywhere — every section and function explains what it does, which endpoint it hits, and links to the docs.
- **Anchored top bar** — the client identifier (used by every section) and a workspace switcher stay pinned while you scroll. Add more workspace API keys and hop between them; each key is validated with a login and then stored in the **platform keystore** (macOS Keychain, Windows Credential Manager, or a libsecret keyring on Linux) under the service `handbill-tests` — never in browser storage, never in a plaintext file, and never on a command line. The browser only ever sees `{ id, name }`, so the workspace list is shared by every browser on the machine; the `(.env key)` entry is whatever `SYNERISE_API_KEY` the server booted with.
- **Settings tab** — check the bearer token and reorder or hide the testing sections, grouped by domain (Handbills / Promotions & POS / Vouchers / Profile & data); drag & drop within a group, persisted per browser.

Under the hood it's a tiny Node/Express server ([server.js](server.js)) that logs in with your workspace API key, caches the JWT, and proxies every call — the key and token never reach the browser. The server binds to `127.0.0.1` only and guards `/api/*` with a Host/Origin allow-list plus a session cookie, so nothing is exposed to your LAN.

## Quick start — for humans 🧑‍💻

Requirements: [Node.js](https://nodejs.org) ≥ 18.

```bash
git clone https://github.com/arkadiuszwisniewski-synerise/synerise-handbill-tests.git
cd synerise-handbill-tests
npm install
cp .env.example .env   # then put your workspace API key in SYNERISE_API_KEY
npm start              # or: npm run dev (auto-restart on changes)
```

Then open **http://localhost:3000** in your browser. That's it.

- The bearer token is fetched and refreshed automatically; you can inspect it in **Settings → Bearer token**. Workspace API keys are added and switched in the top bar (the `＋` next to the workspace picker).
- The port comes from `PORT` in `.env` (default `3000`).

## Quick start — for Claude 🤖

> Instructions for AI coding agents (Claude Code and friends) working in this repo.

1. **Install & configure**: `npm install`, then make sure `.env` exists (`cp .env.example .env`) and `SYNERISE_API_KEY` holds a valid workspace API key.
2. **Run the server** with your dev-server tooling (don't block your shell): `npm start` serves `http://localhost:3000` — loopback only. A `.claude/launch.json` entry named `handbill-tests` may already exist for browser-preview tools.
3. **Verify in the browser** at `http://localhost:3000` — every UI action logs the proxied Synerise request (method, status, URL, body) to the **server console**, which is the fastest way to confirm what was actually sent.
4. **Calling `/api/*` directly** (curl/fetch without the UI): the routes require the session cookie issued on `GET /`, and the `Host` header must be `localhost:3000` or `127.0.0.1:3000`:

   ```bash
   curl -sc /tmp/hb.cookies http://localhost:3000/ > /dev/null
   curl -b /tmp/hb.cookies -H 'content-type: application/json' \
     -d '{"identifierType":"clientId","identifierValue":"123","sort":["priority,asc"]}' \
     http://localhost:3000/api/promotions-for-client
   ```

5. **Local API surface** (all proxied with auth, in `server.js` order): `GET /api/workspaces` (names + ids only, never keys), `POST /api/workspaces` (validates the key, then stores it in the platform keystore), `POST /api/workspaces/:id/activate` (switch the active workspace), `DELETE /api/workspaces/:id` (drop the keystore item and the metadata), `POST /api/apikey/reset` (switch back to the `.env` key), `GET /api/token`, `POST /api/promotion`, `POST /api/promotions/batch-import`, `POST /api/promotion/activate-for-client`, `POST /api/promotion/redeem`, `POST /api/promotion-details`, `POST /api/promotion-raw` (body `{ payload }` — verbatim CreateAPromotion), `PUT /api/promotion-raw` (body `{ searchKey, searchValue, payload }` — UpdateAPromotion), `GET /api/promotions?prefix=…`, `POST /api/promotions/delete`, `GET /api/promotion-tags`, `GET /api/handbills`, `GET /api/promotion-settings`, `PUT /api/promotion-settings`, `POST /api/promotions-for-client`, `POST /api/handbill`, `POST /api/handbill-config`, `PATCH /api/handbill-config` (body `{ handbillUuid, payload }`), `POST /api/handbill-batch`, `POST /api/process-sale`, `POST /api/process-checkout`, `GET /api/voucher-pools` (accepts `limit`/`page`/`includeMeta`), `POST /api/vouchers-in-pool` (body `{ poolUuid, limit, page, includeMeta }`), `POST /api/voucher-details`, `POST /api/vouchers-for-client`, `POST /api/voucher/redeem`, `POST /api/voucher/batch-redeem-for-profile`, `POST /api/voucher`, `POST /api/event`, `POST /api/transaction` (CreateATransaction), `GET /api/brickworks-schemas`, `GET /api/brickworks-records?schemaId=…`, `POST /api/brickworks-generate`, `POST /api/brickworks-preview`.

## Extending it 🙂

The whole thing is a deliberately simple framework for adding more Synerise endpoints:

- **Server**: add a route in [server.js](server.js) — `authedFetch()` gives you a bearer-authenticated `fetch`, `proxyGet()` covers simple GET proxies.
- **UI**: add a card in [public/index.html](public/index.html) and wire it in [public/app.js](public/app.js) (`runFetch()` handles buttons/results; `createCombo()` gives you a fetch-and-pick dropdown).
- **Tooltips**: describe the new function in the `HELP_TOPICS` registry (description + endpoint + docs link) and drop a `?` button next to it.
- **Sections**: register the new card in `SECTION_DEFS` (with a `group` from `SECTION_GROUPS`) so it shows up in Settings → Testing sections.

Ideas, new endpoints and pull requests are very welcome — **let's build it together**: [arkadiusz.wisniewski@synerise.com](mailto:arkadiusz.wisniewski@synerise.com)
