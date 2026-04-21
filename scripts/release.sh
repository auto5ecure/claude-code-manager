#!/usr/bin/env bash
# release.sh — ClaudeMC Release-Automation
# Usage: ./scripts/release.sh [-v VERSION] [-n "NOTES"] [--dry-run] [--no-push]
#
# Ablauf: version bump → build → Nextcloud upload → git commit
#
# Voraussetzungen:
#   - npm, electron-builder, curl
#   - NEXTCLOUD_TOKEN env var oder Hardcode in version.json bekannt

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
RELEASE_DIR="/tmp/claude-mc-release"
NEXTCLOUD_BASE="https://nx65086.your-storageshare.de/public.php/webdav"

# ShareToken aus version.json lesen (kein Hardcode im Script)
VERSION_JSON="$ROOT/release/version.json"
SHARE_TOKEN=$(python3 -c "import json,sys; d=json.load(open('$VERSION_JSON')); print(d.get('shareToken',''))" 2>/dev/null || echo "")

# ── Argumente ─────────────────────────────────────────────────────────────────
NEW_VERSION=""
RELEASE_NOTES=""
DRY_RUN=false
NO_PUSH=false

while [[ $# -gt 0 ]]; do
  case $1 in
    -v|--version) NEW_VERSION="$2"; shift 2 ;;
    -n|--notes)   RELEASE_NOTES="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=true; shift ;;
    --no-push)    NO_PUSH=true; shift ;;
    *) echo "Unbekannte Option: $1"; exit 1 ;;
  esac
done

# ── Farben ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; BOLD='\033[1m'; RESET='\033[0m'
ok()   { echo -e "${GREEN}✓${RESET} $*"; }
info() { echo -e "${BLUE}→${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
err()  { echo -e "${RED}✗${RESET} $*"; exit 1; }

echo -e "${BOLD}╔══════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   ClaudeMC Release Automation    ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════╝${RESET}"

# ── Aktuelle Version lesen ────────────────────────────────────────────────────
CURRENT_VERSION=$(python3 -c "import json; d=json.load(open('$ROOT/package.json')); print(d['version'])")
info "Aktuelle Version: $CURRENT_VERSION"

# ── Version interaktiv abfragen wenn nicht übergeben ─────────────────────────
if [[ -z "$NEW_VERSION" ]]; then
  # Patch-Version automatisch vorschlagen
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
  SUGGESTED="$MAJOR.$MINOR.$((PATCH + 1))"
  read -rp "$(echo -e "Neue Version ${YELLOW}[$SUGGESTED]${RESET}: ")" NEW_VERSION
  NEW_VERSION="${NEW_VERSION:-$SUGGESTED}"
fi

# ── Release Notes interaktiv abfragen wenn nicht übergeben ───────────────────
if [[ -z "$RELEASE_NOTES" ]]; then
  read -rp "$(echo -e "Release Notes: ")" RELEASE_NOTES
  [[ -z "$RELEASE_NOTES" ]] && RELEASE_NOTES="v$NEW_VERSION"
fi

# ── Validierung ───────────────────────────────────────────────────────────────
[[ "$NEW_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || err "Version muss im Format X.Y.Z sein"
[[ -n "$SHARE_TOKEN" ]] || err "ShareToken nicht in $VERSION_JSON gefunden"

echo ""
echo -e "${BOLD}Release-Plan:${RESET}"
echo -e "  Version:  $CURRENT_VERSION → ${GREEN}$NEW_VERSION${RESET}"
echo -e "  Notes:    $RELEASE_NOTES"
$DRY_RUN && echo -e "  ${YELLOW}Dry-Run: kein Build, kein Upload, kein Commit${RESET}"
$NO_PUSH && echo -e "  ${YELLOW}No-Push: kein git push${RESET}"
echo ""
read -rp "Fortfahren? [Y/n] " CONFIRM
[[ "${CONFIRM:-Y}" =~ ^[Yy]$ ]] || { echo "Abgebrochen."; exit 0; }

# ── 1. Version bump ───────────────────────────────────────────────────────────
info "Version bump → $NEW_VERSION"
RELEASE_DATE=$(date +%Y-%m-%d)
DMG_NAME="Claude%20MC-${NEW_VERSION}-arm64.dmg"
ZIP_NAME="Claude%20MC-${NEW_VERSION}-arm64-mac.zip"
DMG_URL="${NEXTCLOUD_BASE}/${DMG_NAME}"
ZIP_URL="${NEXTCLOUD_BASE}/${ZIP_NAME}"

if ! $DRY_RUN; then
  # package.json
  python3 - <<PYEOF
import json
with open('$ROOT/package.json', 'r') as f:
    d = json.load(f)
d['version'] = '$NEW_VERSION'
with open('$ROOT/package.json', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
PYEOF

  # release/version.json
  python3 - <<PYEOF
import json
with open('$VERSION_JSON', 'r') as f:
    d = json.load(f)
d['version'] = '$NEW_VERSION'
d['releaseDate'] = '$RELEASE_DATE'
d['dmgUrl'] = '${DMG_URL//%20/ }'.replace(' ', '%20') if False else '$DMG_URL'
d['zipUrl'] = '$ZIP_URL'
d['notes'] = 'v$NEW_VERSION: $RELEASE_NOTES'
with open('$VERSION_JSON', 'w') as f:
    json.dump(d, f, indent=2, ensure_ascii=False)
    f.write('\n')
PYEOF
  ok "package.json + version.json aktualisiert"
fi

# ── 2. Build ──────────────────────────────────────────────────────────────────
if ! $DRY_RUN; then
  info "Build: npm run dist"
  cd "$ROOT"
  npm run dist
  ok "Build abgeschlossen"
  cd - > /dev/null
else
  warn "Dry-Run: Build übersprungen"
fi

# ── 3. Nextcloud Upload ───────────────────────────────────────────────────────
DMG_FILE="$RELEASE_DIR/Claude MC-${NEW_VERSION}-arm64.dmg"
ZIP_FILE="$RELEASE_DIR/Claude MC-${NEW_VERSION}-arm64-mac.zip"

if ! $DRY_RUN; then
  for FILE in "$DMG_FILE" "$ZIP_FILE"; do
    [[ -f "$FILE" ]] || err "Build-Datei nicht gefunden: $FILE"
  done

  info "Upload DMG..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "${SHARE_TOKEN}:" \
    -T "$DMG_FILE" \
    "${NEXTCLOUD_BASE}/Claude%20MC-${NEW_VERSION}-arm64.dmg")
  [[ "$STATUS" =~ ^20 ]] && ok "DMG hochgeladen (HTTP $STATUS)" || err "DMG Upload fehlgeschlagen (HTTP $STATUS)"

  info "Upload ZIP..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "${SHARE_TOKEN}:" \
    -T "$ZIP_FILE" \
    "${NEXTCLOUD_BASE}/Claude%20MC-${NEW_VERSION}-arm64-mac.zip")
  [[ "$STATUS" =~ ^20 ]] && ok "ZIP hochgeladen (HTTP $STATUS)" || err "ZIP Upload fehlgeschlagen (HTTP $STATUS)"

  info "Upload version.json..."
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -u "${SHARE_TOKEN}:" \
    -T "$VERSION_JSON" \
    "${NEXTCLOUD_BASE}/version.json")
  [[ "$STATUS" =~ ^20 ]] && ok "version.json hochgeladen (HTTP $STATUS)" || err "version.json Upload fehlgeschlagen (HTTP $STATUS)"
else
  warn "Dry-Run: Upload übersprungen"
  warn "  Würde hochladen: $DMG_FILE"
  warn "  Würde hochladen: $ZIP_FILE"
  warn "  Würde hochladen: $VERSION_JSON"
fi

# ── 4. Git Commit ─────────────────────────────────────────────────────────────
if ! $DRY_RUN; then
  info "Git commit v$NEW_VERSION"
  cd "$ROOT"
  git add package.json release/version.json CLAUDE.md 2>/dev/null || true
  git add -A 2>/dev/null || true
  git commit -m "$(cat <<EOF
release: v$NEW_VERSION

$RELEASE_NOTES

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
  )"

  if ! $NO_PUSH; then
    info "Git push..."
    git push
    ok "Git push abgeschlossen"
  else
    warn "No-Push: kein git push"
  fi
  cd - > /dev/null
  ok "Git commit abgeschlossen"
else
  warn "Dry-Run: Git übersprungen"
fi

# ── Fertig ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}✓ Release v$NEW_VERSION abgeschlossen!${RESET}"
echo -e "  DMG: ${NEXTCLOUD_BASE}/Claude%20MC-${NEW_VERSION}-arm64.dmg"
