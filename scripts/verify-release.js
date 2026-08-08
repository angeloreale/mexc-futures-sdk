#!/usr/bin/env node
/**
 * Verify that every release metadata file (latest*.yml) in the release output
 * matches the actual build artifacts on disk (sha512 + size).
 *
 * electron-updater trusts the checksums published in these yml files. If an
 * installer is rebuilt / re-signed after the yml was generated (or the two are
 * copied from different machines/builds), updates fail with:
 *   "App download failed: sha512 checksum mismatch, expected ..., got ..."
 *
 * Usage: node scripts/verify-release.js [release-dir]
 * Defaults to ./release. Exits non-zero if any artifact mismatches, so it can
 * be run as a pre-upload gate (e.g. before attaching assets to a GitHub release).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const dir = path.resolve(process.argv[2] || "release");
if (!fs.existsSync(dir)) {
  console.error(`❌ Release directory not found: ${dir}`);
  process.exit(2);
}

function sha512Base64(file) {
  return crypto
    .createHash("sha512")
    .update(fs.readFileSync(file))
    .digest("base64");
}

let failures = 0;
const metas = fs
  .readdirSync(dir)
  .filter((f) => /^latest.*\.yml$/.test(f))
  .sort();

if (metas.length === 0) {
  console.error(`❌ No latest*.yml metadata found in ${dir}`);
  process.exit(2);
}

for (const meta of metas) {
  const text = fs.readFileSync(path.join(dir, meta), "utf8");

  // Parse the `files:` entries: `- url:`, `sha512:`, `size:` blocks.
  const entries = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const url = line.match(/^\s*-\s+url:\s*(.+)$/);
    const sha = line.match(/^\s*sha512:\s*(.+)$/);
    const size = line.match(/^\s*size:\s*(\d+)$/);
    if (url) {
      cur = { url: url[1].trim() };
      entries.push(cur);
    } else if (sha && cur) {
      cur.sha512 = sha[1].trim();
    } else if (size && cur) {
      cur.size = Number(size[1]);
    }
  }

  for (const entry of entries) {
    const artifact = path.join(dir, entry.url);
    if (!fs.existsSync(artifact)) {
      console.error(`❌ [${meta}] missing artifact: ${entry.url}`);
      failures++;
      continue;
    }
    const actualHash = sha512Base64(artifact);
    const actualSize = fs.statSync(artifact).size;
    if (actualHash === entry.sha512 && actualSize === entry.size) {
      console.log(`✅ [${meta}] ${entry.url}`);
    } else {
      console.error(`❌ [${meta}] ${entry.url}`);
      if (actualHash !== entry.sha512) {
        console.error(`   sha512 expected: ${entry.sha512}`);
        console.error(`   sha512 actual:   ${actualHash}`);
      }
      if (actualSize !== entry.size) {
        console.error(`   size   expected: ${entry.size}`);
        console.error(`   size   actual:   ${actualSize}`);
      }
      failures++;
    }
  }
}

if (failures === 0) {
  console.log("\n✅ All release metadata matches the artifacts.");
  process.exit(0);
} else {
  console.error(
    `\n❌ ${failures} mismatch(es) — rebuild cleanly so the yml, installers and ` +
      `.blockmap files all come from the same run, then re-upload them together.`
  );
  process.exit(1);
}
