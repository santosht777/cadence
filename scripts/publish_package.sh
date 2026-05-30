#!/usr/bin/env bash
# Publish the browser/API client package to npm after local validation.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$REPO_ROOT/packages/capture"

info() { printf '  · %s\n' "$*"; }
ok() { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
fail() { printf '\033[31m  ✗ %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Usage: bash scripts/publish_package.sh [--dry-run] [--skip-registry-check]

Validates and publishes @cadence-auth/cadence to npm.

Options:
  --dry-run              Run validation, registry availability, and npm pack only.
  --skip-registry-check  Skip the npm registry duplicate-version preflight.
  -h, --help             Show this help.
EOF
}

DRY_RUN=0
SKIP_REGISTRY_CHECK=0
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run)
            DRY_RUN=1
            ;;
        --skip-registry-check)
            SKIP_REGISTRY_CHECK=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "Unknown option: $1"
            ;;
    esac
    shift
done

PACKAGE_NAME="$(node -p "require('$PACKAGE_DIR/package.json').name")"
PACKAGE_VERSION="$(node -p "require('$PACKAGE_DIR/package.json').version")"

[ "$PACKAGE_NAME" = "@cadence-auth/cadence" ] || fail "Unexpected package name: $PACKAGE_NAME"

if [ "$DRY_RUN" -eq 0 ] && [ -z "${NPM_TOKEN:-}" ]; then
    fail "NPM_TOKEN is required to publish $PACKAGE_NAME@$PACKAGE_VERSION"
fi

cleanup() {
    rm -f "$PACKAGE_DIR/.npmrc"
}
trap cleanup EXIT

if [ -n "${NPM_TOKEN:-}" ]; then
    printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$PACKAGE_DIR/.npmrc"
fi

if [ ! -d "$PACKAGE_DIR/node_modules" ]; then
    info "Installing npm dependencies"
    (cd "$PACKAGE_DIR" && npm ci)
fi

check_registry_version() {
    local output
    set +e
    output="$(npm view "$PACKAGE_NAME@$PACKAGE_VERSION" version 2>&1)"
    local status=$?
    set -e
    if [ "$status" -eq 0 ]; then
        fail "$PACKAGE_NAME@$PACKAGE_VERSION already exists on npm. Bump the package version before publishing."
    fi
    if printf '%s\n' "$output" | grep -q 'E404'; then
        ok "$PACKAGE_NAME@$PACKAGE_VERSION is not published yet"
        return
    fi
    printf '%s\n' "$output" >&2
    fail "Could not verify npm registry availability for $PACKAGE_NAME@$PACKAGE_VERSION"
}

if [ "$SKIP_REGISTRY_CHECK" -eq 0 ]; then
    info "Checking npm registry for $PACKAGE_NAME@$PACKAGE_VERSION"
    check_registry_version
fi

info "Validating $PACKAGE_NAME@$PACKAGE_VERSION"
(cd "$PACKAGE_DIR" && npm run typecheck && npm test && npm pack --dry-run)

if [ "$DRY_RUN" -eq 1 ]; then
    ok "dry run completed for $PACKAGE_NAME@$PACKAGE_VERSION"
    exit 0
fi

info "Publishing $PACKAGE_NAME@$PACKAGE_VERSION"
(cd "$PACKAGE_DIR" && npm publish --access public)
