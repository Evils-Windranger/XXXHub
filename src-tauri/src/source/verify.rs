//! Ed25519 signature verification and trust policy for source packages.

use super::manifest::SourcePackage;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64_URL;
use base64::Engine;
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Trusted Ed25519 public keys (raw 32-byte keys, Base64URL without padding).
/// Multiple keys are supported simultaneously for smooth key rotation.
///
/// NOTE: `exp-dev-2026` is the experimental prototype keypair for branch `exp/source-plugin-v1`.
/// Production builds should replace this list with maintainer-owned offline keys.
pub const TRUSTED_KEYS: &[(&str, &str)] = &[
    ("exp-dev-2026", "NDaDYRsR0srXjLylBM8OjXPL9jsPtBtjK3mO0-ncjqg"),
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SignatureInfo {
    /// `"trusted"` | `"self_signed"` | `"unsigned"`
    pub status: String,
    pub key_id: String,
    pub fingerprint: String,
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

pub fn key_fingerprint(raw_pub: &[u8]) -> String {
    let hex = sha256_hex(raw_pub);
    hex.as_bytes()
        .chunks(2)
        .take(8)
        .map(|c| std::str::from_utf8(c).unwrap_or("00"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Deterministic, language-independent signing payload shared with `scripts/pack-source.mjs`.
pub fn canonical_payload(pkg: &SourcePackage) -> Vec<u8> {
    let m = &pkg.manifest;
    format!(
        "hghubx-source-v1\nid={}\nversion={}\napi={}\nruntime={}\norigins={}\nmedia={}\npublish={}\nupdates={}\ncode_sha256={}\n",
        m.id,
        m.version,
        m.api_version,
        m.runtime.kind,
        m.network.origins.join(","),
        m.network.media_origins.join(","),
        m.network.publish_origins.join(","),
        pkg.update_urls.join(","),
        sha256_hex(pkg.code.as_bytes()),
    )
    .into_bytes()
}

fn verify_ed25519(raw_pub: &[u8], payload: &[u8], sig_b64url: &str) -> Result<(), String> {
    if raw_pub.len() != 32 {
        return Err("签名公钥长度无效".into());
    }
    let sig_bytes = B64_URL
        .decode(sig_b64url.trim().as_bytes())
        .map_err(|_| "签名编码无效")?;
    if sig_bytes.len() != 64 {
        return Err("签名长度无效".into());
    }
    UnparsedPublicKey::new(&ED25519, raw_pub)
        .verify(payload, &sig_bytes)
        .map_err(|_| "视频源签名验证失败：内容可能已被篡改".into())
}

fn find_trusted_key_by_id(key_id: &str) -> Option<&'static str> {
    TRUSTED_KEYS
        .iter()
        .find(|(id, _)| *id == key_id)
        .map(|(_, key)| *key)
}

fn find_trusted_id_by_key(pub_b64url: &str) -> Option<&'static str> {
    TRUSTED_KEYS
        .iter()
        .find(|(_, key)| *key == pub_b64url)
        .map(|(id, _)| *id)
}

/// Verify package signature against trusted keys and user opt-in policy.
/// A tampered/invalid signature is ALWAYS rejected even when `allow_untrusted` is enabled.
pub fn verify_package(pkg: &SourcePackage, allow_untrusted: bool) -> Result<SignatureInfo, String> {
    let payload = canonical_payload(pkg);
    let Some(sig) = &pkg.signature else {
        if allow_untrusted {
            return Ok(SignatureInfo {
                status: "unsigned".into(),
                key_id: String::new(),
                fingerprint: String::new(),
            });
        }
        return Err("该视频源未签名；默认仅允许受信任签名源，如需试用自签/测试源请在视频源管理中开启「允许自签/测试源」".into());
    };
    if !sig.algorithm.eq_ignore_ascii_case("ed25519") {
        return Err(format!("不支持的签名算法：{}", sig.algorithm));
    }

    if let Some(trusted_b64) = find_trusted_key_by_id(sig.key_id.trim()) {
        let raw_pub = B64_URL
            .decode(trusted_b64.as_bytes())
            .map_err(|_| "内置受信任公钥格式异常")?;
        verify_ed25519(&raw_pub, &payload, &sig.sig)?;
        return Ok(SignatureInfo {
            status: "trusted".into(),
            key_id: sig.key_id.trim().to_string(),
            fingerprint: key_fingerprint(&raw_pub),
        });
    }

    if let Some(pub_b64) = sig.public_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let raw_pub = B64_URL
            .decode(pub_b64.as_bytes())
            .map_err(|_| "视频源附带公钥编码无效")?;
        verify_ed25519(&raw_pub, &payload, &sig.sig)?;
        let fp = key_fingerprint(&raw_pub);
        if let Some(trusted_id) = find_trusted_id_by_key(pub_b64) {
            return Ok(SignatureInfo {
                status: "trusted".into(),
                key_id: trusted_id.to_string(),
                fingerprint: fp,
            });
        }
        if allow_untrusted {
            return Ok(SignatureInfo {
                status: "self_signed".into(),
                key_id: sig.key_id.trim().to_string(),
                fingerprint: fp,
            });
        }
        return Err(format!(
            "视频源使用未受信任的自签公钥（指纹 {fp}）；如确认来源可靠，请先开启「允许自签/测试源」再导入"
        ));
    }

    Err(format!(
        "未知的签名密钥 ID（{}），且未附带公钥",
        sig.key_id
    ))
}

#[cfg(test)]
pub(crate) fn sign_for_test(pkg: &mut SourcePackage, pkcs8_der: &[u8], key_id: &str, include_pub: bool) {
    use ring::signature::{Ed25519KeyPair, KeyPair};
    let pair = Ed25519KeyPair::from_pkcs8_maybe_unchecked(pkcs8_der).expect("valid pkcs8");
    let payload = canonical_payload(pkg);
    let sig = pair.sign(&payload);
    pkg.signature = Some(super::manifest::SourceSignature {
        algorithm: "ed25519".into(),
        key_id: key_id.into(),
        public_key: include_pub.then(|| B64_URL.encode(pair.public_key().as_ref())),
        sig: B64_URL.encode(sig.as_ref()),
    });
}
