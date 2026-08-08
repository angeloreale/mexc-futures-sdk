#!/usr/bin/env node
/**
 * Regenerate SHA512 checksums and sizes in all latest*.yml files from the
 * actual binary artifacts on disk. Use this when the yml files got out of
 * sync with the installers (e.g. after a cross-platform rebuild).
 *
 * Usage: node scripts/fix-release-checksums.js [release-dir]
 * Defaults to ./release.
 *
 * After running this, verify with: node scripts/verify-release.js
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

const yamlFiles = fs
  .readdirSync(dir)
  .filter((f) => /^latest.*\.yml$/.test(f))
  .sort();

if (yamlFiles.length === 0) {
  console.error(`❌ No latest*.yml files found in ${dir}`);
  process.exit(2);
}

let fixed = 0;
let skipped = 0;
let missing = 0;

for (const meta of yamlFiles) {
  const metaPath = path.join(dir, meta);
  let text = fs.readFileSync(metaPath, "utf8");
  let changed = false;

  // Find the top-level path entry.
  const topPathMatch = text.match(/^path:\s*(.+)$/m);
  const topPath = topPathMatch ? topPathMatch[1].trim() : null;

  // Parse all file entries: `  - url:` blocks with `sha512:` and `size:`.
  const filePattern =
    /( {2}- url:\s*(.+)\n(?: {4}sha512:\s*(.+)\n)?(?: {4}size:\s*(\d+)\n)?(?: {4}blockMapSize:\s*(\d+)\n)?)/g;

  text = text.replace(filePattern, (match, fullLine, url, oldSha, oldSize, oldBlockMapSize) => {
    const artifact = path.join(dir, url.trim());
    if (!fs.existsSync(artifact)) {
      console.error(`⚠️  [${meta}] Missing artifact, skipping: ${url.trim()}`);
      missing++;
      return match; // keep original entry unchanged
    }

    const actualSha = sha512Base64(artifact);
    const actualSize = fs.statSync(artifact).size;

    // Check blockmap
    let actualBlockMapSize = null;
    const blockmapPath = artifact + ".blockmap";
    if (fs.existsSync(blockmapPath)) {
      actualBlockMapSize = fs.statSync(blockmapPath).size;
    }

    if (actualSha === (oldSha || "").trim() && String(actualSize) === (oldSize || "").trim()) {
      skipped++;
      return match;
    }

    fixed++;
    console.log(`🔧 [${meta}] ${url.trim()}`);

    let entry = `  - url: ${url.trim()}\n`;
    entry += `    sha512: ${actualSha}\n`;
    entry += `    size: ${actualSize}`;
    if (actualBlockMapSize !== null) {
      entry += `\n    blockMapSize: ${actualBlockMapSize}`;
    }
    entry += "\n";
    return entry;
  });

  // Fix the top-level path/sha512/size if they reference an artifact that
  // exists and whose checksum we just updated.
  if (topPath) {
    const topArtifact = path.join(dir, topPath);
    if (fs.existsSync(topArtifact)) {
      const actualSha = sha512Base64(topArtifact);
      const actualSize = fs.statSync(topArtifact).size;
      // Replace top-level sha512 line
      text = text.replace(/^sha512:\s*.+$/m, `sha512: ${actualSha}`);
      // Replace top-level size line if present
      if (/^size:\s*\d+$/m.test(text)) {
        text = text.replace(/^size:\s*\d+$/m, `size: ${actualSize}`);
      }
    }
  }

  if (changed || fixed > skipped) {
    fs.writeFileSync(metaPath, text, "utf8");
    console.log(`✅ [${meta}] written with ${fixed} fix(es)`);
  }
}

console.log(
  `\n📊 Summary: ${fixed} fixed, ${skipped} already correct, ${missing} missing artifacts`
);
if (missing > 0) {
  console.warn("⚠️  Missing artifacts were left unchanged in the yml files.");
}
if (fixed === 0 && missing === 0) {
  console.log("✅ All checksums already match the artifacts.");
}
