/**
 * routes/payments.js — Razorpay order creation & webhook verification
 */

const express  = require('express');
const crypto   = require('crypto');
const Razorpay = require('razorpay');
const { Users, Orders } = require('../db');
const { authMiddleware } = require('../middleware/auth');
const { BOTS, PLANS, catPlan } = require('../config/bots');

const router = express.Router();

// Lazy-init Razorpay (only if keys are set)
let rzp = null;
function getRazorpay() {
  if (!rzp) {
    rzp = new Razorpay({
      key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_placeholder',
      key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
    });
  }
  return rzp;
}

// ── GET /api/payments/plans ─────────────────────────────────
// Public — list all available plans & pricing
router.get('/plans', (req, res) => {
  const catPlans = Object.values(BOTS).map(bot => ({
    key:         `cat_${bot.key}`,
    name:        bot.title,
    categoryKey: bot.key,
    amount:      bot.price,
    amountDisplay: `₹${bot.price / 100}`,
    description: `${bot.title} — unlimited questions/month`,
    duration:    30,
    type:        'category',
  }));

  const bundlePlans = Object.values(PLANS).map(p => ({
    key:          p.key,
    name:         p.name,
    amount:       p.amount,
    amountDisplay: `₹${p.amount / 100}`,
    description:  p.description,
    duration:     p.duration,
    type:         'bundle',
  }));

  res.json({ plans: [...bundlePlans, ...catPlans] });
});

// ── POST /api/payments/create-order ────────────────────────
router.post('/create-order', authMiddleware, async (req, res) => {
  try {
    const { planKey } = req.body;
    if (!planKey) return res.status(400).json({ error: 'planKey is required' });

    // Resolve plan
    let plan;
    if (planKey.startsWith('cat_')) {
      const catKey = planKey.replace('cat_', '');
      plan = catPlan(catKey);
    } else {
      plan = PLANS[planKey];
    }
    if (!plan) return res.status(400).json({ error: 'Invalid plan key' });

    // Create Razorpay order
    const razorpayOrder = await getRazorpay().orders.create({
      amount:   plan.amount,
      currency: plan.currency || 'INR',
      receipt:  `nyay_${req.user.id.slice(0, 8)}_${Date.now()}`,
      notes: {
        userId:   req.user.id,
        planKey:  planKey,
        userName: req.user.name,
        email:    req.user.email,
      },
    });

    // Save order in DB
    const order = await Orders.create({
      userId:          req.user.id,
      plan:            planKey,
      categoryKey:     plan.categoryKey || null,
      amount:          plan.amount,
      razorpayOrderId: razorpayOrder.id,
    });

    res.json({
      orderId:        order.id,           // our internal order ID
      razorpayOrderId: razorpayOrder.id,  // Razorpay order ID for checkout
      amount:         plan.amount,
      currency:       'INR',
      planName:       plan.name,
      keyId:          process.env.RAZORPAY_KEY_ID,
      prefill: {
        name:  req.user.name,
        email: req.user.email,
        contact: req.user.phone,
      },
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ error: 'Failed to create payment order. Please try again.' });
  }
});

// ── POST /api/payments/verify ───────────────────────────────
// Called by frontend after Razorpay checkout success
router.post('/verify', authMiddleware, async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({ error: 'Payment details incomplete' });
    }

    // Verify signature
    const secret = process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret';
    const body   = razorpayOrderId + '|' + razorpayPaymentId;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('hex');

    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ error: 'Payment verification failed. Contact support.' });
    }

    // Find our order record
    const order = await Orders.findByRazorpayOrderId(razorpayOrderId);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Mark order as paid
    await Orders.update(order.id, {
      status:              'paid',
      razorpayPaymentId,
      razorpaySignature,
      paidAt:              new Date().toISOString(),
    });

    // Grant access to user
    const user    = await Users.findById(req.user.id);
    const planKey = order.plan;

    let updatedFields = {};

    if (planKey === 'all_access') {
      updatedFields = { allAccess: true, plan: 'pro', allAccessExpiry: expiryDate(30) };
    } else if (planKey === 'annual') {
      updatedFields = { allAccess: true, plan: 'pro', allAccessExpiry: expiryDate(365) };
    } else if (planKey.startsWith('cat_')) {
      const catKey = planKey.replace('cat_', '');
      const cats   = new Set(user.subscribedCats || []);
      cats.add(catKey);
      updatedFields = {
        subscribedCats: [...cats],
        plan: 'pro',
        [`catExpiry_${catKey}`]: expiryDate(30),
      };
    }

    const updatedUser = await Users.update(req.user.id, updatedFields);

    res.json({
      success:  true,
      message:  'Payment verified! Access granted.',
      user:     Users.safe(updatedUser),
    });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Payment verification error. Contact support.' });
  }
});

// ── POST /api/payments/webhook ──────────────────────────────
// Razorpay server-to-server webhook (no auth header)
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const sig  = req.headers['x-razorpay-signature'];
      const body = req.body;
      const expectedSig = crypto
        .createHmac('sha256', webhookSecret)
        .update(body)
        .digest('hex');
      if (sig !== expectedSig) {
        return res.status(400).json({ error: 'Invalid webhook signature' });
      }
    }

    const event = JSON.parse(req.body.toString());
    console.log('[Webhook]', event.event, event.payload?.payment?.entity?.id);

    // Handle payment.captured (backup to /verify endpoint)
    if (event.event === 'payment.captured') {
      const payment  = event.payload.payment.entity;
      const orderId  = payment.order_id;
      const order    = await Orders.findByRazorpayOrderId(orderId);
      if (order && order.status !== 'paid') {
        await Orders.update(order.id, {
          status: 'paid',
          razorpayPaymentId: payment.id,
          paidAt: new Date().toISOString(),
        });
        await grantAccessFromOrder(order);
      }
    }

    if (event.event === 'payment.failed') {
      const orderId = event.payload.payment.entity.order_id;
      const order   = await Orders.findByRazorpayOrderId(orderId);
      if (order) await Orders.update(order.id, { status: 'failed' });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ── GET /api/payments/history ───────────────────────────────
router.get('/history', authMiddleware, async (req, res) => {
  const allOrders = await Orders.findByUser(req.user.id);
  const userOrders = allOrders
    .map(o => ({
      id:          o.id,
      plan:        o.plan,
      amount:      `₹${o.amount / 100}`,
      status:      o.status,
      createdAt:   o.createdAt,
      paidAt:      o.paidAt || null,
    }));

  res.json({ orders: userOrders });
});

// ── Helpers ──────────────────────────────────────────────────
function expiryDate(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function grantAccessFromOrder(order) {
  const user = await Users.findById(order.userId);
  if (!user) return;
  const planKey = order.plan;
  if (planKey === 'all_access' || planKey === 'annual') {
    await Users.update(order.userId, {
      allAccess: true, plan: 'pro',
      allAccessExpiry: expiryDate(planKey === 'annual' ? 365 : 30),
    });
  } else if (planKey.startsWith('cat_')) {
    const catKey = planKey.replace('cat_', '');
    const cats   = new Set(user.subscribedCats || []);
    cats.add(catKey);
    await Users.update(order.userId, {
      subscribedCats: [...cats],
      plan: 'pro',
      [`catExpiry_${catKey}`]: expiryDate(30),
    });
  }
}

module.exports = router;
