#!/usr/bin/env bash
# typecheck.sh — TypeScript Typecheck für Main + Renderer
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GREEN='\033[0;32m'; RED='\033[0;31m'; RESET='\033[0m'

echo "TypeScript Typecheck..."
cd "$ROOT"

ERRORS=0

echo -n "  main...    "
if npm run typecheck 2>&1 | grep -q "error TS"; then
  echo -e "${RED}FEHLER${RESET}"
  npm run typecheck 2>&1 | grep "error TS"
  ERRORS=$((ERRORS + 1))
else
  echo -e "${GREEN}OK${RESET}"
fi

if [[ $ERRORS -eq 0 ]]; then
  echo -e "${GREEN}✓ Kein TypeScript-Fehler${RESET}"
  exit 0
else
  echo -e "${RED}✗ $ERRORS Fehler gefunden${RESET}"
  exit 1
fi
