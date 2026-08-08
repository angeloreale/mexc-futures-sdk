#!/usr/bin/env bash
#
# update-dist.sh — Pull the latest dist.zip from the main branch and
# atomically swap it into place. Exits 0 on success or when already current.
#
# Designed to run as an ExecStartPre in systemd so the bot always starts
# with the freshest code.
set -euo pipefail

OWNER="dupipcom"
REPO="iris"
BRANCH="main"
DIST_ZIP="dist.zip"
DIST_DIR="dist"
BACKUP_DIR=".dist-backup"
VERSION_FILE=".dist-version"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Fetch the latest commit SHA on the main branch ──
echo "🔍 Checking for latest code on ${OWNER}/${REPO}@${BRANCH}…"
LATEST_SHA=$(curl -fsS \
  -H "Accept: application/vnd.github+json" \
  -H "User-Agent: mexc-signal-bot-updater" \
  "https://api.github.com/repos/${OWNER}/${REPO}/commits/${BRANCH}" \
  | grep -m1 '"sha"' | cut -d'"' -f4)

if [ -z "${LATEST_SHA}" ]; then
  echo "⚠️  Could not determine latest commit SHA — skipping update."
  exit 0
fi

SHORT_SHA="${LATEST_SHA:0:7}"

# ── Check if we're already on this version ──
if [ -f "${VERSION_FILE}" ]; then
  CURRENT_SHA=$(cat "${VERSION_FILE}" 2>/dev/null || echo "")
  if [ "${CURRENT_SHA}" = "${SHORT_SHA}" ] && [ -f "${DIST_DIR}/bot/index.js" ]; then
    echo "✅ Already up to date (${SHORT_SHA})."
    exit 0
  fi
fi

# ── Download the latest dist.zip ──
echo "⬇️  Downloading ${DIST_ZIP} from ${OWNER}/${REPO}@${BRANCH} (${SHORT_SHA})…"
DOWNLOAD_URL="https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/${DIST_ZIP}"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "${TMP_DIR}"' EXIT

curl -fsSL -o "${TMP_DIR}/${DIST_ZIP}" "${DOWNLOAD_URL}"

# ── Verify the zip ──
if ! unzip -t "${TMP_DIR}/${DIST_ZIP}" >/dev/null 2>&1; then
  echo "❌ Downloaded ${DIST_ZIP} is corrupt."
  exit 1
fi

# Verify the expected structure
if ! unzip -l "${TMP_DIR}/${DIST_ZIP}" | grep -q 'dist/bot/index.js'; then
  echo "❌ Downloaded ${DIST_ZIP} is missing dist/bot/index.js — aborting."
  exit 1
fi

# ── Atomically swap ──
echo "🔄 Swapping ${DIST_DIR}…"
rm -rf "${BACKUP_DIR}"
if [ -d "${DIST_DIR}" ]; then
  mv "${DIST_DIR}" "${BACKUP_DIR}"
fi

unzip -qo "${TMP_DIR}/${DIST_ZIP}" -d .
rm -rf "${BACKUP_DIR}"

# ── Record version ──
echo "${SHORT_SHA}" > "${VERSION_FILE}"

echo "✅ Updated to ${SHORT_SHA}."
