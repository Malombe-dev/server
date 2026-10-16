require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const M = require('./models');

async function ensureOwner() {
  if (await M.User.exists({ role: 'owner' })) return;
  const email = (process.env.OWNER_EMAIL || 'owner@bsm.co.ke').toLowerCase(); const password = process.env.OWNER_PASSWORD || 'ChangeMe123!';
  await M.User.create({ name: 'Owner', email, passwordHash: await bcrypt.hash(password, 11), role: 'owner', mustChangePassword: true });
  console.log(`Owner account created: ${email} (you must change the password at first login)`);
}
async function seedSample() {
  if (await M.Service.countDocuments()) return;
  const S = await M.Service.insertMany([
    { name: 'House & Office Moving', icon: 'Truck', order: 1, description: 'Full-service moves with a trained crew and a fleet of clean, covered trucks. Local and upcountry.' },
    { name: 'Packing & Unpacking', icon: 'Package', order: 2, description: 'We bring the boxes, wrap and tape. We pack before the move and unpack and set up after it.' },
    { name: 'TV Mounting & DStv/Aerial Installation', icon: 'Tv', order: 3, description: 'Wall mounting, cable hiding, DStv dish and aerial set-up so you can watch on day one.' },
    { name: 'Fragile Item Handling', icon: 'Wine', order: 4, description: 'Glassware, mirrors, artwork and electronics crated and padded by our fragile specialists.' },
    { name: 'Bedroom Sleeping Nets', icon: 'BedDouble', order: 5, description: 'Mosquito nets supplied and fitted over beds, with neat ceiling or frame mounts.' },
    { name: 'Truck Fleet Hire', icon: 'Warehouse', order: 6, description: 'Need only a truck and driver? Choose from pickup, 3-tonne, 5-tonne and 10-tonne trucks.' },
  ]);
  const [mv, pk, tv, fr, nt, fl] = S.map((s) => s._id);
  await M.Package.insertMany([
    { service: mv, name: 'Bedsitter / Studio', priceType: 'from', price: 6500, inclusions: ['Pickup or small truck', '2 movers', 'Loading and offloading', 'Basic wrapping'], featured: true, order: 1 },
    { service: mv, name: '1 Bedroom', priceType: 'from', price: 12000, inclusions: ['3-tonne truck', '3 movers', 'Loading and offloading', 'Furniture wrapping'], featured: true, order: 2 },
    { service: mv, name: '2 Bedroom', priceType: 'from', price: 20000, inclusions: ['5-tonne truck', '4 movers', 'Furniture disassembly and assembly', 'Wrapping and padding'], featured: true, order: 3 },
    { service: mv, name: '3+ Bedroom / Office', priceType: 'quote', price: 0, inclusions: ['Free site visit', 'Custom truck and crew plan', 'Weekend moves available'], order: 4 },
    { service: pk, name: 'Packing only', priceType: 'from', price: 4000, inclusions: ['Boxes and tape', 'Packing crew', 'Labelling'], order: 1 },
    { service: pk, name: 'Pack + unpack', priceType: 'from', price: 7500, inclusions: ['Boxes and tape', 'Packing crew', 'Unpacking and set-up', 'Box removal'], featured: true, order: 2 },
    { service: tv, name: 'TV wall mounting', priceType: 'fixed', price: 2500, inclusions: ['Bracket fitting', 'Levelling', 'Cable tidy'], order: 1 },
    { service: tv, name: 'DStv / aerial installation', priceType: 'fixed', price: 3500, inclusions: ['Dish or aerial fitting', 'Signal alignment', 'Decoder set-up'], order: 2 },
    { service: fr, name: 'Fragile handling', priceType: 'from', price: 3000, inclusions: ['Bubble wrap and padding', 'Crating where needed', 'Careful loading'], order: 1 },
    { service: nt, name: 'Net per bed', priceType: 'fixed', price: 1500, inclusions: ['Net supply', 'Fitting and mounting'], order: 1 },
    { service: fl, name: 'Truck + driver (per day)', priceType: 'quote', price: 0, inclusions: ['Choose your truck size', 'Driver and fuel quoted by distance'], order: 1 },
  ]);
  await M.Addon.insertMany([{ name: 'Packing boxes (bundle of 10)', price: 2000 }, { name: 'TV mounting', price: 2500 }, { name: 'DStv / aerial installation', price: 3500 }, { name: 'Sleeping net (per bed)', price: 1500 }, { name: 'Fragile item handling', price: 3000 }, { name: 'Stairs / no lift', price: 2000 }]);
  await M.Faq.insertMany([
    { question: 'How do I get a final price?', answer: 'Send a booking request. The price shown is an estimate. We call you to confirm details and send an invoice once approved.', order: 1 },
    { question: 'Do I pay a deposit?', answer: 'Payment details are printed on your invoice (M-Pesa or bank). Online M-Pesa payment is planned for a later release.', order: 2 },
    { question: 'Can I change my moving date?', answer: 'Yes. Call or WhatsApp us. We update the date and send you a revised invoice.', order: 3 },
    { question: 'Which areas do you serve?', answer: 'Nairobi and surrounding towns, plus upcountry moves quoted by distance.', order: 4 },
    { question: 'Are my items insured?', answer: 'Ask us about cover for high-value items when we confirm your booking.', order: 5 },
  ]);
  await M.Testimonial.insertMany([{ name: 'Wanjiru K.', location: 'Kilimani', text: 'They packed my whole 2-bedroom in one morning and nothing broke. Very polite crew.', rating: 5 }, { name: 'Brian O.', location: 'Syokimau', text: 'TV mounted, DStv working, boxes unpacked. Moving day felt easy for once.', rating: 5 }]);
  await M.Team.insertMany([{ kind: 'staff', name: 'Crew lead', role: 'Operations', bio: 'Plans every move and walks you through the day.', order: 1 }, { kind: 'truck', name: '5-tonne covered truck', role: 'Fleet', bio: 'Ideal for 2 to 3 bedroom homes.', order: 1 }, { kind: 'truck', name: '3-tonne covered truck', role: 'Fleet', bio: 'Great for 1 bedroom homes and small offices.', order: 2 }]);
  console.log('Sample services, packages, add-ons, FAQs and testimonials added.');
}
async function seed({ sample } = {}) {
  await require('./util').getSettings();
  await M.Settings.updateOne({ key: 'main', 'contacts.phone': { $exists: false } }, { $set: { 'contacts.phone': '+254 700 000 000', 'contacts.whatsapp': '254700000000', 'contacts.email': 'info@bsm.co.ke', 'company.address': 'Nairobi, Kenya', 'company.areasServed': 'Nairobi and nationwide', 'company.hours': 'Mon-Sat 7:00 - 19:00', 'invoice.terms': 'Balance is due on completion of the move. Cancellations less than 24 hours before the move may be charged.' } });
  await ensureOwner();
  if (sample) await seedSample();
}
module.exports = { seed };
if (require.main === module) {
  mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bsm').then(() => seed({ sample: true })).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
