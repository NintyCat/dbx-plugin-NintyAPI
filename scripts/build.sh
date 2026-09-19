#!/usr/bin/env bash
# One-shot local build: backend tests, sidecar binary, frontend bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="$ROOT/.dbx-dev/bin/dbx-plugin-nintyapi"

# Prefer the newest nvm-managed Node, then Homebrew; fall back to PATH.
NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
export PATH="${NVM_NODE:+$NVM_NODE:}/opt/homebrew/bin:$PATH"
export GOCACHE="${GOCACHE:-${TMPDIR:-/tmp}/nintyapi-go-build}"

echo "==> backend tests"
cd "$ROOT/backend"
go test -mod=readonly ./...

echo "==> backend binary"
mkdir -p "$(dirname "$BIN")"
go build -o "$BIN" .

echo "==> frontend"
cd "$ROOT/ui"
if [ ! -d node_modules ]; then
  if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile
  else
    npm install
  fi
fi
if command -v pnpm >/dev/null 2>&1; then
  pnpm run build
else
  npm run build
fi

echo "DBX_UI_BUILD_SUCCESS"
echo "Built $BIN"
