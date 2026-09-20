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
echo "Nova is built."

rc_file=""
case "${SHELL:-}" in
  */zsh) rc_file="$HOME/.zshrc" ;;
  */bash) rc_file="$HOME/.bashrc" ;;
  *) rc_file="$HOME/.profile" ;;
esac

append_once() {
  # append_once <line> <rc_file> — skip if the line (or an alias/export of the
  # same name) is already present, so re-running install.sh is idempotent.
  local line="$1" file="$2" key
  key="$(echo "$line" | sed -E 's/^(alias|export) ([A-Za-z_]+).*/\2/')"
  if [ -f "$file" ] && grep -qE "^(alias|export) $key=" "$file" 2>/dev/null; then
    sed -i.bak -E "/^(alias|export) $key=/d" "$file" && rm -f "$file.bak"
  fi
  echo "$line" >>"$file"
}

if [ -t 0 ]; then
  echo ""
  read -r -p "Add a 'nova' alias to $rc_file? [Y/n] " add_alias
  if [ "${add_alias:-y}" != "n" ] && [ "${add_alias:-y}" != "N" ]; then
    append_once "alias nova=\"node $bin_path\"" "$rc_file"
    echo "Added. Run 'source $rc_file' (or open a new shell) to use 'nova' directly."
  else
    echo "Skipped. Run Nova with: node $bin_path <command>"
  fi

  echo ""
  read -r -p "OpenAI API key to enable LLM plan proposals (leave blank to skip): " openai_key
  if [ -n "$openai_key" ]; then
    read -r -p "Model to use [gpt-4o-mini]: " openai_model
    openai_model="${openai_model:-gpt-4o-mini}"
    append_once "export OPENAI_API_KEY=\"$openai_key\"" "$rc_file"
    append_once "export NOVA_OPENAI_MODEL=\"$openai_model\"" "$rc_file"
    echo "Saved to $rc_file. Without a key, 'nova plan' falls back to the deterministic template planner."
  else
    echo "Skipped. 'nova plan' will use the deterministic template planner only."
  fi

  echo ""
  read -r -p "Customize other Nova settings (database path, artifacts dir, headless)? [y/N] " customize
  if [ "${customize:-n}" = "y" ] || [ "${customize:-n}" = "Y" ]; then
    read -r -p "NOVA_DATABASE_PATH [data/nova.sqlite]: " db_path
    read -r -p "NOVA_ARTIFACTS_DIR [artifacts]: " artifacts_dir
    read -r -p "NOVA_HEADLESS — run browsers headless? [Y/n] " headless
    [ -n "$db_path" ] && append_once "export NOVA_DATABASE_PATH=\"$db_path\"" "$rc_file"
    [ -n "$artifacts_dir" ] && append_once "export NOVA_ARTIFACTS_DIR=\"$artifacts_dir\"" "$rc_file"
    if [ "${headless:-y}" = "n" ] || [ "${headless:-y}" = "N" ]; then
      append_once "export NOVA_HEADLESS=\"false\"" "$rc_file"
    fi
    echo "Saved to $rc_file."
  fi
else
  echo ""
  echo "Non-interactive shell detected — skipping alias/env prompts."
  echo "Run it with:"
  echo "  node $bin_path <command>"
  echo ""
  echo "Or add manually to your shell profile:"
  echo "  alias nova=\"node $bin_path\""
  echo "  export OPENAI_API_KEY=sk-...        # enables LLM plan proposals"
  echo "  export NOVA_OPENAI_MODEL=gpt-4o-mini # optional, this is the default"
fi

echo ""
echo "Other env vars, all optional with sane defaults:"
echo "  NOVA_DATABASE_PATH   (default: data/nova.sqlite)"
echo "  NOVA_ARTIFACTS_DIR   (default: artifacts)"
echo "  NOVA_HEADLESS        (default: true unless set to \"false\")"
echo ""
echo "Open a new shell (or 'source $rc_file') then:"
echo "  nova init"
echo "  nova discover --target <url> --manifest nova.manifest.json"
