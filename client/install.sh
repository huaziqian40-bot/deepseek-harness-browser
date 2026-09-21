#!/usr/bin/env bash
# dsh-tool-browser — Shared Browser (Multi-Tab) one-command installer.
#
# Usage (single command):
#   curl -sL https://<BASE>/plugin/install.sh | bash -s https://<BASE>
#
# What it does:
#   1. locates your dsh harness "web" profile (~/.dsh/profiles/web by default)
#   2. downloads and extracts the plugin into <profile>/plugins/dsh-tool-browser/
#   3. patches cordis.patch.yml to insert the "browser-share" plugin
#      (handles the default empty "[]" patch file by rewriting it, since
#      appending a block sequence after a flow document is invalid YAML)
#   4. restarts the dsh-web service when a systemd unit exists
# Environment:
#   DSH_HOME   harness home (defaults to $HOME/.dsh)
#   DSH_PATCH  optional: the patch file to edit (defaults to <profile>/cordis.patch.yml)
set -euo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: curl -sL <BASE>/plugin/install.sh | bash -s <BASE>" >&2
  exit 1
fi
BASE="${BASE%/}"
echo "== dsh-tool-browser installer =="
echo "source: $BASE"

# GitHub Releases as source: <repo>/releases/latest/download/dsh-tool-browser.zip
# Any other base: <base>/plugin/download (a running harness's distribution endpoint)
case "$BASE" in
  *github.com*) ZIP_URL="$BASE/dsh-tool-browser.zip" ;;
  *) ZIP_URL="$BASE/plugin/download" ;;
esac

DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
if [ ! -d "$DSH_HOME" ]; then
  echo "error: harness home not found: $DSH_HOME (set DSH_HOME if yours differs)" >&2
  exit 1
fi

PROFILE=""
for cand in "$DSH_HOME/profiles/web" "$DSH_HOME/profiles"/*; do
  if [ -f "$cand/cordis.yml" ] || [ -f "$cand/cordis.patch.yml" ]; then
    PROFILE="$cand"
    break
  fi
done
if [ -z "$PROFILE" ]; then
  echo "error: no dsh 'web' profile found under $DSH_HOME/profiles (looked for cordis.yml)" >&2
  exit 1
fi
echo "profile: $PROFILE"

PLUGINS="$PROFILE/plugins"
mkdir -p "$PLUGINS"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== downloading plugin zip =="
curl -fsSL "$ZIP_URL" -o "$TMP/dsh-tool-browser.zip" \
  || { echo "error: download failed: $ZIP_URL" >&2; exit 1; }

echo "== extracting to $PLUGINS/dsh-tool-browser =="
rm -rf "$PLUGINS/dsh-tool-browser"
mkdir -p "$PLUGINS"
if command -v unzip >/dev/null 2>&1; then
  unzip -oq "$TMP/dsh-tool-browser.zip" -d "$PLUGINS"
elif command -v python3 >/dev/null 2>&1; then
  python3 -c "import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])" "$TMP/dsh-tool-browser.zip" "$PLUGINS"
else
  echo "error: need 'unzip' or 'python3' to extract" >&2
  exit 1
fi
chmod -R u+rwX "$PLUGINS/dsh-tool-browser"
if [ ! -f "$PLUGINS/dsh-tool-browser/manifest.json" ]; then
  echo "error: extracted plugin is missing manifest.json" >&2
  exit 1
fi
echo "installed files: $(find "$PLUGINS/dsh-tool-browser" -type f | wc -l)"

PATCH="${DSH_PATCH:-$PROFILE/cordis.patch.yml}"
INSERT_BLOCK='- insert:
    - id: browser-share
      name: ./plugins/dsh-tool-browser/lib/index.js'

# Strip comments/blank lines to find the "real" content of the patch file.
stripped="$(sed -e 's/#.*//' -e 's/[[:space:]]*$//' "$PATCH" 2>/dev/null | sed '/^[[:space:]]*$/d' | tr -d '[:space:]' || true)"
backup_patch() { cp -f "$PATCH" "$PATCH.bak-$(date +%s)" 2>/dev/null || true; }

if [ -z "$stripped" ] || [ "$stripped" = "[]" ] || [ "$stripped" = "{}" ] || [ "${stripped#"[]"}" != "$stripped" ] || [ "${stripped#"{}"}" != "$stripped" ]; then
  # Empty/default patch ("[]") or a file a previous installer run already
  # broke by appending after a flow document. Both are structurally invalid
  # to append to, so rewrite the whole file as a proper patch list.
  echo "== rewriting $PATCH (flow-doc or empty content) =="
  backup_patch
  printf '# dsh-tool-browser (Shared Browser) — installed by installer\n%s\n' "$INSERT_BLOCK" > "$PATCH"
elif grep -q "browser-share" "$PATCH" 2>/dev/null; then
  echo "== browser-share already in $PATCH, skipping patch =="
else
  # Existing real (block-style) patch entries: append as a new entry.
  echo "== appending browser-share to $PATCH =="
  backup_patch
  { printf '\n'; printf '%s\n' "$INSERT_BLOCK"; } >> "$PATCH"
fi

echo "== restarting dsh-web if present =="
if systemctl list-unit-files 2>/dev/null | grep -qE "^dsh-web"; then
  systemctl restart dsh-web && echo "dsh-web restarted"
else
  echo "no dsh-web systemd unit found — restart your harness web process"
  echo "manually (e.g. stop and re-run 'dsh web ...') to load the plugin."
fi

echo ""
echo "== done =="
echo "Open the shared-browser panel from your harness GUI, or visit:"
echo "  <your-harness-origin>/publish      (e.g. http://127.0.0.1:3080/publish)"
echo "The token printed by your harness unlocks the shared browser."