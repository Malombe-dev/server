const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const M = require('../models');
const U = require('../util');
const { unavailableDates, estimateFor } = require('../booking');

const bookLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, message: { error: 'Too many requests. Please try again later.' } });
const trackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, message: { error: 'Too many attempts. Please try again later.' } });
const act = { active: true };

router.get('/settings', U.wrap(async (req, res) => res.json(U.publicSettings(await U.getSettings()))));
router.get('/services', U.wrap(async (req, res) => res.json(await M.Service.find(act).sort('order name'))));
router.get('/services/:id', U.wrap(async (req, res) => {
  const service = await M.Service.findOne({ _id: req.params.id, ...act });
  if (!service) throw new U.HttpError(404, 'Service not found');
  res.json({ service, packages: await M.Package.find({ service: service._id, ...act }).sort('order price') });
}));
router.get('/packages', U.wrap(async (req, res) => {
  const q = { ...act }; if (req.query.featured) q.featured = true; if (req.query.service) q.service = req.query.service;
  res.json(await M.Package.find(q).sort('order price').populate('service', 'name'));
}));
router.get('/addons', U.wrap(async (req, res) => res.json(await M.Addon.find(act).sort('name'))));
router.get('/gallery', U.wrap(async (req, res) => res.json(await M.Gallery.find(act).sort('order -createdAt'))));
router.get('/events', U.wrap(async (req, res) => res.json(await M.Event.find(act).sort('-date'))));
router.get('/testimonials', U.wrap(async (req, res) => res.json(await M.Testimonial.find(act).sort('-createdAt'))));
router.get('/faqs', U.wrap(async (req, res) => res.json(await M.Faq.find(act).sort('order'))));
router.get('/team', U.wrap(async (req, res) => res.json(await M.Team.find(act).sort('order name'))));
router.get('/availability', U.wrap(async (req, res) => res.json({ unavailable: await unavailableDates() })));

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a valid date');
const bookingSchema = z.object({
  name: z.string().trim().min(2, 'Enter your name'), phone: z.string().trim().min(9, 'Enter a valid phone number'),
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('')),
  serviceId: z.string().min(1), packageId: z.string().optional().or(z.literal('')),
  addonIds: z.array(z.string()).default([]),
  pickup: z.string().trim().min(2, 'Enter the pickup location'), dropoff: z.string().trim().optional().default(''),
  requestedDate: dateStr, notes: z.string().max(2000).optional().default(''),
});

router.post('/bookings', bookLimiter, U.wrap(async (req, res) => {
  const d = bookingSchema.parse(req.body);
  const today = new Date().toISOString().slice(0, 10);
  if (d.requestedDate < today) throw new U.HttpError(400, 'The date cannot be in the past.');
  if ((await unavailableDates()).includes(d.requestedDate)) throw new U.HttpError(409, 'That date is fully booked. Please choose another date.');
  const service = await M.Service.findOne({ _id: d.serviceId, active: true });
  if (!service) throw new U.HttpError(400, 'Choose a valid service.');
  let pkg = null;
  if (d.packageId) { pkg = await M.Package.findOne({ _id: d.packageId, service: service._id, active: true }); if (!pkg) throw new U.HttpError(400, 'Choose a valid package.'); }
  const addons = d.addonIds.length ? await M.Addon.find({ _id: { $in: d.addonIds }, active: true }) : [];
  let tracking, tries = 0;
  do { tracking = U.trackingNumber(); } while ((await M.Booking.exists({ tracking })) && ++tries < 5);
  const booking = await M.Booking.create({
    tracking, client: { name: d.name, phone: d.phone, email: d.email || undefined },
    service: service._id, serviceName: service.name, package: pkg?._id, packageName: pkg?.name,
    addons: addons.map((a) => ({ addon: a._id, name: a.name, price: a.price })),
    pickup: d.pickup, dropoff: d.dropoff, notes: d.notes, requestedDate: d.requestedDate,
    estimate: estimateFor(pkg, addons), history: [{ by: 'client', action: 'Booking requested' }],
  });
  const s = await U.getSettings();
  const base = process.env.CLIENT_URL || 'http://localhost:3000';
  if (booking.client.email) U.sendMailBg({ booking: tracking, to: booking.client.email, subject: `We received your booking ${tracking}`, html: `<p>Hello ${U.esc(d.name)},</p><p>Thank you for choosing ${U.esc(s.company.name)}. Your request is received.</p><p><b>Tracking number: ${tracking}</b></p><p>Service: ${U.esc(service.name)}${pkg ? ' - ' + U.esc(pkg.name) : ''}<br>Preferred date: ${d.requestedDate}<br>Pickup: ${U.esc(d.pickup)}${d.dropoff ? '<br>Drop-off: ' + U.esc(d.dropoff) : ''}</p><p>We will call you shortly to confirm the final price and date. Track your booking any time: <a href="${base}/track?tracking=${tracking}">${base}/track</a> (you will need your phone number).</p>` });
  const notify = s.email?.notifyEmail || s.contacts?.email || s.email?.gmailUser;
  if (notify) U.sendMailBg({ booking: tracking, to: notify, subject: `New booking ${tracking} - ${d.name}`, html: `<p><b>New booking request</b></p><p>${U.esc(d.name)} - ${U.esc(d.phone)}<br>${U.esc(service.name)}${pkg ? ' / ' + U.esc(pkg.name) : ''}<br>Date: ${d.requestedDate}<br>From: ${U.esc(d.pickup)}<br>To: ${U.esc(d.dropoff)}<br>Add-ons: ${addons.map((a) => U.esc(a.name)).join(', ') || 'none'}<br>Estimate: ${booking.estimate ? U.kes(booking.estimate) : 'quote needed'}</p><p><a href="${base}/admin/bookings/${booking._id}">Open in admin</a></p>` });
  res.status(201).json({ tracking, estimate: booking.estimate, requestedDate: booking.requestedDate });
}));

const trackSchema = z.object({ tracking: z.string().trim().min(5), phone: z.string().trim().min(6) });
async function findTracked(q) {
  const { tracking, phone } = trackSchema.parse(q);
  const b = await M.Booking.findOne({ tracking: tracking.toUpperCase() });
  if (!b || U.phoneKey(b.client.phone) !== U.phoneKey(phone)) throw new U.HttpError(404, 'No booking found. Check your tracking number and phone number.');
  return b;
}
router.get('/track', trackLimiter, U.wrap(async (req, res) => {
  const b = await findTracked(req.query);
  const showMoney = b.invoiceNumber && ['approved', 'in_progress', 'completed'].includes(b.status);
  res.json({
    tracking: b.tracking, status: b.status, serviceName: b.serviceName, packageName: b.packageName, name: b.client.name,
    pickup: b.pickup, dropoff: b.dropoff, requestedDate: b.requestedDate, confirmedDate: b.confirmedDate,
    estimate: b.estimate, total: showMoney ? b.totals.total : null, paymentStatus: b.paymentStatus, amountPaid: b.amountPaid,
    message: b.adminMessage, rejectReason: b.status === 'rejected' ? b.rejectReason : undefined,
    invoice: showMoney ? { number: b.invoiceNumber, revision: b.invoiceRevision } : null, createdAt: b.createdAt,
  });
}));
router.get('/track/invoice', trackLimiter, U.wrap(async (req, res) => {
  const b = await findTracked(req.query);
  if (!b.invoiceNumber || !['approved', 'in_progress', 'completed'].includes(b.status)) throw new U.HttpError(404, 'Invoice not available yet.');
  const rev = Number(req.query.rev) || b.invoiceRevision;
  const inv = await M.Invoice.findOne({ booking: b._id, revision: rev });
  if (!inv) throw new U.HttpError(404, 'Invoice not found.');
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${inv.number}.pdf"`);
  U.invoicePdf(inv).pipe(res);
}));

module.exports = router;
