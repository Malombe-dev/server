const mongoose = require('mongoose');
const { Schema, model } = mongoose;
const opts = { timestamps: true };

const PERMS = ['bookings', 'catalog', 'content', 'calendar', 'settings'];

const User = model('User', new Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ['owner', 'admin'], default: 'admin' },
  permissions: { type: Map, of: Boolean, default: {} },
  active: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: false },
  resetTokenHash: { type: String, select: false },
  resetExpires: { type: Date, select: false },
  lastLoginAt: Date,
}, opts));

const Settings = model('Settings', new Schema({
  key: { type: String, default: 'main', unique: true },
  company: { name: { type: String, default: 'BSM Ltd' }, tagline: { type: String, default: 'Stress-free moves across Kenya' }, logo: String, address: String, hours: String, areasServed: String, mapEmbedUrl: String },
  home: { heroTitle: { type: String, default: 'Move home or office without the stress.' }, heroSubtitle: { type: String, default: 'Packing, loading, transport, unpacking, TV mounting and DStv set-up. One team, one price, no surprises.' }, promoBanner: String, promoActive: { type: Boolean, default: false }, about: String },
  contacts: { phone: String, whatsapp: String, email: String },
  social: { facebook: String, instagram: String, tiktok: String, x: String },
  tax: { kraPin: String, vatEnabled: { type: Boolean, default: false }, vatRate: { type: Number, default: 16 }, vatMode: { type: String, enum: ['inclusive', 'exclusive'], default: 'exclusive' } },
  invoice: { prefix: { type: String, default: 'INV' }, terms: String, notes: String, mpesaType: { type: String, enum: ['', 'till', 'paybill'], default: '' }, mpesaNumber: String, mpesaAccount: String, bankName: String, bankAccountName: String, bankAccountNumber: String, bankBranch: String },
  calendar: { movesPerDay: { type: Number, default: 1 } },
  email: { gmailUser: String, gmailAppPassword: String, notifyEmail: String, fromName: { type: String, default: 'BSM Ltd' } },
}, opts));

const Service = model('Service', new Schema({ name: { type: String, required: true }, description: String, photo: String, icon: { type: String, default: 'Truck' }, order: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts));
const Package = model('Package', new Schema({
  service: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
  name: { type: String, required: true },
  priceType: { type: String, enum: ['fixed', 'from', 'quote'], default: 'fixed' },
  price: { type: Number, default: 0 },
  inclusions: [String], details: String, pricingImage: String,
  featured: { type: Boolean, default: false }, order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, opts));
const Addon = model('Addon', new Schema({ name: { type: String, required: true }, price: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts));

const lineSchema = new Schema({ description: String, qty: { type: Number, default: 1 }, unitPrice: { type: Number, default: 0 } }, { _id: false });
const Booking = model('Booking', new Schema({
  tracking: { type: String, unique: true, index: true },
  client: { name: String, phone: String, email: String },
  service: { type: Schema.Types.ObjectId, ref: 'Service' },
  package: { type: Schema.Types.ObjectId, ref: 'Package' },
  serviceName: String, packageName: String,
  addons: [{ addon: Schema.Types.ObjectId, name: String, price: Number }],
  pickup: String, dropoff: String, notes: String,
  requestedDate: String, confirmedDate: String, // YYYY-MM-DD
  status: { type: String, enum: ['pending', 'approved', 'in_progress', 'completed', 'rejected', 'cancelled'], default: 'pending', index: true },
  estimate: Number,
  lines: [lineSchema], discount: { type: Number, default: 0 },
  totals: { subtotal: Number, discount: Number, vat: Number, total: Number },
  paymentStatus: { type: String, enum: ['unpaid', 'deposit', 'paid'], default: 'unpaid' },
  amountPaid: { type: Number, default: 0 },
  adminMessage: String, rejectReason: String, privateNotes: String,
  called: { done: { type: Boolean, default: false }, at: Date, by: String, note: String },
  invoiceNumber: String, invoiceRevision: { type: Number, default: 0 },
  history: [{ at: { type: Date, default: Date.now }, by: String, action: String, detail: String }],
}, opts));

const Invoice = model('Invoice', new Schema({
  number: { type: String, required: true, index: true }, revision: { type: Number, default: 1 },
  booking: { type: Schema.Types.ObjectId, ref: 'Booking', index: true },
  snapshot: Schema.Types.Mixed, // frozen copy of everything printed on the invoice
  issuedBy: String,
}, opts));

const BlockedDate = model('BlockedDate', new Schema({ date: { type: String, unique: true }, reason: String }, opts));
const Gallery = model('Gallery', new Schema({ title: String, image: { type: String, required: true }, caption: String, order: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts));
const Event = model('Event', new Schema({ title: { type: String, required: true }, date: String, description: String, image: String, active: { type: Boolean, default: true } }, opts));
const Testimonial = model('Testimonial', new Schema({ name: { type: String, required: true }, location: String, text: { type: String, required: true }, rating: { type: Number, default: 5 }, active: { type: Boolean, default: true } }, opts));
const Faq = model('Faq', new Schema({ question: { type: String, required: true }, answer: { type: String, required: true }, order: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts));
const Team = model('Team', new Schema({ kind: { type: String, enum: ['staff', 'truck'], default: 'staff' }, name: { type: String, required: true }, role: String, bio: String, photo: String, order: { type: Number, default: 0 }, active: { type: Boolean, default: true } }, opts));
const ActivityLog = model('ActivityLog', new Schema({ user: String, action: String, detail: String }, opts));
const EmailLog = model('EmailLog', new Schema({ to: String, subject: String, status: { type: String, enum: ['sent', 'failed', 'skipped'] }, error: String, booking: String }, opts));
const Counter = model('Counter', new Schema({ _id: String, seq: { type: Number, default: 0 } }));

module.exports = { PERMS, User, Settings, Service, Package, Addon, Booking, Invoice, BlockedDate, Gallery, Event, Testimonial, Faq, Team, ActivityLog, EmailLog, Counter };
