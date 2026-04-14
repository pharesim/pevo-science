#!/usr/bin/env bash
# Fetches the JetBrains/swot academic domain database and generates
# a JSON file for use by the email validator at runtime.
#
# Usage: ./scripts/update-academic-domains.sh
# Output: data/academic-domains.json

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

REPO_URL="https://github.com/JetBrains/swot.git"

echo "Cloning swot repository (shallow)..."
git clone --depth 1 --filter=blob:none --sparse "$REPO_URL" "$TMP_DIR/swot" 2>/dev/null
cd "$TMP_DIR/swot"
git sparse-checkout set lib/domains 2>/dev/null

DOMAINS_DIR="$TMP_DIR/swot/lib/domains"

if [ ! -d "$DOMAINS_DIR" ]; then
  echo "ERROR: domains directory not found" >&2
  exit 1
fi

echo "Extracting domains..."

mkdir -p "$DATA_DIR"

# Use node to walk the directory tree and build the JSON
node -e "
const fs = require('fs');
const path = require('path');

const domainsDir = process.argv[1];
const domains = new Set();
const tlds = [];

// Read abused domains to exclude
const abusedFile = path.join(domainsDir, 'abused.txt');
const abused = new Set();
if (fs.existsSync(abusedFile)) {
  for (const line of fs.readFileSync(abusedFile, 'utf8').split('\n')) {
    const d = line.trim().toLowerCase();
    if (d && !d.startsWith('#')) abused.add(d);
  }
}

// Read TLD patterns
const tldsFile = path.join(domainsDir, 'tlds.txt');
if (fs.existsSync(tldsFile)) {
  for (const line of fs.readFileSync(tldsFile, 'utf8').split('\n')) {
    const d = line.trim().toLowerCase();
    if (d && !d.startsWith('#')) tlds.push(d);
  }
}

// Walk directory tree to extract domains
// Path lib/domains/de/uni-freiburg.txt -> uni-freiburg.de
function walk(dir, parts) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'abused.txt' || entry.name === 'tlds.txt') continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, [entry.name, ...parts]);
    } else if (entry.name.endsWith('.txt')) {
      const name = entry.name.slice(0, -4); // remove .txt
      const domain = [name, ...parts].join('.');
      if (!abused.has(domain)) {
        domains.add(domain);
      }
    }
  }
}

walk(domainsDir, []);

const result = {
  _generated: new Date().toISOString(),
  _source: 'https://github.com/JetBrains/swot',
  tlds: tlds.sort(),
  domains: [...domains].sort(),
};

const outPath = path.join(process.argv[2], 'academic-domains.json');
fs.writeFileSync(outPath, JSON.stringify(result, null, 0));
const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
console.log('Wrote ' + result.domains.length + ' domains + ' + result.tlds.length + ' TLD patterns (' + sizeKB + ' KB)');
" "$DOMAINS_DIR" "$DATA_DIR"

echo "Done: data/academic-domains.json"
