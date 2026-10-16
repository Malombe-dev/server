const M = require('./models');
const U = require('./util');

async function unavailableDates() {
  const s = await U.getSettings();
  const limit = s.calendar?.movesPerDay || 1;
  const blocked = (await M.BlockedDate.find({}, 'date')).map((b) => b.date);
  const full = await M.Booking.aggregate([
    { $match: { status: { $in: ['approved', 'in_progress'] }, confirmedDate: { $exists: true, $ne: null } } },
    { $group: { _id: '$confirmedDate', n: { $sum: 1 } } }, { $match: { n: { $gte: limit } } },
  ]);
  return [...new Set([...blocked, ...full.map((f) => f._id)])];
}
async function dateIsFull(date, excludeId) {
  const s = await U.getSettings();
  const limit = s.calendar?.movesPerDay || 1;
  const blocked = await M.BlockedDate.exists({ date });
  const n = await M.Booking.countDocuments({ _id: { $ne: excludeId }, status: { $in: ['approved', 'in_progress'] }, confirmedDate: date });
  return { blocked: !!blocked, full: n >= limit, count: n, limit };
}
function estimateFor(pkg, addons) {
  if (pkg && pkg.priceType === 'quote') return null;
  const total = (pkg ? pkg.price : 0) + addons.reduce((a, x) => a + (x.price || 0), 0);
  return total > 0 ? total : null;
}
function defaultLines(b) {
  const lines = [];
  if (b.packageName) lines.push({ description: `${b.serviceName} - ${b.packageName}`, qty: 1, unitPrice: b.packagePrice || 0 });
  else lines.push({ description: b.serviceName, qty: 1, unitPrice: 0 });
  for (const a of b.addons) lines.push({ description: a.name, qty: 1, unitPrice: a.price || 0 });
  return lines;
}

// Create (or revise) the invoice from a frozen snapshot of everything printed on it.
async function issueInvoice(booking, user) {
  const s = await U.getSettings();
  const o = s.toObject();
  let number = booking.invoiceNumber;
  if (!number) {
    const year = new Date().getFullYear();
    number = `${o.invoice.prefix || 'INV'}-${year}-${String(await U.nextSeq('invoice-' + year)).padStart(4, '0')}`;
  }
  const revision = (booking.invoiceRevision || 0) + 1;
  const snapshot = {
    issuedAt: new Date(), tracking: booking.tracking, company: { name: o.company.name, address: o.company.address, kraPin: o.tax.kraPin }, contacts: o.contacts,
    tax: { vatEnabled: o.tax.vatEnabled, vatRate: o.tax.vatRate, vatMode: o.tax.vatMode },
    payment: { mpesaType: o.invoice.mpesaType, mpesaNumber: o.invoice.mpesaNumber, mpesaAccount: o.invoice.mpesaAccount, bankName: o.invoice.bankName, bankAccountName: o.invoice.bankAccountName, bankAccountNumber: o.invoice.bankAccountNumber, bankBranch: o.invoice.bankBranch },
    terms: o.invoice.terms, notes: o.invoice.notes, client: booking.client.toObject ? booking.client.toObject() : booking.client,
    serviceName: booking.serviceName, packageName: booking.packageName, confirmedDate: booking.confirmedDate, pickup: booking.pickup, dropoff: booking.dropoff,
    lines: booking.lines.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice })), totals: booking.totals, amountPaid: booking.amountPaid, adminMessage: booking.adminMessage,
  };
  const inv = await M.Invoice.create({ number, revision, booking: booking._id, snapshot, issuedBy: user.email });
  booking.invoiceNumber = number; booking.invoiceRevision = revision;
  return inv;
}
async function pdfBuffer(inv) {
  const doc = U.invoicePdf(inv); const chunks = [];
  await new Promise((r, j) => { doc.on('data', (c) => chunks.push(c)); doc.on('end', r); doc.on('error', j); });
  return Buffer.concat(chunks);
}
async function emailInvoice(booking, inv, revised) {
  if (!booking.client.email) return;
  const base = process.env.CLIENT_URL || 'http://localhost:3000';
  const t = booking.totals;
  const content = Buffer.from(await pdfBuffer(inv));
  U.sendMailBg({ booking: booking.tracking, to: booking.client.email, subject: `${revised ? 'Updated invoice' : 'Booking confirmed'} ${inv.number} (${booking.tracking})`,
    html: `<p>Hello ${U.esc(booking.client.name)},</p><p>${revised ? 'Your booking details changed. Please find the updated invoice attached.' : 'Your booking is confirmed. Your invoice is attached.'}</p><p><b>Move date:</b> ${booking.confirmedDate}<br><b>Total:</b> ${U.kes(t.total)}</p>${booking.adminMessage ? `<p>${U.esc(booking.adminMessage)}</p>` : ''}<p>Track your booking: <a href="${base}/track?tracking=${booking.tracking}">${base}/track</a></p>`,
    attachments: [{ filename: `${inv.number}${inv.revision > 1 ? '-rev' + inv.revision : ''}.pdf`, content, contentType: 'application/pdf' }] });
}
module.exports = { unavailableDates, dateIsFull, estimateFor, defaultLines, issueInvoice, emailInvoice, pdfBuffer };
