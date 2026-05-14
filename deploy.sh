#!/bin/bash
# SEO Room v5 — One-command deploy
# Usage: ./deploy.sh "commit message"

set -e
cd "$(dirname "$0")"

MSG="${1:-auto deploy}"

# Copy any staged files from Desktop
[ -f ~/Desktop/server-v5-latest.js ] && cp ~/Desktop/server-v5-latest.js server.js && echo "✓ server.js updated"
[ -f ~/Desktop/index-v5-latest.html ] && cp ~/Desktop/index-v5-latest.html public/index.html && echo "✓ index.html updated"

# Clean git locks
rm -f .git/HEAD.lock .git/index.lock

# Commit and push
git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit"
  exit 0
fi
git commit -m "$MSG"
git push

# Cleanup
rm -f ~/Desktop/server-v5-latest.js ~/Desktop/index-v5-latest.html

echo "✓ Deployed: $MSG"
