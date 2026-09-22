#!/usr/bin/env bash
set -euo pipefail

# Nova installer.
#
#   git clone https://github.com/thaaaru/nova.git && cd nova && ./install.sh
#
# Installs an executable shim at ~/.local/bin/nova — a real file, not a shell
# alias, so `nova` also works in scripts, cron and non-interactive shells.
# Re-running is idempotent: it repoints the shim at this checkout and reuses
# whatever configuration is already saved.

say() { printf '%s\n' "$*"; }

if ! command -v node >/dev/null 2>&1; then
  say "Node.js 22+ is required. Install it (e.g. via nvm or https://nodejs.org) and re-run this script." >&2
  exit 1
fi

node_major="$(node -e 'console.log(process.versions.node.split(".")[0])')"
if [ "$node_major" -lt 22 ]; then
  say "Node.js 22+ is required (found $(node --version)). Upgrade and re-run this script." >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    say "pnpm not found - enabling it via corepack..."
    corepack enable
    corepack prepare pnpm@10.34.5 --activate
  else
    # Node 25+ no longer bundles corepack (it is an opt-in package now), so
    # `corepack` may not exist even on a fresh Node install. Get corepack via
    # npm first; if that is unavailable too, install pnpm directly.
    say "pnpm not found and no 'corepack' command available - installing corepack via npm..."
    if command -v npm >/dev/null 2>&1 && npm install -g corepack; then
      corepack enable
      corepack prepare pnpm@10.34.5 --activate
    else
      say "corepack install failed - installing pnpm directly via npm..."
      npm install -g pnpm@10.34.5
    fi
  fi
fi

say "Installing dependencies..."
pnpm install --frozen-lockfile

say "Installing the Playwright Chromium browser..."
pnpm exec playwright install --with-deps chromium

say "Building Nova..."
pnpm build

entrypoint="$(pwd)/dist/cli/index.js"
if [ ! -f "$entrypoint" ]; then
  say "Build did not produce $entrypoint." >&2
  exit 1
fi

# A shim, not an alias: an alias only exists in interactive shells that
# sourced the rc file, so `nova` used to disappear inside scripts.
bin_dir="${NOVA_BIN_DIR:-$HOME/.local/bin}"
mkdir -p "$bin_dir"
shim="$bin_dir/nova"
{
  printf '#!/usr/bin/env bash\n'
  printf 'exec node "%s" "$@"\n' "$entrypoint"
} >"$shim"
chmod +x "$shim"
say "Installed $shim"

case "${SHELL:-}" in
  */zsh) rc_file="$HOME/.zshrc" ;;
  */bash) rc_file="$HOME/.bashrc" ;;
  *) rc_file="$HOME/.profile" ;;
esac
touch "$rc_file"

drop_lines() {
  # drop_lines <extended-regex> <file> - portable in-place delete, no backup
  # file left behind and no BSD/GNU `sed -i` incompatibility.
  local pattern="$1" file="$2" tmp
  tmp="$(mktemp)"
  grep -vE "$pattern" "$file" >"$tmp" || true
  mv "$tmp" "$file"
}

append_once() {
  # append_once <line> <file> - replaces any previous export/alias of the same
  # name, so re-running this script never stacks duplicates.
  local line="$1" file="$2" key
  key="$(printf '%s' "$line" | sed -E 's/^(alias|export) ([A-Za-z_]+).*/\2/')"
  drop_lines "^(alias|export) ${key}=" "$file"
  printf '%s\n' "$line" >>"$file"
}

# The shim supersedes the alias older installs added.
if grep -qE '^alias nova="node ' "$rc_file" 2>/dev/null; then
  drop_lines '^alias nova="node ' "$rc_file"
  say "Removed the old 'nova' shell alias from $rc_file (the shim replaces it)."
fi

# Two separate problems: bin_dir may be missing from PATH entirely, or it may
# be present but *behind* a directory that already has its own `nova` (a stale
# global install, say). Only checking membership would silently leave the shim
# shadowed, so check what `nova` actually resolves to as well.
path_note=""
shadowed_by=""
existing_nova="$(command -v nova 2>/dev/null || true)"
if [ -n "$existing_nova" ] && [ "$existing_nova" != "$shim" ]; then
  shadowed_by="$existing_nova"
fi

needs_path_line=0
case ":${PATH}:" in
  *":$bin_dir:"*)
    # Present, but prepend anyway when something else owns `nova` today —
    # the rc line lands after whatever put that directory on PATH, so ours wins.
    if [ -n "$shadowed_by" ]; then
      needs_path_line=1
    fi
    ;;
  *) needs_path_line=1 ;;
esac

if [ "$needs_path_line" = "1" ]; then
  drop_lines "^export PATH=\"${bin_dir}:" "$rc_file"
  printf 'export PATH="%s:$PATH"\n' "$bin_dir" >>"$rc_file"
  path_note="$bin_dir was put at the front of your PATH in $rc_file."
fi

read_saved() {
  # `|| true` matters: with `set -o pipefail`, a grep that simply finds
  # nothing fails the whole pipeline, and under `set -e` that would kill the
  # installer the first time a variable is not already present.
  grep -E "^export $1=\"" "$rc_file" 2>/dev/null | sed -E "s/^export $1=\"(.*)\"\$/\1/" | tail -n1 || true
}

# Migrate the old DeepSeek-only variables onto the provider-neutral ones.
existing_key="${NOVA_LLM_API_KEY:-${DEEPSEEK_API_KEY:-}}"
existing_provider="${NOVA_LLM_PROVIDER:-}"
existing_model="${NOVA_LLM_MODEL:-${NOVA_DEEPSEEK_MODEL:-}}"
# Written as `if` blocks, not `[ test ] && assign`: under `set -e` a false
# test makes the whole list return non-zero and kills the script, which is
# exactly what used to happen here when a key was already in the environment.
if [ -z "$existing_key" ]; then existing_key="$(read_saved NOVA_LLM_API_KEY)"; fi
if [ -z "$existing_key" ]; then existing_key="$(read_saved DEEPSEEK_API_KEY)"; fi
if [ -z "$existing_provider" ]; then existing_provider="$(read_saved NOVA_LLM_PROVIDER)"; fi
if [ -z "$existing_model" ]; then existing_model="$(read_saved NOVA_LLM_MODEL)"; fi

save_llm() {
  append_once "export NOVA_LLM_PROVIDER=\"$1\"" "$rc_file"
  append_once "export NOVA_LLM_MODEL=\"$2\"" "$rc_file"
  if [ -n "$3" ]; then
    append_once "export NOVA_LLM_API_KEY=\"$3\"" "$rc_file"
  fi
}

if [ -n "$existing_key" ] || [ -n "$existing_provider" ]; then
  save_llm "${existing_provider:-deepseek}" "${existing_model:-deepseek-chat}" "$existing_key"
  say "Reused your existing model configuration (provider: ${existing_provider:-deepseek})."
elif [ -t 0 ]; then
  say ""
  say "Nova can identify the application under test and suggest extra test cases using an LLM."
  say "Optional: without one, identification is recorded as unknown and planning stays fully"
  say "deterministic. Providers: deepseek, openai, openai-compatible, ollama, self-hosted."
  read -r -p "Provider (blank to skip): " provider
  if [ -n "$provider" ]; then
    read -r -p "Model: " model
    read -r -p "API key (blank for a local endpoint that does not authenticate): " api_key
    read -r -p "Base URL (required for openai-compatible/self-hosted, else blank): " base_url
    save_llm "$provider" "$model" "$api_key"
    if [ -n "$base_url" ]; then
      append_once "export NOVA_LLM_BASE_URL=\"$base_url\"" "$rc_file"
    fi
    say "Saved to $rc_file."
  else
    say "Skipped. Nova will run without a model."
  fi
fi

say ""
if [ -n "$shadowed_by" ]; then
  say "Note: another 'nova' is already on your PATH at:"
  say "  $shadowed_by"
  say "$bin_dir now comes first, so a new shell will use this checkout. Remove the"
  say "other one if you do not want it around (e.g. pnpm remove -g @thaaaru/nova)."
  say ""
fi
say "Done. Open a new shell (or: source $rc_file), then:"
say ""
say "  nova                              guided workflow; resumes anything in flight"
say "  nova https://app.example.com      start against a target"
say ""
if [ -n "$path_note" ]; then
  say "$path_note"
  say ""
fi
say "Optional environment variables, all with sane defaults:"
say "  NOVA_LLM_PROVIDER / NOVA_LLM_MODEL / NOVA_LLM_BASE_URL / NOVA_LLM_API_KEY"
say "  NOVA_DATABASE_PATH   (default: data/nova.sqlite)"
say "  NOVA_ARTIFACTS_DIR   (default: artifacts)"
say "  NOVA_HEADLESS        (default: true unless set to \"false\")"
