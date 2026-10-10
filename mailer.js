const nodemailer = require("nodemailer");

// Email is optional for the hackathon demo.
// If SMTP details are not configured via env vars, the service logs
// the notification to the console instead of sending a real email.
let transporter = null;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/**
 * Send an email notification to a farmer.
 * Falls back to console logging when SMTP is not configured.
 */
async function sendEmail(to, subject, text) {
  if (!transporter) {
    console.log(`\n[EMAIL-DEMO] To: ${to}\n[EMAIL-DEMO] Subject: ${subject}\n[EMAIL-DEMO] Body: ${text}\n`);
    return { delivered: false, demo: true };
  }
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || "procurement@fpo.gov.in",
      to,
      subject,
      text,
    });
    return { delivered: true };
  } catch (err) {
    console.error("Email send failed:", err.message);
    return { delivered: false, error: err.message };
  }
}

module.exports = { sendEmail };