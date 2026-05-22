# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — run the server (`node index.js`).
- `npm run dev` — run with `nodemon` for auto-reload (nodemon is not in `devDependencies`; install globally or with `npx`).
- `npm test` — **not implemented**; the script just `exit 1`. There is no test framework configured.
- Lint config exists ([.eslintrc.json](.eslintrc.json), `eslint-config-standard`), but no `lint` script. Run with `npx eslint index.js` if needed.
- The server listens on a **hardcoded** port `3000` ([index.js:4614](index.js#L4614)) — `PORT` env var is ignored.

## Configuration

Secrets live in `.env` (gitignored, loaded via `dotenv`):

- `CHANNELACCESSTOKEN`, `CHANNELSECRET` — LINE Messaging API credentials.
- `DATABASE_URL` — external Render Postgres connection string (default).
- `INTERNALCONNECT` — Render-internal hostname; swap for `DATABASE_URL` when deployed on Render itself ([index.js:19-29](index.js#L19-L29)).

The [README.md](README.md) is **stale upstream starter content** — it references a `config.json` and configurable port that this fork no longer uses. Ignore it.

## Architecture

This is a **single-file monolith**: virtually all server logic lives in [index.js](index.js) (~4600 lines). It is an Express app that serves EJS-rendered LIFF mini-apps and a LINE webhook to manage a weekly employee shuttle-bus booking system for Resonac (Gateway plant). Data lives in PostgreSQL under the `gateway.*` schema.

### LINE/LIFF integration

- LINE webhook: `POST /callback` ([index.js:4408](index.js#L4408)), guarded by an HMAC-SHA256 signature middleware ([index.js:4390](index.js#L4390)).
- The bot replies to text `/checkin` with a Flex menu and `location` with a static location.
- **Known bug**: `validateSignatureMiddleware` and the `reply*` helpers reference an undefined `config` variable (`config.channelSecret`, `config.channelAccessToken`). Calling `/callback` or any reply path will throw `ReferenceError`. The push-message path (`sendPushMessage`, [index.js:3978](index.js#L3978)) correctly uses `process.env.CHANNELACCESSTOKEN` and works. If you touch the webhook, fix this — it has been latent since the dotenv migration.
- LIFF IDs (e.g., `2005019112-X2WPDJwv` for `/register`, `-pWR2kZDm` for `/nextweek`) are **hardcoded inline at each route**. Search for `liffid:` to find them all.

### Database schema (`gateway.*`)

The schema has three classes of tables — all column-compatible within a class so data flows by `INSERT INTO ... SELECT FROM`.

- **Booking** (per-employee weekly grid of inbound/outbound times): `lastweek`, `thisweek`, `nextweek`. Each row = one user × one route, with `monday_inbound`/`monday_outbound`/... columns plus `department_approval`.
- **Bus assignments** (system → driver → HR pipeline, two parallel tables each):
  - Bus list (route/day/bound/time/bus_number): `driver` → `bustoday` → `busfromhr`
  - Seat list (per-passenger): `seatdriver` → `seattoday` → `seatfromhr`
- **History snapshots** taken at each pipeline stage: `driverhistoryfromsystem`/`seathistoryfromsystem` (when system computes), `driverhistoryfromdriver`/`seathistoryfromdriver` (when sent to HR), `driverhistoryfromhr`/`seathistoryfromhr` (when HR finalizes).
- Other: `users` (registered employees), `route` (route catalog).

### Weekly data lifecycle (the thing to internalize)

Booking advances through stages via specific endpoints intended to be hit by a scheduler:

1. Employees book next week via LIFF (`POST /nextweek`) → writes to `gateway.nextweek`.
2. **Weekly rollover** — `GET /weekly` ([index.js:3276](index.js#L3276)): `thisweek` → `lastweek`, `nextweek` → `thisweek`, then clears `nextweek`.
3. **Daily bus packing** — `GET /daliy` (sic, [index.js:3007](index.js#L3007)): runs `calculatebus(day, 'before'|'after')` which reads `thisweek` + `route`, packs passengers into buses with `MAX_SEATS = 13`, and writes proposals to `driver` + `seatdriver`. Snapshots into `*historyfromsystem`. Skips weekends; on Friday, pre-computes Sat/Sun/Mon.
4. **Pack scheduler dispatches HR review** — `POST /driversendtohr` ([index.js:3080](index.js#L3080)): promotes `driver` → `bustoday`, `seatdriver` → `seattoday`, clears proposals, snapshots `*historyfromdriver`, pushes LINE notification.
5. HR adjusts via `bustoday`/`seattoday` admin pages, then approves → copies to `busfromhr`/`seatfromhr`, snapshots `*historyfromhr`.

### `before` vs `after` time split (calculatebus)

`calculatebus` runs twice per day with a `time` arg ([index.js:765](index.js#L765)). The `INVALID_TIMES` array filters bookings:
- `'after'` excludes morning runs `05:15, 07:30, 08:15, 10:30` (only pack PM departures).
- `'before'` excludes evening runs `17:15, 19:30, 20:15` (only pack AM departures).

This lets each day's morning/evening cohorts be packed independently into separate bus assignments.

### View layer

EJS templates in [views/](views/). Static assets in [public/](public/) (also mounted at `/static`). Most user-facing pages are LIFF mini-apps that authenticate via LINE access token (`POST /verifyaccesstoken`, [index.js:105](index.js#L105)) and verify `client_id === '2005019112'`.

### CSV/Excel exports

Endpoints `GET /download-csv-*` and `GET /download-excel-busfromhr` use `csv-writer` / `exceljs` to dump the bus/seat tables for HR. Files are written to disk (project root) then served — there is no temp-dir cleanup.

### Notifications

- `sendPushMessage(userIds, msg)` calls LINE `/v2/bot/message/multicast`.
- `telegramNotify(msg)` posts to a hardcoded Telegram bot/chat ([index.js:146](index.js#L146)) used for deploy + pipeline alerts.

## Conventions / gotchas when editing

- The `pg.Pool` is shared at module scope (`max: 95`, `keepAlive: true`). Long-running handlers must `client.release()` in a `finally`. Several handlers do this; copy that pattern. Do **not** call `client.release()` if you used `pool.query(...)` directly.
- Many SQL statements interpolate via `$1, $2, ...` parameters — keep that pattern, never string-concat user input into SQL.
- `process.env.CHANNELACCESSTOKEN` is captured **once at startup** into the `accessToken` constant ([index.js:31](index.js#L31)). Restart the server after rotating tokens.
- The hardcoded user ID `U5da05fd30c7794592221bb51827861d4` appearing in `sendPushMessage` calls is the HR/admin LINE recipient.
