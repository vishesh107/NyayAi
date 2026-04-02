-- ================================================================
-- NyayAI — Supabase Database Schema
-- Run this entire file in Supabase → SQL Editor → New Query
-- ================================================================

-- ── 1. USERS ────────────────────────────────────────────────────
create table if not exists users (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  email             text not null unique,
  phone             text not null unique,
  password_hash     text not null,

  -- Plan & trial
  plan              text not null default 'trial',   -- 'trial' | 'pro'
  trial_start_at    timestamptz not null default now(),
  trial_days        int not null default 3,
  all_access        boolean not null default false,
  all_access_expiry timestamptz,
  subscribed_cats   text[] not null default '{}',    -- ['labour','itr',...]

  -- Per-category expiry stored as JSONB  { "labour": "2025-08-01T00:00:00Z" }
  cat_expiry        jsonb not null default '{}',

  -- Stats
  total_queries     int not null default 0,
  query_log         jsonb not null default '{}',     -- { "labour": 12, "itr": 3 }

  -- Meta
  email_verified    boolean not null default false,
  last_login_at     timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists users_updated_at on users;
create trigger users_updated_at
  before update on users
  for each row execute function update_updated_at();

-- Indexes
create index if not exists users_email_idx on users(email);
create index if not exists users_phone_idx on users(phone);
create index if not exists users_plan_idx  on users(plan);

-- ── 2. ORDERS ───────────────────────────────────────────────────
create table if not exists orders (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(id) on delete cascade,

  plan                  text not null,           -- 'all_access' | 'annual' | 'cat_labour'
  category_key          text,                    -- 'labour' | 'itr' etc (null for bundles)
  amount                int not null,            -- in paise
  currency              text not null default 'INR',
  status                text not null default 'created', -- 'created' | 'paid' | 'failed'

  razorpay_order_id     text unique,
  razorpay_payment_id   text,
  razorpay_signature    text,

  paid_at               timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at
  before update on orders
  for each row execute function update_updated_at();

create index if not exists orders_user_id_idx         on orders(user_id);
create index if not exists orders_razorpay_order_idx  on orders(razorpay_order_id);
create index if not exists orders_status_idx          on orders(status);

-- ── 3. CONVERSATIONS ────────────────────────────────────────────
create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  cat_key    text not null,
  user_msg   text not null,
  ai_reply   text not null,
  created_at timestamptz not null default now()
);

create index if not exists conv_user_id_idx  on conversations(user_id);
create index if not exists conv_cat_key_idx  on conversations(cat_key);
create index if not exists conv_created_idx  on conversations(created_at desc);

-- ── 4. ROW LEVEL SECURITY (RLS) ─────────────────────────────────
-- We use the service_role key in the backend (bypasses RLS)
-- but good practice to enable it anyway
alter table users          enable row level security;
alter table orders         enable row level security;
alter table conversations  enable row level security;

-- Service role bypasses RLS automatically — no policies needed for backend
-- If you add Supabase Auth later, add user-specific policies here

-- ── 5. HELPER VIEW — admin dashboard ────────────────────────────
create or replace view admin_stats as
select
  (select count(*) from users)                                          as total_users,
  (select count(*) from users where plan = 'pro')                       as pro_users,
  (select count(*) from orders where status = 'paid')                   as paid_orders,
  (select coalesce(sum(amount), 0) from orders where status = 'paid')   as total_revenue_paise,
  (select count(*) from conversations)                                  as total_conversations;

-- ── Done ─────────────────────────────────────────────────────────
-- After running this, go to your backend .env and add:
-- SUPABASE_URL=https://xxxx.supabase.co
-- SUPABASE_SERVICE_KEY=your-service-role-key  (Settings → API → service_role)
