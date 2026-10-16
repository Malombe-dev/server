// One-off: upload existing local images to Cloudinary and rewrite "/uploads/xxx.webp" values in MongoDB.
// Usage (from /server, with CLOUDINARY_* and MONGODB_URI set):  node src/migrate-uploads.js [--dry]
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const cloudinary = require('cloudinary').v2;
const fs = require('fs');
const path = require('path');
const DIR = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
const DRY = process.argv.includes('--dry');
cloudinary.config({ secure: true, ...(process.env.CLOUDINARY_URL ? {} : { cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET }) });
const cache = {};
async function toCloud(file) {
  if (cache[file]) return cache[file];
  const full = path.join(DIR, file);
  if (!fs.existsSync(full)) { console.warn('  missing on disk:', file); return null; }
  if (DRY) return (cache[file] = 'DRY-RUN');
  const r = await cloudinary.uploader.upload(full, { folder: process.env.CLOUDINARY_FOLDER || 'bsm', public_id: file.replace(/\.[^.]+$/, ''), overwrite: false, resource_type: 'image' });
  return (cache[file] = r.secure_url);
}
async function walk(v, state) {
  if (typeof v === 'string') {
    const m = v.match(/^\/uploads\/([^/]+)$/);
    if (m) { const u = await toCloud(m[1]); if (u) { state.changed = true; return u; } }
    return v;
  }
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = await walk(v[i], state); return v; }
  if (v && typeof v === 'object' && v.constructor === Object) { for (const k of Object.keys(v)) v[k] = await walk(v[k], state); return v; }
  return v;
}
(async () => {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/bsm');
  const db = mongoose.connection.db;
  for (const { name } of await db.listCollections().toArray()) {
    const col = db.collection(name);
    for await (const doc of col.find({})) {
      const state = { changed: false };
      const { _id, ...rest } = doc;
      const next = await walk(rest, state);
      if (state.changed) { console.log(`${DRY ? '[dry] ' : ''}updating ${name}/${_id}`); if (!DRY) await col.updateOne({ _id }, { $set: next }); }
    }
  }
  console.log('Done.', DRY ? '(dry run, nothing changed)' : '');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
