// Experimental QuickJS source plugin implementing upstream's dx150-edge-v1
// (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) purely via `host.fetch` + `host.crypto`.

const PROTOCOL = "dx150-edge-v1";
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function bytesToB64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64_CHARS[(n >> 18) & 63];
    out += B64_CHARS[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64_CHARS[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64_CHARS[n & 63] : "=";
  }
  return out;
}

function nonceB64ForSeq(seq) {
  const buf = [0, 0, 0, 0, 0, 0, 0, 0, (seq >>> 24) & 255, (seq >>> 16) & 255, (seq >>> 8) & 255, seq & 255];
  return bytesToB64(buf);
}

function baseOrigin() {
  const b = (host.info.baseUrl || host.info.origins[0] || "").replace(/\/+$/, "");
  if (!b) throw new Error("未配置可用站点域名");
  return b;
}

function scopeEndpoint(scope) {
  return `${baseOrigin()}/api/${scope}/request`;
}

function edgeCall(scope, method, pathWithQuery, bodyObj) {
  const endpoint = scopeEndpoint(scope);

  // 1. Ephemeral ECDH P-256 handshake (private key stays in Rust host vault)
  const kp = host.crypto.ecdhP256Create();
  const helloResp = host.fetch({
    method: "POST",
    url: endpoint,
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ v: 1, type: "hello", client_pub: kp.publicKeyB64Url }),
  });
  if (!helloResp.ok) {
    throw new Error(`HTTP ${helloResp.status}`);
  }
  const hello = JSON.parse(helloResp.text);
  if (hello.v !== 1 || hello.type !== "hello" || !hello.server_pub || !hello.salt) {
    throw new Error("加密握手响应格式无效");
  }

  // 2. Derive request & response AES-256-GCM keys via HKDF-SHA256
  const info = `${PROTOCOL}\n${scope}\n${hello.site}\n${hello.kid}\n${hello.sid}`;
  const [reqKeyB64, resKeyB64] = host.crypto.ecdhP256Derive(
    kp.handle,
    hello.server_pub,
    hello.salt,
    [`${info}\nreq`, `${info}\nres`],
  );

  // 3. Encrypt inner request envelope
  const seq = 1;
  const ts = Math.floor(Date.now() / 1000) + (hello.server_time - Math.floor(Date.now() / 1000));
  const envelope = { method, path: pathWithQuery };
  if (bodyObj !== undefined && bodyObj !== null) envelope.body = bodyObj;
  const nonceB64 = nonceB64ForSeq(seq);
  const enc = host.crypto.aes256GcmEncrypt({
    keyB64: reqKeyB64,
    nonceB64,
    plaintextUtf8: JSON.stringify({ request: envelope }),
    aadUtf8: `${info}\nreq\n${seq}\n${ts}`,
  });

  // 4. Send encrypted call
  const callResp = host.fetch({
    method: "POST",
    url: endpoint,
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({
      v: 1,
      type: "call",
      kid: hello.kid,
      sid: hello.sid,
      seq,
      ts,
      ciphertext: enc.ciphertextB64Url,
    }),
  });
  if (!callResp.ok) {
    throw new Error(`HTTP ${callResp.status}`);
  }
  const resultEnv = JSON.parse(callResp.text);
  if (resultEnv.v !== 1 || resultEnv.type !== "result" || resultEnv.sid !== hello.sid) {
    throw new Error("加密响应信封不匹配");
  }

  // 5. Decrypt inner HTTP response
  const dec = host.crypto.aes256GcmDecrypt({
    keyB64: resKeyB64,
    nonceB64,
    ciphertextB64Url: resultEnv.ciphertext,
    aadUtf8: `${info}\nres\n${seq}\n${ts}`,
  });
  const inner = JSON.parse(dec.plaintextUtf8);
  if (inner.status < 200 || inner.status >= 300) {
    throw new Error(`HTTP ${inner.status}`);
  }
  const bodyText = inner.body ? host.crypto.base64Decode(inner.body) : "{}";
  const parsed = JSON.parse(bodyText);
  if (parsed && typeof parsed === "object" && "data" in parsed) {
    return parsed.data;
  }
  return parsed;
}

function sortQuery(pairs) {
  return pairs
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

module.exports = {
  init() {
    return { ok: true, protocol: PROTOCOL, base: baseOrigin() };
  },

  home(input) {
    const page = Number(input?.page) || 1;
    const size = Number(input?.size) || 20;
    const q = sortQuery([["page", page], ["size", size]]);
    return edgeCall("public", "GET", `/api/videos?${q}`);
  },

  search(input) {
    const q = String(input?.q || "");
    const page = Number(input?.page) || 1;
    const size = Number(input?.size) || 20;
    const kind = input?.kind === "post" ? "&type=post" : input?.kind === "video" ? "&type=video" : "";
    return edgeCall("dynamic", "GET", `/api/search?q=${encodeURIComponent(q)}&page=${page}&size=${size}${kind}`);
  },

  detail(input) {
    const id = Number(input?.id);
    if (!Number.isFinite(id) || id <= 0) throw new Error("无效的视频 ID");
    return edgeCall("dynamic", "GET", `/api/videos/${id}`);
  },

  playback(input) {
    const id = Number(input?.id);
    const ep = Number(input?.ep) || 1;
    try {
      const primary = edgeCall("playback", "POST", `/api/videos/${id}/episodes/${ep}/playback`, {});
      if (primary && (primary.video_url || primary.video_url_hevc || primary.streams?.main || primary.streams?.hevc)) {
        return primary;
      }
    } catch (_) {
      // Fallback to legacy play path
    }
    return edgeCall("playback", "GET", `/api/videos/${id}/play?ep=${ep}&page_texts=0`);
  },

  hotTags() {
    const resp = host.fetch({ method: "GET", url: `${baseOrigin()}/` });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const anchors = host.htmlQuery(resp.text, "section.hg-home-popular-tags a[href]");
    const seen = new Set();
    const items = [];
    for (const a of anchors) {
      const name = String(a.text || "").replace(/\s+/g, " ").trim();
      const href = String(a.attrs?.href || "");
      const m = href.match(/^\/tag\/([^/?#]+)/);
      if (!name || !m || seen.has(name)) continue;
      seen.add(name);
      items.push({ name, slug: decodeURIComponent(m[1]) });
      if (items.length >= 50) break;
    }
    if (!items.length) throw new Error("未解析到官网热门标签");
    return { items };
  },
};
