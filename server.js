const path = require("path");
const fs = require("fs");
// Load .env BEFORE anything else so sms.js/mailer.js see TWILIO_*/SMTP_* vars
try {
  if (fs.existsSync(path.join(__dirname, ".env"))) {
    process.loadEnvFile(path.join(__dirname, ".env"));
  }
} catch (e) {}

const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const QRCode = require("qrcode");
const { all, get, run, db } = require("./db");
const { sendEmail } = require("./mailer");
const { sendSms } = require("./sms");
const { paymentReceipt, misReport } = require("./pdf");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: "6mb" }));

// ─── Security headers ───
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "X-XSS-Protection": "1; mode=block",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=()",
  });
  next();
});

// ─── Simple in-memory rate limiter ───
const RATE = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + "|" + req.path;
    const now = Date.now();
    const rec = RATE.get(key) || [];
    const fresh = rec.filter((t) => now - t < windowMs);
    RATE.set(key, fresh);
    if (RATE.size > 5000) RATE.clear();
    if (fresh.length >= max) return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    fresh.push(now);
    RATE.set(key, fresh);
    next();
  };
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/offline", (req, res) => res.sendFile(path.join(__dirname, "public", "offline.html")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "krishi-procurement-secret-2024",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 },
  })
);

// ─── HELPERS ───

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: "Not authenticated" });
}

function requireOfficer(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "officer") {
    global.__ksOfficerId = req.session.userId;
    global.__ksOfficerName = req.session.name || "";
    return next();
  }
  return res.status(403).json({ error: "Officer access required" });
}

function requireFarmer(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "farmer") return next();
  return res.status(403).json({ error: "Farmer access required" });
}

async function pushNotification(farmerId, title, body) {
  await run(
    "INSERT INTO notifications (id, farmerId, title, body, read, createdAt) VALUES (?,?,?,?,0,?)",
    genId("NTF"),
    farmerId,
    title,
    body,
    new Date().toISOString()
  );
}

async function notify(farmer, title, body, smsText) {
  await pushNotification(farmer.id, title, body);
  if (farmer.email && farmer.emailAllowed !== 0) await sendEmail(farmer.email, title, body);
  if (farmer.phone && farmer.smsAllowed !== 0) await sendSms(farmer.phone, smsText || `${title}. ${body}`);
}

// Officer action trail — every mutating officer call is recorded.
async function audit(action, target, details) {
  await run(
    "INSERT INTO audit_log (id, actorId, actorName, action, target, details, createdAt) VALUES (?,?,?,?,?,?,?)",
    genId("AUD"),
    global.__ksOfficerId || "",
    global.__ksOfficerName || "",
    action,
    target,
    details || "",
    new Date().toISOString()
  );
}

function timeSlots(centre) {
  const slots = [];
  for (let h = centre.startHour; h < centre.endHour; h++) {
    slots.push(`${String(h).padStart(2, "0")}:00-${String(h + 1).padStart(2, "0")}:00`);
  }
  return slots;
}

function centreWithSlots(c) {
  return { ...c, slots: timeSlots(c) };
}

async function getCentre(id) {
  return get("SELECT * FROM centres WHERE id = ?", id);
}

async function bookingsForSlot(centreId, date, timeSlot) {
  return await all(
    "SELECT * FROM bookings WHERE centreId=? AND date=? AND timeSlot=? AND status != 'cancelled'",
    centreId,
    date,
    timeSlot
  );
}

async function isSlotAvailable(centre, date, timeSlot) {
  const slots = await bookingsForSlot(centre.id, date, timeSlot);
  return slots.length < centre.capacityPerSlot;
}

function fmtMoney(n) {
  return "₹" + Number(n).toLocaleString("en-IN");
}

// ─── Shipment / produce tracking ───

// Route from the farmer's farm to the final FCI depot.
function buildRoute(booking, farmer, centre) {
  const source = [farmer.village || "Farm", farmer.district].filter(Boolean).join(", ") || "Farm";
  const state = centre.state || "India";
  return [
    { name: source, type: "farm", km: 0, icon: "🌾" },
    { name: centre.name, type: "centre", km: 40, icon: "🏪" },
    { name: `Town Hub · ${centre.district}`, type: "hub", km: 120, icon: "🏭" },
    { name: `Regional Warehouse · ${state}`, type: "warehouse", km: 220, icon: "🏬" },
    { name: "Highway Dispatch (In Transit)", type: "transit", km: 300, icon: "🚚" },
    { name: `FCI Depot · ${state}`, type: "destination", km: 420, icon: "🏁" },
  ];
}

async function getShipment(bookingId) {
  return (await get("SELECT * FROM shipments WHERE bookingId = ?", bookingId)) || null;
}

function shipPayload(s) {
  if (!s) return null;
  let route = [];
  try { route = JSON.parse(s.route || "[]"); } catch (e) {}
  let events = [];
  try { events = JSON.parse(s.events || "[]"); } catch (e) {}
  return { ...s, route, events };
}

async function setShipmentStage(s, stage, label) {
  const events = JSON.parse(s.events || "[]");
  events.push({ stage, label, at: new Date().toISOString() });
  await run(
    "UPDATE shipments SET stage=?, events=?, updatedAt=? WHERE id=?",
    stage,
    JSON.stringify(events),
    new Date().toISOString(),
    s.id
  );
}

async function initShipment(booking, farmer) {
  const centre = await getCentre(booking.centreId);
  const route = buildRoute(booking, farmer, centre);
  const events = [{ stage: 0, label: route[0].name, at: new Date().toISOString() }];
  const id = genId("SHP");
  await run(
    "INSERT INTO shipments (id, bookingId, farmerId, commodityName, quantity, source, route, stage, totalStages, events, updatedAt, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    id, booking.id, booking.farmerId, booking.commodityName, booking.quantity,
    route[0].name, JSON.stringify(route), 0, route.length - 1, JSON.stringify(events),
    new Date().toISOString(), new Date().toISOString()
  );
  return getShipment(booking.id);
}

const STAGE_LABELS = ["Prepared at farm", "Accepted at procurement centre", "Reached town hub", "Stored at regional warehouse", "Dispatched in transit", "Delivered at FCI depot"];

// Advance (or clamp) a shipment to a given stage
async function advanceShipment(booking, minStage, via) {
  let s = await getShipment(booking.id);
  if (!s) return null;
  const target = Math.max(s.stage, Math.min(minStage, s.totalStages));
  if (target === s.stage) return shipPayload(s);
  await setShipmentStage(s, target, STAGE_LABELS[target]);
  s = await getShipment(booking.id);

  const payer = await get("SELECT * FROM farmers WHERE id = ?", booking.farmerId);
  const route = JSON.parse(s.route);
  const wp = route[target];
  if (payer && wp) {
    await notify(
      payer,
      "Shipment Update",
      `Produce tracking — ${booking.commodityName} (${booking.quantity} qtl): Stage ${target + 1}/${s.totalStages + 1} · ${STAGE_LABELS[target]} at ${wp.name}.`,
      `Kisan Setu: Your ${booking.commodityName} shipment reached ${wp.name}. (${via || "auto-update"})`
    );
  }
  return shipPayload(s);
}

// Register shipment progress when a booking crosses key milestones
async function syncShipmentStatus(booking) {
  const map = { approved: 1, paid: 5 };
  if (map[booking.status] != null) {
    await advanceShipment(booking, map[booking.status], "system update");
  }
}

// Cascade-delete a farmer account and all their data (bookings/payments/shipments/notifications)
async function deleteFarmerData(farmerId) {
  await db.exec("BEGIN");
  try {
    for (const table of ["notifications", "payments", "grievances", "centre_ratings", "shipments", "bookings"]) {
      await run(`DELETE FROM ${table} WHERE farmerId=?`, farmerId);
    }
    await run("DELETE FROM farmers WHERE id=?", farmerId);
    await db.exec("COMMIT");
  } catch (err) {
    await db.exec("ROLLBACK");
    console.error("Farmer delete error:", err);
    throw err;
  }
}

// Queue state for a centre on a date
async function queueForCentre(centreId, date) {
  const rows = await all(
    "SELECT * FROM bookings WHERE centreId=? AND date=? AND status IN ('in-queue','weighing','qc') ORDER BY queuePosition ASC",
    centreId,
    date
  );
  const centre = await getCentre(centreId);
  const avg = centre ? centre.avgMinutesPerFarmer : 10;

  const posById = {};
  rows.forEach((b, i) => {
    posById[b.id] = { index: i + 1, estWaitMin: i * avg };
  });

  return { rows, posById, avg };
}

// ─── AUTH ROUTES ───

app.post("/api/register", rateLimit(5, 10 * 60 * 1000), async (req, res) => {
  try {
    const {
      name, phone, email, aadhaar, district, village, landSize, password,
      paymentMethod, bankName, accountNumber, ifscCode, upiId,
      smsAllowed, emailAllowed,
    } = req.body;

    if (!name || !phone || !email || !password) {
      return res.status(400).json({ error: "All required fields must be filled" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    if (!/^\d{10}$/.test(String(phone))) {
      return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) {
      return res.status(400).json({ error: "Enter a valid email address" });
    }
    if (name.length > 80 || /<[^>]*>/.test(name)) {
      return res.status(400).json({ error: "Name must be free of special characters" });
    }

    // Payment details validation
    const method = paymentMethod === "upi" ? "upi" : "bank";
    if (method === "bank" && (!accountNumber || !ifscCode)) {
      return res.status(400).json({ error: "Bank Account Number and IFSC Code are required" });
    }
    if (method === "upi" && !upiId) {
      return res.status(400).json({ error: "UPI ID is required" });
    }

    const exists = await all(
      "SELECT id FROM farmers WHERE email = ? OR phone = ?",
      String(email).toLowerCase(),
      String(phone)
    );
    if (exists.length) {
      return res.status(400).json({ error: "An account with this email or phone already exists" });
    }

    const farmer = {
      id: genId("USR"),
      name,
      phone,
      email: String(email).toLowerCase(),
      aadhaar: aadhaar || "",
      district: district || "",
      village: village || "",
      landSize: landSize ? parseFloat(landSize) : 0,
      paymentMethod: method,
      bankName: method === "bank" ? bankName || "" : "",
      accountNumber: method === "bank" ? String(accountNumber).replace(/\D/g, "") : "",
      ifscCode: method === "bank" ? String(ifscCode).toUpperCase() : "",
      upiId: method === "upi" ? upiId : "",
      role: "farmer",
      password: await bcrypt.hash(password, 10),
      kyc: "pending",
      smsAllowed: smsAllowed === false || smsAllowed === "0" ? 0 : 1,
      emailAllowed: emailAllowed === false || emailAllowed === "0" ? 0 : 1,
      createdAt: new Date().toISOString(),
    };

    await run(
      "INSERT INTO farmers (id, name, phone, email, aadhaar, district, village, landSize, paymentMethod, bankName, accountNumber, ifscCode, upiId, role, password, kyc, smsAllowed, emailAllowed, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      farmer.id, farmer.name, farmer.phone, farmer.email, farmer.aadhaar,
      farmer.district, farmer.village, farmer.landSize, farmer.paymentMethod,
      farmer.bankName, farmer.accountNumber, farmer.ifscCode, farmer.upiId,
      "farmer", farmer.password, farmer.kyc, farmer.smsAllowed, farmer.emailAllowed, farmer.createdAt
    );

    req.session.userId = farmer.id;
    req.session.name = farmer.name;
    req.session.email = farmer.email;
    req.session.role = "farmer";

    await notify(
      farmer,
      "Welcome to Kisan Setu",
      `Namaste ${name}! Your farmer account is ready. Book procurement slots and track payments at kisansetu.gov.in.`,
      `Welcome to Kisan Setu! Your account is active. Book your procurement slot now. - Kisan Setu`
    );

    res.json({ success: true, role: "farmer", redirect: "/booking" });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", rateLimit(10, 60 * 1000), async (req, res) => {
  try {
    const { email, password, role } = req.body;
    if (!email || !password) return res.status(400).json({ error: "All fields are required" });

    const user = await get("SELECT * FROM farmers WHERE email = ?", String(email).toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (role && user.role !== role) {
      return res.status(401).json({ error: role === "farmer" ? "This account is not a farmer account. Please select Officer." : "This account is not an officer account. Please select Farmer." });
    }

    req.session.userId = user.id;
    req.session.name = user.name;
    req.session.email = user.email;
    req.session.role = user.role;

    res.json({ success: true, role: user.role, redirect: user.role === "farmer" ? "/booking" : "/dashboard" });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/logout", async (req, res) => {
  req.session.destroy(() => res.json({ success: true, redirect: "/" }));
});

app.get("/api/me", async (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({
      loggedIn: true,
      id: req.session.userId,
      name: req.session.name,
      email: req.session.email,
      role: req.session.role,
    });
  }
  res.json({ loggedIn: false });
});

// ─── NOTIFICATIONS ───

app.get("/api/notifications", requireAuth, async (req, res) => {
  res.json(await all("SELECT * FROM notifications WHERE farmerId=? ORDER BY createdAt DESC", req.session.userId));
});

app.post("/api/notifications/read", requireAuth, async (req, res) => {
  await run("UPDATE notifications SET read=1 WHERE farmerId=?", req.session.userId);
  res.json({ success: true });
});

// Officer: send a test SMS to any verified mobile number
app.post("/api/sms/test", requireOfficer, rateLimit(3, 10 * 60 * 1000), async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{10}$/.test(String(phone))) {
    return res.status(400).json({ error: "Enter a valid 10-digit mobile number" });
  }
  const r = await sendSms(
    phone,
    "This is a test SMS from Kisan Setu. Farmer procurement notifications are working! - Kisan Setu"
  );
  await audit("sms.test", phone, r.delivered ? "delivered" : r.demo ? "demo" : r.skipped ? "skipped" : "failed");
  res.json({ success: true, ...r });
});

// ─── CENTRES ───

app.get("/api/centres", async (req, res) => {
  const rows = await all("SELECT * FROM centres ORDER BY district");
  const out = [];
  for (const c of rows) {
    const ratingAvg = await get("SELECT ROUND(AVG(rating),1) AS r FROM centre_ratings WHERE centreId=?", c.id);
    const ratingCount = await get("SELECT COUNT(*) AS n FROM centre_ratings WHERE centreId=?", c.id);
    out.push({
      ...c,
      slots: timeSlots(c),
      ratingAvg: ratingAvg ? ratingAvg.r : null,
      ratingCount: ratingCount ? ratingCount.n : 0,
    });
  }
  res.json(out);
});

app.post("/api/centres", requireOfficer, async (req, res) => {
  const { name, district, state, address, contact, capacityPerSlot, avgMinutesPerFarmer, startHour, endHour } = req.body;
  if (!name || !district) return res.status(400).json({ error: "Name and district required" });

  const centre = {
    id: genId("CTR"),
    name,
    district,
    state: state || "",
    address: address || "",
    contact: contact || "",
    officer: req.session.name,
    capacityPerSlot: parseInt(capacityPerSlot) || 8,
    avgMinutesPerFarmer: parseInt(avgMinutesPerFarmer) || 10,
    startHour: parseInt(startHour) || 8,
    endHour: parseInt(endHour) || 17,
  };

  const id = await run(
    "INSERT INTO centres (id, name, district, state, address, contact, officer, capacityPerSlot, avgMinutesPerFarmer, startHour, endHour) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    centre.id, centre.name, centre.district, centre.state, centre.address,
    centre.contact, centre.officer, centre.capacityPerSlot, centre.avgMinutesPerFarmer, centre.startHour, centre.endHour
  ).id;
  await audit("centre.create", id, `${centre.name} (${centre.district})`);

  res.json({ success: true, centre: { ...centre, id } });
});

// ─── COMMODITIES ───

app.get("/api/commodities", async (req, res) => {
  res.json(await all("SELECT * FROM commodities WHERE active=1 ORDER BY category, name"));
});

app.post("/api/commodities", requireOfficer, async (req, res) => {
  const { name, category, msp, season } = req.body;
  if (!name || !msp) return res.status(400).json({ error: "Name and MSP required" });

  const commodity = {
    id: genId("COM"),
    name,
    category: category || "Cereal",
    msp: parseFloat(msp),
    unit: "quintal",
    season: season || "",
    active: 1,
  };

  const id = await run(
    "INSERT INTO commodities (id, name, category, msp, unit, season, active) VALUES (?,?,?,?,?,?,1)",
    commodity.id, commodity.name, commodity.category, commodity.msp, commodity.unit, commodity.season
  ).id;
  await audit("commodity.create", id, `${commodity.name} @ Rs.${commodity.msp}`);
  res.json({ success: true, commodity: { ...commodity, id } });
});

// ─── COMMODITY AVAILABLE DATES ───

app.get("/api/commodity-dates", requireAuth, async (req, res) => {
  const { commodityId, month } = req.query;
  if (!commodityId || !month) return res.status(400).json({ error: "commodityId and month (YYYY-MM) required" });
  const rows = await all(
    "SELECT id, commodityId, date, centreId FROM commodity_dates WHERE commodityId=? AND date LIKE ? ORDER BY date",
    commodityId, month + "%"
  );
  res.json(rows);
});

app.post("/api/commodity-dates", requireOfficer, async (req, res) => {
  try {
    const { commodityId, dates, centreId } = req.body;
    if (!commodityId || !Array.isArray(dates) || !dates.length) {
      return res.status(400).json({ error: "commodityId and dates array required" });
    }
    const commodity = await get("SELECT * FROM commodities WHERE id = ?", commodityId);
    if (!commodity) return res.status(400).json({ error: "Invalid commodity" });

    const added = [];
    for (const d of dates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const existing = await get(
        "SELECT id FROM commodity_dates WHERE commodityId=? AND date=?",
        commodityId, d
      );
      if (!existing) {
        const id = genId("CDT");
        await run(
          "INSERT INTO commodity_dates (id, commodityId, date, centreId, createdAt) VALUES (?,?,?,?,?)",
          id, commodityId, d, centreId || null, new Date().toISOString()
        );
        added.push({ id, date: d });
      }
    }
    await audit("commodity_dates.set", commodityId, `${commodity.name}: ${added.length} dates added`);
    res.json({ success: true, added });
  } catch (err) {
    console.error("Commodity dates error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/commodity-dates/:id", requireOfficer, async (req, res) => {
  try {
    const row = await get("SELECT * FROM commodity_dates WHERE id = ?", req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    await run("DELETE FROM commodity_dates WHERE id = ?", req.params.id);
    await audit("commodity_dates.remove", row.commodityId, `Date ${row.date} removed`);
    res.json({ success: true });
  } catch (err) {
    console.error("Commodity date delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/commodity-dates", requireOfficer, async (req, res) => {
  try {
    const { commodityId, date } = req.body;
    if (!commodityId || !date) return res.status(400).json({ error: "commodityId and date required" });
    await run(
      "DELETE FROM commodity_dates WHERE commodityId=? AND date=?",
      commodityId, date
    );
    await audit("commodity_dates.remove", commodityId, `Date ${date} removed`);
    res.json({ success: true });
  } catch (err) {
    console.error("Commodity date delete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── BOOKING ROUTES ───

app.post("/api/bookings", requireFarmer, rateLimit(20, 10 * 60 * 1000), async (req, res) => {
  try {
    const { centreId, commodityId, date, timeSlot, quantity, grade } = req.body;

    const centre = await getCentre(centreId);
    const commodity = await get("SELECT * FROM commodities WHERE id = ?", commodityId);

    if (!centre) return res.status(400).json({ error: "Invalid centre selected" });
    if (!commodity) return res.status(400).json({ error: "Invalid commodity selected" });
    if (!commodity.active) return res.status(400).json({ error: "Procurement not open for this commodity" });
    if (!date || !timeSlot) return res.status(400).json({ error: "Date and time slot are required" });
    if (!quantity || quantity <= 0) return res.status(400).json({ error: "Enter a valid quantity" });
    if (!timeSlots(centre).includes(timeSlot)) return res.status(400).json({ error: "Invalid time slot" });

    // Check commodity available dates
    const commodityDate = await get(
      "SELECT id FROM commodity_dates WHERE commodityId=? AND date=?",
      commodityId, date
    );
    if (!commodityDate) {
      return res.status(400).json({ error: `${commodity.name} is not available for procurement on this date. Please select a valid date.`, dateRestricted: true });
    }

    const selDate = new Date(date + "T00:00:00");
    if (isNaN(selDate)) return res.status(400).json({ error: "Invalid date" });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (selDate < today) return res.status(400).json({ error: "You cannot book a past date" });

    // Enforce the officer-set daily capacity per centre
    const slots = Math.max(1, centre.endHour - centre.startHour);
    const dailyCap = centre.dailyCapacity ? centre.dailyCapacity : slots * centre.capacityPerSlot;
    const bookedDay = (
      await get(
        "SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND date=? AND status != 'cancelled'",
        centre.id, date
      )
    ).n;
    if (bookedDay >= dailyCap) {
      return res.status(400).json({ error: "This centre is fully booked for the day. Please try another date.", dayFull: true });
    }

    const isAvail = await isSlotAvailable(centre, date, timeSlot);
    if (!isAvail) {
      return res.status(400).json({ error: "This slot is full. Please choose another time slot.", slotFull: true });
    }

    const estAmount = parseFloat((quantity * commodity.msp).toFixed(2));

    const booking = {
      id: genId("BKG"),
      farmerId: req.session.userId,
      farmerName: req.session.name,
      centreId: centre.id,
      centreName: centre.name,
      commodityId: commodity.id,
      commodityName: commodity.name,
      msp: commodity.msp,
      date,
      timeSlot,
      quantity: parseFloat(quantity),
      grade: grade || "A",
      estAmount,
      status: "booked",
      queuePosition: null,
      createdAt: new Date().toISOString(),
    };

    await run(
      "INSERT INTO bookings (id, farmerId, farmerName, centreId, centreName, commodityId, commodityName, msp, date, timeSlot, quantity, grade, estAmount, status, queuePosition, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      booking.id, booking.farmerId, booking.farmerName, booking.centreId, booking.centreName,
      booking.commodityId, booking.commodityName, booking.msp, booking.date, booking.timeSlot,
      booking.quantity, booking.grade, booking.estAmount, booking.status, null, booking.createdAt
    );

    const farmer = await get("SELECT * FROM farmers WHERE id = ?", req.session.userId);
    await initShipment(booking, farmer);
    await notify(
      farmer,
      "Procurement Slot Confirmed",
      `Your slot for ${booking.commodityName} is confirmed at ${booking.centreName} on ${booking.date} (${booking.timeSlot}). Show this booking on arrival.`,
      `Kisan Setu: Slot confirmed for ${booking.commodityName} at ${booking.centreName} on ${booking.date} (${booking.timeSlot}).`
    );

    res.json({ success: true, booking, shipment: shipPayload(await getShipment(booking.id)) });
  } catch (err) {
    console.error("Booking error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/bookings/my", requireFarmer, async (req, res) => {
  const bookings = await all(
    "SELECT b.*, s.route AS shipRoute, s.stage AS shipStage, s.totalStages AS shipTotal, s.events AS shipEvents, s.updatedAt AS shipUpdated FROM bookings b LEFT JOIN shipments s ON s.bookingId = b.id WHERE b.farmerId=? ORDER BY b.createdAt DESC",
    req.session.userId
  );

  const result = [];
  for (const b of bookings) {
    const q = await queueForCentre(b.centreId, b.date);
    const pos = q.posById[b.id] || null;
    let route = [], events = [];
    try { route = JSON.parse(b.shipRoute || "[]"); } catch (e) {}
    try { events = JSON.parse(b.shipEvents || "[]"); } catch (e) {}
    const { shipRoute, shipEvents, ...rest } = b;
    result.push({
      ...rest,
      queueIndex: pos ? pos.index : null,
      estWaitMin: pos ? pos.estWaitMin : null,
      shipment: rest.shipStage != null ? { route, stage: b.shipStage, totalStages: b.shipTotal, events, updatedAt: b.shipUpdated } : null,
    });
  }

  res.json(result);
});

// Public: slot availability for a centre on a date
app.get("/api/slots/availability", async (req, res) => {
  const { centreId, date } = req.query;
  const centre = await getCentre(centreId);
  if (!centre || !date) return res.status(400).json({ error: "centreId and date required" });
  const info = [];
  for (const timeSlot of timeSlots(centre)) {
    const cnt = (await bookingsForSlot(centreId, date, timeSlot)).length;
    info.push({
      timeSlot,
      booked: cnt,
      capacity: centre.capacityPerSlot,
      available: cnt < centre.capacityPerSlot,
    });
  }
  res.json({ centreId, date, slots: info });
});

app.get("/api/queue", async (req, res) => {
  const centreId = req.query.centreId;
  const date = req.query.date || new Date().toISOString().split("T")[0];
  if (!centreId) return res.status(400).json({ error: "centreId required" });

  const q = await queueForCentre(centreId, date);

  res.json({
    centreId,
    date,
    queueLength: q.rows.length,
    rows: q.rows.map((b) => ({
      id: b.id,
      farmerName: b.farmerName,
      commodityName: b.commodityName,
      quantity: b.quantity,
      status: b.status,
      queuePosition: b.queuePosition,
      estWaitMin: (q.posById[b.id]?.index - 1) * q.avg,
    })),
  });
});

// Public: per-centre load for a date, sorted least-busy first (smart suggestions)
app.get("/api/centres/load", async (req, res) => {
  const date = req.query.date || new Date().toISOString().split("T")[0];
  const rawCentres = await all("SELECT * FROM centres ORDER BY district");
  const centres = [];
  for (const c of rawCentres) {
    const slots = Math.max(1, c.endHour - c.startHour);
    const capacityTotal = slots * c.capacityPerSlot;
    const booked = (await get(
      "SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND date=? AND status != 'cancelled'",
      c.id,
      date
    )).n;
    const load = capacityTotal ? Math.round((booked / capacityTotal) * 100) : 0;
    centres.push({
      id: c.id,
      name: c.name,
      district: c.district,
      state: c.state,
      slots,
      capacityPerSlot: c.capacityPerSlot,
      capacityTotal,
      booked,
      free: Math.max(0, capacityTotal - booked),
      load,
    });
  }
  centres.sort((a, b) => a.load - b.load);
  res.json({ date, centres });
});

// Officer: list bookings (optionally filtered by centre/date/status)
app.get("/api/bookings", requireOfficer, async (req, res) => {
  const { centreId, date, status } = req.query;
  let sql = "SELECT b.*, f.paymentMethod AS farmerPaymentMethod, f.bankName AS farmerBankName, f.accountNumber AS farmerAccountNumber, f.ifscCode AS farmerIfscCode, f.upiId AS farmerUpiId, s.stage AS shipStage, s.totalStages AS shipTotal FROM bookings b LEFT JOIN farmers f ON b.farmerId = f.id LEFT JOIN shipments s ON s.bookingId = b.id WHERE 1=1";
  const params = [];

  if (centreId) { sql += " AND b.centreId=?"; params.push(centreId); }
  if (date) { sql += " AND b.date=?"; params.push(date); }
  if (status) { sql += " AND b.status=?"; params.push(status); }
  sql += " ORDER BY b.createdAt DESC";

  let bookings = await all(sql, ...params);

  if (centreId && date) {
    const q = await queueForCentre(centreId, date);
    bookings = bookings.map((b) => ({
      ...b,
      queueIndex: q.posById[b.id] ? q.posById[b.id].index : null,
      estWaitMin: q.posById[b.id] ? q.posById[b.id].estWaitMin : null,
    }));
  }

  const today = new Date().toISOString().split("T")[0];
  bookings = bookings.map((b) => ({ ...b, today: b.date === today }));
  res.json(bookings);
});

// Officer: check-in a farmer → assign queue position
app.post("/api/bookings/:id/checkin", requireOfficer, async (req, res) => {
  const booking = await get("SELECT * FROM bookings WHERE id = ?", req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const inQueue = await all(
    "SELECT * FROM bookings WHERE centreId=? AND date=? AND status IN ('in-queue','weighing','qc')",
    booking.centreId,
    booking.date
  );

  const nextPosition = inQueue.length
    ? Math.max(...inQueue.map((b) => b.queuePosition || 0)) + 1
    : 1;

  await run("UPDATE bookings SET status='in-queue', queuePosition=? WHERE id=?", nextPosition, booking.id);
  await audit("checkin", booking.id, `${booking.farmerName} → queue #${nextPosition}`);

  const farmer = await get("SELECT * FROM farmers WHERE id = ?", booking.farmerId);
  await notify(
    farmer,
    "Check-in Successful",
    `You are checked in at ${booking.centreName}. Your queue number is #${nextPosition}. Estimated wait: ${Math.max(0, (nextPosition - 1) * 10)} minutes.`,
    `Kisan Setu: Check-in done at ${booking.centreName}. Your queue number is #${nextPosition}. Estimated wait: ${Math.max(0, (nextPosition - 1) * 10)} min.`
  );

  res.json({ success: true, booking: { ...booking, status: "in-queue", queuePosition: nextPosition } });
});

// Officer: update booking status (weighing / qc / approved / rejected / cancelled)
app.patch("/api/bookings/:id/status", requireOfficer, async (req, res) => {
  const { status } = req.body;
  const allowed = ["booked", "in-queue", "weighing", "qc", "approved", "rejected", "cancelled"];
  if (!allowed.includes(status)) return res.status(400).json({ error: "Invalid status" });

  const booking = await get("SELECT * FROM bookings WHERE id = ?", req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });

  const feedback = (req.body.feedback && String(req.body.feedback).trim()) || "";
  const isCancelLike = status === "cancelled" || status === "rejected";
  const removeFarmer = isCancelLike && !!req.body.removeFarmer;

  await run("UPDATE bookings SET status=? WHERE id=?", status, booking.id);
  await audit("status", booking.id, `${booking.farmerName} → ${status}`);

  const farmer = await get("SELECT * FROM farmers WHERE id = ?", booking.farmerId);
  const defaultMsg = {
    "in-queue": "Your procurement has started and you are now in the queue.",
    "weighing": "Your produce is being weighed now.",
    "qc": "Your produce is under quality inspection.",
    "approved": `Your produce has been approved. Payment will be released after the officer completes the payout.`,
    "rejected": "Your produce was rejected at the centre. Please contact the procurement officer.",
    "cancelled": "Your booking was cancelled.",
    "booked": "Your booking is confirmed.",
  }[status];
  const smsMap = {
    "weighing": `Kisan Setu: Your ${booking.commodityName} is being weighed at ${booking.centreName}.`,
    "qc": `Kisan Setu: Your ${booking.commodityName} is under quality inspection.`,
    "approved": `Kisan Setu: Your ${booking.commodityName} approved! Payment will be released after the officer completes the payout.`,
    "rejected": `Kisan Setu: Your ${booking.commodityName} was rejected at the centre. Contact the procurement officer.`,
  }[status];

  // A custom feedback message replaces the generic message on cancel / reject
  const msg = feedback && isCancelLike ? feedback : defaultMsg;
  const smsText = feedback && isCancelLike ? `Kisan Setu: ${feedback}` : smsMap;

  if (farmer && msg) await notify(farmer, `Update: ${booking.commodityName}`, msg, smsText);

  await syncShipmentStatus({ ...booking, status });

  const freshBooking = await get("SELECT * FROM bookings WHERE id = ?", booking.id);

  let removed = false, removedName = null;
  if (removeFarmer && farmer) {
    await deleteFarmerData(farmer.id);
    await audit("farmer.remove", farmer.id, `after ${status}${feedback ? ` — ${feedback}` : " (no reason given)"}`);
    removed = true;
    removedName = farmer.name;
  }

  res.json({ success: true, booking: freshBooking, removed, removedName });
});

// Officer: mark payment as paid
app.post("/api/bookings/:id/pay", requireOfficer, async (req, res) => {
  const { transactionRef, paymentMode } = req.body;

  const booking = await get("SELECT * FROM bookings WHERE id = ?", req.params.id);
  if (!booking) return res.status(404).json({ error: "Booking not found" });
  if (booking.status !== "approved") {
    return res.status(400).json({ error: "Booking must be approved before payment" });
  }

  let payment = await get("SELECT * FROM payments WHERE bookingId=?", booking.id);
  if (!payment) {
    const id = genId("PAY");
    await run(
      "INSERT INTO payments (id, bookingId, farmerId, commodityName, quantity, amount, status, paymentMode, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
      id, booking.id, booking.farmerId, booking.commodityName, booking.quantity,
      booking.estAmount, "processing", paymentMode || "Draft / Bank Transfer", new Date().toISOString()
    );
    payment = await get("SELECT * FROM payments WHERE bookingId=?", booking.id);
  }

  const ref = transactionRef || "DEMO-" + Date.now().toString().slice(-6);
  await run(
    "UPDATE payments SET status='paid', transactionRef=?, paymentMode=?, paidAt=? WHERE id=?",
    ref, paymentMode || payment.paymentMode, new Date().toISOString(), payment.id
  );
  await run("UPDATE bookings SET status='paid' WHERE id=?", booking.id);
  await audit("payment", booking.id, `${booking.farmerName} → Rs.${Number(payment.amount || 0).toLocaleString("en-IN")} (${ref})`);

  const farmer = await get("SELECT * FROM farmers WHERE id = ?", booking.farmerId);
  const amount = payment.amount;
  const payDestination =
    farmer.paymentMethod === "upi"
      ? `UPI ${farmer.upiId}`
      : `bank A/c ${farmer.bankName ? farmer.bankName + " " : ""}${(farmer.accountNumber || "").slice(-4).padStart(4, "•") && "••••" + (farmer.accountNumber || "").slice(-4)}`;
  await notify(
    farmer,
    "Payment Successful",
    `Payment of ${fmtMoney(amount)} for ${booking.commodityName} has been credited to your ${payDestination}. Ref: ${ref}.`,
    `Kisan Setu: Payment of ${fmtMoney(amount)} for ${booking.commodityName} credited to your ${payDestination}. Ref: ${ref}.`
  );

  await syncShipmentStatus({ ...booking, status: "paid" });

  const fresh = await get("SELECT * FROM bookings WHERE id = ?", booking.id);
  res.json({ success: true, booking: fresh, payment: { ...payment, status: "paid", transactionRef: ref } });
});

// ─── SHIPMENT TRACKING ───

// Officer: list shipments (with booking context)
app.get("/api/shipments", requireOfficer, async (req, res) => {
  const rows = await all(
    "SELECT s.*, b.farmerName, b.centreName, b.date, b.status AS bookingStatus FROM shipments s JOIN bookings b ON b.id = s.bookingId ORDER BY s.updatedAt DESC"
  );
  res.json(rows.map((r) => shipPayload(r)));
});

// View a single shipment (farmer own or officer)
app.get("/api/shipments/:bookingId", requireAuth, async (req, res) => {
  const s = await getShipment(req.params.bookingId);
  if (!s) return res.status(404).json({ error: "Shipment not found" });
  if (req.session.userId !== s.farmerId && req.session.role !== "officer") {
    return res.status(403).json({ error: "Forbidden" });
  }
  res.json(shipPayload(s));
});

// Officer: advance a shipment to the next stage
app.post("/api/shipments/:bookingId/advance", requireOfficer, async (req, res) => {
  const bookingId = req.params.bookingId;
  let s = await getShipment(bookingId);
  if (!s) return res.status(404).json({ error: "Shipment not found" });
  if (s.stage >= s.totalStages) {
    return res.status(400).json({ error: "Shipment already delivered" });
  }
  const booking = await get("SELECT * FROM bookings WHERE id = ?", bookingId);
  const payload = await advanceShipment(booking, s.stage + 1, "officer update");
  await audit("shipment.advance", bookingId, `stage ${s.stage} → ${payload.stage}`);
  res.json({ success: true, shipment: payload });
});

// ─── PAYMENTS ───

app.get("/api/payments/my", requireFarmer, async (req, res) => {
  res.json(
    await all("SELECT * FROM payments WHERE farmerId=? ORDER BY createdAt DESC", req.session.userId)
  );
});

// ─── FARMER REGISTER (officer) ───

app.get("/api/farmers", requireOfficer, async (req, res) => {
  const rows = await all(
    `SELECT f.id, f.name, f.phone, f.email, f.district, f.village, f.landSize, f.paymentMethod, f.bankName, f.ifscCode, f.upiId, f.kyc, f.createdAt,
      (SELECT COUNT(*) FROM bookings b WHERE b.farmerId = f.id) AS bookingCount,
      (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.farmerId = f.id AND p.status='paid') AS paidAmount
     FROM farmers f WHERE f.role='farmer' ORDER BY f.createdAt DESC`
  );
  res.json(rows);
});

// Officer: delete a farmer account AND all their data (bookings/payments/shipments/notifications)
app.delete("/api/farmers/:id", requireOfficer, async (req, res) => {
  const farmer = await get("SELECT * FROM farmers WHERE id=? AND role='farmer'", req.params.id);
  if (!farmer) return res.status(404).json({ error: "Farmer not found or not a farmer account" });

  const reason = (req.body && req.body.reason && String(req.body.reason).trim()) || "";
  try {
    await deleteFarmerData(farmer.id);
  } catch (err) {
    return res.status(500).json({ error: "Delete failed" });
  }

  await audit("farmer.delete", farmer.id, reason ? `${farmer.name} — ${reason}` : farmer.name);
  res.json({ success: true, id: farmer.id, name: farmer.name });
});

// ─── SMS LOG (officer) ───

app.get("/api/sms/log", requireOfficer, async (req, res) => {
  res.json(await all("SELECT * FROM sms_log ORDER BY createdAt DESC LIMIT 200"));
});

// ─── MARKET PRICES (MSP vs APMC mandi) ───

app.get("/api/prices", async (req, res) => {
  const rows = await all(
    `SELECT mp.commodityId, mp.commodityName, mp.unit, mp.msp, mp.mandi, mp.district, mp.updatedAt
       FROM market_prices mp
      WHERE EXISTS (SELECT 1 FROM commodities c WHERE c.id = mp.commodityId AND c.active = 1)
      ORDER BY mp.commodityName, mp.district`
  );
  const group = {};
  rows.forEach((r) => {
    if (!group[r.commodityId]) group[r.commodityId] = { commodityId: r.commodityId, commodityName: r.commodityName, unit: r.unit, msp: r.msp, districts: [] };
    group[r.commodityId].districts.push({ district: r.district, mandi: r.mandi });
  });
  res.json({ updatedAt: rows.length ? rows[0].updatedAt : null, commodities: Object.values(group) });
});

app.get("/api/prices/:commodityId", async (req, res) => {
  const rows = await all(
    "SELECT commodityId, commodityName, unit, msp, mandi, district FROM market_prices WHERE commodityId=?",
    req.params.commodityId
  );
  if (!rows.length) return res.status(404).json({ error: "Commodity not found" });
  res.json(rows);
});

app.post("/api/prices/update", requireOfficer, async (req, res) => {
  try {
    const { commodityId, msp, district, mandi } = req.body;
    if (!commodityId) return res.status(400).json({ error: "commodityId required" });
    if (!msp && !mandi) return res.status(400).json({ error: "msp or mandi price required" });
    const commodity = await get("SELECT * FROM commodities WHERE id=?", commodityId);
    if (!commodity) return res.status(404).json({ error: "Commodity not found" });
    const now = new Date().toISOString();
    if (msp) {
      await run("UPDATE commodities SET msp=? WHERE id=?", parseFloat(msp), commodity.id);
      await run("UPDATE market_prices SET msp=?, updatedAt=? WHERE commodityId=?", parseFloat(msp), now, commodity.id);
    }
    if (district && mandi) {
      await run("UPDATE market_prices SET mandi=?, msp=COALESCE(?,msp), updatedAt=? WHERE commodityId=? AND district=?", parseFloat(mandi), msp ? parseFloat(msp) : null, now, commodity.id, district);
    }
    await audit("prices.update", commodity.id, `${commodity.name}: MSP=${msp || commodity.msp}${district ? ", " + district + "=" + mandi : ""}`);
    res.json({ success: true });
  } catch (err) {
    console.error("Price update error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ─── PROFILE + PREFERENCES (farmer) ───

app.get("/api/profile", requireAuth, async (req, res) => {
  const f = await get("SELECT id, name, phone, email, aadhaar, district, village, landSize, paymentMethod, bankName, accountNumber, ifscCode, upiId, kyc, smsAllowed, emailAllowed, createdAt FROM farmers WHERE id=?", req.session.userId);
  if (!f) return res.status(404).json({ error: "Not found" });
  const safe = { ...f, accountNumber: f.accountNumber ? "••••" + f.accountNumber.slice(-4) : "" };
  res.json(safe);
});

app.patch("/api/profile/prefs", requireAuth, async (req, res) => {
  const { smsAllowed, emailAllowed } = req.body;
  await run("UPDATE farmers SET smsAllowed=?, emailAllowed=? WHERE id=?",
    smsAllowed === false || smsAllowed === "0" ? 0 : 1,
    emailAllowed === false || emailAllowed === "0" ? 0 : 1,
    req.session.userId);
  res.json({ success: true });
});

// ─── KYC ───

app.post("/api/kyc/submit", requireFarmer, async (req, res) => {
  try {
    const { docType, docData } = req.body;
    if (!docType || !docData) return res.status(400).json({ error: "Document type and data are required" });
    const allowed = ["aadhaar", "pan", "voterId", "drivingLicence", "passport"];
    if (!allowed.includes(docType)) return res.status(400).json({ error: "Invalid document type" });
    if (!docData.startsWith("data:image/")) return res.status(400).json({ error: "Document must be an image (base64 data URL)" });
    if (docData.length > 5 * 1024 * 1024) return res.status(400).json({ error: "Document too large (max 5MB)" });

    await run(
      "UPDATE farmers SET kycDocType=?, kycDocData=?, kyc='pending', kycNotes='' WHERE id=?",
      docType, docData, req.session.userId
    );
    await audit("kyc.submit", req.session.userId, `Document submitted: ${docType}`);
    res.json({ success: true, kyc: "pending" });
  } catch (err) {
    console.error("KYC submit error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/kyc/status", requireFarmer, async (req, res) => {
  try {
    const f = await get(
      "SELECT kyc, kycDocType, kycNotes, kycVerifiedBy, kycVerifiedAt FROM farmers WHERE id=?",
      req.session.userId
    );
    if (!f) return res.status(404).json({ error: "Farmer not found" });
    res.json({
      kyc: f.kyc,
      docType: f.kycDocType || "",
      hasDoc: false,
      notes: f.kycNotes || "",
      verifiedBy: f.kycVerifiedBy || "",
      verifiedAt: f.kycVerifiedAt || "",
    });
  } catch (err) {
    console.error("KYC status error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.get("/api/kyc/:id/doc", requireOfficer, async (req, res) => {
  try {
    const f = await get(
      "SELECT kycDocType, kycDocData FROM farmers WHERE id=? AND role='farmer'",
      req.params.id
    );
    if (!f || !f.kycDocData) return res.status(404).json({ error: "No document" });
    res.json({ docType: f.kycDocType, docData: f.kycDocData });
  } catch (err) {
    console.error("KYC doc error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/farmers/:id/kyc", requireOfficer, async (req, res) => {
  const { kyc, notes } = req.body;
  if (!["verified", "rejected", "pending"].includes(kyc)) {
    return res.status(400).json({ error: "kyc must be verified | rejected | pending" });
  }
  const f = await get("SELECT * FROM farmers WHERE id=? AND role='farmer'", req.params.id);
  if (!f) return res.status(404).json({ error: "Farmer not found" });
  const officerName = req.session.name || "Officer";
  await run(
    "UPDATE farmers SET kyc=?, kycNotes=?, kycVerifiedBy=?, kycVerifiedAt=? WHERE id=?",
    kyc, notes || f.kycNotes || "", kyc === "verified" || kyc === "rejected" ? officerName : "", kyc === "verified" || kyc === "rejected" ? new Date().toISOString() : "", f.id
  );
  await audit("farmer.kyc", f.id, `${f.name} → ${kyc}${notes ? " — " + notes : ""}`);
  res.json({ success: true, kyc });
});

// ─── AUDIT LOG (officer) ───

app.get("/api/audit", requireOfficer, async (req, res) => {
  const q = req.query.action || "";
  const rows = q
    ? await all("SELECT * FROM audit_log WHERE action=? ORDER BY createdAt DESC LIMIT 200", q)
    : await all("SELECT * FROM audit_log ORDER BY createdAt DESC LIMIT 200");
  res.json(rows);
});

// ─── GRIEVANCES ───

app.post("/api/grievances", requireFarmer, rateLimit(3, 10 * 60 * 1000), async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) return res.status(400).json({ error: "Subject and message are required" });
  if (String(subject).length > 120 || String(message).length > 1000 || /<[^>]*>/.test(subject + message)) {
    return res.status(400).json({ error: "Keep it under 1000 chars, no HTML" });
  }
  const farmer = await get("SELECT * FROM farmers WHERE id=?", req.session.userId);
  const g = {
    id: genId("GRV"),
    farmerId: farmer.id,
    farmerName: farmer.name,
    subject: String(subject).slice(0, 120),
    message: String(message).slice(0, 1000),
    status: "open",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await run("INSERT INTO grievances (id, farmerId, farmerName, subject, message, status, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)",
    g.id, g.farmerId, g.farmerName, g.subject, g.message, g.status, g.createdAt, g.updatedAt);
  await notify(farmer, "Grievance Received",
    `We have registered your complaint "${g.subject}". Your ticket ID is ${g.id}. An officer will respond shortly.`,
    `Kisan Setu: Complaint "${g.subject}" registered. Ticket ${g.id}. We will respond shortly.`);
  res.json({ success: true, grievance: g });
});

app.get("/api/grievances/my", requireFarmer, async (req, res) => {
  res.json(await all("SELECT * FROM grievances WHERE farmerId=? ORDER BY createdAt DESC", req.session.userId));
});

app.get("/api/grievances", requireOfficer, async (req, res) => {
  const status = req.query.status || "";
  const rows = status
    ? await all("SELECT * FROM grievances WHERE status=? ORDER BY createdAt DESC LIMIT 200", status)
    : await all("SELECT * FROM grievances ORDER BY createdAt DESC LIMIT 200");
  res.json(rows);
});

app.post("/api/grievances/:id", requireOfficer, async (req, res) => {
  const { status, officerNote } = req.body;
  if (!["open", "in-progress", "resolved", "closed"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const g = await get("SELECT * FROM grievances WHERE id=?", req.params.id);
  if (!g) return res.status(404).json({ error: "Grievance not found" });
  const note = String(officerNote || "").slice(0, 500);
  await run("UPDATE grievances SET status=?, officerNote=?, updatedAt=? WHERE id=?",
    status, note, new Date().toISOString(), g.id);
  const farmer = await get("SELECT * FROM farmers WHERE id=?", g.farmerId);
  if (farmer) {
    const noteTxt = note ? ` Officer's note: ${note}` : "";
    await notify(farmer, "Grievance Update",
      `Your ticket ${g.id} ("${g.subject}") is now marked ${status}.${noteTxt}`,
      `Kisan Setu: Ticket ${g.id} status: ${status}.${noteTxt}`);
  }
  await audit("grievance", g.id, `${g.farmerName} → ${status}`);
  const freshGrievance = await get("SELECT * FROM grievances WHERE id=?", g.id);
  res.json({ success: true, grievance: freshGrievance });
});

// ─── CENTRE RATINGS ───

app.post("/api/ratings", requireFarmer, async (req, res) => {
  const { centreId, rating, comment } = req.body;
  const r = parseInt(rating);
  if (!centreId || !Number.isInteger(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: "Rating must be a whole number 1-5" });
  }
  const hasBooking = await get("SELECT id FROM bookings WHERE farmerId=? AND centreId=? LIMIT 1", req.session.userId, centreId);
  if (!hasBooking) return res.status(403).json({ error: "You can only rate a centre you've booked at" });
  const seen = await get("SELECT id FROM centre_ratings WHERE farmerId=?", req.session.userId);
  if (seen) return res.status(400).json({ error: "You have already rated a centre" });
  const id = genId("RAT");
  await run("INSERT INTO centre_ratings (id, farmerId, centreId, rating, comment, createdAt) VALUES (?,?,?,?,?,?)",
    id, req.session.userId, centreId, r, String(comment || "").slice(0, 200), new Date().toISOString());
  res.json({ success: true, id, rating: r });
});

// ─── CENTRE CAPACITY (officer) ───

app.post("/api/centres/:id/capacity", requireOfficer, async (req, res) => {
  const cap = parseInt(req.body.dailyCapacity);
  if (!Number.isInteger(cap) || cap < 1 || cap > 10000) {
    return res.status(400).json({ error: "dailyCapacity must be a positive number" });
  }
  const c = await getCentre(req.params.id);
  if (!c) return res.status(404).json({ error: "Centre not found" });
  await run("UPDATE centres SET dailyCapacity=? WHERE id=?", cap, c.id);
  await audit("centre.capacity", c.id, `${c.name} → ${cap}/day`);
  res.json({ success: true, centre: { ...await getCentre(c.id), dailyCapacity: cap } });
});

// ─── SLOT REMINDER (officer) ───

app.post("/api/bookings/:id/remind", requireOfficer, async (req, res) => {
  const b = await get("SELECT * FROM bookings WHERE id=?", req.params.id);
  if (!b) return res.status(404).json({ error: "Booking not found" });
  const farmer = await get("SELECT * FROM farmers WHERE id=?", b.farmerId);
  if (!farmer) return res.status(404).json({ error: "Farmer not found" });
  await run("UPDATE bookings SET reminderSent=1 WHERE id=?", b.id);
  await notify(farmer, "Slot Reminder",
    `Reminder: your ${b.commodityName} procurement slot at ${b.centreName} is today ${b.timeSlot}. Please carry a valid ID.`,
    `Kisan Setu: Reminder — ${b.commodityName} slot at ${b.centreName} today ${b.timeSlot}. Carry valid ID.`);
  await audit("reminder", b.id, b.farmerName);
  res.json({ success: true, reminded: true });
});

// ─── PAYMENTS: UPI QR + RECEIPT ───

function upiLink(farmer, payment, ref) {
  const pa = encodeURIComponent(farmer.upiId || "");
  const pn = encodeURIComponent((farmer.name || "").slice(0, 30));
  const am = Number(payment.amount || 0).toFixed(2);
  const tn = encodeURIComponent(ref || payment.id);
  return `upi://pay?pa=${pa}&pn=${pn}&am=${am}&tn=${tn}&cu=INR`;
}

async function ownedPayment(req, paymentId) {
  const p = await get("SELECT * FROM payments WHERE id=?", paymentId);
  if (!p) return { error: { status: 404, msg: "Payment not found" } };
  if (req.session.role !== "officer" && p.farmerId !== req.session.userId) {
    return { error: { status: 403, msg: "Forbidden" } };
  }
  return { payment: p };
}

app.get("/api/payments/:id/upi-link", requireAuth, async (req, res) => {
  const { payment, error } = await ownedPayment(req, req.params.id);
  if (error) return res.status(error.status).json({ error: error.msg });
  const farmer = await get("SELECT * FROM farmers WHERE id=?", payment.farmerId);
  if (!farmer || !farmer.upiId) return res.status(400).json({ error: "Farmer has no UPI ID on file" });
  res.json({ link: upiLink(farmer, payment, payment.transactionRef) });
});

app.get("/api/payments/:id/upi-qr", requireAuth, async (req, res) => {
  const { payment, error } = await ownedPayment(req, req.params.id);
  if (error) return res.status(error.status).json({ error: error.msg });
  const farmer = await get("SELECT * FROM farmers WHERE id=?", payment.farmerId);
  if (!farmer || !farmer.upiId) return res.status(400).json({ error: "Farmer has no UPI ID on file" });
  try {
    const qr = await QRCode.toDataURL(upiLink(farmer, payment, payment.transactionRef), { width: 320, margin: 1 });
    res.json({ qr, upiId: farmer.upiId, amount: payment.amount });
  } catch (e) {
    res.status(500).json({ error: "Could not generate UPI QR: " + e.message });
  }
});

app.get("/api/payments/:id/receipt.pdf", requireAuth, async (req, res) => {
  const { payment, error } = await ownedPayment(req, req.params.id);
  if (error) return res.status(error.status).json({ error: error.msg });
  const booking = await get("SELECT * FROM bookings WHERE id=?", payment.bookingId) || {};
  const farmer = await get("SELECT * FROM farmers WHERE id=?", payment.farmerId) || { name: "-" };
  const centre = await getCentre(booking.centreId);
  const buf = paymentReceipt(payment, booking, farmer, centre);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="receipt-${payment.transactionRef || payment.id}.pdf"`,
    "Content-Length": buf.length,
  });
  res.send(buf);
});

// ─── ANALYTICS (officer) ───

app.get("/api/analytics", requireOfficer, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const days = 14;
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dayKeys.push(d.toISOString().split("T")[0]);
  }

  const tonnage = [];
  for (const key of dayKeys) {
    tonnage.push({ date: key, qty: (await get("SELECT COALESCE(SUM(quantity),0) AS s FROM bookings WHERE date=? AND status!='cancelled'", key)).s });
  }
  const revenue = [];
  for (const key of dayKeys) {
    revenue.push({ date: key, amount: (await get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid' AND paidAt LIKE ?", key + "%")).s });
  }

  const statusCounts = {};
  const scRows = await all("SELECT status, COUNT(*) AS n FROM bookings GROUP BY status");
  for (const r of scRows) statusCounts[r.status] = r.n;

  const commoditySplit = await all(
    "SELECT b.commodityName, COUNT(*) AS bookings, COALESCE(SUM(b.quantity),0) AS qty, COALESCE(SUM(p.amount),0) AS paid FROM bookings b LEFT JOIN payments p ON p.bookingId=b.id AND p.status='paid' GROUP BY b.commodityName ORDER BY paid DESC"
  );

  const rawCentres = await all("SELECT * FROM centres ORDER BY district");
  const centres = [];
  for (const c of rawCentres) {
    const slots = Math.max(1, c.endHour - c.startHour);
    const cap = c.dailyCapacity ? c.dailyCapacity : slots * c.capacityPerSlot;
    const queueNow = (await get("SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND status IN ('in-queue','weighing','qc')", c.id)).n;
    const bookedToday = (await get("SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND date=? AND status!='cancelled'", c.id, today)).n;
    const avgRating = (await get("SELECT ROUND(AVG(rating),1) AS r FROM centre_ratings WHERE centreId=?", c.id)).r;
    const assignedResult = await all("SELECT MIN(substr(createdAt,1,10)) AS d FROM bookings WHERE centreId=?", c.id);
    centres.push({
      id: c.id, name: c.name, district: c.district,
      queueNow, bookedToday, capacityTotal: cap, load: cap ? Math.round((bookedToday / cap) * 100) : 0,
      rating: avgRating || "-",
      assignedSince: (assignedResult[0] || {}).d || today,
    });
  }

  const forecast = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split("T")[0];
    const fcCentres = await all("SELECT * FROM centres ORDER BY district");
    const fcMapped = [];
    for (const c of fcCentres) {
      const slots = Math.max(1, c.endHour - c.startHour);
      const cap = c.dailyCapacity ? c.dailyCapacity : slots * c.capacityPerSlot;
      const booked = (await get("SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND date=? AND status!='cancelled'", c.id, key)).n;
      fcMapped.push({ id: c.id, name: c.name, booked, cap, load: cap ? Math.round((booked / cap) * 100) : 0 });
    }
    forecast.push({
      date: key,
      centres: fcMapped,
    });
    forecast[forecast.length - 1].dayLabel = key;
  }

  const ratings = await all("SELECT cr.*, c.name AS centreName FROM centre_ratings cr LEFT JOIN centres c ON cr.centreId=c.id ORDER BY cr.createdAt DESC LIMIT 50");

  res.json({ tonnage, revenue, statusCounts, commoditySplit, centres, forecast, ratings });
});

// ─── MIS EXPORTS (CSV/PDF) ───

function toCsv(rows) {
  if (!rows.length) return "No data\n";
  const keys = Object.keys(rows[0]);
  const line = (arr) => arr.map((v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`).join(",") + "\n";
  return line(keys) + rows.map((r) => line(keys.map((k) => r[k]))).join("");
}

const EXPORTS = {
  bookings: (q) => all("SELECT b.id,b.farmerName,b.commodityName,b.quantity,b.grade,b.centreName,b.date,b.timeSlot,b.status,b.estAmount,b.createdAt FROM bookings b ORDER BY b.createdAt DESC LIMIT " + Math.min(5000, parseInt(q.limit) || 1000)),
  payments: (q) => all("SELECT p.id,p.bookingId,p.commodityName,p.quantity,p.amount,p.status,p.paymentMode,p.transactionRef,p.paidAt,f.name AS farmer FROM payments p LEFT JOIN farmers f ON f.id=p.farmerId ORDER BY p.createdAt DESC LIMIT " + Math.min(5000, parseInt(q.limit) || 1000)),
  shipments: (q) => all("SELECT s.id,s.bookingId,s.commodityName,s.quantity,s.stage,s.totalStages,s.createdAt,f.name AS farmer,c.name AS centre FROM shipments s LEFT JOIN farmers f ON f.id=s.farmerId LEFT JOIN bookings b ON b.id=s.bookingId LEFT JOIN centres c ON c.id=b.centreId ORDER BY s.createdAt DESC LIMIT " + Math.min(5000, parseInt(q.limit) || 1000)),
  farmers: (q) => all("SELECT f.id,f.name,f.phone,f.email,f.district,f.village,f.landSize,f.kyc,f.createdAt FROM farmers f WHERE f.role='farmer' ORDER BY f.createdAt DESC LIMIT " + Math.min(5000, parseInt(q.limit) || 1000)),
  grievances: (q) => all("SELECT g.id,g.farmerName,g.subject,g.message,g.status,g.officerNote,g.createdAt,g.updatedAt FROM grievances g ORDER BY g.createdAt DESC LIMIT " + Math.min(5000, parseInt(q.limit) || 1000)),
};

app.get("/api/export/:type.csv", requireOfficer, async (req, res) => {
  const fn = EXPORTS[req.params.type];
  if (!fn) return res.status(404).json({ error: "Unknown export type" });
  const rows = await fn(req.query);
  if (!rows.length) return res.status(404).json({ error: "No data to export" });
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${req.params.type}-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.send("\uFEFF" + toCsv(rows));
});

app.get("/api/export/:type.pdf", requireOfficer, async (req, res) => {
  const fn = EXPORTS[req.params.type];
  if (!fn) return res.status(404).json({ error: "Unknown export type" });
  const rows = await fn(req.query);
  if (!rows.length) return res.status(404).json({ error: "No data to export" });
  const keys = Object.keys(rows[0]);
  const buf = misReport(`${req.params.type.toUpperCase()} report`, keys, rows.map((r) => keys.map((k) => r[k])));
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${req.params.type}-${new Date().toISOString().slice(0, 10)}.pdf"`,
    "Content-Length": buf.length,
  });
  res.send(buf);
});

// ─── QR LOT SCAN → audit trail ───

app.post("/api/qr/scan", requireAuth, async (req, res) => {
  const { ref } = req.body;
  const b = await get("SELECT b.*, f.name AS farmerName, c.name AS centreName FROM bookings b LEFT JOIN farmers f ON f.id=b.farmerId LEFT JOIN centres c ON c.id=b.centreId WHERE b.id=?", String(ref || ""));
  if (!b) return res.status(404).json({ error: "Lot not found" });
  if (req.session.role === "farmer" && b.farmerId !== req.session.userId) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const pay = await get("SELECT status FROM payments WHERE bookingId=? ORDER BY createdAt DESC LIMIT 1", b.id);
  const ship = await get("SELECT stage, totalStages FROM shipments WHERE bookingId=?", b.id);
  await run("INSERT INTO scan_log (id, bookingId, scanner, ip, createdAt) VALUES (?,?,?,?,?)",
    genId("SCN"), b.id, req.session.name || "verifier", req.ip, new Date().toISOString());
  const scans = await all("SELECT scanner, ip, createdAt FROM scan_log WHERE bookingId=? ORDER BY createdAt DESC", b.id);
  res.json({
    verified: true,
    scannedBy: req.session.name || "verifier",
    lot: { ref: b.id, farmer: b.farmerName, commodity: b.commodityName, grade: b.grade, quantity: b.quantity, unit: b.unit || "quintal", centre: b.centreName, date: b.date, status: b.status, payment: pay ? pay.status : "-", shipment: ship ? `${ship.stage}/${ship.totalStages}` : "-" },
    scans,
  });
});

// ─── ADMIN STATS ───

app.get("/api/stats", requireOfficer, async (req, res) => {
  const today = new Date().toISOString().split("T")[0];

  const totalFarmers = (await get("SELECT COUNT(*) AS n FROM farmers WHERE role='farmer'")).n;
  const todayBookings = (await get("SELECT COUNT(*) AS n FROM bookings WHERE date=?", today)).n;
  const inQueueToday = (
    await get(
      "SELECT COUNT(*) AS n FROM bookings WHERE date=? AND status IN ('in-queue','weighing','qc')",
      today
    )
  ).n;

  const paidTotal = (await get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid'")).s;
  const pendingTotal = (
    await get(
      "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status IN ('pending','processing')"
    )
  ).s;
  const paidToday = (
    await get(
      "SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid' AND paidAt LIKE ?",
      today + "%"
    )
  ).s;

  const shipmentsActive = (await get("SELECT COUNT(*) AS n FROM shipments WHERE stage < totalStages")).n;
  const shipmentsDelivered = (await get("SELECT COUNT(*) AS n FROM shipments WHERE stage >= totalStages")).n;

  const rawCentres2 = await all("SELECT * FROM centres ORDER BY district");
  const centres = [];
  for (const c of rawCentres2) {
    const q = await all(
      "SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND status IN ('in-queue','weighing','qc')",
      c.id
    );
    const slots = Math.max(1, c.endHour - c.startHour);
    const capacityTotal = slots * c.capacityPerSlot;
    const bookedToday = (await get(
      "SELECT COUNT(*) AS n FROM bookings WHERE centreId=? AND date=? AND status != 'cancelled'",
      c.id,
      today
    )).n;
    centres.push({
      id: c.id,
      name: c.name,
      district: c.district,
      queueNow: q[0].n,
      capacity: c.capacityPerSlot,
      capacityTotal,
      bookedToday,
      freeToday: Math.max(0, capacityTotal - bookedToday),
      load: capacityTotal ? Math.round((bookedToday / capacityTotal) * 100) : 0,
    });
  }

  const statusCounts = {};
  const scRows = await all("SELECT status, COUNT(*) AS n FROM bookings WHERE date=? GROUP BY status", today);
  for (const r of scRows) statusCounts[r.status] = r.n;

  const trend = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split("T")[0];
    trend.push({ date: key, count: (await get("SELECT COUNT(*) AS n FROM bookings WHERE date=?", key)).n });
  }

  res.json({
    totalFarmers,
    todayBookings,
    inQueueToday,
    todayRevenue: Number(paidToday).toFixed(2),
    totalApprovedAmount: Number(paidTotal).toFixed(2),
    pendingAmount: Number(pendingTotal).toFixed(2),
    centres,
    statusCounts,
    trend,
    shipmentsActive,
    shipmentsDelivered,
  });
});

// ─── MULTILINGUAL FARMER ASSISTANT (chatbot) ───

const ASSISTANT = {
  en: {
    greeting: (n) => `Hello ${n || "there"}! I'm the Kisan Setu assistant. Ask me about MSP rates, which centre is least busy, or your booking & payment status.`,
    msp: `Current MSP rates at Kisan Setu:`,
    centres: `Centre load right now (busiest first):`,
    centresTip: `Tip: choose a centre with fewer farmers in queue to save time — booking shows slot availability too.`,
    my: (b) => `Your latest booking ${b.id} for ${b.quantity} ${b.unit} of ${b.commodity} at ${b.centre} on ${b.date} is: ${b.status}.${b.stage ? ` Shipment stage ${b.stage} / ${b.totalStages}.` : ""}`,
    myPay: (p) => `Your payment line: ${p.amount}, status ${p.status}.${p.paidText}`,
    noLogin: `Please log in first (Login → Farmer) so I can check your bookings and payment.`,
    help: `I can help with:\n• MSP rates — "What is the MSP for paddy?"\n• Centre load — "Which centre is least busy?"\n• Your booking/payment — "Where is my payment?"`,
    how: `Booking is easy:\n1. Register/Login as Farmer\n2. Book Slot → pick centre, date & time slot\n3. Reach the centre for check-in → weighing → QC\n4. After approval, the officer releases payment to your bank/UPI.\nAsk me "which centre is least busy?" next!`,
    fallback: `Sorry, I couldn't understand that. Try: "MSP rates", "which centre is least busy?", or "where is my payment?".`,
    officer: (s) => `Welcome back, ${s.name}! Today: ${s.todayBookings} bookings, ${s.inQueue} farmers in queue, ${s.paid} released today.`,
  },
  te: {
    greeting: (n) => `నమస్తే ${n || "మీరు"}! నేను కిసాన్ సేతు సహాయకుడిని. మద్దతు ధర, ఏ కేంద్రం తక్కువ రద్దీగా ఉంది, లేదా మీ బుకింగ్, చెల్లింపు స్థితి గురించి అడగండి.`,
    msp: `కిసాన్ సేతులో ప్రస్తుత మద్దతు ధరలు:`,
    centres: `ఇప్పుడు కేంద్రాల రద్దీ (ముందుగా అత్యంత రద్దీ):`,
    centresTip: `సూచన: రద్దీ తక్కువగా ఉన్న కేంద్రాన్ని ఎంచుకుంటే సమయం ఆదా అవుతుంది.`,
    my: (b) => `మీ తాజా బుకింగ్ ${b.id} — ${b.quantity} ${b.unit} ${b.commodity}, ${b.centre} వద్ద ${b.date} నాడు. స్థితి: ${b.status}.${b.stage ? ` రవాణా దశ ${b.stage}/${b.totalStages}.` : ""}`,
    myPay: (p) => `మీ చెల్లింపు: ${p.amount}, స్థితి ${p.status}.${p.paidText}`,
    noLogin: `దయచేసి ముందుగా లాగిన్ అవ్వండి (లాగిన్ → రైతు) — చెల్లింపులు, బుకింగ్ లు చూడటానికి.`,
    help: `నేను చెప్పగలను:\n• మద్దతు ధర — "మద్దతు ధర ఎంత?"\n• కేంద్ర రద్దీ — "ఏ కేంద్రం తక్కువ రద్దీ?"\n• బుకింగ్/చెల్లింపు — "చెల్లింపు ఎక్కడ?"`,
    how: `బుకింగ్ సులభం:\n1. రైతుగా రిజిస్టర్/లాగిన్\n2. బుక్ స్లాట్ → కేంద్రం, తేదీ, సమయం ఎంచుకోండి\n3. చెక్-ఇన్ → బరువు → నాణ్యత పరీక్ష\n4. ఆమోదం తర్వాత డబ్బు మీ బ్యాంక్/UPIకి వస్తుంది.`,
    fallback: `క్షమించండి, అర్థం కాలేదు. అడగండి: "మద్దతు ధర", "ఏ కేంద్రం తక్కువ రద్దీ?", "చెల్లింపు ఎక్కడ?".`,
    officer: (s) => `స్వాగతం, ${s.name}! ఈ రోజు: ${s.todayBookings} బుకింగ్ లు, ${s.inQueue} రైతులు క్యూలో, ${s.paid} చెల్లించారు.`,
  },
  hi: {
    greeting: (n) => `नमस्ते ${n || "आप"}! मैं किसान सेतु का सहायक हूँ. MSP दरों, किस केंद्र में कम भीड़ है, या आपकी बुकिंग व भुगतान स्थिति के बारे में पूछें.`,
    msp: `किसान सेतु पर वर्तमान MSP दरें:`,
    centres: `अभी केंद्रों की भीड़ (पहले सबसे भीड़):`,
    centresTip: `सुझाव: जिस केंद्र में कतार कम हो उसे चुनें — समय बचेगा.`,
    my: (b) => `आपकी नवीनतम बुकिंग ${b.id} — ${b.quantity} ${b.unit} ${b.commodity}, ${b.centre} में ${b.date} को. स्थिति: ${b.status}.${b.stage ? ` परिवहन चरण ${b.stage}/${b.totalStages}.` : ""}`,
    myPay: (p) => `आपका भुगतान: ${p.amount}, स्थिति ${p.status}.${p.paidText}`,
    noLogin: `कृपया पहले लॉगिन करें (लॉगिन → किसान) ताकि मैं आपकी बुकिंग व भुगतान देख सकूं.`,
    help: `मैं बता सकता हूँ:\n• MSP दरें — "धान का MSP क्या है?"\n• केंद्र की भीड़ — "किस केंद्र में कम भीड़ है?"\n• बुकिंग/भुगतान — "मेरा भुगतान कहाँ है?"`,
    how: `बुकिंग आसान है:\n1. किसान के रूप में रजिस्टर/लॉगिन करें\n2. बुक स्लॉट → केंद्र, तारीख व समय चुनें\n3. चेक-इन → तौल → गुणवत्ता जांच\n4. स्वीकृति के बाद भुगतान आपके बैंक/UPI में आ जाएगा.`,
    fallback: `क्षमा करें, मैं समझ नहीं पाया. पूछें: "MSP दरें", "किस केंद्र में कम भीड़?", "मेरा भुगतान कहाँ?".`,
    officer: (s) => `वापसी पर स्वागत, ${s.name}! आज: ${s.todayBookings} बुकिंग, ${s.inQueue} किसान कतार में, ${s.paid} आज जारी.`,
  },
};

// Detect the farmer's language from the script of their message (Devanagari → Hindi, Telugu → Telugu)
function msgLang(text) {
  let te = 0;
  let hi = 0;
  for (const ch of String(text || "")) {
    const c = ch.codePointAt(0);
    if (c >= 0x0c00 && c <= 0x0c7f) te++;
    else if (c >= 0x0900 && c <= 0x097f) hi++;
  }
  if (te > 0 && te >= hi) return "te";
  if (hi > 0 && hi > te) return "hi";
  return null;
}

const ASSISTANT_INTENTS = {
  greeting: ["hi", "hello", "hey", "namaste", "సలామ్", "నమస్తే", "నమస్కారం", "హలో", "నమస్కారం", "శుభోదయం", "నమస్తే", "నమస్కారం", "हैलो", "नमस्ते", "नमस्कार", "सुप्रभात", "good morning", "good evening", "good afternoon"],
  msp: ["msp", "rate", "price", "ధర", "రేటు", "మద్దతు", "సపోర్టు", "మండి", "ధరలు", "భావం", "भाव", "दाम", "दर", "मंडी", "भाउ", "मूल्य"],
  centres: ["centre", "queue", "busy", "crowd", "wait", "line", "కేంద్రం", "కేంద్రాలు", "కేంద్రం ఎక్కడ", "కేంద్రాలు ఎక్కడ", "కేంద్రం దగ్గర", "క్యూ", "రద్దీ", "సమీప", "వేచి", "केंद्र", "केंद्रों", "कतार", "भीड़", "केंद्र कहां", "केंद्र कहाँ", "కేంద్రం ఎక్కడ ఉంది", "कौनसा", "समीप"],
  booking: ["booking", "book", "slot", "payment", "paid", "money", "status", "track", "బుకింగ్", "స్లాట్", "చెల్లింపు", "డబ్బు", "స్టేటస్", "బుక్", "చెల్లించారు", "ఇస్తారు", "వచ్చిందా", "बुकिंग", "स्लॉट", "भुगतान", "पैसा", "स्टेटस", "बुक", "रकम"],
  how: ["how", "process", "step", "proce", "ఎలా", "ప్రక్రియ", "దశ", "చేయాలి", "రిజిస్టర్", "कैसे", "प्रक्रिया", "कदम", "रजिस्टर"],
  help: ["help", "can you", "what can", "సహాయం", "ఏమి", "చేయగలరు", "అడగవచ్చా", "మీరు ఎవరు", "मदद", "क्या कर सकते", "मैं पूछ सकता", "आप कौन"],
};

async function assistantCtx(req) {
  const ctx = { lang: msgLang(req.body.message) || (req.body.lang === "hi" ? "hi" : req.body.lang === "te" ? "te" : "en"), reply: null };
  const name = (req.session && req.session.name) || null;
  const dict = ASSISTANT[ctx.lang];

  const centres = await all("SELECT * FROM centres ORDER BY district");
  const commodities = await all("SELECT * FROM commodities WHERE active=1 ORDER BY name");

  const today = new Date().toISOString().split("T")[0];
  const countRows = await all("SELECT centreId, COUNT(*) AS n FROM bookings WHERE status != 'cancelled' GROUP BY centreId");
  const counts = {};
  for (const r of countRows) counts[r.centreId] = r.n;
  const centreRows = centres
    .map((c) => {
      const slots = Math.max(1, c.endHour - c.startHour);
      const load = Math.min(100, Math.round(((counts[c.id] || 0) / (c.capacityPerSlot * slots)) * 100));
      return { ...c, load };
    })
    .sort((a, b) => b.load - a.load);

  const latest =
    req.session && req.session.role === "farmer"
      ? await get(
          "SELECT b.*, c.name AS centreName, co.name AS commodityName FROM bookings b LEFT JOIN centres c ON b.centreId=c.id LEFT JOIN commodities co ON b.commodityId=co.id WHERE b.farmerId=? ORDER BY b.createdAt DESC LIMIT 1",
          req.session.userId
        )
      : null;
  const latestShip =
    latest ? await get("SELECT stage, totalStages FROM shipments WHERE bookingId=?", latest.id) : null;
  const latestPay =
    latest ? await get("SELECT amount, status FROM payments WHERE bookingId=? ORDER BY createdAt DESC LIMIT 1", latest.id) : null;

  const msg = String(req.body.message || "").toLowerCase();
  // Score intents: word-boundary match for Latin keywords (so "which" doesn't match "hi"),
  // substring match for Devanagari/Telugu keywords, phrase match for multi-word intents.
  let intent = "fallback";
  let bestScore = 0;
  for (const k of Object.keys(ASSISTANT_INTENTS)) {
    let score = 0;
    for (const w of ASSISTANT_INTENTS[k]) {
      const kw = String(w).toLowerCase();
      if (/^[a-z ]+$/.test(kw)) {
        if (/\s/.test(kw)) { if (msg.includes(kw)) score += 3; }
        else if (new RegExp("(^|[^a-z])" + kw + "([^a-z]|$)").test(msg)) score += 2;
      } else if (msg.includes(kw)) score += 2;
    }
    if (score > bestScore) { bestScore = score; intent = k; }
  }

  switch (intent) {
    case "greeting":
      ctx.reply = dict.greeting(name);
      break;
    case "msp":
      ctx.reply = dict.msp + "\n" + commodities.map((c) => `• ${c.name} (${c.category}): ${fmtMoney(c.msp)} / ${c.unit}`).join("\n");
      break;
    case "centres":
      ctx.reply = dict.centres + "\n" + centreRows.map((c) => `• ${c.name} (${c.district}) — ${c.load}%`).join("\n") + "\n" + dict.centresTip;
      break;
    case "booking":
      if (!latest) {
        ctx.reply = req.session ? dict.noLogin : dict.noLogin;
      } else {
        const paidText = latestPay && latestPay.status === "paid"
          ? (ctx.lang === "hi" ? " — आपके बैंक/UPI में जारी" : ctx.lang === "te" ? " — మీ బ్యాంక్/UPIకి విడుదలైంది" : " — released to your bank/UPI")
          : "";
        if (latestPay) ctx.reply = dict.my({ id: latest.id, quantity: latest.quantity, unit: latest.unit || "kg", commodity: latest.commodityName, centre: latest.centreName, date: latest.date, status: latest.status, stage: latestShip ? latestShip.stage : null, totalStages: latestShip ? latestShip.totalStages : null }) + "\n" + dict.myPay({ amount: fmtMoney(latestPay.amount), status: latestPay.status, paidText });
        else ctx.reply = dict.my({ id: latest.id, quantity: latest.quantity, unit: latest.unit || "kg", commodity: latest.commodityName, centre: latest.centreName, date: latest.date, status: latest.status, stage: latestShip ? latestShip.stage : null, totalStages: latestShip ? latestShip.totalStages : null });
      }
      break;
    case "how":
      ctx.reply = dict.how;
      break;
    case "help":
      ctx.reply = dict.help;
      break;
    default:
      if (req.session && req.session.role === "officer") {
        const todayBookings = (await get("SELECT COUNT(*) AS n FROM bookings WHERE date=?", today)).n;
        const inQueue = (await get("SELECT COUNT(*) AS n FROM bookings WHERE date=? AND status IN ('in-queue','weighing','qc')", today)).n;
        const paidToday = (await get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='paid' AND paidAt LIKE ?", today + "%")).s;
        ctx.reply = dict.officer({ name: req.session.name, todayBookings, inQueue, paid: fmtMoney(paidToday) });
      } else {
        ctx.reply = dict.fallback;
      }
  }
  return ctx;
}

app.post("/api/assistant", async (req, res) => {
  const ctx = await assistantCtx(req);
  ctx.reply = ctx.reply || ASSISTANT.en.fallback;
  res.json({ reply: ctx.reply, lang: ctx.lang });
});

// Lot traceability QR passport for a booking
app.get("/api/bookings/:id/qr", requireAuth, async (req, res) => {
  const b = await get(
    "SELECT b.*, f.name AS farmerName, f.village, f.district, c.name AS centreName, co.name AS commodityName, co.msp, co.unit FROM bookings b LEFT JOIN farmers f ON b.farmerId=f.id LEFT JOIN centres c ON b.centreId=c.id LEFT JOIN commodities co ON b.commodityId=co.id WHERE b.id=?",
    req.params.id
  );
  if (!b) return res.status(404).json({ error: "Booking not found" });
  if (req.session.role === "farmer" && b.farmerId !== req.session.userId) {
    return res.status(403).json({ error: "Forbidden" });
  }
  const pay = await get("SELECT status, amount FROM payments WHERE bookingId=? ORDER BY createdAt DESC LIMIT 1", b.id);
  const ship = await get("SELECT stage, totalStages FROM shipments WHERE bookingId=?", b.id);
  const content = [
    "KISAN SETU - LOT PASSPORT",
    `Ref:${b.id}`,
    `Farmer:${b.farmerName}`,
    `Village:${b.village || "-"},${b.district || "-"}`,
    `Commodity:${b.commodityName}`,
    `Grade:${b.grade || "-"}`,
    `Qty:${b.quantity} ${b.unit || "quintal"}`,
    `MSP:${b.msp}`,
    `Est:${b.estAmount}`,
    `Centre:${b.centreName}`,
    `Date:${b.date} ${b.timeSlot}`,
    `Status:${b.status}`,
    `Payment:${pay ? pay.status + (pay.amount != null ? ":" + pay.amount : "") : "-"}`,
    `Shipment:${ship ? ship.stage + "/" + ship.totalStages : "-"}`,
  ].join("\n");
  try {
    const url = await QRCode.toDataURL(content, { width: 360, margin: 1 });
    res.json({
      bookingId: b.id,
      qr: url,
      lot: {
        ref: b.id,
        farmer: b.farmerName,
        commodity: b.commodityName,
        grade: b.grade || "-",
        quantity: b.quantity,
        unit: b.unit || "quintal",
        msp: b.msp,
        estAmount: b.estAmount,
        centre: b.centreName,
        date: b.date,
        timeSlot: b.timeSlot,
        status: b.status,
        payment: pay ? pay.status : "-",
        shipment: ship ? `${ship.stage}/${ship.totalStages}` : "-",
      },
    });
  } catch (err) {
    res.status(500).json({ error: "Could not generate QR: " + err.message });
  }
});

// ─── PAGE ROUTES ───

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/register", async (req, res) => {
  if (req.session && req.session.userId) return res.redirect(req.session.role === "farmer" ? "/booking" : "/dashboard");
  res.sendFile(path.join(__dirname, "public", "register.html"));
});
app.get("/login", async (req, res) => {
  if (req.session && req.session.userId) return res.redirect(req.session.role === "farmer" ? "/booking" : "/dashboard");
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

function pageIfAuth(req, res, page) {
  if (!(req.session && req.session.userId)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", page));
}

app.get("/booking", (req, res) => pageIfAuth(req, res, "booking.html"));
app.get("/my-bookings", (req, res) => pageIfAuth(req, res, "my-bookings.html"));
app.get("/kyc", (req, res) => pageIfAuth(req, res, "kyc.html"));
app.get("/dashboard", async (req, res) => {
  if (!(req.session && req.session.userId)) return res.redirect("/login");
  if (req.session.role !== "officer") return res.redirect("/my-bookings");
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Slot reminders: optional background cron — enable with KS_REMINDERS=on in .env
// (sends SMS/email ~45 min before today's booked window).
if ((process.env.KS_REMINDERS || "").toLowerCase() === "on") {
  setInterval(async () => {
    try {
      const today = new Date().toISOString().split("T")[0];
      const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
      const cups = await all("SELECT * FROM bookings WHERE status='booked' AND reminderSent=0 AND date=?", today);
      for (const b of cups) {
        const m = String(b.timeSlot || "").match(/^(\d{2}):/);
        if (!m) continue;
        const startMin = parseInt(m[1]) * 60;
        const minsLeft = startMin - nowMin;
        if (minsLeft >= 20 && minsLeft <= 75) {
          await run("UPDATE bookings SET reminderSent=1 WHERE id=?", b.id);
          const farmer = await get("SELECT * FROM farmers WHERE id=?", b.farmerId);
          if (farmer) await notify(farmer, "Slot Reminder",
            `Reminder: your ${b.commodityName} procurement slot at ${b.centreName} starts in about ${minsLeft} minutes (${b.timeSlot}).`,
            `Kisan Setu: ${b.commodityName} slot at ${b.centreName} in ~${minsLeft} min (${b.timeSlot}).`);
        }
      }
    } catch (e) {
      console.error("[REMINDER] error:", e.message);
    }
  }, 60 * 1000);
}

// ─── 404 / error pages ───

app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, "public", "404.html")));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (req.path.startsWith("/api")) return res.status(500).json({ error: "Server error" });
  res.status(500).sendFile(path.join(__dirname, "public", "500.html"));
});

app.listen(PORT, () => {
  const dbSource = process.env.DATABASE_URL ? "Supabase (Postgres)" : "SQLite (data/app.db)";
  console.log(`\n  Kisan Setu — Farmer Procurement Platform`);
  console.log(`  DB: ${dbSource}`);
  console.log(`  SMS: ${process.env.TWILIO_PHONE_NUMBER ? "Twilio (live)" : "demo mode (console log)"}`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});