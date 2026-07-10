#!/bin/bash
# Rotate the RAG function's Zoho refresh token in one step.
#
# Usage:
#   1. Zoho API console (https://api-console.zoho.in) -> Self Client ->
#      Generate Code with scope QuickML.rag.READ
#   2. ./scripts/rotate-rag-token.sh <paste-code-here>
#
# The script exchanges the code, VERIFIES the new refresh token actually
# mints an access token, writes it into functions/rag/catalyst-config.json,
# and redeploys. It refuses to save anything that doesn't verify.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/functions/rag/catalyst-config.json"
ACCOUNTS="https://accounts.zoho.in"

CODE="${1:-}"
if [ -z "$CODE" ]; then
  echo "Usage: $0 <self-client-code>" >&2
  exit 1
fi

CLIENT_ID=$(python3 -c "import json;print(json.load(open('$CONFIG'))['deployment']['env_variables']['RAG_CLIENT_ID'])")
CLIENT_SECRET=$(python3 -c "import json;print(json.load(open('$CONFIG'))['deployment']['env_variables']['RAG_CLIENT_SECRET'])")

echo "==> Exchanging code for tokens..."
RESP=$(curl -s -X POST "$ACCOUNTS/oauth/v2/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "code=$CODE")

REFRESH=$(echo "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('refresh_token',''))")
if [ -z "$REFRESH" ]; then
  echo "FAILED — no refresh_token in response:" >&2
  echo "$RESP" >&2
  exit 1
fi

echo "==> Verifying the new refresh token mints an access token..."
VERIFY=$(curl -s -X POST "$ACCOUNTS/oauth/v2/token" \
  -d "grant_type=refresh_token" \
  -d "client_id=$CLIENT_ID" \
  -d "client_secret=$CLIENT_SECRET" \
  -d "refresh_token=$REFRESH")
ACCESS=$(echo "$VERIFY" | python3 -c "import json,sys;print(json.load(sys.stdin).get('access_token',''))")
if [ -z "$ACCESS" ]; then
  echo "FAILED — refresh token did not verify, NOT saving:" >&2
  echo "$VERIFY" >&2
  exit 1
fi

echo "==> Verified. Updating catalyst-config.json..."
python3 - "$CONFIG" "$REFRESH" <<'EOF'
import json, sys
path, token = sys.argv[1], sys.argv[2]
cfg = json.load(open(path))
cfg["deployment"]["env_variables"]["RAG_REFRESH_TOKEN"] = token
with open(path, "w") as f:
    json.dump(cfg, f, indent="\t")
    f.write("\n")
EOF

echo "==> Deploying function..."
cd "$ROOT" && catalyst deploy

echo "==> Smoke-testing the deployed RAG endpoint..."
curl -s -X POST "https://sentinel-60073599957.development.catalystserverless.in/server/rag/" \
  -H "Content-Type: application/json" \
  -d '{"query": "What is a cognizable offence?"}' | head -c 300
echo
echo "==> Done."
