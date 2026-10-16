const router = require('express').Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const M = require('../models');
const U = require('../util');

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many attempts. Try again in 15 minutes.' } });
const me = (u) => ({ id: u._id, name: u.name, email: u.email, role: u.role, mustChangePassword: u.mustChangePassword, permissions: Object.fromEntries(M.PERMS.map((p) => [p, U.can(u, p)])) });
const pw = z.string().min(8, 'Password must be at least 8 characters');

router.post('/login', limiter, U.wrap(async (req, res) => {
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await M.User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) throw new U.HttpError(401, 'Wrong email or password.');
  user.lastLoginAt = new Date(); await user.save();
  U.signIn(res, user); U.logActivity(user, 'login');
  res.json(me(user));
}));
router.post('/logout', (req, res) => { res.clearCookie(U.COOKIE, { path: '/' }); res.json({ ok: true }); });
router.get('/me', U.requireAuth, (req, res) => res.json(me(req.user)));

router.post('/change-password', U.requireAuth, U.wrap(async (req, res) => {
  const { current, password } = z.object({ current: z.string(), password: pw }).parse(req.body);
  const user = await M.User.findById(req.user._id).select('+passwordHash');
  if (!(await bcrypt.compare(current, user.passwordHash))) throw new U.HttpError(400, 'Current password is wrong.');
  user.passwordHash = await bcrypt.hash(password, 11); user.mustChangePassword = false; await user.save();
  U.logActivity(user, 'password changed');
  res.json(me(user));
}));

router.post('/forgot', limiter, U.wrap(async (req, res) => {
  const { email } = z.object({ email: z.string().email() }).parse(req.body);
  const user = await M.User.findOne({ email: email.toLowerCase(), active: true });
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    user.resetTokenHash = crypto.createHash('sha256').update(token).digest('hex'); user.resetExpires = new Date(Date.now() + 3600e3); await user.save();
    const link = `${process.env.CLIENT_URL || 'http://localhost:3000'}/admin/reset?token=${token}`;
    U.sendMailBg({ to: user.email, subject: 'Reset your password', html: `<p>Hello ${U.esc(user.name)},</p><p>Click the link below to set a new password. It expires in 1 hour.</p><p><a href="${link}">${link}</a></p><p>If you did not ask for this, ignore this email.</p>` });
  }
  res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
}));
router.post('/reset', limiter, U.wrap(async (req, res) => {
  const { token, password } = z.object({ token: z.string(), password: pw }).parse(req.body);
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const user = await M.User.findOne({ resetTokenHash: hash, resetExpires: { $gt: new Date() } }).select('+resetTokenHash +resetExpires +passwordHash');
  if (!user) throw new U.HttpError(400, 'This reset link is invalid or has expired.');
  user.passwordHash = await bcrypt.hash(password, 11); user.resetTokenHash = undefined; user.resetExpires = undefined; user.mustChangePassword = false; await user.save();
  U.logActivity(user, 'password reset');
  res.json({ ok: true });
}));

module.exports = router;
