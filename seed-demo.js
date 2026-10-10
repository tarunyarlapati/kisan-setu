// Kisan Setu demo data seeder
// Usage: node seed-demo.js   (from project root)
// Idempotent: wipes demo farmers/bookings/payments/shipments/notifications, then re-seeds.
const bcrypt = require("bcryptjs");
const { all, get, run } = require("./db");

let idCounter = 0;
function genId(prefix) {
  idCounter += 1;
  return prefix + "_DEMO" + String(idCounter).padStart(3, "0");
}

const DAY_MS = 24 * 60 * 60 * 1000;
function iso(d) {
  return d.toISOString().replace(/T.*$/, "");
}
function daysFromNow(n, hour) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, 15, 0, 0);
  return d;
}
function agoHours(h) {
  return new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
}

const STAGE_LABELS = [
  "Prepared at farm",
  "Accepted at procurement centre",
  "Reached town hub",
  "Stored at regional warehouse",
  "Dispatched in transit",
  "Delivered at FCI depot",
];

const CENTRES = {
  CTR001: { name: "FCI Ludhiana Procurement Centre", district: "Ludhiana", state: "Punjab" },
  CTR002: { name: "Karnal Mandi Procurement Centre", district: "Karnal", state: "Haryana" },
  CTR003: { name: "Indore Sagarkhana Procurement Centre", district: "Indore", state: "Madhya Pradesh" },
  CTR004: { name: "Kanpur Mandi Samiti Centre", district: "Kanpur", state: "Uttar Pradesh" },
  CTR005: { name: "Vijayawada Paddy Procurement Centre", district: "Vijayawada", state: "Andhra Pradesh" },
};

const COMMODITIES = {
  COM001: { name: "Wheat", msp: 2425 },
  COM002: { name: "Paddy (Common)", msp: 2300 },
  COM003: { name: "Paddy (Grade A)", msp: 2320 },
  COM004: { name: "Tur / Arhar", msp: 7550 },
  COM005: { name: "Moong", msp: 8682 },
  COM006: { name: "Gram (Chana)", msp: 5440 },
  COM007: { name: "Mustard / Rapeseed", msp: 5650 },
  COM008: { name: "Soybean", msp: 4892 },
  COM009: { name: "Cotton (Medium)", msp: 7121 },
};

// farmer specs: [name, phone, district, village, landSize, method, bankName/a/c | upi]
const FARMERS = [
  ["Ram Singh", "9815000001", "Ludhiana", "Raikot", 12, "bank", "State Bank of India", "30123456789", "SBIN0001234"],
  ["Gurpreet Kaur", "9815000002", "Ludhiana", "Jagraon", 9, "upi", "gurpreet@okhdfcbank"],
  ["Harjinder Singh", "9815000003", "Ludhiana", "Sahnewal", 15, "bank", "Punjab National Bank", "40123456789", "PUNB0003210"],
  ["Simranjeet Kaur", "9815000004", "Ludhiana", "Doraha", 7, "upi", "simran@ybl"],
  ["Ramesh Yadav", "9815000005", "Karnal", "Nilokheri", 18, "bank", "Karnal Central Co-op Bank", "50123456789", "UTIB0004567"],
  ["Sushil Kumar", "9815000006", "Karnal", "Assandh", 11, "bank", "Axis Bank", "60123456789", "UTIB0007891"],
  ["Priya Devi", "9815000007", "Karnal", "Gharaunda", 6, "upi", "priya.g@okaxis"],
  ["Sanjay Chauhan", "9815000008", "Indore", "Depalpur", 20, "bank", "Bank of Baroda", "70123456789", "BARB0DEPALP"],
  ["Meena Patidar", "9815000009", "Indore", "Sanwer", 13, "upi", "meena.pati@ybl"],
  ["Arjun Patel", "9815000010", "Indore", "Mhow", 10, "bank", "ICICI Bank", "80123456789", "ICIC0002221"],
  ["Devendra Mishra", "9815000011", "Kanpur", "Bilhaur", 16, "bank", "Union Bank of India", "90123456789", "UBIN0531234"],
  ["Kamlesh Gupta", "9815000012", "Kanpur", "Sachendi", 8, "upi", "kamlesh.g@okicici"],
  ["Naresh Kumar", "9815000013", "Kanpur", "Chaubepur", 14, "bank", "Punjab National Bank", "11123456789", "PUNB0102233"],
  ["Venkata Rao", "9815000014", "Vijayawada", "Nunna", 22, "bank", "Andhra Bank", "12123456789", "ANDB0000111"],
  ["Lakshmi Prasanna", "9815000015", "Vijayawada", "Penamaluru", 9, "upi", "lakshmi.p@ybl"],
  ["Chandra Shekhar", "9815000016", "Vijayawada", "Guntur", 17, "bank", "Canara Bank", "13123456789", "CNRB0000999"],
];

// booking specs: [farmerIdx, centreId, commodityId, offsetDays, slot, qty, grade, status, stage, payment]
// statuses: paid-f(past), approved(processing pay), rejected, in-queue/weighing/qc(today), booked(future)
const BOOKING_SPECS = [
  // ---- yesterday: completed & payout stories ----
  [0, "CTR001", "COM001", -1, "08:00-09:00", 42, "A", "paid", 5, "paid"],
  [1, "CTR001", "COM006", -1, "09:00-10:00", 18, "A", "paid", 5, "paid"],
  [2, "CTR003", "COM008", -1, "11:00-12:00", 25, "B", "approved", 1, "processing"],
  [3, "CTR001", "COM004", -2, "10:00-11:00", 12, "A", "paid", 5, "paid"],
  [4, "CTR002", "COM001", -1, "08:00-09:00", 55, "A", "paid", 5, "paid"],
  [5, "CTR003", "COM001", -2, "09:00-10:00", 30, "B", "rejected", 0, null],
  [6, "CTR002", "COM002", -2, "11:00-12:00", 20, "A", "approved", 1, "processing"],
  // ---- today: live queues for the dashboard ----
  [7, "CTR003", "COM001", 0, "08:00-09:00", 34, "A", "in-queue", 1, null],
  [8, "CTR001", "COM001", 0, "09:00-10:00", 28, "A", "in-queue", 1, null],
  [9, "CTR001", "COM002", 0, "10:00-11:00", 22, "B", "weighing", 1, null],
  [10, "CTR004", "COM007", 0, "09:00-10:00", 16, "A", "qc", 1, null],
  [11, "CTR004", "COM001", 0, "11:00-12:00", 40, "B", "in-queue", 1, null],
  [12, "CTR002", "COM002", 0, "08:00-09:00", 31, "A", "qc", 1, null],
  [13, "CTR005", "COM002", 0, "10:00-11:00", 60, "A", "in-queue", 1, null],
  [14, "CTR005", "COM003", 0, "09:00-10:00", 26, "B", "weighing", 1, null],
  // ---- future: upcoming bookings (tomorrow = booking page default) ----
  [0, "CTR001", "COM001", 1, "08:00-09:00", 50, "A", "booked", 0, null],
  [2, "CTR002", "COM001", 1, "09:00-10:00", 33, "A", "booked", 0, null],
  [3, "CTR004", "COM001", 1, "10:00-11:00", 21, "B", "booked", 0, null],
  [6, "CTR005", "COM002", 1, "08:00-09:00", 44, "A", "booked", 0, null],
  [7, "CTR003", "COM008", 1, "12:00-13:00", 29, "B", "booked", 0, null],
  [9, "CTR001", "COM006", 1, "11:00-12:00", 15, "A", "booked", 0, null],
  [12, "CTR002", "COM002", 1, "10:00-11:00", 37, "A", "booked", 0, null],
  [15, "CTR003", "COM001", 1, "09:00-10:00", 48, "B", "booked", 0, null],
  [10, "CTR004", "COM007", 2, "09:00-10:00", 19, "A", "booked", 0, null],
  [13, "CTR005", "COM002", 2, "11:00-12:00", 52, "A", "booked", 0, null],
  [5, "CTR004", "COM006", 2, "12:00-13:00", 24, "B", "booked", 0, null],
];

function routeFor(farmer, centreId) {
  const c = CENTRES[centreId];
  return [
    { name: farmer.village + ", " + farmer.district, type: "farm", km: 0, icon: "🌾" },
    { name: c.name, type: "centre", km: 40, icon: "🏪" },
    { name: "Town Hub · " + c.district, type: "hub", km: 120, icon: "🏭" },
    { name: "Regional Warehouse · " + c.state, type: "warehouse", km: 220, icon: "🏬" },
    { name: "Highway Dispatch (In Transit)", type: "transit", km: 300, icon: "🚚" },
    { name: "FCI Depot · " + c.state, type: "destination", km: 420, icon: "🏁" },
  ];
}

async function main() {
  // 1. wipe previous demo data (keep centres/commodities/officer)
  for (const t of ["notifications", "payments", "shipments", "bookings"]) {
    await run("DELETE FROM " + t);
    console.log("cleared", t);
  }
  const demoFarmerIds = await all("SELECT id FROM farmers WHERE role='farmer'");
  for (const { id } of demoFarmerIds) {
    await run("DELETE FROM farmers WHERE id=?", id);
  }
  console.log("cleared farmers");

  // 2. farmers
  const farmers = [];
  const password = await bcrypt.hash("Farmer@123", 10);
  const insFarmer = "INSERT INTO farmers (id, name, phone, email, aadhaar, district, village, landSize, paymentMethod, bankName, accountNumber, ifscCode, upiId, role, password, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
  for (let i = 0; i < FARMERS.length; i++) {
    const f = FARMERS[i];
    const isUpi = f[5] === "upi";
    const farmer = {
      id: "USR_DEMO" + String(i + 1).padStart(2, "0"),
      name: f[0],
      phone: f[1],
      email: f[0].replace(/\s+/g, ".").toLowerCase() + i + "@farmer.demo",
      aadhaar: "1234-5678-" + String(9000 + i),
      district: f[2],
      village: f[3],
      landSize: f[4],
      paymentMethod: isUpi ? "upi" : "bank",
      bankName: isUpi ? "" : f[6],
      accountNumber: isUpi ? "" : f[7],
      ifscCode: isUpi ? "" : f[8],
      upiId: isUpi ? f[6] : "",
      createdAt: agoHours(72 - i),
    };
    await run(
      insFarmer,
      farmer.id, farmer.name, farmer.phone, farmer.email, farmer.aadhaar,
      farmer.district, farmer.village, farmer.landSize, farmer.paymentMethod,
      farmer.bankName, farmer.accountNumber, farmer.ifscCode, farmer.upiId,
      "farmer", password, farmer.createdAt
    );
    farmers.push(farmer);
  }
  console.log("farmers:", farmers.length);

  // 3. bookings + shipments + payments + notifications
  const insBooking =
    "INSERT INTO bookings (id, farmerId, farmerName, centreId, centreName, commodityId, commodityName, msp, date, timeSlot, quantity, grade, estAmount, status, queuePosition, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
  const insShip =
    "INSERT INTO shipments (id, bookingId, farmerId, commodityName, quantity, source, route, stage, totalStages, events, updatedAt, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
  const insPay =
    "INSERT INTO payments (id, bookingId, farmerId, commodityName, quantity, amount, status, paymentMode, transactionRef, paidAt, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)";
  const insNtf =
    "INSERT INTO notifications (id, farmerId, title, body, read, createdAt) VALUES (?,?,?,?,?,?)";

  const todayStr = iso(new Date());
  const queueCounters = {}; // centreId:date -> next position

  let shipCount = 0, payCount = 0, ntfCount = 0, bookingCount = 0;

  for (const [fi, ctrId, comId, offset, slot, qty, grade, status, stage, payment] of BOOKING_SPECS) {
    const farmer = farmers[fi];
    const c = CENTRES[ctrId];
    const cm = COMMODITIES[comId];
    const dateStr = iso(daysFromNow(offset, 9));
    const bookingId = genId("BKG");
    const queueKey = ctrId + ":" + dateStr;
    const inQueueStatuses = ["in-queue", "weighing", "qc"];
    const queued = inQueueStatuses.includes(status);

    queueCounters[queueKey] = queueCounters[queueKey] || 0;
    const queuePosition = queued ? ++queueCounters[queueKey] : null;

    const createdAt = queued
      ? agoHours(2 + fi % 4)
      : offset < 0 ? agoHours(-offset * 24 + 4) : agoHours(3);

    await run(
      insBooking,
      bookingId, farmer.id, farmer.name, ctrId, c.name, comId, cm.name, cm.msp,
      dateStr, slot, qty, grade, Math.round(qty * cm.msp),
      status, queuePosition, createdAt
    );
    bookingCount++;

    // shipment
    const route = routeFor(farmer, ctrId);
    const sStage = Math.min(stage, route.length - 1);
    const events = [];
    for (let i = 0; i <= sStage; i++) {
      events.push({ stage: i, label: STAGE_LABELS[i], at: agoHours(12 - i * 3) });
    }
    await run(
      insShip,
      genId("SHP"), bookingId, farmer.id, cm.name, qty, route[0].name,
      JSON.stringify(route), sStage, route.length - 1, JSON.stringify(events),
      agoHours(2), createdAt
    );
    shipCount++;

    // payment
    if (payment === "paid") {
      await run(
        insPay,
        genId("PAY"), bookingId, farmer.id, cm.name, qty, Math.round(qty * cm.msp),
        "paid", "Bank Transfer / UPI",
        "NEFT-" + String(400000 + bookingCount * 137), agoHours(4), agoHours(6)
      );
      payCount++;
    } else if (payment === "processing") {
      await run(
        insPay,
        genId("PAY"), bookingId, farmer.id, cm.name, qty, Math.round(qty * cm.msp),
        "processing", "Draft / Bank Transfer", null, null, agoHours(8)
      );
      payCount++;
    }

    // notifications
    await run(insNtf, genId("NTF"), farmer.id, "Procurement Slot Confirmed",
      `Your slot for ${cm.name} is confirmed at ${c.name} on ${dateStr} (${slot}).`, 1, createdAt);
    if (status === "paid") {
      await run(insNtf, genId("NTF"), farmer.id, "Payment Successful",
        `Payment of ₹${Math.round(qty * cm.msp).toLocaleString("en-IN")} for ${cm.name} has been credited to your account.`, 1, agoHours(3));
    }
    if (queued) {
      await run(insNtf, genId("NTF"), farmer.id, "Check-in Successful",
        `You are checked in at ${c.name}. Your queue number is #${queuePosition}. Estimated wait: ${Math.max(0, (queuePosition - 1) * 10)} minutes.`, 0, agoHours(1));
    }
    ntfCount += 3;
  }

  console.log("bookings:", bookingCount, "| shipments:", shipCount, "| payments:", payCount, "| notifications:", ntfCount);
  console.log("Today:", todayStr, "| Booking page default (tomorrow) has", (await all("SELECT COUNT(*) AS n FROM bookings WHERE date=?", iso(daysFromNow(1, 9))))[0].n, "bookings");
  console.log("Seed complete. Login as officer@fpo.gov.in / officer123 to explore.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Seed failed:", e);
  process.exit(1);
});