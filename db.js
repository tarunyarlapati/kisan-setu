// db.js — data-access facade.
//
// Two modes:
//   1) DATABASE_URL set  → Supabase (Postgres) via supabase/pg-db.js.
//   2) otherwise          → embedded SQLite (current default, zero breakage).
//
// The rest of this file is the SQLite implementation. When DATABASE_URL is
// present we undo the bottom `module.exports` and hand over the pg layer.

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, ".env") });

if (process.env.DATABASE_URL && process.env.DATABASE_URL.trim()) {
  // ── SUPA FALSE-BRANCH: hand everything to the Postgres facade ──
  // If pg-db throws at load (no pg installed yet), fall back to SQLite so the
  // app cannot be taken down by a missing dependency.
  try {
    const pgdb = require("./supabase/pg-db.js");
    module.exports = pgdb;
    return; // CommonJS top-level return — halts the rest of this module.
  } catch (e) {
    console.error("[db] pg-db failed to load, using SQLite:", e.message.split("\n")[0]);
  }
}

const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "app.db"));

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS farmers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE,
  email TEXT UNIQUE,
  aadhaar TEXT,
  district TEXT,
  village TEXT,
  landSize REAL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'farmer',
  password TEXT NOT NULL,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS centres (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  district TEXT NOT NULL,
  state TEXT,
  address TEXT,
  contact TEXT,
  officer TEXT,
  capacityPerSlot INTEGER DEFAULT 8,
  avgMinutesPerFarmer INTEGER DEFAULT 10,
  startHour INTEGER DEFAULT 8,
  endHour INTEGER DEFAULT 17
);

CREATE TABLE IF NOT EXISTS commodities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT,
  msp REAL NOT NULL,
  unit TEXT DEFAULT 'quintal',
  season TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  farmerId TEXT NOT NULL,
  farmerName TEXT,
  centreId TEXT NOT NULL,
  centreName TEXT,
  commodityId TEXT NOT NULL,
  commodityName TEXT,
  msp REAL,
  date TEXT NOT NULL,
  timeSlot TEXT NOT NULL,
  quantity REAL NOT NULL,
  grade TEXT DEFAULT 'A',
  estAmount REAL DEFAULT 0,
  status TEXT DEFAULT 'booked',
  queuePosition INTEGER,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  farmerId TEXT NOT NULL,
  title TEXT,
  body TEXT,
  read INTEGER DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  bookingId TEXT NOT NULL,
  farmerId TEXT NOT NULL,
  commodityName TEXT,
  quantity REAL,
  amount REAL DEFAULT 0,
  status TEXT DEFAULT 'processing',
  paymentMode TEXT,
  transactionRef TEXT,
  paidAt TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY,
  bookingId TEXT NOT NULL,
  farmerId TEXT NOT NULL,
  commodityName TEXT,
  quantity REAL,
  source TEXT,
  route TEXT,
  stage INTEGER DEFAULT 0,
  totalStages INTEGER DEFAULT 5,
  events TEXT,
  updatedAt TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sms_log (
  id TEXT PRIMARY KEY,
  to_number TEXT,
  message TEXT,
  provider TEXT,
  status TEXT,
  error TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actorId TEXT,
  actorName TEXT,
  action TEXT,
  target TEXT,
  details TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS grievances (
  id TEXT PRIMARY KEY,
  farmerId TEXT NOT NULL,
  farmerName TEXT,
  subject TEXT,
  message TEXT,
  status TEXT DEFAULT 'open',
  officerNote TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS centre_ratings (
  id TEXT PRIMARY KEY,
  farmerId TEXT NOT NULL,
  centreId TEXT NOT NULL,
  rating INTEGER NOT NULL,
  comment TEXT,
  createdAt TEXT NOT NULL,
  UNIQUE(farmerId, centreId)
);

CREATE TABLE IF NOT EXISTS scan_log (
  id TEXT PRIMARY KEY,
  bookingId TEXT NOT NULL,
  scanner TEXT,
  ip TEXT,
  createdAt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_prices (
  commodityId TEXT NOT NULL,
  commodityName TEXT,
  unit TEXT,
  msp REAL,
  mandi REAL,
  district TEXT,
  updatedAt TEXT,
  PRIMARY KEY (commodityId, district)
);

CREATE TABLE IF NOT EXISTS commodity_dates (
  id TEXT PRIMARY KEY,
  commodityId TEXT NOT NULL,
  date TEXT NOT NULL,
  centreId TEXT,
  createdAt TEXT NOT NULL
);
`);

// Migrate existing DBs: safely add payment columns if missing
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
ensureColumn("farmers", "paymentMethod", "TEXT DEFAULT ''");
ensureColumn("farmers", "bankName", "TEXT DEFAULT ''");
ensureColumn("farmers", "accountNumber", "TEXT DEFAULT ''");
ensureColumn("farmers", "ifscCode", "TEXT DEFAULT ''");
ensureColumn("farmers", "upiId", "TEXT DEFAULT ''");
ensureColumn("farmers", "kyc", "TEXT DEFAULT 'pending'");
ensureColumn("farmers", "smsAllowed", "INTEGER DEFAULT 1");
ensureColumn("farmers", "emailAllowed", "INTEGER DEFAULT 1");
ensureColumn("bookings", "reminderSent", "INTEGER DEFAULT 0");
ensureColumn("centres", "dailyCapacity", "INTEGER DEFAULT 0");
ensureColumn("farmers", "kycDocType", "TEXT DEFAULT ''");
ensureColumn("farmers", "kycDocData", "TEXT DEFAULT ''");
ensureColumn("farmers", "kycNotes", "TEXT DEFAULT ''");
ensureColumn("farmers", "kycVerifiedBy", "TEXT DEFAULT ''");
ensureColumn("farmers", "kycVerifiedAt", "TEXT DEFAULT ''");

// ─── Seed data ───

const SEED_CENTRES = [
  { id: "CTR001", name: "FCI Ludhiana Procurement Centre", district: "Ludhiana", state: "Punjab", address: "Mandi Road, Grain Market, Ludhiana", contact: "0161-2601234", officer: "Officer Services", capacityPerSlot: 8, avgMinutesPerFarmer: 10, startHour: 8, endHour: 17 },
  { id: "CTR002", name: "Karnal Mandi Procurement Centre", district: "Karnal", state: "Haryana", address: "New Grain Market, Karnal", contact: "0184-2234567", officer: "Dhan Mandi", capacityPerSlot: 6, avgMinutesPerFarmer: 12, startHour: 8, endHour: 17 },
  { id: "CTR003", name: "Indore Sagarkhana Procurement Centre", district: "Indore", state: "Madhya Pradesh", address: "Sagarkhana Mandi, Indore", contact: "0731-2498765", officer: "Mandi Board", capacityPerSlot: 10, avgMinutesPerFarmer: 10, startHour: 8, endHour: 18 },
  { id: "CTR004", name: "Kanpur Mandi Samiti Centre", district: "Kanpur", state: "Uttar Pradesh", address: "Grain Mandi, Kanpur", contact: "0512-2245678", officer: "Bhaav Mandi", capacityPerSlot: 7, avgMinutesPerFarmer: 15, startHour: 9, endHour: 17 },
  { id: "CTR005", name: "Vijayawada Paddy Procurement Centre", district: "Vijayawada", state: "Andhra Pradesh", address: "Rice Purchase Yard, Vijayawada", contact: "0866-2578901", officer: "Civil Supplies", capacityPerSlot: 9, avgMinutesPerFarmer: 12, startHour: 8, endHour: 17 },
];

const SEED_COMMODITIES = [
  { id: "COM001", name: "Wheat", category: "Cereal", msp: 2425, unit: "quintal", season: "Rabi (Oct-Mar)", active: 1 },
  { id: "COM002", name: "Paddy (Common)", category: "Cereal", msp: 2300, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM003", name: "Paddy (Grade A)", category: "Cereal", msp: 2320, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM004", name: "Tur / Arhar", category: "Pulse", msp: 7550, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM005", name: "Moong", category: "Pulse", msp: 8682, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM006", name: "Gram (Chana)", category: "Pulse", msp: 5440, unit: "quintal", season: "Rabi (Oct-Mar)", active: 1 },
  { id: "COM007", name: "Mustard / Rapeseed", category: "Oilseed", msp: 5650, unit: "quintal", season: "Rabi (Oct-Mar)", active: 1 },
  { id: "COM008", name: "Soybean", category: "Oilseed", msp: 4892, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM009", name: "Cotton (Medium)", category: "Fiber", msp: 7121, unit: "quintal", season: "Kharif (Jun-Oct)", active: 1 },
  { id: "COM010", name: "Sugarcane (FRP)", category: "Commercial", msp: 340, unit: "quintal", season: "Perennial", active: 0 },
];

const OFFICER = {
  id: "USR_OFFICER1",
  name: "Procurement Officer (Demo)",
  phone: "9800000000",
  email: "officer@fpo.gov.in",
  aadhaar: "XXXX-XXXX-0001",
  role: "officer",
  centreId: "CTR001",
  password: "$2a$10$DHHi9eKLXMtrSJAoa5zVLe9ZSG9rehAxdXCyxgzB.EceCKVp03aA2",
  createdAt: "2026-09-01T00:00:00.000Z",
};

function seed() {
  const centreCount = db.prepare("SELECT COUNT(*) AS n FROM centres").get().n;
  if (centreCount === 0) {
    const ins = db.prepare(
      "INSERT INTO centres (id, name, district, state, address, contact, officer, capacityPerSlot, avgMinutesPerFarmer, startHour, endHour) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    );
    SEED_CENTRES.forEach((c) =>
      ins.run(c.id, c.name, c.district, c.state, c.address, c.contact, c.officer, c.capacityPerSlot, c.avgMinutesPerFarmer, c.startHour, c.endHour)
    );
  }

  const comCount = db.prepare("SELECT COUNT(*) AS n FROM commodities").get().n;
  if (comCount === 0) {
    const ins = db.prepare(
      "INSERT INTO commodities (id, name, category, msp, unit, season, active) VALUES (?,?,?,?,?,?,?)"
    );
    SEED_COMMODITIES.forEach((c) => ins.run(c.id, c.name, c.category, c.msp, c.unit, c.season, c.active));
  }

  // MSP vs APMC mandi prices, seeded per district so farmers can compare rates.
  const priceCount = db.prepare("SELECT COUNT(*) AS n FROM market_prices").get().n;
  if (priceCount === 0) {
    const districts = ["Ludhiana", "Karnal", "Indore", "Kanpur", "Vijayawada", "Etawah", "Nizamabad"];
    const ins = db.prepare(
      "INSERT INTO market_prices (commodityId, commodityName, unit, msp, mandi, district, updatedAt) VALUES (?,?,?,?,?,?,?)"
    );
    const now = new Date().toISOString();
    const hash = (s) => {
      let h = 0;
      for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 1000;
      return h;
    };
    SEED_COMMODITIES.filter((c) => c.active).forEach((c) => {
      districts.forEach((d) => {
        // Mandi typically trades a little below/below MSP; deterministic ±4% spread
        const drift = ((hash(c.id + d) % 81) - 40) / 10; // -4.0 .. +4.0 %
        const mandi = Math.round((c.msp * (1 + drift / 100)) / 5) * 5;
        ins.run(c.id, c.name, c.unit, c.msp, mandi, d, now);
      });
    });
  }

  const officerCount = db.prepare("SELECT COUNT(*) AS n FROM farmers WHERE role = 'officer'").get().n;
  if (officerCount === 0) {
    db.prepare(
      "INSERT INTO farmers (id, name, phone, email, aadhaar, district, village, landSize, role, password, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run(OFFICER.id, OFFICER.name, OFFICER.phone, OFFICER.email, OFFICER.aadhaar, "", "", 0, "officer", OFFICER.password, OFFICER.createdAt);
  }
}

seed();

// ─── Query helpers ───

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function run(sql, ...params) {
  const r = db.prepare(sql).run(...params);
  return { changes: r.changes, id: r.lastInsertRowid };
}

module.exports = { db, all, get, run, DATA_DIR };