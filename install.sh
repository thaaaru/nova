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
  if command -v corepack >/dev/null 2>&1; then
    echo "pnpm not found — enabling it via corepack..."
    corepack enable
    corepack prepare pnpm@10.34.5 --activate
  else
    # Node 25+ no longer bundles corepack (it's an opt-in package now), so
    # `corepack` may not exist even on a fresh Node install. Get corepack
    # via npm first; if that's unavailable too, fall back to installing
    # pnpm directly.
    echo "pnpm not found and no 'corepack' command available — installing corepack via npm..."
    if command -v npm >/dev/null 2>&1 && npm install -g corepack; then
      corepack enable
      corepack prepare pnpm@10.34.5 --activate
    else
      echo "corepack install failed — installing pnpm directly via npm..."
      npm install -g pnpm@10.34.5
    fi
  fi
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

# Detect an existing installation/config so re-running install.sh (or running
# it again after a fresh clone) never re-prompts for things Nova already
# knows — it just repoints the alias at this checkout and reuses saved keys.
existing_alias_path=""
if [ -f "$rc_file" ]; then
  existing_alias_path="$(grep -E '^alias nova="node ' "$rc_file" 2>/dev/null | sed -E 's/^alias nova="node (.*)"$/\1/' | tail -n1)"
fi
existing_deepseek_key="${DEEPSEEK_API_KEY:-}"
if [ -z "$existing_deepseek_key" ] && [ -f "$rc_file" ]; then
  existing_deepseek_key="$(grep -E '^export DEEPSEEK_API_KEY="' "$rc_file" 2>/dev/null | sed -E 's/^export DEEPSEEK_API_KEY="(.*)"$/\1/' | tail -n1)"
fi
existing_deepseek_model="${NOVA_DEEPSEEK_MODEL:-}"
if [ -z "$existing_deepseek_model" ] && [ -f "$rc_file" ]; then
  existing_deepseek_model="$(grep -E '^export NOVA_DEEPSEEK_MODEL="' "$rc_file" 2>/dev/null | sed -E 's/^export NOVA_DEEPSEEK_MODEL="(.*)"$/\1/' | tail -n1)"
fi

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
  if [ -n "$existing_alias_path" ]; then
    if [ "$existing_alias_path" = "$bin_path" ]; then
      echo "Existing 'nova' alias in $rc_file already points here."
    else
      append_once "alias nova=\"node $bin_path\"" "$rc_file"
      echo "Found an existing 'nova' alias in $rc_file pointing at $existing_alias_path — repointed it at this checkout ($bin_path)."
    fi
  else
    read -r -p "Add a 'nova' alias to $rc_file? [Y/n] " add_alias
    if [ "${add_alias:-y}" != "n" ] && [ "${add_alias:-y}" != "N" ]; then
      append_once "alias nova=\"node $bin_path\"" "$rc_file"
      echo "Added. Run 'source $rc_file' (or open a new shell) to use 'nova' directly."
    else
      echo "Skipped. Run Nova with: node $bin_path <command>"
    fi
  fi

  echo ""
  if [ -n "$existing_deepseek_key" ]; then
    echo "Reusing existing DeepSeek API key (found in $([ -n "${DEEPSEEK_API_KEY:-}" ] && echo "the current shell environment" || echo "$rc_file"))."
    append_once "export DEEPSEEK_API_KEY=\"$existing_deepseek_key\"" "$rc_file"
    append_once "export NOVA_DEEPSEEK_MODEL=\"${existing_deepseek_model:-deepseek-chat}\"" "$rc_file"
  else
    read -r -p "DeepSeek API key to enable LLM plan proposals (leave blank to skip): " deepseek_key
    if [ -n "$deepseek_key" ]; then
      read -r -p "Model to use [deepseek-chat]: " deepseek_model
      deepseek_model="${deepseek_model:-deepseek-chat}"
      append_once "export DEEPSEEK_API_KEY=\"$deepseek_key\"" "$rc_file"
      append_once "export NOVA_DEEPSEEK_MODEL=\"$deepseek_model\"" "$rc_file"
      echo "Saved to $rc_file. Without a key, 'nova plan' falls back to the deterministic template planner."
    else
      echo "Skipped. 'nova plan' will use the deterministic template planner only."
    fi
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
  if [ -n "$existing_alias_path" ] && [ "$existing_alias_path" != "$bin_path" ]; then
    append_once "alias nova=\"node $bin_path\"" "$rc_file"
    echo "Non-interactive shell detected — repointed the existing 'nova' alias in $rc_file at this checkout ($bin_path)."
  else
    echo "Non-interactive shell detected — skipping alias/env prompts."
  fi
  if [ -n "$existing_deepseek_key" ]; then
    append_once "export DEEPSEEK_API_KEY=\"$existing_deepseek_key\"" "$rc_file"
    append_once "export NOVA_DEEPSEEK_MODEL=\"${existing_deepseek_model:-deepseek-chat}\"" "$rc_file"
    echo "Reused the existing DeepSeek API key."
  fi
  echo "Run it with:"
  echo "  node $bin_path <command>"
  echo ""
  if [ -z "$existing_alias_path" ]; then
    echo "Or add manually to your shell profile:"
    echo "  alias nova=\"node $bin_path\""
  fi
  if [ -z "$existing_deepseek_key" ]; then
    echo "  export DEEPSEEK_API_KEY=sk-...          # enables LLM plan proposals"
    echo "  export NOVA_DEEPSEEK_MODEL=deepseek-chat # optional, this is the default"
  fi
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
