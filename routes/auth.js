/**
 * routes/auth.js — Registration, Login, Profile
 * Fixed: all DB calls are now properly awaited (Supabase is async)
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const { Users } = require('../db');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

function generateToken(userId) {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'fallback_secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

// ── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;

    // Validation
    if (!name || !email || !phone || !password) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    // Duplicate check — MUST await (Supabase is async)
    const existingEmail = await Users.findByEmail(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }

    const existingPhone = await Users.findByPhone(phone);
    if (existingPhone) {
      return res.status(409).json({ error: 'An account with this phone number already exists. Please sign in.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await Users.create({ name, email, phone, passwordHash });

    const token = generateToken(user.id);

    res.status(201).json({
      message: 'Account created! Your 3-day free trial has started.',
      token,
      user: Users.safe(user),
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Email/phone and password are required' });
    }

    // MUST await (Supabase is async)
    const user = await Users.findByEmailOrPhone(identifier);
    if (!user) {
      return res.status(401).json({ error: 'No account found with this email or phone. Please sign up.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    }

    // Update last login
    await Users.update(user.id, { lastLoginAt: new Date().toISOString() });

    const token = generateToken(user.id);

    res.json({
      message: `Welcome back, ${user.name.split(' ')[0]}!`,
      token,
      user: Users.safe(user),
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  const user = req.user;
  const trialMs    = (user.trialDays || 3) * 24 * 60 * 60 * 1000;
  const elapsed    = Date.now() - new Date(user.trialStartAt).getTime();
  const daysLeft   = Math.max(0, Math.ceil((trialMs - elapsed) / (1000 * 60 * 60 * 24)));
  const trialActive = elapsed < trialMs;

  res.json({
    user: Users.safe(user),
    trial: { active: trialActive, daysLeft },
  });
});

// ── POST /api/auth/change-password ───────────────────────────
router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Both current and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const valid = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await Users.update(req.user.id, { passwordHash });
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update password' });
  }
});

module.exports = router;
