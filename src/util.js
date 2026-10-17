const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const M = require('./models');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'bsm_token';
const prod = process.env.NODE_ENV === 'production';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); } }

// ---------- auth ----------
function signIn(res, user) {
  const token = jwt.sign({ id: user._id }, SECRET, { expiresIn: '7d' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: prod && process.env.COOKIE_SECURE !== 'false', maxAge: 7 * 864e5, path: '/' });
}
const requireAuth = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) throw new HttpError(401, 'Please log in.');
  let payload;
  try { payload = jwt.verify(token, SECRET); } catch { throw new HttpError(401, 'Session expired. Please log in again.'); }
  const user = await M.User.findById(payload.id);
  if (!user || !user.active) throw new HttpError(401, 'Account not available.');
  req.user = user;
  if (user.mustChangePassword && !req.path.startsWith('/change-password') && !req.originalUrl.includes('/auth/')) throw new HttpError(403, 'Change your password first.', { code: 'MUST_CHANGE_PASSWORD' });
  next();
});
const can = (user, perm) => user.role === 'owner' || (user.permissions && user.permissions.get && user.permissions.get(perm) === true);
const requirePerm = (perm) => (req, res, next) => can(req.user, perm) ? next() : next(new HttpError(403, `You don't have the "${perm}" permission.`));
const ownerOnly = (req, res, next) => req.user.role === 'owner' ? next() : next(new HttpError(403, 'Owner only.'));
const logActivity = (user, action, detail = '') => M.ActivityLog.create({ user: user?.email || user || 'system', action, detail }).catch(() => {});

// ---------- settings ----------
async function getSettings() {
  let s = await M.Settings.findOne({ key: 'main' });
  if (!s) s = await M.Settings.create({ key: 'main' });
  return s;
}
function publicSettings(s) {
  const o = s.toObject();
  delete o.email; // never expose email credentials
  return o;
}

// ---------- tracking & money ----------
function trackingNumber(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const code = crypto.randomBytes(3).toString('hex').toUpperCase().replace(/[01OI]/g, 'X').slice(0, 4);
  return `BSM-${p(d.getFullYear() % 100)}${p(d.getMonth() + 1)}${p(d.getDate())}-${code}`;
}
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
function calcTotals(lines, discount, tax) {
  const subtotal = round(lines.reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0));
  const disc = Math.min(round(discount), subtotal);
  const net = round(subtotal - disc);
  let vat = 0, total = net;
  if (tax.vatEnabled) {
    const r = (Number(tax.vatRate) || 0) / 100;
    if (tax.vatMode === 'inclusive') vat = round(net - net / (1 + r));
    else { vat = round(net * r); total = round(net + vat); }
  }
  return { subtotal, discount: disc, vat, total };
}
const phoneKey = (p = '') => { const d = String(p).replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : d; };
async function nextSeq(id) { const c = await M.Counter.findOneAndUpdate({ _id: id }, { $inc: { seq: 1 } }, { upsert: true, new: true }); return c.seq; }

// ---------- email (background, logged) ----------
// Uses Brevo's HTTPS API when BREVO_API_KEY is set (works on hosts that block SMTP, e.g. Render free tier);
// otherwise falls back to Gmail SMTP.
async function sendViaBrevo({ s, to, subject, html, attachments }) {
  const senderEmail = process.env.BREVO_SENDER_EMAIL || s.email?.gmailUser || process.env.GMAIL_USER;
  if (!senderEmail) throw new Error('Set BREVO_SENDER_EMAIL to your verified Brevo sender address');
  const body = {
    sender: { name: s.email?.fromName || s.company.name, email: senderEmail },
    to: [{ email: to }],
    subject,
    htmlContent: layout(s, subject, html),
  };
  if (attachments?.length) body.attachment = attachments.map((a) => ({ name: a.filename, content: Buffer.from(a.content).toString('base64') }));
  const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
}
const emailConfigured = (s) => !!(process.env.BREVO_API_KEY || (s.email?.gmailUser && s.email?.gmailAppPassword) || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD));
async function sendMail({ to, subject, html, attachments, booking }) {
  try {
    const s = await getSettings();
    if (!to || !emailConfigured(s)) { await M.EmailLog.create({ to, subject, status: 'skipped', error: 'Email not configured', booking }); return; }
    if (process.env.BREVO_API_KEY) await sendViaBrevo({ s, to, subject, html, attachments });
    else {
      const user = s.email?.gmailUser || process.env.GMAIL_USER;
      const pass = s.email?.gmailAppPassword || process.env.GMAIL_APP_PASSWORD;
      const tr = nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, connectionTimeout: 15000, socketTimeout: 20000 });
      await tr.sendMail({ from: `"${s.email?.fromName || s.company.name}" <${user}>`, to, subject, html: layout(s, subject, html), attachments });
    }
    await M.EmailLog.create({ to, subject, status: 'sent', booking });
  } catch (e) {
    await M.EmailLog.create({ to, subject, status: 'failed', error: String(e.message).slice(0, 300), booking }).catch(() => {});
  }
}
const sendMailBg = (o) => { setImmediate(() => sendMail(o)); };
const esc = (t = '') => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function layout(s, title, body) {
  return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;border:1px solid #eee"><div style="background:#7a1424;color:#fff;padding:16px 20px;font-size:18px;font-weight:bold">${esc(s.company.name)}</div><div style="padding:20px;color:#222;line-height:1.5">${body}</div><div style="background:#f6f1f1;padding:12px 20px;font-size:12px;color:#666">${esc(s.company.name)} ${s.contacts?.phone ? '· ' + esc(s.contacts.phone) : ''}</div></div>`;
}
const kes = (n) => 'KES ' + Number(n || 0).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// ---------- invoice PDF (from frozen snapshot) ----------
function invoicePdf(inv) {
  const s = inv.snapshot;
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  const maroon = '#7a1424';
  doc.rect(0, 0, 595, 90).fill(maroon);
  doc.fillColor('#fff').fontSize(22).font('Helvetica-Bold').text(s.company.name, 40, 28);
  doc.fontSize(10).font('Helvetica').text([s.company.address, s.contacts.phone, s.contacts.email].filter(Boolean).join('  |  '), 40, 58, { width: 515 });
  doc.fillColor('#000').fontSize(18).font('Helvetica-Bold').text('INVOICE', 40, 110);
  doc.fontSize(10).font('Helvetica');
  const right = (t, y) => doc.text(t, 330, y, { width: 225, align: 'right' });
  right(`Invoice no: ${inv.number}${inv.revision > 1 ? ' (rev ' + inv.revision + ')' : ''}`, 112);
  right(`Date: ${new Date(s.issuedAt).toLocaleDateString('en-GB')}`, 126);
  right(`Booking ref: ${s.tracking}`, 140);
  if (s.company.kraPin) right(`KRA PIN: ${s.company.kraPin}`, 154);
  doc.text('Bill to', 40, 150).font('Helvetica-Bold').text(s.client.name).font('Helvetica').text([s.client.phone, s.client.email].filter(Boolean).join(' | '));
  doc.moveDown(0.5).text(`Service: ${s.serviceName}${s.packageName ? ' - ' + s.packageName : ''}`);
  doc.text(`Move date: ${s.confirmedDate}`);
  if (s.pickup) doc.text(`From: ${s.pickup}`);
  if (s.dropoff) doc.text(`To: ${s.dropoff}`);
  let y = Math.max(doc.y + 14, 250);
  doc.rect(40, y, 515, 20).fill(maroon);
  doc.fillColor('#fff').font('Helvetica-Bold').text('Description', 46, y + 6).text('Qty', 330, y + 6, { width: 40, align: 'right' }).text('Unit price', 380, y + 6, { width: 80, align: 'right' }).text('Amount', 470, y + 6, { width: 80, align: 'right' });
  y += 26; doc.fillColor('#000').font('Helvetica');
  for (const l of s.lines) {
    if (y > 740) { doc.addPage(); y = 50; }
    const h = doc.heightOfString(l.description || '', { width: 280 });
    doc.text(l.description || '', 46, y, { width: 280 }).text(String(l.qty), 330, y, { width: 40, align: 'right' }).text(kes(l.unitPrice), 380, y, { width: 80, align: 'right' }).text(kes(l.qty * l.unitPrice), 470, y, { width: 80, align: 'right' });
    y += Math.max(h, 12) + 8; doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor('#ddd').stroke();
  }
  const row = (label, val, bold) => { doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#000').text(label, 350, y, { width: 110, align: 'right' }).text(val, 470, y, { width: 80, align: 'right' }); y += bold ? 20 : 15; };
  y += 6; row('Subtotal', kes(s.totals.subtotal));
  if (s.totals.discount) row('Discount', '- ' + kes(s.totals.discount));
  if (s.tax.vatEnabled) row(`VAT ${s.tax.vatRate}%${s.tax.vatMode === 'inclusive' ? ' (incl.)' : ''}`, kes(s.totals.vat));
  row('Total', kes(s.totals.total), true);
  if (s.amountPaid) row('Paid', kes(s.amountPaid));
  doc.fontSize(10).font('Helvetica');
  y += 14; doc.fillColor(maroon).font('Helvetica-Bold').text('Payment details', 40, y); y = doc.y + 2; doc.fillColor('#000').font('Helvetica');
  const pay = s.payment, lines = [];
  if (pay.mpesaNumber) lines.push(`M-Pesa ${pay.mpesaType === 'paybill' ? 'Paybill' : 'Till'}: ${pay.mpesaNumber}${pay.mpesaAccount ? ' (Account: ' + pay.mpesaAccount + ')' : ''}`);
  if (pay.bankAccountNumber) lines.push(`Bank: ${pay.bankName || ''} ${pay.bankBranch ? '(' + pay.bankBranch + ')' : ''} - ${pay.bankAccountName || ''} - ${pay.bankAccountNumber}`);
  doc.text(lines.join('\n') || 'Contact us for payment details.', 40, y, { width: 515 });
  if (s.adminMessage) { doc.moveDown().font('Helvetica-Bold').text('Message').font('Helvetica').text(s.adminMessage, { width: 515 }); }
  if (s.terms || s.notes) { doc.moveDown().font('Helvetica-Bold').text('Terms & notes').font('Helvetica').fontSize(9).text([s.terms, s.notes].filter(Boolean).join('\n'), { width: 515 }); }
  doc.end();
  return doc;
}

module.exports = { wrap, HttpError, signIn, requireAuth, requirePerm, ownerOnly, can, logActivity, getSettings, publicSettings, trackingNumber, calcTotals, phoneKey, nextSeq, sendMail, sendMailBg, emailConfigured, esc, kes, invoicePdf, COOKIE, round };
