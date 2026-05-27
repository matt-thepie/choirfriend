#!/usr/bin/env bash
#
# Apply choirfriend's B2 CORS rules to a bucket.
#
# Usage: ./scripts/apply-b2-cors.sh <bucket-name>
#
# Requires:
#   - b2 CLI installed (`brew install b2-tools` or `pipx install b2`)
#   - `b2 account authorize <keyId> <applicationKey>` run beforehand
#   - jq, for stripping the JSON file's _comment helper keys
#
# WARNING: this REPLACES the bucket's entire corsRules array. If other
# services share the bucket and add their own rules, merge by hand or
# this will trample them. As of writing, choirfriend is the only service
# on the SGMC shared bucket that needs CORS (the others upload server-side).

set -euo pipefail

bucket="${1:-}"
if [[ -z "$bucket" ]]; then
  echo "usage: $0 <bucket-name>" >&2
  exit 64
fi

here="$(cd "$(dirname "$0")" && pwd)"
rules_file="$here/b2-cors-rules.json"

if ! command -v b2 >/dev/null; then
  echo "error: b2 CLI not found. Install with 'brew install b2-tools' or 'pipx install b2'." >&2
  exit 1
fi
if ! command -v jq >/dev/null; then
  echo "error: jq not found. Install with 'brew install jq'." >&2
  exit 1
fi

# Strip the human-readable _comment fields before sending to B2.
rules="$(jq 'map(del(._comment))' "$rules_file")"

echo "Applying CORS rules to bucket: $bucket"
echo "$rules" | jq -r '.[] | "  · " + .corsRuleName + " (" + (.allowedOperations | join(",")) + ")"'
echo

b2 bucket update "$bucket" --cors-rules "$rules"

echo
echo "Done. Verify with: b2 bucket get $bucket | jq .corsRules"
