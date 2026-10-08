-- Bunker Pilot licenses table.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.

create table if not exists licenses (
  id            bigserial primary key,
  code          text unique not null,
  note          text not null default '',
  status        text not null default 'active' check (status in ('active','revoked')),
  device_id     text,
  device_label  text,
  created_at    timestamptz not null default now(),
  activated_at  timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

-- Supabase also exposes tables to the public internet through its own API.
-- Turning on Row Level Security with no policies locks that door completely.
-- Our Render server connects with the database password, which is not affected.
alter table licenses enable row level security;

-- ---- Gumroad automatic sales (safe to run again) ----
-- One row per Gumroad sale. The sale id is unique, so the same sale can never create two codes.
create table if not exists gumroad_sales (
  sale_id      text primary key,
  code         text,
  email        text not null,
  buyer_name   text not null default '',
  created_at   timestamptz not null default now(),
  emailed_at   timestamptz,
  email_error  text,
  refunded_at  timestamptz
);
alter table gumroad_sales enable row level security;
