#!/usr/bin/env bash
# Apply backend/schema.sql to a local or production Supabase Postgres database.
#
# Usage:
#   DATABASE_URL=postgres://... bash scripts/apply_schema.sh
#   SUPABASE_DB_URL=postgres://... bash scripts/apply_schema.sh
#   bash scripts/apply_schema.sh  # falls back to `supabase status -o env`

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA_FILE="${CADENCE_SCHEMA_FILE:-$REPO_ROOT/backend/schema.sql}"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

resolve_db_url() {
    if [ -n "${DATABASE_URL:-}" ]; then
        printf '%s\n' "$DATABASE_URL"
        return
    fi
    if [ -n "${SUPABASE_DB_URL:-}" ]; then
        printf '%s\n' "$SUPABASE_DB_URL"
        return
    fi
    if command -v supabase >/dev/null 2>&1; then
        supabase status -o env \
            | sed -n 's/^DB_URL=//p' \
            | tr -d '"' \
            | head -n 1
        return
    fi
    if command -v npx >/dev/null 2>&1; then
        npx supabase status -o env \
            | sed -n 's/^DB_URL=//p' \
            | tr -d '"' \
            | head -n 1
        return
    fi
}

apply_with_container() {
    info "psql not found locally; applying schema through the Supabase DB container"
    DB_CONTAINER="$(
        docker ps --format '{{.Names}}' \
            | grep '^supabase_db_' \
            | head -n 1 \
            || true
    )"
    if [ -z "$DB_CONTAINER" ]; then
        fail "Could not find psql or a running Supabase database container."
    fi
    docker exec -i "$DB_CONTAINER" \
        psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
        <"$SCHEMA_FILE"
}

[ -f "$SCHEMA_FILE" ] || fail "Schema file not found: $SCHEMA_FILE"

bold "Applying Cadence schema"
DB_URL="$(resolve_db_url)"
if [ -z "$DB_URL" ]; then
    fail "Set DATABASE_URL or SUPABASE_DB_URL, or run a local Supabase stack."
fi

if command -v psql >/dev/null 2>&1; then
    psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f "$SCHEMA_FILE"
else
    apply_with_container
fi

ok "schema applied from $SCHEMA_FILE"
