#!/usr/bin/env bash
#
# Apply choirfriend's B2 CORS rules to a bucket.
#
# Usage: ./scripts/apply-b2-cors.sh <bucket-name> [upload-origin ...]
#
# Upload origins are the sites allowed to PUT files into the bucket. With none
# given, they are CLIENT_ORIGIN from the repo's .env plus the Vite dev server
# (http://localhost:5173). Reads are allowed from any origin.
#
# Requires:
#   - b2 CLI installed (`brew install b2-tools` or `pipx install b2`)
#   - `b2 account authorize <keyId> <applicationKey>` run beforehand
#   - jq, for stripping the JSON file's _comment helper keys
#
# WARNING: this REPLACES the bucket's entire corsRules array. If other
# services share the bucket and add their own rules, merge by hand or
# this will trample them.

set -euo pipefail

bucket="${1:-}"
if [[ -z "$bucket" ]]; then
  echo "usage: $0 <bucket-name> [upload-origin ...]" >&2
  exit 64
fi
shift

here="$(cd "$(dirname "$0")" && pwd)"
rules_file="$here/b2-cors-rules.json"

origins=("$@")
if [[ ${#origins[@]} -eq 0 ]]; then
  env_file="$here/../.env"
  client_origin=""
  if [[ -f "$env_file" ]]; then
    client_origin="$(sed -n 's/^CLIENT_ORIGIN=//p' "$env_file" | tail -n1 | tr -d '"'"'"'\r')"
  fi
  origins=("http://localhost:5173")
  if [[ -n "$client_origin" && "$client_origin" != "http://localhost:5173" ]]; then
    origins+=("$client_origin")
  fi
fi

if ! command -v b2 >/dev/null; then
  echo "error: b2 CLI not found. Install with 'brew install b2-tools' or 'pipx install b2'." >&2
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "error: jq not found. Install with 'brew install jq'." >&2
  exit 1
fi

# Strip the human-readable _comment fields and fill in the upload origins.
rules="$(jq --args 'map(del(._comment) | if .corsRuleName == "choirfriendUploads" then .allowedOrigins = $ARGS.positional else . end)' "${origins[@]}" < "$rules_file")"

echo "Applying CORS rules to bucket: $bucket"
echo "$rules" | jq -r '.[] | "  · " + .corsRuleName + " (" + (.allowedOperations | join(",")) + ") from " + (.allowedOrigins | join(", "))'
echo

b2 bucket update "$bucket" --cors-rules "$rules"

echo
echo "Done. Verify with: b2 bucket get $bucket | jq .corsRules"
