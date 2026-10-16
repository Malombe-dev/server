const router = require('express').Router();
const bcrypt = require('bcryptjs');
const multer = require('multer');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { z } = require('zod');
const M = require('../models');
const U = require('../util');
const B = require('../booking');

router.use(U.requireAuth);
const UPLOADS = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
// Cloudinary is used when CLOUDINARY_URL (or the three CLOUDINARY_* vars) is set; otherwise files fall back to local disk.
const USE_CLOUD = !!(process.env.CLOUDINARY_URL || (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET));
if (USE_CLOUD) cloudinary.config({ secure: true, ...(process.env.CLOUDINARY_URL ? {} : { cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET }) });
const toCloud = (buffer, public_id) => new Promise((resolve, reject) => cloudinary.uploader.upload_stream({ folder: process.env.CLOUDINARY_FOLDER || 'bsm', public_id, resource_type: 'image', overwrite: false }, (err, r) => (err ? reject(err) : resolve(r))).end(buffer));

// ---------- generic CRUD for catalog & content ----------
function crud(name, Model, perm, sort = '-createdAt', populate) {
  const r = router;
  const base = `/${name}`;
  r.get(base, U.requirePerm(perm), U.wrap(async (req, res) => { let q = Model.find(req.query.service ? { service: req.query.service } : {}).sort(sort); if (populate) q = q.populate(populate); res.json(await q); }));
  r.post(base, U.requirePerm(perm), U.wrap(async (req, res) => { const doc = await Model.create(clean(req.body)); U.logActivity(req.user, `created ${name}`, doc.name || doc.title || doc.question || String(doc._id)); res.status(201).json(doc); }));
  r.put(`${base}/:id`, U.requirePerm(perm), U.wrap(async (req, res) => { const doc = await Model.findByIdAndUpdate(req.params.id, clean(req.body), { new: true, runValidators: true }); if (!doc) throw new U.HttpError(404, 'Not found'); U.logActivity(req.user, `updated ${name}`, doc.name || doc.title || doc.question || String(doc._id)); res.json(doc); }));
  r.delete(`${base}/:id`, U.requirePerm(perm), U.wrap(async (req, res) => {
    if (name === 'services' && (await M.Package.exists({ service: req.params.id }))) throw new U.HttpError(400, 'Delete or move this service\'s packages first (or switch it off instead).');
    await Model.findByIdAndDelete(req.params.id); U.logActivity(req.user, `deleted ${name}`, req.params.id); res.json({ ok: true });
  }));
}
const clean = (b) => { const o = { ...b }; delete o._id; delete o.__v; delete o.createdAt; delete o.updatedAt; return o; };
crud('services', M.Service, 'catalog', 'order name');
crud('packages', M.Package, 'catalog', 'order name', { path: 'service', select: 'name' });
crud('addons', M.Addon, 'catalog', 'name');
crud('gallery', M.Gallery, 'content', 'order -createdAt');
crud('events', M.Event, 'content', '-date');
crud('testimonials', M.Testimonial, 'content', '-createdAt');
crud('faqs', M.Faq, 'content', 'order');
crud('team', M.Team, 'content', 'kind order name');

// ---------- uploads ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: (req, f, cb) => cb(/^image\/(jpeg|png|webp|gif)$/.test(f.mimetype) ? null : new U.HttpError(400, 'Only JPG, PNG, WebP or GIF images are allowed.'), true) });
router.post('/upload', upload.single('file'), U.wrap(async (req, res) => {
  if (!req.file) throw new U.HttpError(400, 'Choose an image to upload.');
  let out;
  try { out = await sharp(req.file.buffer).rotate().resize({ width: 1600, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(); }
  catch { throw new U.HttpError(400, 'That file is not a valid image.'); }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.webp`;
  if (USE_CLOUD) {
    let r;
    try { r = await toCloud(out, name.replace(/\.webp$/, '')); }
    catch (e) { console.error('Cloudinary upload failed:', e.message || e); throw new U.HttpError(502, 'Image storage is unavailable. Please try again.'); }
    return res.json({ url: r.secure_url });
  }
  await fs.promises.writeFile(path.join(UPLOADS, name), out);
  res.json({ url: `/uploads/${name}` });
}));

// ---------- settings ----------
function flatten(o, p = '', out = {}) { for (const [k, v] of Object.entries(o || {})) { if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p + k + '.', out); else out[p + k] = v; } return out; }
const SECTIONS = ['company', 'home', 'contacts', 'social', 'tax', 'invoice', 'calendar', 'email'];
router.get('/settings', U.requirePerm('settings'), U.wrap(async (req, res) => {
  const o = (await U.getSettings()).toObject();
  o.email = { ...o.email, hasAppPassword: !!o.email?.gmailAppPassword }; delete o.email.gmailAppPassword;
  res.json(o);
}));
router.put('/settings', U.requirePerm('settings'), U.wrap(async (req, res) => {
  const body = {}; for (const k of SECTIONS) if (req.body[k]) body[k] = req.body[k];
  if (body.email) { delete body.email.hasAppPassword; if (!body.email.gmailAppPassword) delete body.email.gmailAppPassword; else body.email.gmailAppPassword = body.email.gmailAppPassword.replace(/\s+/g, ''); }
  if (body.calendar) body.calendar.movesPerDay = Math.max(1, Number(body.calendar.movesPerDay) || 1);
  await U.getSettings();
  await M.Settings.updateOne({ key: 'main' }, { $set: flatten(body) }, { runValidators: true });
  U.logActivity(req.user, 'updated settings', Object.keys(body).join(', '));
  res.json({ ok: true });
}));
router.post('/settings/test-email', U.requirePerm('settings'), U.wrap(async (req, res) => {
  const s = await U.getSettings();
  const to = s.email?.notifyEmail || s.email?.gmailUser || process.env.GMAIL_USER;
  await U.sendMail({ to, subject: 'Test email', html: '<p>Your email settings work.</p>' });
  const last = await M.EmailLog.findOne({ to, subject: 'Test email' }).sort('-createdAt');
  res.json({ status: last?.status, error: last?.error, to });
}));

// ---------- calendar ----------
router.get('/calendar', U.requirePerm('calendar'), U.wrap(async (req, res) => {
  const s = await U.getSettings();
  const bookings = await M.Booking.find({ status: { $in: ['approved', 'in_progress'] } }, 'tracking client.name confirmedDate status serviceName');
  res.json({ movesPerDay: s.calendar.movesPerDay, blocked: await M.BlockedDate.find().sort('date'), bookings, unavailable: await B.unavailableDates() });
}));
router.put('/calendar/limit', U.requirePerm('calendar'), U.wrap(async (req, res) => {
  const n = Math.max(1, Math.floor(Number(req.body.movesPerDay) || 1)); await U.getSettings();
  await M.Settings.updateOne({ key: 'main' }, { $set: { 'calendar.movesPerDay': n } }); U.logActivity(req.user, 'changed moves per day', String(n)); res.json({ movesPerDay: n });
}));
router.post('/blocked-dates', U.requirePerm('calendar'), U.wrap(async (req, res) => {
  const { date, reason } = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().optional() }).parse(req.body);
  const d = await M.BlockedDate.findOneAndUpdate({ date }, { reason }, { upsert: true, new: true }); U.logActivity(req.user, 'blocked date', date); res.status(201).json(d);
}));
router.delete('/blocked-dates/:date', U.requirePerm('calendar'), U.wrap(async (req, res) => { await M.BlockedDate.deleteOne({ date: req.params.date }); U.logActivity(req.user, 'unblocked date', req.params.date); res.json({ ok: true }); }));

// ---------- users (owner only) ----------
const safe = (u) => { const o = u.toObject(); delete o.passwordHash; delete o.resetTokenHash; delete o.resetExpires; return o; };
const permsSchema = z.object(Object.fromEntries(M.PERMS.map((p) => [p, z.boolean().optional()]))).default({});
router.get('/users', U.ownerOnly, U.wrap(async (req, res) => res.json(await M.User.find().sort('createdAt'))));
router.post('/users', U.ownerOnly, U.wrap(async (req, res) => {
  const d = z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8), permissions: permsSchema }).parse(req.body);
  if (await M.User.exists({ email: d.email.toLowerCase() })) throw new U.HttpError(400, 'A user with that email already exists.');
  const u = await M.User.create({ name: d.name, email: d.email, passwordHash: await bcrypt.hash(d.password, 11), role: 'admin', permissions: d.permissions, mustChangePassword: true });
  U.logActivity(req.user, 'created user', u.email); res.status(201).json(safe(u));
}));
router.put('/users/:id', U.ownerOnly, U.wrap(async (req, res) => {
  const d = z.object({ name: z.string().min(2).optional(), permissions: permsSchema.optional(), active: z.boolean().optional(), password: z.string().min(8).optional() }).parse(req.body);
  const u = await M.User.findById(req.params.id).select('+passwordHash'); if (!u) throw new U.HttpError(404, 'User not found');
  if (u.role === 'owner' && d.active === false) throw new U.HttpError(400, 'The owner cannot be disabled.');
  if (d.name) u.name = d.name; if (d.permissions && u.role !== 'owner') u.permissions = d.permissions; if (d.active !== undefined) u.active = d.active;
  if (d.password) { u.passwordHash = await bcrypt.hash(d.password, 11); u.mustChangePassword = true; }
  await u.save(); U.logActivity(req.user, 'updated user', u.email); res.json(safe(u));
}));
router.delete('/users/:id', U.ownerOnly, U.wrap(async (req, res) => {
  const u = await M.User.findById(req.params.id); if (!u) throw new U.HttpError(404, 'User not found');
  if (u.role === 'owner') throw new U.HttpError(400, 'The owner cannot be deleted.');
  await u.deleteOne(); U.logActivity(req.user, 'deleted user', u.email); res.json({ ok: true });
}));

// ---------- logs ----------
router.get('/logs/activity', U.ownerOnly, U.wrap(async (req, res) => res.json(await M.ActivityLog.find().sort('-createdAt').limit(300))));
router.get('/logs/email', U.requirePerm('bookings'), U.wrap(async (req, res) => res.json(await M.EmailLog.find().sort('-createdAt').limit(300))));

// ---------- dashboard ----------
router.get('/dashboard', U.wrap(async (req, res) => {
  const s = await U.getSettings();
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  const month = today.slice(0, 7);
  const live = { $in: ['approved', 'in_progress'] };
  const [pending, todayMoves, upcoming, monthBookings, recent, failedEmails] = await Promise.all([
    M.Booking.countDocuments({ status: 'pending' }),
    M.Booking.find({ confirmedDate: today, status: live }).select('tracking client serviceName status confirmedDate'),
    M.Booking.find({ confirmedDate: { $gt: today, $lte: week }, status: live }).sort('confirmedDate').select('tracking client serviceName status confirmedDate'),
    M.Booking.find({ confirmedDate: { $regex: '^' + month }, status: { $in: ['approved', 'in_progress', 'completed'] } }).select('totals amountPaid status'),
    M.Booking.find({ status: 'pending' }).sort('-createdAt').limit(8).select('tracking client serviceName requestedDate createdAt'),
    M.EmailLog.countDocuments({ status: 'failed', createdAt: { $gt: new Date(Date.now() - 7 * 864e5) } }),
  ]);
  res.json({
    pending, todayMoves, upcoming, recent, failedEmails,
    emailConfigured: !!((s.email?.gmailUser && s.email?.gmailAppPassword) || (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)),
    month: { moves: monthBookings.length, invoiced: monthBookings.reduce((a, b) => a + (b.totals?.total || 0), 0), paid: monthBookings.reduce((a, b) => a + (b.amountPaid || 0), 0), completed: monthBookings.filter((b) => b.status === 'completed').length },
  });
}));

// ---------- bookings ----------
const bk = U.requirePerm('bookings');
router.get('/bookings', bk, U.wrap(async (req, res) => {
  const { status, q, date } = req.query; const f = {};
  if (status && status !== 'all') f.status = status;
  if (date) f.$or = [{ requestedDate: date }, { confirmedDate: date }];
  if (q) { const rx = new RegExp(String(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); f.$and = [{ $or: [{ tracking: rx }, { 'client.name': rx }, { 'client.phone': rx }, { 'client.email': rx }, { invoiceNumber: rx }] }]; }
  res.json(await M.Booking.find(f).sort('-createdAt').limit(200).select('-history -privateNotes'));
}));
router.get('/bookings/:id', bk, U.wrap(async (req, res) => {
  const b = await M.Booking.findById(req.params.id).populate('package', 'price priceType name service'); if (!b) throw new U.HttpError(404, 'Booking not found');
  const invoices = await M.Invoice.find({ booking: b._id }).sort('revision').select('number revision createdAt issuedBy snapshot.totals');
  const emails = await M.EmailLog.find({ booking: b.tracking }).sort('-createdAt');
  res.json({ booking: b, invoices, emails });
}));
const hist = (b, user, action, detail) => b.history.push({ by: user.email, action, detail });
const load = async (id) => { const b = await M.Booking.findById(id); if (!b) throw new U.HttpError(404, 'Booking not found'); return b; };

const approveSchema = z.object({
  confirmedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the confirmed date'), packageId: z.string().optional().or(z.literal('')),
  lines: z.array(z.object({ description: z.string().min(1), qty: z.coerce.number().min(0), unitPrice: z.coerce.number().min(0) })).min(1, 'Add at least one invoice line'),
  discount: z.coerce.number().min(0).default(0), message: z.string().max(2000).optional().default(''), override: z.boolean().optional().default(false),
});
async function applyApproval(b, req, revised) {
  const d = approveSchema.parse(req.body);
  const cap = await B.dateIsFull(d.confirmedDate, b._id);
  if (cap.blocked || cap.full) {
    if (!(req.user.role === 'owner' && d.override)) throw new U.HttpError(409, cap.blocked ? 'That date is blocked.' : `That date is full (${cap.count}/${cap.limit} moves).`, { code: 'DATE_FULL', canOverride: req.user.role === 'owner' });
    hist(b, req.user, 'Date capacity overridden', d.confirmedDate);
  }
  if (d.packageId && String(b.package) !== d.packageId) { const p = await M.Package.findById(d.packageId).populate('service'); if (!p) throw new U.HttpError(400, 'Package not found'); b.package = p._id; b.packageName = p.name; b.service = p.service._id; b.serviceName = p.service.name; }
  const s = await U.getSettings();
  const prevDate = b.confirmedDate;
  b.confirmedDate = d.confirmedDate; b.lines = d.lines; b.discount = d.discount; b.adminMessage = d.message;
  b.totals = U.calcTotals(d.lines, d.discount, s.tax);
  if (!revised) b.status = 'approved';
  const inv = await B.issueInvoice(b, req.user);
  hist(b, req.user, revised ? `Invoice reissued (rev ${inv.revision})` : 'Booking approved', `${inv.number} - ${U.kes(b.totals.total)} - ${d.confirmedDate}${prevDate && prevDate !== d.confirmedDate ? ` (was ${prevDate})` : ''}`);
  await b.save();
  await B.emailInvoice(b, inv, revised);
  U.logActivity(req.user, revised ? 'reissued invoice' : 'approved booking', `${b.tracking} ${inv.number}`);
  return { booking: b, invoice: inv };
}
router.get('/bookings/:id/draft', bk, U.wrap(async (req, res) => { // suggested invoice lines
  const b = await load(req.params.id); const pkg = b.package ? await M.Package.findById(b.package) : null;
  res.json({ lines: b.lines.length ? b.lines : B.defaultLines({ ...b.toObject(), packagePrice: pkg && pkg.priceType !== 'quote' ? pkg.price : 0 }) });
}));
router.post('/bookings/:id/approve', bk, U.wrap(async (req, res) => {
  const b = await load(req.params.id);
  if (b.status !== 'pending') throw new U.HttpError(400, 'Only pending bookings can be approved.');
  res.json(await applyApproval(b, req, false));
}));
router.post('/bookings/:id/reissue', bk, U.wrap(async (req, res) => {
  const b = await load(req.params.id);
  if (!b.invoiceNumber || !['approved', 'in_progress', 'completed'].includes(b.status)) throw new U.HttpError(400, 'Approve the booking first.');
  res.json(await applyApproval(b, req, true));
}));
router.post('/bookings/:id/reject', bk, U.wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().min(3, 'Give a reason') }).parse(req.body); const b = await load(req.params.id);
  if (b.status !== 'pending') throw new U.HttpError(400, 'Only pending bookings can be rejected.');
  b.status = 'rejected'; b.rejectReason = reason; hist(b, req.user, 'Booking rejected', reason); await b.save();
  if (b.client.email) U.sendMailBg({ booking: b.tracking, to: b.client.email, subject: `About your booking ${b.tracking}`, html: `<p>Hello ${U.esc(b.client.name)},</p><p>Sorry, we are unable to take your booking.</p><p>${U.esc(reason)}</p><p>Please contact us and we will help find another option.</p>` });
  U.logActivity(req.user, 'rejected booking', b.tracking); res.json(b);
}));
const transition = (name, from, to, label) => router.post(`/bookings/:id/${name}`, bk, U.wrap(async (req, res) => {
  const b = await load(req.params.id);
  if (!from.includes(b.status)) throw new U.HttpError(400, `Cannot ${name} a ${b.status.replace('_', ' ')} booking.`);
  b.status = to; hist(b, req.user, label, req.body?.reason); await b.save();
  if (name === 'cancel' && b.client.email) U.sendMailBg({ booking: b.tracking, to: b.client.email, subject: `Booking ${b.tracking} cancelled`, html: `<p>Hello ${U.esc(b.client.name)},</p><p>Your booking ${b.tracking} has been cancelled.${req.body?.reason ? ' Reason: ' + U.esc(req.body.reason) : ''}</p>` });
  U.logActivity(req.user, label.toLowerCase(), b.tracking); res.json(b);
}));
transition('start', ['approved'], 'in_progress', 'Move started');
transition('complete', ['approved', 'in_progress'], 'completed', 'Move completed');
transition('cancel', ['pending', 'approved', 'in_progress'], 'cancelled', 'Booking cancelled');
router.post('/bookings/:id/payment', bk, U.wrap(async (req, res) => {
  const d = z.object({ paymentStatus: z.enum(['unpaid', 'deposit', 'paid']), amountPaid: z.coerce.number().min(0) }).parse(req.body); const b = await load(req.params.id);
  b.paymentStatus = d.paymentStatus; b.amountPaid = d.amountPaid; hist(b, req.user, 'Payment updated', `${d.paymentStatus} - ${U.kes(d.amountPaid)}`); await b.save(); U.logActivity(req.user, 'payment updated', b.tracking); res.json(b);
}));
router.post('/bookings/:id/notes', bk, U.wrap(async (req, res) => { const b = await load(req.params.id); b.privateNotes = String(req.body.privateNotes || '').slice(0, 5000); await b.save(); res.json(b); }));
router.post('/bookings/:id/call', bk, U.wrap(async (req, res) => {
  const b = await load(req.params.id); b.called = { done: true, at: new Date(), by: req.user.name, note: String(req.body.note || '').slice(0, 500) };
  hist(b, req.user, 'Client called', b.called.note); await b.save(); res.json(b);
}));
router.get('/bookings/:id/invoice/:rev', bk, U.wrap(async (req, res) => {
  const inv = await M.Invoice.findOne({ booking: req.params.id, revision: Number(req.params.rev) }); if (!inv) throw new U.HttpError(404, 'Invoice not found');
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${inv.number}-rev${inv.revision}.pdf"`); U.invoicePdf(inv).pipe(res);
}));

module.exports = router;
