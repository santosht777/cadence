-- Cadence backend schema. Run against the Postgres database backing
-- your Supabase stack (local or cloud). Idempotent: safe to re-run.
--
-- Migration for existing databases: adds events_hash to login_attempts.
-- The CREATE TABLE block above already includes it for fresh installs.
alter table if exists public.login_attempts
    add column if not exists events_hash text;

alter table if exists public.user_profiles
    add column if not exists failed_password_attempts integer not null default 0;

create index if not exists login_attempts_replay_idx
    on public.login_attempts (user_id, events_hash, created_at);

create extension if not exists "pgcrypto";

-- One row per Supabase auth user. Mirrors auth.users for app-level
-- state we don't want to stuff into auth metadata.
create table if not exists public.user_profiles (
    user_id uuid primary key references auth.users(id) on delete cascade,
    username text not null unique,
    email text not null,
    threshold real not null default 0.5,
    current_login_status text,
    number_login_attempts integer not null default 0,
    -- Counts consecutive wrong passwords; resets to 0 on any successful auth.
    -- Reaching the threshold triggers a password-unlock email flow.
    failed_password_attempts integer not null default 0,
    created_at timestamptz not null default now()
);

create index if not exists user_profiles_username_idx
    on public.user_profiles (username);

-- One row per /authenticate call. Stores raw keystroke data plus the
-- model's similarity score so successful rows double as enrollment
-- samples for future logins.
create table if not exists public.login_attempts (
    login_attempt_id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    username text not null,
    login_number integer not null,
    two_fa_invoked boolean not null default false,
    successful_login boolean,
    confidence_score real,
    raw_data jsonb,
    -- SHA-256 of the canonicalized events array; used to detect replayed payloads.
    events_hash text,
    created_at timestamptz not null default now()
);

create index if not exists login_attempts_user_idx
    on public.login_attempts (user_id, login_number desc);
create index if not exists login_attempts_username_success_idx
    on public.login_attempts (username, successful_login);
-- Supports the replay-detection query: (user_id, events_hash) within a time window.
create index if not exists login_attempts_replay_idx
    on public.login_attempts (user_id, events_hash, created_at);

-- Pending OTP per login attempt. Deleted on success; expires_at gates
-- replay; attempt_count caps verification tries at 3.
create table if not exists public._2fa (
    login_attempt_id uuid primary key references public.login_attempts(login_attempt_id) on delete cascade,
    user_id uuid not null,
    username text not null,
    otp_hash text not null,
    expires_at timestamptz not null,
    attempt_count integer not null default 0,
    created_at timestamptz not null default now()
);
