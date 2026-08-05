#!/bin/bash
# Generate app icon PNG from SVG for Dupip Crypto Connector.
# Uses macOS Quick Look (qlmanage). For other platforms, install librsvg
# (`brew install librsvg` → `rsvg-convert`) or use an online converter.
set -e

SVG="desktop/renderer/icon.svg"
OUT="desktop/renderer/icon.png"

if command -v qlmanage &>/dev/null; then
  echo "🔧 macOS: using qlmanage..."
  qlmanage -t -s 512 -o desktop/renderer "$SVG"
  mv "${OUT%.png}.svg.png" "$OUT"
elif command -v rsvg-convert &>/dev/null; then
  echo "🔧 Linux/brew: using rsvg-convert..."
  rsvg-convert -w 512 -h 512 "$SVG" -o "$OUT"
else
  echo "❌ No SVG→PNG converter found."
  echo "   macOS: built-in (should always work)"
  echo "   Linux: brew install librsvg"
  echo "   Windows: use an online converter or install librsvg"
  exit 1
fi

echo "✅ App icon generated: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
