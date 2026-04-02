/**
 * server.js — NyayAI Backend Entry Point
 *
 * Start:  node server.js
 * Dev:    npx nodemon server.js
 */

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const path       = require('path');

const { checkConnection } = require('./db');
const authRoutes     = require('./routes/auth');
const paymentRoutes  = require('./routes/payments');
const chatRoutes     = require('./routes/chat');
const userRoutes     = require('./routes/user');
const documentRoutes = require('./routes/documents');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Security headers ─────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// ── CORS ─────────────────────────────────────────────────────
// Build allowed origins list — add your local IP from .env
const allowedOrigins = [
  process.env.FRONTEND_URL || 'http://localhost:5500',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5500',
  'http://localhost:5173',
];

// Also allow any extra origins defined in .env (comma-separated)
// EXTRA_ORIGINS=http://192.168.0.102:3000,http://192.168.1.5:3000
if (process.env.EXTRA_ORIGINS) {
  process.env.EXTRA_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    .forEach(o => allowedOrigins.push(o));
}

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, Postman, curl, same-origin)
    if (!origin) return cb(null, true);

    // Allow if in whitelist
    if (allowedOrigins.includes(origin)) return cb(null, true);

    // Allow any localhost / 127.0.0.1 on any port (development)
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return cb(null, true);

    // Allow local network IPs (192.168.x.x, 10.x.x.x) — for testing on phone/LAN
    if (/^https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(origin)) return cb(null, true);

    console.error(`[CORS blocked] ${origin}`);
    cb(new Error(`CORS: Origin ${origin} not allowed`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Body parsing ─────────────────────────────────────────────
// Note: Razorpay webhook needs raw body — mount BEFORE express.json()
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 min
  max:      200,
  message:  { error: 'Too many requests from this IP, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      10,
  message:  { error: 'Too many login attempts. Please wait 15 minutes.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 min
  max:      20,
  message:  { error: 'Too many chat requests. Please slow down.' },
});

app.use('/api/', generalLimiter);
app.use('/api/auth/login',    authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/chat/',         chatLimiter);

// ── Serve static frontend ────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',     authRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/chat',     chatRoutes);
app.use('/api/user',     userRoutes);
app.use('/api/documents', documentRoutes);

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const dbOk = await checkConnection().catch(() => false);
  res.json({
    status:    'ok',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    env:       process.env.NODE_ENV || 'development',
    services: {
      database:  dbOk,
      anthropic: !!process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'sk-ant-your-key-here',
      razorpay:  !!process.env.RAZORPAY_KEY_ID   && process.env.RAZORPAY_KEY_ID   !== 'rzp_test_your_key_id',
    },
  });
});

// ── SPA fallback — serve index.html for all non-API routes ──
app.get('/{*path}', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (require('fs').existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Frontend not found. Place index.html in /public folder.' });
  }
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.message && err.message.includes('CORS')) {
    return res.status(403).json({ error: err.message });
  }
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  // Validate required env vars
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'].filter(k => !process.env[k]);
  if (missing.length) {
    console.error(`\n❌ Missing required env vars: ${missing.join(', ')}`);
    console.error('   Copy .env.example to .env and fill in the values.\n');
    process.exit(1);
  }

  // Check Supabase connection before starting
  console.log('\n🔄 Connecting to Supabase...');
  const dbOk = await checkConnection();
  if (!dbOk) {
    console.error('❌ Could not connect to Supabase. Check SUPABASE_URL and SUPABASE_SERVICE_KEY in .env');
    process.exit(1);
  }

  app.listen(PORT, () => {
    const anthropicOk = process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'sk-ant-your-key-here';
    const razorpayOk  = process.env.RAZORPAY_KEY_ID   && process.env.RAZORPAY_KEY_ID   !== 'rzp_test_your_key_id';

    console.log(`\n╔══════════════════════════════════════════╗`);
    console.log(`║          NyayAI Backend Server           ║`);
    console.log(`╠══════════════════════════════════════════╣`);
    console.log(`║  Running at: http://localhost:${PORT}         ║`);
    console.log(`║  Env:        ${(process.env.NODE_ENV || 'development').padEnd(28)}║`);
    console.log(`║  Database:   ✓ Supabase connected        ║`);
    console.log(`║  Anthropic:  ${anthropicOk ? '✓ Connected               ' : '✗ Demo mode (add API key) '}║`);
    console.log(`║  Razorpay:   ${razorpayOk  ? '✓ Connected               ' : '✗ Set your key            '}║`);
    console.log(`╚══════════════════════════════════════════╝\n`);
  });
}

startServer();

module.exports = app;
