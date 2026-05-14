#!/bin/bash
# One-time setup with macOS GUI dialogs
# Run: ./setup-tokens.sh

cd "$(dirname "$0")"
TOKEN_FILE="$HOME/.seoroom-tokens"

# Load existing values
if [ -f "$TOKEN_FILE" ]; then
  source "$TOKEN_FILE"
fi

# macOS dialog helper
ask() {
  local prompt="$1"
  local default="$2"
  local hidden="$3"
  if [ "$hidden" = "true" ]; then
    osascript -e "display dialog \"$prompt\" default answer \"$default\" with hidden answer with title \"SEO Room Setup\" with icon note" -e 'text returned of result' 2>/dev/null
  else
    osascript -e "display dialog \"$prompt\" default answer \"$default\" with title \"SEO Room Setup\" with icon note" -e 'text returned of result' 2>/dev/null
  fi
}

notify() {
  osascript -e "display notification \"$1\" with title \"SEO Room\" sound name \"Glass\""
}

alert() {
  osascript -e "display dialog \"$1\" with title \"SEO Room Setup\" buttons {\"OK\"} default button \"OK\" with icon $2"
}

# Welcome
osascript -e 'display dialog "SEO Room Token Setup\n\nThis saves your API tokens locally and sets Railway env vars.\nTokens are stored in ~/.seoroom-tokens (never committed)." with title "SEO Room Setup" buttons {"Cancel", "Start"} default button "Start" with icon note' 2>/dev/null || exit 0

# Collect tokens
GITHUB_PAT=$(ask "GitHub Personal Access Token:" "${GITHUB_PAT}" "true") || exit 0
CLOUDFLARE_API_TOKEN=$(ask "Cloudflare API Token:" "${CLOUDFLARE_API_TOKEN}" "true") || exit 0
CF_ZONE_GOLDPC=$(ask "Cloudflare Zone ID (goldpc.net.au):" "${CF_ZONE_GOLDPC}" "false") || exit 0

# Save
cat > "$TOKEN_FILE" << EOF
GITHUB_PAT="$GITHUB_PAT"
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN"
CF_ZONE_GOLDPC="$CF_ZONE_GOLDPC"
EOF
chmod 600 "$TOKEN_FILE"

# Set Railway env vars
RAIL_MSG=""
if command -v railway &>/dev/null; then
  railway variables set CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" 2>/dev/null && RAIL_MSG="\n✓ Railway CLOUDFLARE_API_TOKEN set" || RAIL_MSG="\n⚠ Railway not linked — run 'railway link' first"
else
  RAIL_MSG="\n⚠ Railway CLI not installed"
fi

alert "Setup Complete!\n\n✓ Tokens saved to ~/.seoroom-tokens$RAIL_MSG\n\nDeploy anytime by typing: d" "note"
notify "Setup complete — type d to deploy"
