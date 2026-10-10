const { Client, types } = require("pg");

// Postgres returns BIGINT (int8) and NUMERIC as strings by default.
// Parse them back to JS numbers so COUNT(*) / SUM() behave like SQLite.
types.setTypeParser(20, (v) => parseInt(v, 10)); // int8  → number
types.setTypeParser(21, (v) => parseInt(v, 10)); // int2  → number
types.setTypeParser(23, (v) => parseInt(v, 10)); // int4  → number
types.setTypeParser(1700, (v) => parseFloat(v)); // numeric → number

// Single client (not a pool) so BEGIN / COMMIT / ROLLBACK transactions
// always run on the same connection and are truly atomic.
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Postgres folds unquoted identifiers to lower case. The app SQL is written
// in SQLite style using camelCase columns, which folds to lower case and
// matches our lower-cased schema. Result rows then arrive lower-cased, so
// we restore the camelCase keys the application code reads.
const IDENT_MAP = {
  id: "id",
  name: "name",
  phone: "phone",
  email: "email",
  aadhaar: "aadhaar",
  district: "district",
  village: "village",
  landsize: "landSize",
  role: "role",
  password: "password",
  createdat: "createdAt",
  paymentmethod: "paymentMethod",
  bankname: "bankName",
  accountnumber: "accountNumber",
  ifsccode: "ifscCode",
  upiid: "upiId",
  kyc: "kyc",
  smsallowed: "smsAllowed",
  emailallowed: "emailAllowed",
  centreid: "centreId",
  centrename: "centreName",
  state: "state",
  address: "address",
  contact: "contact",
  officer: "officer",
  capacityperslot: "capacityPerSlot",
  avgminutesperfarmer: "avgMinutesPerFarmer",
  starthour: "startHour",
  endhour: "endHour",
  dailycapacity: "dailyCapacity",
  category: "category",
  msp: "msp",
  unit: "unit",
  season: "season",
  active: "active",
  farmerid: "farmerId",
  farmername: "farmerName",
  commodityid: "commodityId",
  commodityname: "commodityName",
  date: "date",
  timeslot: "timeSlot",
  quantity: "quantity",
  grade: "grade",
  estamount: "estAmount",
  status: "status",
  queueposition: "queuePosition",
  remindersent: "reminderSent",
  title: "title",
  body: "body",
  read: "read",
  bookingid: "bookingId",
  transactionref: "transactionRef",
  paidat: "paidAt",
  paymentmode: "paymentMode",
  source: "source",
  route: "route",
  stage: "stage",
  totalstages: "totalStages",
  events: "events",
  updatedat: "updatedAt",
  error: "error",
  provider: "provider",
  actorid: "actorId",
  actorname: "actorName",
  action: "action",
  target: "target",
  details: "details",
  subject: "subject",
  officernote: "officerNote",
  officerid: "officerId",
  rating: "rating",
  comment: "comment",
  scanner: "scanner",
  ip: "ip",
  // aliases used in queries
  shiproute: "shipRoute",
  shipstage: "shipStage",
  shiptotal: "shipTotal",
  shipevents: "shipEvents",
  shipupdated: "shipUpdated",
  farmerpaymentmethod: "farmerPaymentMethod",
  farmerbankname: "farmerBankName",
  farmeraccountnumber: "farmerAccountNumber",
  farmerifsccode: "farmerIfscCode",
  farmerupiid: "farmerUpiId",
  bookingstatus: "bookingStatus",
  ratingavg: "ratingAvg",
  ratingcount: "ratingCount",
  bookingcount: "bookingCount",
  paidamount: "paidAmount",
  mandi: "mandi",
  to_number: "to_number",
  qty: "qty",
  paid: "paid",
  bookings: "bookings",
  todaybookings: "todayBookings",
  inqueuetoday: "inQueueToday",
  todayrevenue: "todayRevenue",
  totalapprovedamount: "totalApprovedAmount",
  pendingamount: "pendingAmount",
  shipmentsactive: "shipmentsActive",
  shipmentsdelivered: "shipmentsDelivered",
  queuenow: "queueNow",
  bookedtoday: "bookedToday",
  capacitytotal: "capacityTotal",
  freetoday: "freeToday",
  assignedsince: "assignedSince",
  queueindex: "queueIndex",
  estwaitmin: "estWaitMin",
  booked: "booked",
  free: "free",
  load: "load",
  slots: "slots",
  n: "n",
  r: "r",
  s: "s",
  a: "a",
  d: "d",
};

function mapRow(row) {
  if (!row) return row;
  const out = {};
  for (const k of Object.keys(row)) {
    if (IDENT_MAP[k] != null) out[IDENT_MAP[k]] = row[k];
    else out[k] = row[k];
  }
  return out;
}

async function seedSchema() {
  await client.query(`
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
      paymentMethod TEXT DEFAULT '',
      bankName TEXT DEFAULT '',
      accountNumber TEXT DEFAULT '',
      ifscCode TEXT DEFAULT '',
      upiId TEXT DEFAULT '',
      kyc TEXT DEFAULT 'pending',
      kycDocType TEXT DEFAULT '',
      kycDocData TEXT DEFAULT '',
      kycNotes TEXT DEFAULT '',
      kycVerifiedBy TEXT DEFAULT '',
      kycVerifiedAt TEXT DEFAULT '',
      smsAllowed INTEGER DEFAULT 1,
      emailAllowed INTEGER DEFAULT 1,
      centreId TEXT,
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
      endHour INTEGER DEFAULT 17,
      dailyCapacity INTEGER DEFAULT 0
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
      reminderSent INTEGER DEFAULT 0,
      unit TEXT DEFAULT 'quintal',
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
      officerId TEXT,
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
}

async function seedData() {
  const centreRes = await client.query("SELECT COUNT(*) AS n FROM centres");
  if (parseInt(centreRes.rows[0].n) === 0) {
    const centres = [
      ["CTR001", "FCI Ludhiana Procurement Centre", "Ludhiana", "Punjab", "Mandi Road, Grain Market, Ludhiana", "0161-2601234", "Officer Services", 8, 10, 8, 17, 0],
      ["CTR002", "Karnal Mandi Procurement Centre", "Karnal", "Haryana", "New Grain Market, Karnal", "0184-2234567", "Dhan Mandi", 6, 12, 8, 17, 0],
      ["CTR003", "Indore Sagarkhana Procurement Centre", "Indore", "Madhya Pradesh", "Sagarkhana Mandi, Indore", "0731-2498765", "Mandi Board", 10, 10, 8, 18, 0],
      ["CTR004", "Kanpur Mandi Samiti Centre", "Kanpur", "Uttar Pradesh", "Grain Mandi, Kanpur", "0512-2245678", "Bhaav Mandi", 7, 15, 9, 17, 0],
      ["CTR005", "Vijayawada Paddy Procurement Centre", "Vijayawada", "Andhra Pradesh", "Rice Purchase Yard, Vijayawada", "0866-2578901", "Civil Supplies", 9, 12, 8, 17, 0],
    ];
    for (const c of centres) {
      await client.query(
        `INSERT INTO centres (id, name, district, state, address, contact, officer, capacityPerSlot, avgMinutesPerFarmer, startHour, endHour, dailyCapacity) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        c
      );
    }
  }

  const comRes = await client.query("SELECT COUNT(*) AS n FROM commodities");
  if (parseInt(comRes.rows[0].n) === 0) {
    const commodities = [
      ["COM001", "Wheat", "Cereal", 2425, "quintal", "Rabi (Oct-Mar)", 1],
      ["COM002", "Paddy (Common)", "Cereal", 2300, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM003", "Paddy (Grade A)", "Cereal", 2320, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM004", "Tur / Arhar", "Pulse", 7550, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM005", "Moong", "Pulse", 8682, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM006", "Gram (Chana)", "Pulse", 5440, "quintal", "Rabi (Oct-Mar)", 1],
      ["COM007", "Mustard / Rapeseed", "Oilseed", 5650, "quintal", "Rabi (Oct-Mar)", 1],
      ["COM008", "Soybean", "Oilseed", 4892, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM009", "Cotton (Medium)", "Fiber", 7121, "quintal", "Kharif (Jun-Oct)", 1],
      ["COM010", "Sugarcane (FRP)", "Commercial", 340, "quintal", "Perennial", 0],
    ];
    for (const c of commodities) {
      await client.query(
        `INSERT INTO commodities (id, name, category, msp, unit, season, active) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        c
      );
    }
  }

  const priceRes = await client.query("SELECT COUNT(*) AS n FROM market_prices");
  if (parseInt(priceRes.rows[0].n) === 0) {
    const districts = ["Ludhiana", "Karnal", "Indore", "Kanpur", "Vijayawada", "Etawah", "Nizamabad"];
    const commodities = [
      ["COM001", "Wheat", "quintal", 2425],
      ["COM002", "Paddy (Common)", "quintal", 2300],
      ["COM003", "Paddy (Grade A)", "quintal", 2320],
      ["COM004", "Tur / Arhar", "quintal", 7550],
      ["COM005", "Moong", "quintal", 8682],
      ["COM006", "Gram (Chana)", "quintal", 5440],
      ["COM007", "Mustard / Rapeseed", "quintal", 5650],
      ["COM008", "Soybean", "quintal", 4892],
      ["COM009", "Cotton (Medium)", "quintal", 7121],
    ];
    const now = new Date().toISOString();
    for (const [comId, comName, unit, msp] of commodities) {
      for (const district of districts) {
        let h = 0;
        for (const ch of comId + district) h = (h * 31 + ch.charCodeAt(0)) % 1000;
        const drift = ((h % 81) - 40) / 10;
        const mandi = Math.round((msp * (1 + drift / 100)) / 5) * 5;
        await client.query(
          `INSERT INTO market_prices (commodityId, commodityName, unit, msp, mandi, district, updatedAt) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [comId, comName, unit, msp, mandi, district, now]
        );
      }
    }
  }

  const officerRes = await client.query("SELECT COUNT(*) AS n FROM farmers WHERE role = 'officer'");
  if (parseInt(officerRes.rows[0].n) === 0) {
    await client.query(
      `INSERT INTO farmers (id, name, phone, email, aadhaar, district, village, landSize, role, password, createdAt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      ["USR_OFFICER1", "Procurement Officer (Demo)", "9800000000", "officer@fpo.gov.in", "XXXX-XXXX-0001", "", "", 0, "officer", "$2a$10$DHHi9eKLXMtrSJAoa5zVLe9ZSG9rehAxdXCyxgzB.EceCKVp03aA2", "2026-09-01T00:00:00.000Z"]
    );
  }
}

let initialized = false;
let connecting = false;
async function ensureClient() {
  if (client._connected) return;
  if (connecting) {
    while (!client._connected) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return;
  }
  connecting = true;
  try {
    await client.connect();
    client._connected = true;
  } finally {
    connecting = false;
  }
}

async function ensureInit() {
  await ensureClient();
  if (!initialized) {
    await seedSchema();
    await seedData();
    // Add new columns if missing (safe for existing tables)
    const alterCols = [
      "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS kycDocType TEXT DEFAULT ''",
      "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS kycDocData TEXT DEFAULT ''",
      "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS kycNotes TEXT DEFAULT ''",
      "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS kycVerifiedBy TEXT DEFAULT ''",
      "ALTER TABLE farmers ADD COLUMN IF NOT EXISTS kycVerifiedAt TEXT DEFAULT ''",
    ];
    for (const sql of alterCols) {
      try { await client.query(sql); } catch (e) { /* column already exists */ }
    }
    initialized = true;
  }
}

function convertPlaceholders(sql) {
  let i = 0;
  const replaced = sql.replace(/\?/g, () => "$" + (++i));
  return replaced;
}

async function all(sql, ...params) {
  await ensureInit();
  const converted = convertPlaceholders(sql);
  const result = await client.query(converted, params);
  return (result.rows || []).map(mapRow);
}

async function get(sql, ...params) {
  const rows = (await all(sql, ...params)) || [];
  return rows[0] || null;
}

async function run(sql, ...params) {
  await ensureInit();
  const converted = convertPlaceholders(sql);
  const result = await client.query(converted, params);
  return { changes: result.rowCount, id: params[0] };
}

const db = {
  exec: async (sql) => {
    await ensureInit();
    await client.query(sql);
  },
  query: (sql, params) => client.query(sql, params),
  connect: () => ensureClient(),
};

module.exports = { db, all, get, run };