/**
 * db.js — Supabase database layer
 * Replaces the old JSON file-based db.js
 * All methods keep the same interface so routes don't need to change
 */

const { createClient } = require('@supabase/supabase-js');

// ── Supabase client (singleton) ──────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service_role key — bypasses RLS
);

// ── Helper: throw readable error ─────────────────────────────────
function dbError(operation, error) {
  console.error(`[DB] ${operation} failed:`, error?.message || error);
  throw new Error(`Database error during ${operation}`);
}

// ════════════════════════════════════════════════════════════════
// USERS
// ════════════════════════════════════════════════════════════════
const Users = {

  // Convert DB snake_case row → camelCase object used by routes
  _format(row) {
    if (!row) return null;
    return {
      id:               row.id,
      name:             row.name,
      email:            row.email,
      phone:            row.phone,
      passwordHash:     row.password_hash,
      plan:             row.plan,
      trialStartAt:     row.trial_start_at,
      trialDays:        row.trial_days,
      allAccess:        row.all_access,
      allAccessExpiry:  row.all_access_expiry,
      subscribedCats:   row.subscribed_cats || [],
      catExpiry:        row.cat_expiry || {},
      totalQueries:     row.total_queries,
      queryLog:         row.query_log || {},
      emailVerified:    row.email_verified,
      lastLoginAt:      row.last_login_at,
      createdAt:        row.created_at,
      updatedAt:        row.updated_at,
    };
  },

  // Remove passwordHash before sending to frontend
  safe(user) {
    if (!user) return null;
    const { passwordHash, ...safe } = user;
    return safe;
  },

  async findById(id) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .single();
    if (error && error.code !== 'PGRST116') dbError('findById', error);
    return this._format(data);
  },

  async findByEmail(email) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .single();
    if (error && error.code !== 'PGRST116') dbError('findByEmail', error);
    return this._format(data);
  },

  async findByPhone(phone) {
    const clean = phone.replace(/\s+/g, '').replace(/^\+91/, '');
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('phone', clean)
      .single();
    if (error && error.code !== 'PGRST116') dbError('findByPhone', error);
    return this._format(data);
  },

  async findByEmailOrPhone(identifier) {
    const clean = identifier.replace(/\s+/g, '').replace(/^\+91/, '');

    // Try email first
    const { data: byEmail } = await supabase
      .from('users')
      .select('*')
      .eq('email', identifier.toLowerCase())
      .single();
    if (byEmail) return this._format(byEmail);

    // Try phone
    const { data: byPhone } = await supabase
      .from('users')
      .select('*')
      .eq('phone', clean)
      .single();
    return this._format(byPhone);
  },

  async create(data) {
    const clean = data.phone.replace(/\s+/g, '').replace(/^\+91/, '');
    const { data: row, error } = await supabase
      .from('users')
      .insert({
        name:          data.name,
        email:         data.email.toLowerCase(),
        phone:         clean,
        password_hash: data.passwordHash,
        plan:          'trial',
        trial_days:    parseInt(process.env.TRIAL_DAYS || '3'),
      })
      .select()
      .single();
    if (error) dbError('create user', error);
    return this._format(row);
  },

  async update(id, patch) {
    // Convert camelCase patch keys → snake_case for Supabase
    const mapped = {};
    if (patch.name            !== undefined) mapped.name              = patch.name;
    if (patch.plan            !== undefined) mapped.plan              = patch.plan;
    if (patch.passwordHash    !== undefined) mapped.password_hash     = patch.passwordHash;
    if (patch.allAccess       !== undefined) mapped.all_access        = patch.allAccess;
    if (patch.allAccessExpiry !== undefined) mapped.all_access_expiry = patch.allAccessExpiry;
    if (patch.subscribedCats  !== undefined) mapped.subscribed_cats   = patch.subscribedCats;
    if (patch.catExpiry       !== undefined) mapped.cat_expiry        = patch.catExpiry;
    if (patch.emailVerified   !== undefined) mapped.email_verified    = patch.emailVerified;
    if (patch.lastLoginAt     !== undefined) mapped.last_login_at     = patch.lastLoginAt;
    if (patch.totalQueries    !== undefined) mapped.total_queries     = patch.totalQueries;
    if (patch.queryLog        !== undefined) mapped.query_log         = patch.queryLog;

    if (Object.keys(mapped).length === 0) return this.findById(id);

    const { data: row, error } = await supabase
      .from('users')
      .update(mapped)
      .eq('id', id)
      .select()
      .single();
    if (error) dbError('update user', error);
    return this._format(row);
  },

  // Atomically increment query count for a category
  async incrementQuery(id, catKey) {
    const { data: row, error: fetchErr } = await supabase
      .from('users')
      .select('total_queries, query_log')
      .eq('id', id)
      .single();
    if (fetchErr) { console.error('[DB] incrementQuery fetch failed:', fetchErr.message); return; }

    const currentLog   = row.query_log || {};
    const currentTotal = row.total_queries || 0;

    const { error: updateErr } = await supabase
      .from('users')
      .update({
        total_queries: currentTotal + 1,
        query_log:     { ...currentLog, [catKey]: (currentLog[catKey] || 0) + 1 },
      })
      .eq('id', id);
    if (updateErr) console.error('[DB] incrementQuery update failed:', updateErr.message);
  },

  async findAll(limit = 100, offset = 0) {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) dbError('findAll users', error);
    return (data || []).map(r => this._format(r));
  },

  async count() {
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });
    if (error) dbError('count users', error);
    return count || 0;
  },
};

// ════════════════════════════════════════════════════════════════
// ORDERS
// ════════════════════════════════════════════════════════════════
const Orders = {

  _format(row) {
    if (!row) return null;
    return {
      id:                  row.id,
      userId:              row.user_id,
      plan:                row.plan,
      categoryKey:         row.category_key,
      amount:              row.amount,
      currency:            row.currency,
      status:              row.status,
      razorpayOrderId:     row.razorpay_order_id,
      razorpayPaymentId:   row.razorpay_payment_id,
      razorpaySignature:   row.razorpay_signature,
      paidAt:              row.paid_at,
      createdAt:           row.created_at,
      updatedAt:           row.updated_at,
    };
  },

  async create(data) {
    const { data: row, error } = await supabase
      .from('orders')
      .insert({
        user_id:           data.userId,
        plan:              data.plan,
        category_key:      data.categoryKey || null,
        amount:            data.amount,
        razorpay_order_id: data.razorpayOrderId,
      })
      .select()
      .single();
    if (error) dbError('create order', error);
    return this._format(row);
  },

  async findById(id) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', id)
      .single();
    if (error && error.code !== 'PGRST116') dbError('findById order', error);
    return this._format(data);
  },

  async findByRazorpayOrderId(razorpayOrderId) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('razorpay_order_id', razorpayOrderId)
      .single();
    if (error && error.code !== 'PGRST116') dbError('findByRazorpayOrderId', error);
    return this._format(data);
  },

  async update(id, patch) {
    const mapped = {};
    if (patch.status            !== undefined) mapped.status              = patch.status;
    if (patch.razorpayPaymentId !== undefined) mapped.razorpay_payment_id = patch.razorpayPaymentId;
    if (patch.razorpaySignature !== undefined) mapped.razorpay_signature  = patch.razorpaySignature;
    if (patch.paidAt            !== undefined) mapped.paid_at             = patch.paidAt;

    const { data: row, error } = await supabase
      .from('orders')
      .update(mapped)
      .eq('id', id)
      .select()
      .single();
    if (error) dbError('update order', error);
    return this._format(row);
  },

  async findByUser(userId) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    if (error) dbError('findByUser orders', error);
    return (data || []).map(r => this._format(r));
  },

  async findAll(limit = 100) {
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) dbError('findAll orders', error);
    return (data || []).map(r => this._format(r));
  },
};

// ════════════════════════════════════════════════════════════════
// CONVERSATIONS
// ════════════════════════════════════════════════════════════════
const Conversations = {

  async save(data) {
    const { data: row, error } = await supabase
      .from('conversations')
      .insert({
        user_id:  data.userId,
        cat_key:  data.catKey,
        user_msg: data.userMsg,
        ai_reply: data.aiReply,
      })
      .select()
      .single();
    if (error) {
      console.error('[DB] save conversation failed:', error.message);
      return null;
    }
    return row;
  },

  async findByUser(userId, catKey = null, limit = 50) {
    let query = supabase
      .from('conversations')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (catKey) query = query.eq('cat_key', catKey);

    const { data, error } = await query;
    if (error) dbError('findByUser conversations', error);
    return (data || []).reverse();
  },
};

// ════════════════════════════════════════════════════════════════
// HEALTH CHECK
// ════════════════════════════════════════════════════════════════
async function checkConnection() {
  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    if (error) throw error;
    return true;
  } catch (err) {
    console.error('[DB] Supabase connection failed:', err.message);
    return false;
  }
}

module.exports = { supabase, Users, Orders, Conversations, checkConnection };
