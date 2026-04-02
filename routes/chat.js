/**
 * routes/chat.js
 * Claude API integration for all 8 NyayAI bots
 * Features: streaming, per-bot model selection, rate limiting, full error handling
 */

const express    = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { Users, Conversations } = require('../db');
const { authMiddleware }       = require('../middleware/auth');
const { BOTS }                 = require('../config/bots');

const { retrieveContext, buildContextString } = require('../rag');
const router = express.Router();

// ── Anthropic client (lazy singleton) ────────────────────────
let _anthropic = null;
function getClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ── Per-bot model selection ───────────────────────────────────
// Startup bot uses Sonnet (complex legal reasoning needed)
// All others use Haiku (10x cheaper, handles factual Q&A perfectly)
const BOT_MODELS = {
  labour:     'claude-haiku-4-5-20251001',
  tenant:     'claude-haiku-4-5-20251001',
  itr:        'claude-haiku-4-5-20251001',
  freelancer: 'claude-haiku-4-5-20251001',
  regime:     'claude-haiku-4-5-20251001',
  fir:        'claude-haiku-4-5-20251001',
  rera:       'claude-haiku-4-5-20251001',
  startup:    'claude-haiku-4-5-20251001',  // all bots on Haiku
};

// Override via .env: FORCE_MODEL=claude-sonnet-4-20250514 forces all bots to Sonnet
function modelForBot(botKey) {
  if (process.env.FORCE_MODEL) return process.env.FORCE_MODEL;
  return BOT_MODELS[botKey] || 'claude-haiku-4-5-20251001';
}

// ── Simple in-memory rate limiter (per user per minute) ──────
const userRequestTimes = new Map();
function checkRateLimit(userId) {
  const now     = Date.now();
  const windowMs = 60 * 1000;  // 1 minute
  const maxReqs  = parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '15');

  const times = (userRequestTimes.get(userId) || []).filter(t => now - t < windowMs);
  if (times.length >= maxReqs) return false;

  times.push(now);
  userRequestTimes.set(userId, times);
  return true;
}

// ── Access check ──────────────────────────────────────────────
function userHasAccess(user, botKey) {
  if (user.allAccess) return true;
  if ((user.subscribedCats || []).includes(botKey)) return true;

  const trialMs    = (user.trialDays || 3) * 24 * 60 * 60 * 1000;
  const elapsed    = Date.now() - new Date(user.trialStartAt).getTime();
  return elapsed < trialMs;
}

// ══════════════════════════════════════════════════════════════
// POST /api/chat/:botKey  — main chat endpoint
// ══════════════════════════════════════════════════════════════
router.post('/:botKey', authMiddleware, async (req, res) => {
  const { botKey } = req.params;
  const bot  = BOTS[botKey];
  const user = req.user;

  // ── 1. Validate bot ───────────────────────────────────────
  if (!bot) {
    return res.status(404).json({ error: `Bot "${botKey}" not found.` });
  }

  // ── 2. Access gate ────────────────────────────────────────
  if (!userHasAccess(user, botKey)) {
    return res.status(403).json({
      error:       'Access required',
      code:        'TRIAL_EXPIRED',
      message:     'Your 3-day trial has ended. Please subscribe to continue.',
      showPaywall: true,
      planKey:     `cat_${botKey}`,
      planPrice:   bot.priceLabel || `₹${bot.price / 100}/mo`,
    });
  }

  // ── 3. Rate limit ─────────────────────────────────────────
  if (!checkRateLimit(user.id)) {
    return res.status(429).json({
      error: 'Too many messages. Please wait a moment before sending again.',
      code:  'RATE_LIMITED',
    });
  }

  // ── 4. Validate messages ──────────────────────────────────
  const { messages, stream: wantsStream } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // Clean + sanitise: keep last 20 turns, max 4000 chars per message
  const cleaned = messages
    .filter(m => m && m.role && typeof m.content === 'string' && m.content.trim())
    .map(m => ({
      role:    m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.trim().slice(0, 4000),
    }))
    .slice(-20);

  if (cleaned.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided' });
  }

  // Ensure conversation alternates correctly (Anthropic requirement)
  const validMessages = [];
  let lastRole = null;
  for (const m of cleaned) {
    if (m.role === lastRole) continue;  // skip duplicate roles
    validMessages.push(m);
    lastRole = m.role;
  }
  // Must start with user
  if (validMessages[0]?.role !== 'user') {
    validMessages.unshift({ role: 'user', content: '...' });
  }

  const userMessage = validMessages[validMessages.length - 1]?.content || '';
  const model       = modelForBot(botKey);
  const isApiKeySet = process.env.ANTHROPIC_API_KEY &&
                      process.env.ANTHROPIC_API_KEY !== 'sk-ant-your-key-here';

  // ── 5. Demo mode (no API key) ─────────────────────────────
  if (!isApiKeySet) {
    const reply = getDemoReply(botKey, userMessage);
    await Users.incrementQuery(user.id, botKey);
    await Conversations.save({
      userId:   user.id,
      catKey:   botKey,
      userMsg:  userMessage,
      aiReply:  reply,
    });
    return res.json({ reply, demo: true, model: 'demo' });
  }

  // ── 6. Streaming response ─────────────────────────────────
  if (wantsStream) {
    return handleStream(res, bot, validMessages, model, user, botKey, userMessage, ragContext);
  }

  // ── 7. RAG — retrieve relevant document context ─────────────
  let ragContext = null;
  try {
    const chunks = await retrieveContext(userMessage, botKey, user.id);
    if (chunks.length > 0) {
      ragContext = buildContextString(chunks);
      console.log(`[RAG] ${chunks.length} chunks retrieved for ${botKey}`);
    }
  } catch (ragErr) {
    console.warn(`[RAG] Retrieval failed (non-fatal): ${ragErr.message}`);
  }

  // Build enhanced system prompt — inject document context if found
  const systemPrompt = ragContext
    ? `${bot.system}\n\n${ragContext}`
    : bot.system;

  // ── 8. Standard response ──────────────────────────────────
  try {
    console.log(`[Chat] ${botKey} | ${model} | rag:${ragContext ? 'yes' : 'no'} | user:${user.id.slice(0,8)} | "${userMessage.slice(0,60)}..."`);

    const response = await getClient().messages.create({
      model,
      max_tokens:  1500,
      system:      systemPrompt,
      messages:    validMessages,
    });

    const reply = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    if (!reply) {
      return res.status(500).json({ error: 'Empty response from AI. Please try again.' });
    }

    // Log asynchronously — don't block the response
    Promise.all([
      Users.incrementQuery(user.id, botKey),
      Conversations.save({ userId: user.id, catKey: botKey, userMsg: userMessage, aiReply: reply }),
    ]).catch(err => console.error('[Chat] Logging error:', err.message));

    return res.json({
      reply,
      model,
      rag_used:  !!ragContext,
      usage: {
        input_tokens:  response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      },
    });

  } catch (err) {
    return handleApiError(err, res, botKey);
  }
});

// ══════════════════════════════════════════════════════════════
// Streaming handler — sends text chunks as Server-Sent Events
// ══════════════════════════════════════════════════════════════
async function handleStream(res, bot, messages, model, user, botKey, userMessage, ragContext = null) {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering

  let fullReply = '';

  try {
    const streamSystem = ragContext ? `${bot.system}\n\n${ragContext}` : bot.system;
    const stream = getClient().messages.stream({
      model,
      max_tokens: 1500,
      system:     streamSystem,
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const chunk = event.delta.text;
        fullReply += chunk;
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      if (event.type === 'message_stop') {
        res.write(`data: ${JSON.stringify({ done: true, model })}\n\n`);
        break;
      }
    }

    // Log after stream completes
    Promise.all([
      Users.incrementQuery(user.id, botKey),
      Conversations.save({ userId: user.id, catKey: botKey, userMsg: userMessage, aiReply: fullReply }),
    ]).catch(err => console.error('[Stream] Logging error:', err.message));

  } catch (err) {
    console.error(`[Stream error] ${botKey}:`, err.message);
    res.write(`data: ${JSON.stringify({ error: 'Stream failed. Please try again.' })}\n\n`);
  } finally {
    res.end();
  }
}

// ══════════════════════════════════════════════════════════════
// GET /api/chat/history/:botKey
// ══════════════════════════════════════════════════════════════
router.get('/history/:botKey', authMiddleware, async (req, res) => {
  try {
    const { botKey } = req.params;
    if (!BOTS[botKey]) return res.status(404).json({ error: 'Bot not found' });

    const history = await Conversations.findByUser(req.user.id, botKey, 50);

    // Return as message pairs for easy frontend use
    const messages = history.flatMap(h => [
      { role: 'user',      content: h.user_msg || h.userMsg, timestamp: h.created_at },
      { role: 'assistant', content: h.ai_reply  || h.aiReply,  timestamp: h.created_at },
    ]);

    res.json({ history: messages, total: history.length });
  } catch (err) {
    console.error('[History] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch history' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/chat/bots  — list all available bots (public)
// ══════════════════════════════════════════════════════════════
router.get('/bots', (req, res) => {
  const list = Object.values(BOTS).map(b => ({
    key:       b.key,
    title:     b.title,
    subtitle:  b.subtitle,
    icon:      b.icon,
    price:     b.price,
    priceLabel: b.priceLabel,
    model:     modelForBot(b.key),
  }));
  res.json({ bots: list });
});

// ══════════════════════════════════════════════════════════════
// Error handler for Claude API errors
// ══════════════════════════════════════════════════════════════
function handleApiError(err, res, botKey) {
  const status  = err.status || err.statusCode;
  const message = err.message || '';

  console.error(`[Claude API Error] ${botKey} | status:${status} | ${message}`);

  if (status === 401) {
    return res.status(500).json({
      error: 'AI service authentication failed. Please contact support.',
      code:  'AUTH_ERROR',
    });
  }
  if (status === 429) {
    return res.status(429).json({
      error: 'AI service is busy right now. Please wait a few seconds and try again.',
      code:  'RATE_LIMITED',
    });
  }
  if (status === 529 || message.includes('overloaded')) {
    return res.status(503).json({
      error: 'AI service is temporarily overloaded. Please try again in a moment.',
      code:  'OVERLOADED',
    });
  }
  if (status === 400 && message.includes('context')) {
    return res.status(400).json({
      error: 'Conversation is too long. Please start a new chat.',
      code:  'CONTEXT_EXCEEDED',
    });
  }

  return res.status(500).json({
    error: 'AI response failed. Please try again.',
    code:  'UNKNOWN_ERROR',
  });
}

// ══════════════════════════════════════════════════════════════
// Demo responses — shown when ANTHROPIC_API_KEY is not set
// ══════════════════════════════════════════════════════════════
function getDemoReply(botKey, question) {
  const q = (question || '').toLowerCase();

  const demos = {
    labour: `**Indian Labour Law — Demo Answer**

Based on your question, here is what the law says:

Under the **Payment of Wages Act 1936** and the relevant state Shops & Establishments Act, your employer cannot arbitrarily reduce your salary or make unauthorised deductions.

**Key rights:**
• Salary must be paid on time (before the 7th/10th of the following month)
• Deductions only permitted under Section 7 of the Payment of Wages Act
• PF deduction: 12% of basic salary (employer also contributes 12%)
• Gratuity: payable after 5 continuous years — (15 × Last Salary × Years) ÷ 26

**If your rights are being violated:**
1. Send a written complaint to HR (keep a copy)
2. Escalate to the Regional Labour Commissioner (RLC)
3. File online at the Shram Suvidha portal: shramsuvidha.gov.in
4. EPFO helpline for PF issues: **1800-118-005** (free)

⚠️ This is general information. For your specific situation, consult a labour lawyer.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    tenant: `**Tenant Rights — Demo Answer**

Under the **Transfer of Property Act 1882** and your state's Rent Control Act, here are your key rights:

**Security Deposit:**
• Must be returned within 30 days of vacating (after deducting legitimate damages)
• Landlord cannot withhold without giving itemised reasons in writing

**Eviction:**
• Landlord cannot evict without valid legal ground + written notice (1–3 months)
• Valid grounds: non-payment of rent, subletting without permission, damage to property
• Must go through Rent Court — direct forceful eviction is illegal

**If landlord is not returning deposit:**
1. Send a legal notice by registered post
2. File complaint at District Consumer Forum (free for claims under ₹50L)
3. Approach Rent Controller / Rent Court in your city

⚠️ Laws vary by state. Consult a local property lawyer for your specific case.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    itr: `**ITR Filing Guide — Demo Answer**

**Which ITR form should you use?**

| Your situation | Use this form |
|---|---|
| Only salary income | ITR-1 (Sahaj) |
| Capital gains / 2+ properties | ITR-2 |
| Business + salary income | ITR-3 |
| Freelance / self-employed | ITR-4 (Sugam) |

**Key deductions for FY 2024-25 (AY 2025-26):**
• Standard deduction: ₹75,000 (new regime) / ₹50,000 (old regime)
• Section 80C: up to ₹1,50,000 (PPF, ELSS, LIC, home loan principal)
• Section 80D: up to ₹25,000 health insurance (₹50,000 for senior citizens)
• HRA: exempt based on actual rent, 40%/50% of salary, and rent paid

**Filing deadline:** July 31, 2025 (without penalty) for FY 2024-25

⚠️ Always consult a CA for your actual filing.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    freelancer: `**Freelancer Tax — Demo Answer**

**GST Registration:**
• Mandatory if annual turnover exceeds **₹20 lakh** (services)
• For exports (foreign clients): register at any turnover, charge 0% GST + file LUT

**TDS on freelance income:**
• Clients paying ₹30,000+ deduct 10% TDS under **Section 194J**
• Check all deductions in Form 26AS on incometax.gov.in
• Claim it back when you file your ITR

**Advance Tax (if total tax > ₹10,000/year):**
| Due Date | Pay this much |
|---|---|
| 15 June | 15% of estimated tax |
| 15 September | 45% cumulative |
| 15 December | 75% cumulative |
| 15 March | 100% |

**Section 44ADA** (Professionals — doctors, lawyers, engineers, consultants):
• Declare 50% of gross receipts as profit — no books of accounts needed
• Applicable if turnover < ₹50 lakh

⚠️ Consult a CA for your actual filing.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    regime: `**New vs Old Tax Regime — Demo Calculator**

Tell me your salary and investments and I'll calculate exactly which saves more. For now, here's the general guide:

**New Regime (FY 2024-25) — Tax Slabs:**
| Income | Tax Rate |
|---|---|
| 0 – ₹3L | Nil |
| ₹3L – ₹7L | 5% (zero tax with rebate up to ₹7L) |
| ₹7L – ₹10L | 10% |
| ₹10L – ₹12L | 15% |
| ₹12L – ₹15L | 20% |
| Above ₹15L | 30% |

**Choose OLD regime if you have:**
✓ HRA (paying rent) + deductions > ₹3.75 lakh total
✓ Home loan interest (Section 24b) + 80C investments
✓ Total exemptions/deductions making old regime save more

**Choose NEW regime if:**
✓ Minimal investments or deductions
✓ Salary ≤ ₹7L (zero tax under new regime after rebate)
✓ You want simpler filing

Share your gross salary + key investments and I'll calculate exactly!
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    fir: `**Police FIR & Legal Rights — Demo Answer**

**Your Right to File an FIR:**
Under **Section 173 BNSS 2023** (previously Section 154 CrPC), every police station is **legally bound** to register your FIR for a cognizable offence. They cannot refuse.

**If police refuse to register your FIR:**
1. Send complaint in writing by **registered post** to the SP/DCP
2. File before **Judicial Magistrate** (Section 175(3) BNSS)
3. File a **Zero FIR** at any police station regardless of jurisdiction
4. Complain to **State Human Rights Commission**

**Cybercrime complaints:**
• Portal: **cybercrime.gov.in**
• Helpline: **1930** (24×7, free)
• For online fraud, blackmail, fake profiles, morphed images

**Your rights during arrest:**
• Right to know the reason for arrest
• Right to inform a family member or friend immediately
• Right to a lawyer from the moment of arrest
• Cannot be detained beyond **24 hours** without a Magistrate's order

⚠️ For serious matters, engage a criminal lawyer immediately.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    rera: `**Consumer Rights & RERA — Demo Answer**

**Your Rights Under RERA 2016:**

**Delayed possession:**
• Builder must compensate you at **SBI MCLR + 2%** per month on your paid amount
• Alternatively, you can demand a **full refund with interest**

**How to file a RERA complaint:**
1. Visit your state RERA portal (see below)
2. Register as a complainant
3. File Form-C with documents (sale agreement, payment receipts)
4. Pay filing fee (₹1,000–₹5,000 depending on state)
5. Builder must respond within 30 days

**State RERA Portals:**
| State | Portal |
|---|---|
| Maharashtra | maharerait.maharashtra.gov.in |
| Delhi | rera.delhi.gov.in |
| Karnataka | rera.karnataka.gov.in |
| UP | up-rera.in |
| Gujarat | gujrera.gujarat.gov.in |

**Consumer Forum** (for non-RERA disputes):
• E-Daakhil portal: **edaakhil.nic.in** — file online, no lawyer needed
• District Forum handles claims up to ₹50 lakh

⚠️ For complex disputes, engage a RERA lawyer (many work on success fee basis).
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,

    startup: `**Startup Legal — Demo Answer**

**Co-founder Agreement — Must-Have Clauses:**

**1. Equity & Vesting**
• Standard: 4-year vesting with 1-year cliff
• Meaning: nothing if you leave before 1 year; then 1/48th vests each month

**2. IP Assignment**
• All IP created must belong to the company — not individual founders
• Critical for investor due diligence

**3. Exit Provisions**
• Right of First Refusal (ROFR) on departing founder's shares
• Good leaver / bad leaver clauses
• Buyout pricing formula

**SAFE Note basics:**
• Investor gives money now, gets equity at next funding round
• Discount rate: typically 15–20% (investor gets shares cheaper than new investors)
• Valuation cap: protects investor if company valuation is very high at next round

**Privacy Policy requirements (DPDP Act 2023):**
• Mandatory if you collect any personal data from Indian users
• Must specify: what data you collect, why, how long you retain it, user rights

**Company types for Indian startups:**
• Private Limited Company — best for VC funding, most common
• LLP — good for services/consulting, lower compliance cost

⚠️ Always have a startup lawyer draft and review these documents.
*(Add your ANTHROPIC_API_KEY in .env for live Claude AI responses)*`,
  };

  return demos[botKey] || `**NyayAI — Demo Mode**\n\nI'm currently running in demo mode. Add your \`ANTHROPIC_API_KEY\` in the \`.env\` file to enable live Claude AI responses for all 8 bots.\n\nYour question was: "${question.slice(0, 100)}"\n\nIn live mode I would give you a detailed, accurate answer citing relevant Indian laws and sections.`;
}

module.exports = router;
