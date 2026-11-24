# RFC 0001：视频源插件契约 v0.1（实验支线草案）

- 状态：Experimental Prototype（分支 `exp/source-plugin-v1`）
- 关联讨论：[zxsos/HGhubX #237](https://github.com/zxsos/HGhubX/discussions/237)
- 更新日期：2026-11-24

## 1. 设计目标与收窄原则

1. **单源优先 + 固定短剧 UI 骨架**：壳（Shell）只保留播放器、交互、媒体代理、本地片库与插件管理；页面模块由 `manifest.capabilities` 控制显隐，不做通用多源矩阵或动态画布 UI。
2. **Legado 风格单份自包含格式**：一个视频源打包为单份 JSON，可编码为剪贴板分享口令（`hghubx-src://<gzip+base64url>`），同时支持「剪贴板口令导入」「HTTPS 链接导入」「本地文件导入」三种入口，底层走同一套验签与原子安装流程。
3. **双轨热更新（零账单风险）**：
   - 路径 A（纯离线）：发一段新版 `hghubx-src://` 口令，用户粘贴覆盖同一 `id`，保留历史/收藏/状态，失败自动回滚；
   - 路径 B（可选 `updateUrls`）：源内可携带多个静态镜像 URL，仅在用户手动点「检查源更新」时拉取（不冷启动后台静默轮询），验签并确认语义化版本递增后原子替换。
4. **安全边界在 Rust Host，不在 JS 引擎**：QuickJS（`rquickjs`）配置硬内存上限（16 MiB）、栈上限（512 KiB）与执行中断超时（12 秒）；脚本无任何直接网络、文件、环境变量或 IPC 权限，所有特权能力均通过 capability-scoped `host.*` 原语访问。

## 2. 包格式与分享口令

单份 `SourcePackage` JSON：

```json
{
  "schemaVersion": 1,
  "manifest": {
    "schemaVersion": 1,
    "id": "com.example.source",
    "name": "示例源",
    "version": "1.0.0",
    "apiVersion": "1",
    "runtime": { "kind": "quickjs", "entry": "inline" },
    "network": {
      "origins": ["https://example.com"],
      "mediaOrigins": ["https://cdn.example.com"],
      "publishOrigins": []
    },
    "capabilities": {
      "home": true,
      "search": true,
      "catalog": { "categories": false, "tags": true, "rankings": false },
      "detail": { "episodes": true, "related": false, "comments": false },
      "playback": { "hls": true, "mp4": true, "subtitles": false },
      "posts": false,
      "account": false,
      "lines": true
    }
  },
  "code": "module.exports = { ... };",
  "updateUrls": [],
  "signature": {
    "algorithm": "ed25519",
    "keyId": "exp-dev-2026",
    "publicKey": "<32-byte raw pubkey base64url>",
    "sig": "<64-byte ed25519 sig base64url>"
  }
}
```

分享口令编码：`hghubx-src://` + `base64url(gzip(utf8(JSON)))`，客户端解压采用有界流读取（最大 512 KB），防止压缩炸弹。

## 3. Ed25519 签名与信任策略

- 签名载荷为跨语言确定性规范文本（覆盖 `id`、`version`、`apiVersion`、`runtime.kind`、三类 origin 列表、`updateUrls` 及 `sha256(code)`），由 `src-tauri/src/source/verify.rs` 与 `scripts/pack-source.mjs` 共同遵循。
- **篡改零容忍**：只要带签名但验签失败，无论是否开启「允许自签/测试源」，一律拒绝导入。
- 默认仅信任内嵌 Ed25519 公钥数组（支持多公钥平滑轮换）；未签名或自签源仅在用户显式开启「允许自签/测试源」后允许导入并展示指纹标识。

## 4. Rust Host 原语（v0.1）

| 原语 | 能力与安全边界 |
| :--- | :--- |
| `host.info` | 只读元信息（`sourceId`、`version`、`baseUrl`、允许的 origins 与限额） |
| `host.fetch(req)` | 复用现有 `network_policy` 严格模式、DNS 固定与代理路由；强制校验 `manifest.network` 白名单与逐跳重定向；禁止 `Cookie`/`Host` 等受限头；响应上限 2 MB |
| `host.htmlQuery(html, selector)` | 桥接 Rust `dom_query`，只读提取文本与属性；输入上限 2 MB，结果上限 200 条 |
| `host.crypto` | 基于 `ring 0.17` 暴露 `sha256Hex`、`hmacSha256`、`randomBytes`、`base64Encode/Decode`、`ecdhP256Create/Derive`（私钥留驻 Rust 侧不暴露给 JS）、`aes256GcmEncrypt/Decrypt` |
| `host.storage` | 按 `sourceId` 严格隔离的 KV 存储（最多 64 键、单值 32 KB），不接触壳账号与其他源状态 |

## 5. 渐进迁移状态（本支线 MVP）

- 已完成：QuickJS 沙箱 + Host 原语 + Ed25519 验签 + 原子安装/升级/回滚 + 「设置 → 网络 → 视频源插件」导入管理界面 + 核心链路（`home / search / detail / playback / hotTags`）接管（未启用插件时默认回退内置源对照）。
- 配套工具与示例：`scripts/pack-source.mjs`、`examples/sources/huangguo/`（纯 JS 跑 `dx150-edge-v1` 与官网 SSR 热门标签）、`examples/sources/demo-offline/`（零网络离线示例源）。
