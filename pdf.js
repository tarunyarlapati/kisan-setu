// Minimal single-page PDF writer (Helvetica text only) — no dependencies.
// Used for payment receipts and MIS report exports.

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

// lines: array of {text, size, bold, gap} — rendered top-down.
function buildPdf(lines, opts) {
  opts = opts || {};
  const W = 595.28; // A4 width
  const H = 841.89; // A4 height
  const M = 48;

  let content = "BT\n";
  let y = H - M - 8;
  (lines || []).forEach((l) => {
    const size = l.size || 11;
    const gap = l.gap == null ? size * 1.45 : l.gap;
    y -= gap;
    if (y < M) return; // silently drop overflow (single page)
    content += `/${l.bold ? "F2" : "F1"} ${size} Tf\n`;
    content += `1 0 0 1 ${M} ${y} Tm\n`;
    content += `(${esc(l.text)}) Tj\n`;
  });
  content += "ET";

  const objects = [];
  let offset = 0;
  const add = (obj) => {
    const str = obj;
    objects.push(str);
    const start = offset;
    offset += Buffer.byteLength(str, "latin1");
    return { start, len: Buffer.byteLength(str, "latin1") };
  };

  const catalog = add(`<< /Type /Catalog /Pages 2 0 R >>\n`);
  const pages = add(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>\n`);
  const page = add(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>\n`
  );
  const cstream = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream\n`);
  const f1 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\n`);
  const f2 = add(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>\n`);

  let pdf = "%PDF-1.4\n";
  let cur = pdf.length;
  const xref = [0];
  const body = objects.join("");
  const writeOffset = (text) => {
    pdf += text;
    xref.push(cur);
    cur += text.length;
  };
  // Emit objects with their current offsets (pdf string built so far)
  let acc = "";
  for (let i = 0; i < objects.length; i++) {
    acc = "";
    const objStart = cur;
    xref[i + 1] = objStart;
    acc += `${i + 1} 0 obj\n${objects[i]}endobj\n`;
    pdf += acc;
    cur += acc.length;
  }
  const xrefPos = cur;
  const xrefText = `xref\n0 ${xref.length}\n0000000000 65535 f \n`;
  let xr = xrefText;
  for (let i = 1; i < xref.length; i++) {
    xr += String(xref[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += xr + `trailer\n<< /Size ${xref.length} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

function paymentReceipt(payment, booking, farmer, centre) {
  const lines = [];
  lines.push({ text: "KISAN SETU - PAYMENT RECEIPT", size: 16, bold: true });
  lines.push({ text: "Farmer Procurement Management Platform", size: 9, gap: 6 });
  lines.push({ text: `Ref: ${payment.transactionRef || payment.id}`, size: 9 });
  lines.push({ text: `Date: ${(payment.paidAt || payment.createdAt || "").slice(0, 19).replace("T", " ")} UTC`, size: 9 });
  lines.push({ text: "------------------------------------------------------------", size: 9, gap: 6 });
  lines.push({ text: `Farmer: ${farmer.name}`, size: 11 });
  lines.push({ text: `Village: ${farmer.village || "-"}  District: ${farmer.district || "-"}`, size: 10 });
  lines.push({ text: `Commodity: ${payment.commodityName || booking.commodityName}`, size: 11 });
  lines.push({ text: `Quantity: ${payment.quantity} quintals  Grade: ${booking.grade || "A"}`, size: 10 });
  lines.push({ text: `Centre: ${centre ? centre.name : booking.centreName}`, size: 10 });
  lines.push({ text: `Booking Date: ${booking.date}  Slot: ${booking.timeSlot}`, size: 10 });
  lines.push({ text: `Mode: ${payment.paymentMode || "-"}`, size: 10 });
  lines.push({ text: `Destination: ${farmer.paymentMethod === "upi" ? "UPI " + (farmer.upiId || "-") : "Bank " + (farmer.bankName || "") + " A/c " + (farmer.accountNumber || "-") + " IFSC " + (farmer.ifscCode || "-")}`, size: 10 });
  lines.push({ text: "------------------------------------------------------------", size: 9, gap: 8 });
  lines.push({ text: `AMOUNT PAID   : Rs. ${Number(payment.amount || 0).toLocaleString("en-IN")}`, size: 14, bold: true, gap: 18 });
  lines.push({ text: "Status: PAID", size: 11, bold: true });
  lines.push({ text: "This is a computer-generated receipt from Kisan Setu.", size: 8, gap: 16 });
  lines.push({ text: "Helpline: 1800-xxx-xxxx  •  www.kisansetu.gov.in", size: 8 });
  return buildPdf(lines);
}

function misReport(title, headers, rows) {
  const lines = [];
  lines.push({ text: "KISAN SETU - MIS REPORT", size: 15, bold: true });
  lines.push({ text: title, size: 11, gap: 6 });
  lines.push({ text: `Generated: ${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC`, size: 8, gap: 12 });
  lines.push({ text: "  " + (headers || []).map((h) => pad(h, 24)).join(""), size: 8, bold: true });
  (rows || []).forEach((r) => {
    const line = "  " + r.map((c) => pad(String(c == null ? "" : c), 24)).join("");
    lines.push({ text: line, size: 8, gap: 10 });
    if (lines.length > 52) return;
  });
  return buildPdf(lines);
}

function pad(s, n) {
  s = String(s || "");
  if (s.length > n) s = s.slice(0, n - 1) + "~";
  return s.padEnd(n);
}

module.exports = { buildPdf, paymentReceipt, misReport };