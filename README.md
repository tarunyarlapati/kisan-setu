# Kisan Setu — Farmer Procurement Management Platform

Smart Agriculture Problem Statement **PS-32** submission: an end-to-end **Farmer Procurement / MSP Management** platform with a multilingual AI-style farmer chatbot, smart slot & centre selection, lot-traceability QR passports, an offline-first PWA, voice support, and a free/cheap SMS delivery chain.

## Quick start

```bash
npm install
npm run seed      # wipes & seeds demo data (16 farmers, 26 bookings, 6 payments, 78 notifications)
npm start         # http://localhost:3000
```

## Demo accounts

| Role    | Email                 | Password      |
|---------|-----------------------|---------------|
| Officer | officer@fpo.gov.in    | officer123    |
| Farmer  | ram.singh0@farmer.demo | Farmer@123    |

All 16 seeded farmers use password `Farmer@123` and follow the email pattern `<first>.<last><index>@farmer.demo` (0-based index, e.g. `ram.singh0@farmer.demo`). The seed script prints a login hint with these details on every run.

## Features

- **Farmer booking & slot selection** — pick a date/centre; smart ranking suggests the least-loaded centre with the shortest queue estimate; a slot is reserved for 5 minutes.
- **Live centre congestion** — officer dashboard shows today's in-queue / weighing / QC load per centre (`todayRevenue`, payments backlog).
- **Officer procurement lifecycle** — book → check-in (queue position) → weigh → quality check → approve/reject → pay → track delivery.
- **Lot traceability** — every shipment gets a QR "Lot Passport" (commodity, weight, route, stage timeline). Sending the QR to a verification API returns the live lot record only to its owner.
- **Multilingual UI** — English, తెలుగు (Telugu), हिन्दी (Hindi): full key-set parity, `<html lang>` updates, persisted choice, `langchange` event re-renders dynamic lists.
- **Voice + bot interface** — "type or speak" chatbot that answers in Hindi/Telugu/English with currency-aware math (5120 kg wheat = ₹…), suggests ideal centres/slots, and can auto-create bookings.
- **PWA / offline-first** — web manifest, installable icons, service worker precaches the full app shell; an offline page for when there's no network.
- **Farmer Register (officer)** — badge-tab on the dashboard listing every registered farmer with booking counts and paid value; one-click **delete account** that transactionally cascades through notifications → payments → shipments → bookings.
- **SMS Log (officer)** — every SMS attempt (welcome, slot confirmation, check-in, payment, delivery) is persisted with status; the dashboard's SMS Log tab lets officers audit delivery (delivered / demo / failed / skipped).
- **Working SMS** — failover chain **Twilio → TextBee → Fast2SMS → demo console log**; on free trial accounts it auto-switches to the allowed trial template. Real and demo attempts are both recorded.
- **Officer analytics** — dashboard charts (14-day tonnage & revenue, booking status split, commodity split, centre load) plus a 7-day capacity forecast; one-click **CSV/PDF exports** for bookings, payments, farmers, shipments and grievances.
- **Audit log** — every mutating officer action (check-in, status, payment, KYC, capacity, reminders, grievances, centre creates) is recorded with actor/target/details and viewable/filterable on the dashboard.
- **Grievance ticketing** — farmers file complaints (ticket ID + status), officers triage to in-progress/resolved with an internal note; the farmer sees updates and is notified by SMS/email.
- **Centre ratings** — farmers rate a centre they've booked at (1–5★ + comment); averages surface on `/api/centres` and the analytics ratings panel.
- **Slot reminders + static daily capacity** — officers cap daily intake per centre (`dailyCapacity`, enforced with a `dayFull` flag), set per-centre limits, and send manual slot reminders to booked farmers; a `KS_REMINDERS=on` cron auto-notifies booked-today farmers 20–75 minutes before their slot.
- **UPI payments** — officers record payout; farmers get a `upi://pay` deep link, an inline **UPI QR** to scan-and-pay, and a download/printable **PDF receipt**.
- **QR scan history + lot passport** — verifying a lot QR audits who scanned it (`scan_log`) and returns the live lot record to its owner only.
- **MSP vs Mandi prices** — live `market_prices` seed (63 rows) for an MSP-vs-APMC comparison, filterable by commodity on the booking page and a dashboard Prices tab.
- **KYC status** — farmers register as `pending`; officers approve/reject from the register tab (badge + filtered audit trail).
- **SMS/email preferences** — farmers control `smsAllowed`/`emailAllowed` at registration and from their profile.
- **Indian formatting, dark mode, skeletons, 404/500** — ₹ Indian number formatting throughout, a persisted dark-mode toggle, loading skeletons, branded 404/500 pages, and a service worker that precaches the full app shell.
- **Anti-abuse** — in-memory **rate limits** (login, register, SMS test, grievances), **SMS throttle** (3/min per number, 25/min global) logged as `skipped` with reason, input sanitisation and security headers.

## SMS / Email setup

Copy `.env.example` to `.env` and fill in either:

- **Twilio** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`) — set `TWILIO_TRIAL_TEMPLATE` to an approved trial template, or leave blank on an upgraded account for custom bodies.
- **TextBee / Fast2SMS** — free/cheap Indian providers; a single send falls through to the next provider, so only one key is required to get live SMS.
- **SMTP** (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) — for the email copies.

Without `.env`, everything runs in **demo mode**: SMS and emails are logged to the server console, and the SMS Log records them as `demo`.

## API surface

| Method | Route                                   | Auth      | Purpose                                              |
|--------|-----------------------------------------|-----------|------------------------------------------------------|
| POST   | `/api/register`                         | public    | Create farmer (KYC `pending`, SMS/email prefs)       |
| POST   | `/api/login`, `/api/logout`, `/api/me`  | public    | Session auth                                         |
| GET    | `/api/centres`                          | public    | Centres + slots + ratingAvg/ratingCount              |
| GET    | `/api/centres/load?date=`               | public    | Per-centre daily load, least-busy first              |
| POST   | `/api/centres/:id/capacity`             | officer   | Set static daily capacity (enforced on booking)      |
| GET    | `/api/commodities`, `/api/prices`, `/api/prices/:id` | public | Commodities, MSP-vs-mandi prices            |
| GET    | `/api/slots/availability?centreId&date` | public    | Slot-level availability                             |
| POST   | `/api/bookings`                         | farmer    | Create booking (daily-cap + slot checks, `dayFull`)  |
| GET    | `/api/bookings/my`                      | farmer    | Own bookings + embedded shipment timeline            |
| GET    | `/api/bookings`                         | officer   | All bookings (+ `today` flag, queue info)            |
| POST   | `/api/bookings/:id/checkin`             | officer   | Check-in → queue position                            |
| PATCH  | `/api/bookings/:id/status`              | officer   | book/in-queue/weighing/qc/approved/rejected/cancelled|
| POST   | `/api/bookings/:id/pay`                 | officer   | Record payout (UPI/bank, ref)                        |
| POST   | `/api/bookings/:id/remind`              | officer   | Manual slot reminder (SMS/email)                     |
| GET    | `/api/bookings/:id/qr`                  | owner/off | QR lot passport (data URL)                           |
| GET    | `/api/queue?centreId&date`              | public    | Live queue positions                                  |
| GET/POST| `/api/shipments...`                    | owner/off | Shipment timeline + stage advance                    |
| GET    | `/api/farmers`                          | officer   | Farmer register (+ KYC status)                       |
| DELETE | `/api/farmers/:id`                      | officer   | Delete farmer + cascade                              |
| POST   | `/api/farmers/:id/kyc`                  | officer   | `verified` / `rejected` / `pending`                  |
| GET    | `/api/audit`                            | officer   | Officer action trail (filter by `?action=`)          |
| POST   | `/api/grievances`                       | farmer    | File complaint (ticket ID)                           |
| GET    | `/api/grievances/my`                    | farmer    | Own tickets + officer notes                          |
| GET    | `/api/grievances`                       | officer   | All tickets (`?status=` filter)                      |
| POST   | `/api/grievances/:id`                   | officer   | Service ticket (status + officerNote)                |
| POST   | `/api/ratings`                          | farmer    | Rate a centre you've booked at (1–5★)                |
| GET    | `/api/payments/:id/upi-link`            | owner/off | `upi://pay` deep link                                |
| GET    | `/api/payments/:id/upi-qr`              | owner/off | UPI QR as PNG data URL                               |
| GET    | `/api/payments/:id/receipt.pdf`         | owner/off | Download/printable PDF receipt                       |
| GET    | `/api/profile`, PATCH `/api/profile/prefs` | auth   | Profile + SMS/email preferences                      |
| POST   | `/api/qr/scan`                          | auth      | Verify lot QR (owner-guarded, scan audit trail)      |
| GET    | `/api/analytics`                        | officer   | Charts/forecast/ratings dataset                      |
| GET    | `/api/export/:type.csv\|.pdf`           | officer   | bookings/ payments/ farmers/ shipments/ grievances   |
| GET    | `/api/stats`, `/api/sms/log`            | officer   | Dashboard stats, SMS delivery audit                  |
| POST   | `/api/sms/test`                         | officer   | Send a test SMS (rate-limited)                       |
| POST   | `/api/notifications/read`               | farmer    | Mark notifications read                              |
| GET    | `/api/notifications`                    | auth      | Farmer notifications                                 |
| GET    | `/offline`, `/404`, `/500`              | any       | PWA fallback + branded error pages                   |

## Tech stack

- Node.js ≥ 22 (built-in **`node:sqlite`** — no native deps, WAL mode), Express, express-session, bcryptjs, nodemailer, `qrcode`.
- Data lives in `data/app.db` (ignored by git). WAL mode allows the demo seed to run against a live server.
- Frontend is vanilla JS + CSS (PWA, no build step); localization keys live in `public/js/i18n.js`.

## Project layout

```
server.js            HTTP routes + auth + lifecycles + reminder cron + error pages
db.js                node:sqlite open + schema + base seed (audit_log, grievances,
                     centre_ratings, scan_log, market_prices + dailyCapacity/kyc/prefs)
seed-demo.js         wipe-and-seed realistic demo dataset
sms.js               provider chain (twilio/textbee/fast2sms/demo) + throttle + sms_log
mailer.js            nodemailer wrapper (demo console fallback)
pdf.js               UPI receipt + MIS report generators (PDF-lite)
public/              static app shell, PWA assets, JS, i18n, CSS, error pages
diagrams/            architecture + process-flow SVGs
```

## Notes

- `npm start` banner shows `DB: SQLite`, `SMS: demo mode` or `SMS: Twilio (live)` per your `.env`.
- Auto slot reminders are **off by default** — set `KS_REMINDERS=on` in `.env` to enable the 20–75-minute-before-slot cron; the manual emergency reminder route is always available.
- SMS is throttled to **3/min per number and 25/min globally**; throttled sends appear in the SMS Log as `skipped` with reason `throttled`.
- Reseeding wipes farmer data and resets the SMS log; re-runs are idempotent.
- The officer account can never be deleted through `/api/farmers/:id` (role guard).