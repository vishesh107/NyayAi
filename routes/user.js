/**
 * routes/user.js — User profile, stats, admin dashboard
 */

const express = require('express');
const { Users, Orders, Conversations } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { BOTS } = require('../config/bots');

const router = express.Router();

// ── GET /api/user/profile ───────────────────────────────────
router.get('/profile', authMiddleware, (req, res) => {
  const user = req.user;

  const trialMs    = (user.trialDays || 3) * 24 * 60 * 60 * 1000;
  const elapsed    = Date.now() - new Date(user.trialStartAt).getTime();
  const daysLeft   = Math.max(0, Math.ceil((trialMs - elapsed) / (1000 * 60 * 60 * 24)));
  const trialActive = elapsed < trialMs;

  // Build per-category access map
  const access = {};
  for (const key of Object.keys(BOTS)) {
    access[key] = user.allAccess ||
      (user.subscribedCats || []).includes(key) ||
      trialActive;
  }

  res.json({
    user:  Users.safe(user),
    trial: { active: trialActive, daysLeft },
    access,
    stats: {
      totalQueries: user.totalQueries || 0,
      queryLog:     user.queryLog || {},
    },
  });
});

// ── PUT /api/user/profile ───────────────────────────────────
router.put('/profile', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Name must be at least 2 characters' });
  }
  const updated = await Users.update(req.user.id, { name: name.trim() });
  res.json({ user: Users.safe(updated), message: 'Profile updated' });
});

// ── GET /api/user/stats ─────────────────────────────────────
router.get('/stats', authMiddleware, (req, res) => {
  const user = req.user;
  const queryLog = user.queryLog || {};

  const breakdown = Object.keys(BOTS).map(key => ({
    bot:     BOTS[key].title,
    queries: queryLog[key] || 0,
    icon:    BOTS[key].icon,
  })).sort((a, b) => b.queries - a.queries);

  res.json({
    totalQueries: user.totalQueries || 0,
    breakdown,
    memberSince:  user.createdAt,
    plan:         user.plan,
    allAccess:    user.allAccess || false,
  });
});

// ── GET /api/admin/stats ────────────────────────────────────
router.get('/admin/stats', authMiddleware, async (req, res) => {
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim());
  if (!adminEmails.includes(req.user.email)) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const [users, orders] = await Promise.all([
      Users.findAll(20),
      Orders.findAll(20),
    ]);

    const totalUsers  = await Users.count();
    const proUsers    = users.filter(u => u.plan === 'pro').length;

    const trialMs = 3 * 24 * 60 * 60 * 1000;
    const activeTrials = users.filter(u => {
      const elapsed = Date.now() - new Date(u.trialStartAt).getTime();
      return elapsed < trialMs && u.plan !== 'pro';
    }).length;

    const paidOrders = orders.filter(o => o.status === 'paid');
    const revenue    = paidOrders.reduce((sum, o) => sum + (o.amount || 0), 0);

    res.json({
      totalUsers,
      proUsers,
      activeTrials,
      totalOrders:  orders.length,
      paidOrders:   paidOrders.length,
      totalRevenue: `₹${(revenue / 100).toFixed(2)}`,
      recentUsers:  users.map(u => Users.safe(u)),
      recentOrders: orders,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
});

module.exports = router;
