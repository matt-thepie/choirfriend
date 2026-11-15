#!/bin/bash
# Runs on the VPS. The GitHub Actions deploy key is locked to this script in
# authorized_keys (command="..."), so CI can run this and nothing else.
set -euo pipefail

# All in one function, so bash has read the whole file before git pull can change it.
main() {
  export NVM_DIR="$HOME/.nvm"
  source "$NVM_DIR/nvm.sh"
  cd ~/github/choirfriend
  git pull --ff-only origin main

  # Server: runs .ts directly under Node 24, no build step.
  cd server
  npm ci
  mkdir -p data   # SQLite lives at ./data/choirfriend.db (cwd = server/)

  # Client: Vite SPA served statically by nginx from client/dist.
  cd ../client
  npm ci
  npm run build

  # Start (or reload) the Fastify app. pm2 belongs to the default Node, shared with
  # the other apps; choirfriend itself is pinned to Node 24 via --interpreter.
  cd ../server
  pm2 restart choirfriend --update-env || pm2 start src/server.ts \
    --name choirfriend \
    --interpreter "$(nvm which 24)" \
    --node-args="--env-file=../.env"
  pm2 save
  echo "Deploy complete: $(git rev-parse --short HEAD)"
}
main "$@"
