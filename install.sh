#!/usr/bin/env bash
set -euo pipefail

readonly REQUIRED_NODE_MAJOR=22
readonly PACKAGE_NAME="@thaaaru/nova"
readonly REGISTRY_URL="https://npm.pkg.github.com"

# Customer installer: pulls the published package from the private registry
# using a read-only token issued at purchase. No git/source access required.
main() {
  local initial_path="$PATH"

  require_command node
  require_command npm
  require_supported_node
  require_registry_token

  npm config set "//npm.pkg.github.com/:_authToken" "$NOVA_NPM_TOKEN" --location=user
  npm install --global --registry "$REGISTRY_URL" "$PACKAGE_NAME"

  local global_bin_dir
  global_bin_dir="$(npm prefix --global)/bin"
  export PATH="$global_bin_dir:$PATH"

  nova install-browser
  print_next_step "$initial_path" "$global_bin_dir"
}

require_registry_token() {
  if [[ -z "${NOVA_NPM_TOKEN:-}" ]]; then
    printf 'NOVA_NPM_TOKEN is required (the read-only registry token from your license email).\n' >&2
    exit 1
  fi
}


print_next_step() {
  local initial_path="$1"
  local global_bin_dir="$2"

  if [[ ":$initial_path:" == *":$global_bin_dir:"* ]]; then
    printf '\nNova is ready. Try: nova --help\n'
    return
  fi

  printf '\nNova is installed. Open a new terminal, or run:\n'
  printf '  export PATH=%q:"$PATH"\n' "$global_bin_dir"
  printf 'Then try: nova --help\n'
}

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%s is required but was not found on PATH.\n' "$command_name" >&2
    exit 1
  fi
}

require_supported_node() {
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"

  if ((node_major < REQUIRED_NODE_MAJOR)); then
    printf 'Nova requires Node.js %s or later; found %s.\n' "$REQUIRED_NODE_MAJOR" "$node_major" >&2
    exit 1
  fi
}

main "$@"
