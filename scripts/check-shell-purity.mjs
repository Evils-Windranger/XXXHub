#!/usr/bin/env node
// Pure-shell boundary guard: verifies no site-specific domain, decrypt key,
// site CSS selector, or site-specific edge protocol leaks into `src/` or `src-tauri/src/`.

import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src", "src-tauri/src"];
const EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".js", ".mjs", ".css"]);
const FORBIDDEN = [
  { label: "site domain", re: /huangguo/i },
  { label: "hardcoded cover key", re: /f5d965df75336270/i },
  { label: "hardcoded cover iv", re: /97b60394abc2fbe1/i },
  { label: "site edge protocol", re: /dx150-edge-v1/i },
  { label: "site SSR selector", re: /hg-home-popular-tags|hg-search-hot/i },
  { label: "site publish page", re: /pages\.dev/i },
];

const violations = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((line, idx) => {
        for (const rule of FORBIDDEN) {
          if (rule.re.test(line)) {
            violations.push(`${full}:${idx + 1}: [${rule.label}] ${line.trim()}`);
          }
        }
      });
    }
  }
}

for (const root of ROOTS) {
  if (fs.existsSync(root)) walk(root);
}

if (violations.length) {
  console.error(`purity: FAILED (${violations.length} site-specific reference(s) leaked into shell):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("purity: ok 0 site-specific references in src/ and src-tauri/src/");
