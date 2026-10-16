require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { ZodError } = require('zod');
const U = require('./util');
const { seed } = require('./seed');

const app = express();
app.set('trust proxy', 1);
const allowed = (process.env.CLIENT_URL || 'http://localhost:3000').split(',').map((s) => s.trim().replace(/\/$/, ''));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
if (process.env.NODE_ENV !== 'test') app.use(morgan('tiny'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
// origin check: browser requests that change data must come from our own site
app.use((req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const o = req.headers.origin;
  if (o && !allowed.includes(o.replace(/\/$/, ''))) return res.status(403).json({ error: 'Request blocked (origin not allowed).' });
  next();
});
app.use('/api', rateLimit({ windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use('/uploads', express.static(process.env.UPLOAD_DIR || path.join(__dirname, '../uploads'), { maxAge: '30d' }));

app.get('/api/health', (req, res) => res.json({ ok: true, db: mongoose.connection.readyState === 1 }));
app.use('/api/public', require('./routes/public'));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use((err, req, res, next) => {
  if (err instanceof ZodError) return res.status(400).json({ error: err.issues[0]?.message || 'Invalid data', fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  if (err.name === 'ValidationError') return res.status(400).json({ error: Object.values(err.errors)[0].message });
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.code === 11000) return res.status(400).json({ error: 'That value already exists.' });
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Image is too large (max 8 MB).' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message, code: err.code, canOverride: err.canOverride });
});

const PORT = process.env.PORT || 4000;
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) { console.error('Set JWT_SECRET (32+ characters) in production.'); process.exit(1); }
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bsm')
  .then(() => seed({ sample: process.env.SEED_SAMPLE !== 'false' }))
  .then(() => app.listen(PORT, () => console.log(`BSM API listening on :${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
