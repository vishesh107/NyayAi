/**
 * middleware/auth.js — JWT authentication middleware
 * Fixed: Users.findById is now properly awaited
 */

const jwt    = require('jsonwebtoken');
const { Users } = require('../db');

async function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret');
    const user    = await Users.findById(decoded.userId);   // MUST await
    if (!user) return res.status(401).json({ error: 'User not found' });

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAccess(catKey) {
  return async (req, res, next) => {
    const user = req.user;

    if (user.allAccess) return next();
    if (user.subscribedCats && user.subscribedCats.includes(catKey)) return next();

    const trialMs    = (user.trialDays || 3) * 24 * 60 * 60 * 1000;
    const elapsed    = Date.now() - new Date(user.trialStartAt).getTime();
    const trialActive = elapsed < trialMs;

    if (trialActive) return next();

    return res.status(403).json({
      error:      'Trial expired',
      code:       'TRIAL_EXPIRED',
      message:    'Your 3-day trial has ended. Please upgrade to continue.',
      showPaywall: true,
    });
  };
}

module.exports = { authMiddleware, requireAccess };
