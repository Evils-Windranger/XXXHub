#!/usr/bin/env node
// Pure-shell boundary guard: verifies no site-specific domain, decrypt key,
// site SSR selector, hardcoded external source, or site edge protocol leaks into the shell.

import fs from "node:fs";
import path from "node:path";

const SCAN_DIRS = [
  "src",
  "src-tauri/src",
  "src-tauri/tv",
  "src-tauri/capabilities",
  "src-tauri/icons",
  "tests",
  "scripts",
  "examples",
  ".github",
];

const SCAN_FILES = [
  "index.html",
  "package.json",
  "vite.config.ts",
  "Makefile",
  "tsconfig.json",
  "tsconfig.node.json",
  "tsconfig.tests.json",
  "pnpm-workspace.yaml",
  "README.md",
  "tools/size-budgets.json",
  "src-tauri/Cargo.toml",
  "src-tauri/build.rs",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.tv.conf.json",
  "src-tauri/tauri.ios.conf.json",
  "src-tauri/tauri.linux.conf.json",
  "src-tauri/tauri.macos.conf.json",
  "src-tauri/Info.ios.plist",
];

const SKIP_DIRS = new Set(["target", "gen", "node_modules", "dist", ".git"]);
const SKIP_FILES = new Set(["scripts/check-shell-purity.mjs"]);

const EXTENSIONS = new Set([
  ".rs",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".json",
  ".toml",
  ".html",
  ".xml",
  ".kt",
  ".swift",
  ".plist",
  ".sh",
  ".py",
  ".list",
  ".md",
  ".yml",
  ".yaml",
  ".svg",
]);

const FORBIDDEN = [
  { label: "site domain", re: /huangguo/i },
  { label: "site CDN/mirror domain", re: /drleao\.cn|hzjvlo\.cn|xxbgwypx\.cc/i },
  { label: "site publish/worker domain", re: /pages\.dev|workers\.dev/i },
  { label: "hardcoded external source", re: /hghg-src|\bhghg\b|\bhg\.json\b/i },
  { label: "hardcoded CDN registry", re: /jsdelivr\.net|unpkg\.com/i },
  { label: "hardcoded cover key", re: /f5d965df75336270/i },
  { label: "hardcoded cover iv", re: /97b60394abc2fbe1/i },
  {
    label: "unicode-escaped site brand",
    re: /\\(?:u\{0*9ec4\}|u9ec4|U0*9ec4)\\(?:u\{0*679c\}|u679c|U0*679c)/i,
  },
  { label: "site brand/taxonomy copy", re: /黄果|吃瓜|AI成人短剧|AI成人漫剧/ },
  { label: "site channel slug", re: /ai-duanju|ai-manju|remen-chigua/i },
  { label: "site edge protocol", re: /dx150-edge-v1|\bdx150\b/i },
  {
    label: "site edge endpoint or header",
    re: /\/api\/(?:edge|public|dynamic|playback|user)\/request|X-HG-Public-JSON/i,
  },
  {
    label: "site SSR selector",
    re: /hg-home-popular-tags|hg-search-hot|hg-channel-page|hg-list-page|hg-card-grid|hg-drama-card|hg-page-header__extra|hg-tagrow__item/i,
  },
  {
    label: "site publish script or route",
    re: /\bpublish\.js\b|\/blog\/gossip|\/ranks\/hot/i,
  },
  {
    label: "site fixture/helper residue",
    re: /via=hgdj|healthy_proxy_response/i,
  },
];

const violations = [];
let scannedFiles = 0;

function toPosix(p) {
  return p.split(path.sep).join("/");
}

function decodeUnicodeEscapes(text) {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (match, hex) => {
      const cp = Number.parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/\\U([0-9a-fA-F]{8})/g, (match, hex) => {
      const cp = Number.parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/\\u([0-9a-fA-F]{4})/g, (match, hex) => {
      const cp = Number.parseInt(hex, 16);
      return cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    })
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const JS_TS_EXTS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const JSX_EXTS = new Set([".tsx", ".jsx"]);
const C_COMMENT_EXTS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".rs",
  ".css",
  ".kt",
  ".swift",
  ".json",
  ".md",
]);
const PROSE_MARKUP_EXTS = new Set([".md", ".html", ".xml", ".plist", ".svg"]);
const HTML_MARKUP_EXTS = new Set([".html", ".xml", ".svg", ".plist"]);
const URL_SCHEMES = new Set([
  "http",
  "https",
  "ws",
  "wss",
  "ftp",
  "file",
  "hg",
  "hghub",
  "hghubx",
  "hghubx-src",
  "tauri",
  "asset",
]);
const REGEX_PREFIX_KEYWORDS = new Set([
  "return",
  "case",
  "throw",
  "typeof",
  "void",
  "delete",
  "in",
  "of",
  "await",
  "yield",
  "else",
  "do",
  "new",
  "export",
  "default",
  "instanceof",
  "extends",
  "break",
  "continue",
  "debugger",
]);
const COND_KEYWORDS = new Set(["if", "while", "for", "with"]);

function isRustCharLiteralStart(text, i) {
  if (i + 2 >= text.length) return false;
  if (text[i + 1] === "\\") {
    let j = i + 2;
    if (j >= text.length || text[j] === "\r" || text[j] === "\n") return false;
    j += 1;
    while (j < text.length && j - i <= 12) {
      if (text[j] === "'") return true;
      if (text[j] === "\r" || text[j] === "\n" || text[j] === " ") return false;
      j += 1;
    }
    return false;
  }
  return text[i + 1] !== "'" && text[i + 1] !== "\r" && text[i + 1] !== "\n" && text[i + 2] === "'";
}

function hasClosingQuoteOnLine(text, i, quoteChar) {
  for (let j = i + 1; j < text.length; j += 1) {
    const ch = text[j];
    if (ch === "\\") {
      if (j + 1 < text.length && text[j + 1] === "\r" && text[j + 2] === "\n") {
        j += 2;
      } else {
        j += 1;
      }
      continue;
    }
    if (ch === "\r" || ch === "\n") return false;
    if (ch === quoteChar) return true;
  }
  return false;
}

function findRegexLiteralEnd(text, start) {
  const n = text.length;
  let inClass = false;
  let j = start + 1;
  while (j < n) {
    const c = text[j];
    if (c === "\r" || c === "\n") return -1;
    if (c === "\\") {
      if (j + 1 >= n || text[j + 1] === "\r" || text[j + 1] === "\n") return -1;
      j += 2;
      continue;
    }
    if (c === "[") {
      inClass = true;
      j += 1;
      continue;
    }
    if (c === "]" && inClass) {
      inClass = false;
      j += 1;
      continue;
    }
    if (c === "/" && !inClass) {
      j += 1;
      while (j < n && /[A-Za-z]/.test(text[j])) j += 1;
      return j;
    }
    j += 1;
  }
  return -1;
}

function isPrecededByUrlScheme(text, slashIdx) {
  if (slashIdx < 2 || text[slashIdx - 1] !== ":") return false;
  let k = slashIdx - 2;
  while (k >= 0 && /[A-Za-z0-9+.-]/.test(text[k])) k -= 1;
  const schemeStart = k + 1;
  if (schemeStart >= slashIdx - 1) return false;
  const scheme = text.slice(schemeStart, slashIdx - 1).toLowerCase();
  if (!URL_SCHEMES.has(scheme)) return false;
  if (schemeStart > 0 && /[{?,A-Za-z0-9_$.]/.test(text[schemeStart - 1])) return false;
  return true;
}

function stripCommentsOutsideStrings(text, ext = "") {
  const n = text.length;
  const isRust = ext === ".rs";
  const isJsTs = JS_TS_EXTS.has(ext);
  const isJsx = JSX_EXTS.has(ext);
  const isPy = ext === ".py";
  const isMd = ext === ".md";
  const isMarkupXml = HTML_MARKUP_EXTS.has(ext);
  const isProseOrMarkup = PROSE_MARKUP_EXTS.has(ext);
  const requireSameLineSingleQuote = isJsTs || isProseOrMarkup || ext === ".toml";
  const requireSameLineDoubleQuote = isJsTs || isProseOrMarkup;

  let out = "";
  let i = 0;
  let mode = "code";
  const templateBraceDepths = [];

  // JS/TS lexer state for regex-literal vs division disambiguation
  let canStartRegex = true;
  let prevWasDot = false;
  let prevKeywordWasCond = false;
  const parenIsCondStack = [];

  // HTML/XML state so prose text like <p>27" screen</p> never eats <script>
  let htmlContext = isMarkupXml ? "text" : "none";
  let currentTagName = "";
  let tagClosing = false;

  while (i < n) {
    const isJsActive = isJsTs || htmlContext === "script";
    const allowCComments = C_COMMENT_EXTS.has(ext) || htmlContext === "script" || htmlContext === "style";

    if (mode === "template") {
      const ch = text[i];
      if (ch === "\\") {
        out += i + 1 < n ? text.slice(i, i + 2) : ch;
        i += i + 1 < n ? 2 : 1;
        continue;
      }
      if (ch === "`") {
        out += ch;
        i += 1;
        mode = "code";
        canStartRegex = false;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        out += "${";
        i += 2;
        templateBraceDepths.push(1);
        mode = "code";
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    const ch = text[i];

    // HTML/XML closing </script> / </style> transitions
    if (isMarkupXml && (htmlContext === "script" || htmlContext === "style") && ch === "<") {
      const closeRe = htmlContext === "script" ? /^<\/script\s*>/i : /^<\/style\s*>/i;
      const m = closeRe.exec(text.slice(i, i + 20));
      if (m) {
        out += m[0];
        i += m[0].length;
        htmlContext = "text";
        continue;
      }
    }

    // HTML/XML/Markdown <!-- ... --> comments outside strings
    if ((isMd || (isMarkupXml && (htmlContext === "text" || htmlContext === "tag"))) && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }

    // HTML/XML tag open/close tracking outside <script>/<style>
    if (isMarkupXml && htmlContext === "text" && ch === "<" && /[A-Za-z!/]/.test(text[i + 1] || "")) {
      htmlContext = "tag";
      tagClosing = text[i + 1] === "/";
      const m = /^<\/?([A-Za-z][A-Za-z0-9:-]*)/.exec(text.slice(i, i + 40));
      currentTagName = m ? m[1].toLowerCase() : "";
      out += ch;
      i += 1;
      continue;
    }

    if (isMarkupXml && htmlContext === "tag" && ch === ">") {
      const selfClosing = i > 0 && text[i - 1] === "/";
      out += ch;
      i += 1;
      if (!tagClosing && !selfClosing && currentTagName === "script") {
        htmlContext = "script";
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
        parenIsCondStack.length = 0;
      } else if (!tagClosing && !selfClosing && currentTagName === "style") {
        htmlContext = "style";
      } else {
        htmlContext = "text";
      }
      currentTagName = "";
      tagClosing = false;
      continue;
    }

    // Rust raw strings r#"..."#, br#"..."#, cr#"..."#
    if (isRust && (i === 0 || !/[A-Za-z0-9_$]/.test(text[i - 1]))) {
      let k = i;
      if ((text[k] === "b" || text[k] === "c") && text[k + 1] === "r") k += 1;
      if (text[k] === "r") {
        let h = k + 1;
        while (h < n && text[h] === "#") h += 1;
        if (h < n && text[h] === '"') {
          const hashes = h - (k + 1);
          out += text.slice(i, h + 1);
          i = h + 1;
          while (i < n) {
            if (text[i] === '"') {
              let m = 0;
              while (m < hashes && i + 1 + m < n && text[i + 1 + m] === "#") m += 1;
              if (m === hashes) {
                out += text.slice(i, i + 1 + hashes);
                i += 1 + hashes;
                break;
              }
            }
            out += text[i];
            i += 1;
          }
          continue;
        }
      }
    }

    // Double-quoted strings
    if (ch === '"') {
      let openDouble = true;
      if (isMarkupXml && htmlContext === "text") {
        openDouble = false;
      } else if (isMarkupXml && htmlContext === "tag") {
        openDouble =
          (i === 0 || /[=\s]/.test(text[i - 1])) && hasClosingQuoteOnLine(text, i, '"');
      } else {
        if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) {
          const isRustPrefix =
            isRust && (text[i - 1] === "b" || text[i - 1] === "c") && (i === 1 || !/[A-Za-z0-9_$]/.test(text[i - 2]));
          const isPyPrefix =
            isPy &&
            ((/[bfrcu]/i.test(text[i - 1]) && (i === 1 || !/[A-Za-z0-9_]/.test(text[i - 2]))) ||
              (i >= 2 &&
                /(?:rb|br|fr|rf)/i.test(text.slice(i - 2, i)) &&
                (i === 2 || !/[A-Za-z0-9_]/.test(text[i - 3]))));
          if ((isJsActive || isProseOrMarkup || isPy || isRust) && !isRustPrefix && !isPyPrefix) {
            openDouble = false;
          }
        }
        if (openDouble && (requireSameLineDoubleQuote || htmlContext === "script") && !hasClosingQuoteOnLine(text, i, '"')) {
          openDouble = false;
        }
      }

      out += ch;
      i += 1;
      if (openDouble) {
        while (i < n) {
          const sc = text[i];
          if (sc === "\\") {
            out += i + 1 < n ? text.slice(i, i + 2) : sc;
            i += i + 1 < n ? 2 : 1;
            continue;
          }
          out += sc;
          i += 1;
          if (sc === '"') break;
        }
        if (isJsActive) {
          canStartRegex = false;
          prevWasDot = false;
          prevKeywordWasCond = false;
        }
      }
      continue;
    }

    // Single-quoted strings / Rust char literals / prose apostrophes
    if (ch === "'") {
      let openSingle = true;
      if (isRust) {
        openSingle = isRustCharLiteralStart(text, i);
      } else if (isMarkupXml && htmlContext === "text") {
        openSingle = false;
      } else if (isMarkupXml && htmlContext === "tag") {
        openSingle =
          (i === 0 || /[=\s]/.test(text[i - 1])) && hasClosingQuoteOnLine(text, i, "'");
      } else {
        if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) {
          const isOneCharPrefix =
            isPy && /[bfrcu]/i.test(text[i - 1]) && (i === 1 || !/[A-Za-z0-9_]/.test(text[i - 2]));
          const isTwoCharPrefix =
            isPy &&
            i >= 2 &&
            /(?:rb|br|fr|rf)/i.test(text.slice(i - 2, i)) &&
            (i === 2 || !/[A-Za-z0-9_]/.test(text[i - 3]));
          if (!isOneCharPrefix && !isTwoCharPrefix) openSingle = false;
        }
        if (openSingle && (requireSameLineSingleQuote || htmlContext === "script") && !hasClosingQuoteOnLine(text, i, "'")) {
          openSingle = false;
        }
      }

      out += ch;
      i += 1;
      if (openSingle) {
        while (i < n) {
          const sc = text[i];
          if (sc === "\\") {
            out += i + 1 < n ? text.slice(i, i + 2) : sc;
            i += i + 1 < n ? 2 : 1;
            continue;
          }
          out += sc;
          i += 1;
          if (sc === "'") break;
        }
        if (isJsActive) {
          canStartRegex = false;
          prevWasDot = false;
          prevKeywordWasCond = false;
        }
      }
      continue;
    }

    // Backtick template literals (not in Markdown prose/fenced code blocks or HTML text)
    if (ch === "`" && !isMd && !(isMarkupXml && htmlContext === "text")) {
      out += ch;
      i += 1;
      mode = "template";
      continue;
    }

    // Block comments /* ... */ (nested in Rust; only in C-comment languages and HTML <script>/<style>)
    if (allowCComments && ch === "/" && text[i + 1] === "*") {
      i += 2;
      if (isRust) {
        let depth = 1;
        while (i < n && depth > 0) {
          if (text[i] === "/" && text[i + 1] === "*") {
            depth += 1;
            i += 2;
          } else if (text[i] === "*" && text[i + 1] === "/") {
            depth -= 1;
            i += 2;
          } else {
            i += 1;
          }
        }
      } else {
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
        if (i < n) i += 2;
      }
      continue;
    }

    // Line comments // ... (strip unconditionally in JS/TS/Rust; preserve valid URL schemes in other C-comment files)
    if (
      allowCComments &&
      ch === "/" &&
      text[i + 1] === "/" &&
      (isJsActive || isRust || !isPrecededByUrlScheme(text, i))
    ) {
      i += 2;
      while (i < n && text[i] !== "\r" && text[i] !== "\n") i += 1;
      continue;
    }

    // JS/TS regex literals /pattern/flags
    if (isJsActive && ch === "/" && canStartRegex) {
      const isJsxTagSlash = isJsx && (text[i + 1] === ">" || (i > 0 && text[i - 1] === "<"));
      if (!isJsxTagSlash) {
        const regexEnd = findRegexLiteralEnd(text, i);
        if (regexEnd > i) {
          out += text.slice(i, regexEnd);
          i = regexEnd;
          canStartRegex = false;
          prevWasDot = false;
          prevKeywordWasCond = false;
          continue;
        }
      }
    }

    if (templateBraceDepths.length > 0) {
      if (ch === "{") {
        templateBraceDepths[templateBraceDepths.length - 1] += 1;
      } else if (ch === "}") {
        templateBraceDepths[templateBraceDepths.length - 1] -= 1;
        if (templateBraceDepths[templateBraceDepths.length - 1] === 0) {
          templateBraceDepths.pop();
          out += ch;
          i += 1;
          mode = "template";
          canStartRegex = false;
          prevWasDot = false;
          prevKeywordWasCond = false;
          continue;
        }
      }
    }

    // Update JS/TS token context for regex vs division
    if (isJsActive) {
      if (/\s/.test(ch)) {
        out += ch;
        i += 1;
        continue;
      }
      if (/[A-Za-z_$]/.test(ch)) {
        let j = i + 1;
        while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
        const word = text.slice(i, j);
        out += word;
        i = j;
        if (!prevWasDot) {
          canStartRegex = REGEX_PREFIX_KEYWORDS.has(word);
          prevKeywordWasCond = COND_KEYWORDS.has(word);
        } else {
          canStartRegex = false;
          prevKeywordWasCond = false;
        }
        prevWasDot = false;
        continue;
      }
      if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] || ""))) {
        let j = i + 1;
        while (j < n && /[0-9A-Za-z_.]/.test(text[j])) {
          if ((text[j] === "e" || text[j] === "E") && (text[j + 1] === "+" || text[j + 1] === "-")) {
            j += 2;
            continue;
          }
          j += 1;
        }
        out += text.slice(i, j);
        i = j;
        canStartRegex = false;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      if ((ch === "+" && text[i + 1] === "+") || (ch === "-" && text[i + 1] === "-")) {
        out += text.slice(i, i + 2);
        i += 2;
        canStartRegex = false;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === "=" && text[i + 1] === ">") {
        out += "=>";
        i += 2;
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === "?" && text[i + 1] === "." && !/[0-9]/.test(text[i + 2] || "")) {
        out += "?.";
        i += 2;
        canStartRegex = false;
        prevWasDot = true;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === "." && text[i + 1] === "." && text[i + 2] === ".") {
        out += "...";
        i += 3;
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === ".") {
        out += ".";
        i += 1;
        canStartRegex = false;
        prevWasDot = true;
        prevKeywordWasCond = false;
        continue;
      }
      if (ch === "(") {
        parenIsCondStack.push(prevKeywordWasCond);
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
      } else if (ch === ")") {
        canStartRegex = parenIsCondStack.length ? parenIsCondStack.pop() : false;
        prevWasDot = false;
        prevKeywordWasCond = false;
      } else if (ch === "]") {
        canStartRegex = false;
        prevWasDot = false;
        prevKeywordWasCond = false;
      } else {
        canStartRegex = true;
        prevWasDot = false;
        prevKeywordWasCond = false;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function collapseLiterals(text) {
  let s = text
    .replace(/\\\r?\n/g, "")
    .replace(/\\(?:r|n|t)/g, "");
  let prev;
  do {
    prev = s;
    s = s
      .replace(/(?<![A-Za-z0-9_$])\(\s*(["'`])([^"'`\r\n]*?)\1\s*\)/g, "$1$2$1")
      .replace(/["'`]\s*\+\s*["'`]/g, "")
      .replace(/["'`]\s*\.\s*concat\s*\(\s*["'`]/g, "")
      .replace(/(?<=\S)["']["'](?=\S)/g, "")
      .replace(/\$\{\s*["'`]/g, "")
      .replace(/["'`]\s*\}/g, "")
      .replace(/concat!\s*\(/gi, "")
      .replace(/(?:[bc]?["'`]|"#*)\s*,\s*(?:[bc]?r#*"|[bc]?["'`])/g, "");
  } while (s !== prev);
  return s;
}

function normalizeForScan(text, ext = "") {
  return collapseLiterals(stripCommentsOutsideStrings(text, ext));
}

function scanFile(filePath) {
  const rel = toPosix(filePath);
  if (SKIP_FILES.has(rel)) return;
  const raw = fs.readFileSync(filePath, "utf8");
  if (raw.includes("\0")) return;
  scannedFiles += 1;

  const ext = path.extname(filePath).toLowerCase();
  const decoded = decodeUnicodeEscapes(raw);
  const matchedOnLine = new Set();
  const rawLines = raw.split(/\r?\n/);
  const decodedLines = decoded === raw ? rawLines : decoded.split(/\r?\n/);

  rawLines.forEach((line, idx) => {
    const decLine = decodedLines[idx] ?? "";
    for (const rule of FORBIDDEN) {
      if (rule.re.test(line) || (decLine !== line && rule.re.test(decLine))) {
        matchedOnLine.add(rule.label);
        violations.push(`${rel}:${idx + 1}: [${rule.label}] ${line.trim()}`);
      }
    }
  });

  const rawCollapsed = collapseLiterals(raw);
  const decCollapsed = decoded === raw ? rawCollapsed : collapseLiterals(decoded);
  const postCollapseDec = decodeUnicodeEscapes(rawCollapsed);

  const normRaw = normalizeForScan(raw, ext);
  const normDec = decoded === raw ? normRaw : normalizeForScan(decoded, ext);
  const postNormDec = decodeUnicodeEscapes(normRaw);

  const candidateTexts = new Set([
    raw,
    rawCollapsed,
    decCollapsed,
    postCollapseDec,
    normRaw,
    normDec,
    postNormDec,
  ]);
  const candidates = [];
  for (const text of candidateTexts) {
    candidates.push(text.replace(/\s+/g, " "), text.replace(/\r?\n/g, ""));
  }

  for (const rule of FORBIDDEN) {
    if (!matchedOnLine.has(rule.label) && candidates.some((c) => rule.re.test(c))) {
      violations.push(`${rel}:multiline: [${rule.label}] matched across lines, escapes, or concatenated literals`);
    }
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      scanFile(full);
    }
  }
}

for (const dir of SCAN_DIRS) {
  if (fs.existsSync(dir)) walk(dir);
}
for (const file of SCAN_FILES) {
  if (fs.existsSync(file)) scanFile(file);
}

if (violations.length) {
  console.error(`purity: FAILED (${violations.length} site-specific reference(s) found):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log(`purity: ok 0 site-specific references across ${scannedFiles} files`);
