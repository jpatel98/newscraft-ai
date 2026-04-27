#!/usr/bin/env bash
set -euo pipefail

cd /home/jigar/hermes-ui

pnpm build
sudo systemctl restart hermes-ui.service

echo "Waiting for hermes-ui health on 127.0.0.1:3001..."
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3001/api/health; then
    echo
    exit 0
  fi
  sleep 1
done

echo "ERROR: hermes-ui did not become healthy in time." >&2
systemctl status hermes-ui.service --no-pager || true
exit 1
