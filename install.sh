#!/usr/bin/env bash
set -euo pipefail

# One-liner installer for Nova. Run from a clone of this repo:
#   git clone git@github.com:thaaaru/nova.git && cd nova && ./install.sh

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required. Install it (e.g. via nvm or https://nodejs.org) and re-run this script." >&2
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 22 ]; then
  echo "Node.js 22+ is required (found $(node --version)). Upgrade and re-run this script." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm not found — enabling it via corepack..."
  corepack enable
  corepack prepare pnpm@10.34.5 --activate
fi

echo "Installing dependencies..."
pnpm install --frozen-lockfile

echo "Installing the Playwright Chromium browser..."
pnpm exec playwright install --with-deps chromium

echo "Building Nova..."
pnpm build

bin_path="$(pwd)/dist/cli/index.js"
chmod +x "$bin_path"

echo ""
echo "Nova is built. Run it with:"
echo "  node $bin_path <command>"
echo ""
echo "Or add a shell alias for convenience:"
echo "  alias nova=\"node $bin_path\""
echo ""
echo "Next steps:"
echo "  nova init"
echo "  nova discover --target <url> --manifest nova.manifest.json"
