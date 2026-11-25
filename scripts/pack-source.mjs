#!/usr/bin/env node
// Pack and Ed25519-sign a HGhubX source plugin directory into:
//   1) single-file JSON (<id>-v<version>.json) for static/mirror URL hosting
//   2) Legado-style clipboard share code (hghubx-src://<gzip+base64url>)
//
// Usage:
//   node scripts/pack-source.mjs <source-dir> [--out-dir /tmp/out] [--print-code]
//   node scripts/pack-source.mjs <source-dir> [--key-file <pem>] [--key-id <id>] [--out-dir /tmp/out]

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DEFAULT_KEY_ID = "custom";

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function canonicalPayload(pkg) {
  const m = pkg.manifest;
  const net = m.network || {};
  const d = m.media?.imageDecrypt;
  const imgdec = d ? `${d.algorithm}:${d.key}:${d.iv}` : "";
  return Buffer.from(
    [
      "hghubx-source-v1",
      `id=${m.id}`,
      `version=${m.version}`,
      `api=${m.apiVersion}`,
      `runtime=${m.runtime.kind}`,
      `origins=${(net.origins || []).join(",")}`,
      `media=${(net.mediaOrigins || []).join(",")}`,
      `publish=${(net.publishOrigins || []).join(",")}`,
      `updates=${(pkg.updateUrls || []).join(",")}`,
      `imgdec=${imgdec}`,
      `code_sha256=${sha256Hex(pkg.code)}`,
      "",
    ].join("\n"),
    "utf8",
  );
}

function encodeShareCode(pkg) {
  const raw = Buffer.from(JSON.stringify(pkg), "utf8");
  const gz = zlib.gzipSync(raw, { level: zlib.constants.Z_BEST_COMPRESSION });
  return `hghubx-src://${gz.toString("base64url")}`;
}

function parseArgs(argv) {
  const args = { dir: "", outDir: "", keyFile: "", keyId: "", printCode: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--print-code") args.printCode = true;
    else if (a === "--out-dir") args.outDir = argv[++i] || "";
    else if (a === "--key-file") args.keyFile = argv[++i] || "";
    else if (a === "--key-id") args.keyId = argv[++i] || "";
    else if (!a.startsWith("-") && !args.dir) args.dir = a;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  console.error("Usage: node scripts/pack-source.mjs <source-dir> [--key-file <pem>] [--key-id <id>] [--out-dir <dir>] [--print-code]");
  process.exit(1);
}

const dir = path.resolve(args.dir);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
const entryFile = manifest.runtime?.entry && manifest.runtime.entry !== "inline" ? manifest.runtime.entry : "source.js";
const code = fs.readFileSync(path.join(dir, entryFile), "utf8");
const updateUrls = Array.isArray(manifest.updateUrls) ? manifest.updateUrls : [];
delete manifest.updateUrls;

const pkg = {
  schemaVersion: 1,
  manifest: {
    ...manifest,
    runtime: { kind: manifest.runtime?.kind || "quickjs", entry: "inline" },
  },
  code,
  updateUrls,
};

if (args.keyFile) {
  const privateKey = crypto.createPrivateKey(fs.readFileSync(args.keyFile, "utf8"));
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ type: "spki", format: "der" });
  const rawPub = spki.subarray(spki.length - 32);
  const sig = crypto.sign(null, canonicalPayload(pkg), privateKey);
  pkg.signature = {
    algorithm: "ed25519",
    keyId: args.keyId || DEFAULT_KEY_ID,
    publicKey: rawPub.toString("base64url"),
    sig: sig.toString("base64url"),
  };
}

const shareCode = encodeShareCode(pkg);
const jsonText = JSON.stringify(pkg, null, 2);

if (args.outDir) {
  fs.mkdirSync(args.outDir, { recursive: true });
  const baseName = `${pkg.manifest.id}-v${pkg.manifest.version}`;
  fs.writeFileSync(path.join(args.outDir, `${baseName}.json`), `${jsonText}\n`);
  fs.writeFileSync(path.join(args.outDir, `${baseName}.share.txt`), `${shareCode}\n`);
  console.error(`Packed ${baseName}: json=${Buffer.byteLength(jsonText)}B, shareCode=${shareCode.length} chars`);
}

if (args.printCode || !args.outDir) {
  console.log(shareCode);
}
