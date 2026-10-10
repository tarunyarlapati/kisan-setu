// SMS notifications with multi-provider support and automatic failover.
// Providers (tried in order until one succeeds):
//   1. twilio   - Twilio REST API (no SDK). Env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
//                 (or TWILIO_API_KEY_SID/TWILIO_API_KEY_SECRET), TWILIO_PHONE_NUMBER.
//                 Optional TWILIO_TRIAL_TEMPLATE (trial accounts use predefined templates).
//   2. textbee  - FREE: self-hosted/open-source Android SMS gateway (use any SIM, no
//                 per-message fees). Env: TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID.
//                 Optional TEXTBEE_BASE_URL (default https://api.textbee.dev/api/v1).
//                 Setup: install textbee Android app on a spare phone -> scan QR.
//   3. fast2sms - Cheap Indian gateway (~Rs.0.30/SMS). Env: FAST2SMS_API_KEY.
//                 Optional FAST2SMS_SENDER_ID.
//   4. demo     - No credentials: logs the message to the console (free, offline).
// Override provider order or lock a single provider with SMS_PROVIDER env, e.g.
//   SMS_PROVIDER=textbee   (only textbee; fall back to demo if it fails)

const CANDIDATES = ["twilio", "textbee", "fast2sms"];
const LOCKED = (process.env.SMS_PROVIDER || "").toLowerCase().trim();
const FALLBACK_TO_DEMO = (process.env.SMS_FALLBACK_TO_DEMO || "true").toLowerCase() !== "false";

// ─── Throttle — protects farmers from SMS spam (per-number + global) ───
const PER_NUMBER = new Map(); // target -> [timestamps]
const GLOBAL_LOG = []; // timestamps
const NUM_MAX_PER_MIN = 3;
const GLOBAL_MAX_PER_MIN = 25;

function throttleHit(target) {
  const now = Date.now();
  const globalWindow = GLOBAL_LOG.filter((t) => now - t < 60_000);
  GLOBAL_LOG.length = 0;
  GLOBAL_LOG.push(...globalWindow);
  if (GLOBAL_LOG.length >= GLOBAL_MAX_PER_MIN) return true;

  const arr = (PER_NUMBER.get(target) || []).filter((t) => now - t < 60_000);
  PER_NUMBER.set(target, arr);
  if (arr.length >= NUM_MAX_PER_MIN) return true;
  arr.push(now);
  PER_NUMBER.set(target, arr);
  return false;
}

// Persist every SMS attempt so officers can audit delivery on the dashboard.
function logSms(number, text, outcome) {
  try {
    const { run } = require("./db");
    const status = outcome.delivered ? "delivered" : outcome.demo ? "demo" : outcome.skipped ? "skipped" : "failed";
    const detail = outcome.reason || outcome.errors || (outcome.delivered && outcome.sid ? `sid:${outcome.sid}` : null);
    const id = "SMS_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    run(
      "INSERT INTO sms_log (id, to_number, message, provider, status, error, createdAt) VALUES (?,?,?,?,?,?,?)",
      id, number, String(text || "").slice(0, 500), outcome.provider || (outcome.demo ? "demo" : "none"),
      status, detail ? JSON.stringify(detail) : null, new Date().toISOString()
    );
  } catch (e) {
    console.error("[SMS-LOG] could not write sms_log:", e.message);
  }
}

function normalizeNumber(to) {
  let target = String(to).replace(/[^0-9+]/g, "");
  if (/^[6-9]\d{9}$/.test(target)) target = "+91" + target;
  if (!target.startsWith("+")) target = "+" + target;
  return target;
}

async function sendTwilio(target, text) {
  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const API_KEY_SID = process.env.TWILIO_API_KEY_SID;
  const API_KEY_SECRET = process.env.TWILIO_API_KEY_SECRET;
  const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const SID = API_KEY_SID || ACCOUNT_SID;
  const TOKEN = API_KEY_SECRET || AUTH_TOKEN;
  const FROM = process.env.TWILIO_PHONE_NUMBER;
  if (!SID || !TOKEN || !FROM || !ACCOUNT_SID) return null; // not configured
  const TRIAL_TEMPLATE = process.env.TWILIO_TRIAL_TEMPLATE;

  const auth = Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  if (TRIAL_TEMPLATE) {
    console.log(`[SMS-TWILIO] Trial template "${TRIAL_TEMPLATE}" — intended content: ${text}`);
  }
  const body = new URLSearchParams({
    From: FROM,
    To: target,
    Body: TRIAL_TEMPLATE || text,
  });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "TWILIO SMS delivery failed");
  return { provider: "twilio", sid: data.sid };
}

async function sendTextbee(target, text) {
  const apiKey = process.env.TEXTBEE_API_KEY;
  const deviceId = process.env.TEXTBEE_DEVICE_ID;
  if (!apiKey || !deviceId) return null; // not configured
  const base = process.env.TEXTBEE_BASE_URL || "https://api.textbee.dev/api/v1";
  const res = await fetch(`${base}/gateway/devices/${deviceId}/send-sms`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({ recipients: [target], message: text }),
  });
  if (!res.ok) throw new Error(`TEXTBEE SMS failed (${res.status})`);
  return { provider: "textbee" };
}

async function sendFast2Sms(target, text) {
  const apiKey = process.env.FAST2SMS_API_KEY;
  if (!apiKey) return null; // not configured
  const senderId = process.env.FAST2SMS_SENDER_ID;
  const digits = target.replace(/\D/g, "").replace(/^91/, "");
  const body = {
    message: text,
    language: "english",
    route: "q",
    numbers: digits,
    expose: "0",
  };
  if (senderId) body.sender_id = senderId;
  const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
    method: "POST",
    headers: {
      authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`FAST2SMS failed (${res.status})`);
  const data = await res.json();
  if (!data || data.return === false) {
    throw new Error(data && data.message ? data.message : "FAST2SMS rejected the message");
  }
  return { provider: "fast2sms", requestId: data.request_id };
}

const PROVIDERS = {
  twilio: sendTwilio,
  textbee: sendTextbee,
  fast2sms: sendFast2Sms,
};

/**
 * Send an SMS to a farmer's mobile number.
 * Tries configured providers in order (or only SMS_PROVIDER if locked) and
 * falls back to console demo logging when nothing is configured / everything fails.
 */
async function sendSms(to, text) {
  if (!to) {
    console.log("[SMS-SKIP] No phone number provided for farmer.");
    const skipped = { delivered: false, skipped: true };
    logSms("(none)", text, skipped);
    return skipped;
  }
  const target = normalizeNumber(to);

  if (throttleHit(target)) {
    const throttled = { delivered: false, skipped: true, reason: "throttled" };
    logSms(target, text, throttled);
    console.log(`[SMS-THROTTLE] skipped send to ${target} (too many recently, anti-spam)`);
    return throttled;
  }

  const order = LOCKED ? [LOCKED] : CANDIDATES;
  const errors = [];
  let outcome = null;
  for (const name of order) {
    const send = PROVIDERS[name];
    if (!send) continue;
    try {
      const result = await send(target, text);
      if (result) {
        console.log(`[SMS-OK] ${result.provider.toUpperCase()} → ${target}`);
        outcome = { delivered: true, ...result };
        break;
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }

  if (!outcome && FALLBACK_TO_DEMO) {
    if (errors.length) console.error("[SMS] provider errors:", errors.join(" | "));
    console.log(`\n[SMS-DEMO] To: ${target}\n[SMS-DEMO] ${text}\n`);
    outcome = { delivered: false, demo: true, errors };
  }
  if (!outcome) outcome = { delivered: false, errors };

  logSms(target, text, outcome);
  return outcome;
}

module.exports = { sendSms };