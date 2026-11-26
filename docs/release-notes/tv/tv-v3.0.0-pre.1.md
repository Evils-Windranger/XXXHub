# HGhubX TV tv-v3.0.0-pre.1

3.0 架构脱壳重构首个 Android TV 预发布版本（`com.hghubx.tv`）：全面切换至纯壳 + QuickJS 视频源插件运行时，新增手机扫码双向同步与真实分页缓存调节。

## 新增与优化
1. **纯壳重构与 QuickJS 视频源运行时**：移除内置站方逻辑，由导入的视频源插件驱动首页、浏览、搜索、详情与播放能力；支持手机局域网扫码 / 4 位 PIN 码推源与 `hghubx://` 深链导入。
2. **视频源每次进入静默更新**：开机进入及恢复前台（60 秒冷却）时后台静默检查并应用 `updateUrls` 视频源新版更新。
3. **真实缓存清理与最高无上限档位**：TV「设置 → 缓存」支持选择 `128 MB` / `256 MB` / `512 MB` / `1 GB` / `无上限` 5 档配额，结合原生 `WebView.clearCache(true)` 释放缓存并返回实际释放体积，保留本地片库、同步记录与启动 PIN。
4. **关于页图标与包体积优化**：「设置 → 关于」新增 HGhubX 应用 Logo 标识；同步启用 R8 资源裁剪与原生库压缩，显著减小 APK 体积。

## 修复
1. **插件请求连接池与 DoH 回退（#266）**：共享底层 HTTP 连接池并支持受控 DoH 回退，修复部分网络下线路批量失败与误报问题。

## 安装与兼容提示
- Android TV 按 ABI 分包提供 `HGhubX-TV_3.0.0-pre.1_arm64.apk`、`HGhubX-TV_3.0.0-pre.1_arm.apk`、`HGhubX-TV_3.0.0-pre.1_x86_64.apk`（`com.hghubx.tv`，`versionCode=3000000`）。
- 沿用既有 `com.hghubx.tv` 签名证书与递增 `versionCode`，支持直接覆盖安装，保留本机片库、观看记录、启动 PIN 与偏好设置；升级后请通过手机端扫码同步重新导入视频源。

## 致谢
- 感谢 @zxsos 与社区成员对 3.0 纯壳 TV 版测试与反馈。

## 验证
- 通过本地 Rust 单元测试、`VITE_APP_EDITION=tv pnpm build`、TV 遥控器验收套件（14/14 场景）、纯壳与文档/版本同步检查，并由 GitHub Actions `TV Release` 工作流构建签名发布。
