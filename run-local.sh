#!/bin/sh
set -eu
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo 'Install a supported Node.js LTS release and pnpm, then run pnpm install.' >&2
  exit 1
fi
node scripts/bootstrap.mjs
NODE_OPTIONS="${NODE_OPTIONS:-} --dns-result-order=ipv4first"
export NODE_OPTIONS
case "${1:-web}" in
  web) exec pnpm exec expo start --web --localhost --port 8081 ;;
  phone) exec pnpm exec expo start ;;
  check) exec pnpm check ;;
  *) echo 'Usage: ./run-local.sh web|phone|check' >&2; exit 1 ;;
esac
