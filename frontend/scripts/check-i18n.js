#!/usr/bin/env node

/**
 * check-i18n.js — Validate that all locale files have the same keys as en.json.
 *
 * Reports missing and extra keys for each locale file.
 * Exits with code 1 if any missing keys are found.
 */

const fs = require("fs");
const path = require("path");

const MESSAGES_DIR = path.join(__dirname, "..", "messages");
const REFERENCE_FILE = "en.json";

function collectKeys(obj, prefix = "") {
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      keys.push(...collectKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

function main() {
  const refPath = path.join(MESSAGES_DIR, REFERENCE_FILE);
  if (!fs.existsSync(refPath)) {
    console.error(`Reference file not found: ${refPath}`);
    process.exit(1);
  }

  const refData = JSON.parse(fs.readFileSync(refPath, "utf-8"));
  const refKeys = new Set(collectKeys(refData));

  const files = fs.readdirSync(MESSAGES_DIR).filter(
    (f) => f.endsWith(".json") && f !== REFERENCE_FILE
  );

  let hasMissing = false;

  for (const file of files) {
    const filePath = path.join(MESSAGES_DIR, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      console.error(`Failed to parse ${file}: ${err.message}`);
      hasMissing = true;
      continue;
    }

    const localeKeys = new Set(collectKeys(data));

    const missing = [...refKeys].filter((k) => !localeKeys.has(k));
    const extra = [...localeKeys].filter((k) => !refKeys.has(k));

    if (missing.length > 0) {
      console.error(`\n${file}: ${missing.length} MISSING key(s):`);
      for (const k of missing) {
        console.error(`  - ${k}`);
      }
      hasMissing = true;
    }

    if (extra.length > 0) {
      console.warn(`\n${file}: ${extra.length} extra key(s):`);
      for (const k of extra) {
        console.warn(`  + ${k}`);
      }
    }

    if (missing.length === 0 && extra.length === 0) {
      console.log(`${file}: OK`);
    }
  }

  if (hasMissing) {
    console.error("\ni18n check FAILED: missing keys detected.");
    process.exit(1);
  }

  console.log("\ni18n check passed.");
}

main();
