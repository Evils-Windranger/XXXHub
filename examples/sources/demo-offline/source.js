// Zero-network offline demo source for verifying hghubx-src:// import & QuickJS sandbox.

const CATALOG = [
  {
    id: 90001,
    title: "【沙箱示例】穿越后我在云端写插件",
    cover: "",
    tags: ["沙箱", "示例", "都市"],
    score: 9.6,
    episode_count: 12,
    total_episodes: 12,
    hot: 128000,
    like_count: 3200,
    collect_count: 1850,
    comment_count: 42,
    is_finished: true,
    is_original: 1,
    description: "由 QuickJS 沙箱本地生成的离线示例卡片，验证剪贴板口令导入、验签、搜索与详情链路。",
    author: { id: 1, name: "QuickJS Sandbox" },
  },
  {
    id: 90002,
    title: "【沙箱示例】零账单分发逆袭记",
    cover: "",
    tags: ["逆袭", "甜宠"],
    score: 9.1,
    episode_count: 8,
    total_episodes: 8,
    hot: 86000,
    like_count: 1900,
    collect_count: 920,
    comment_count: 18,
    is_finished: true,
    is_original: 0,
    description: "支持 Ed25519 签名验证、版本升级与原子回滚。",
    author: { id: 1, name: "QuickJS Sandbox" },
  },
];

module.exports = {
  init() {
    return { ok: true, offline: true, items: CATALOG.length };
  },
  home({ page = 1, size = 20 }) {
    return {
      items: CATALOG,
      pagination: { page, pages: 1, size, total: CATALOG.length },
    };
  },
  search({ q = "", page = 1, size = 20 }) {
    const kw = String(q).trim().toLowerCase();
    const items = kw
      ? CATALOG.filter((it) => it.title.toLowerCase().includes(kw) || it.tags.some((t) => t.toLowerCase().includes(kw)))
      : CATALOG;
    return {
      items,
      pagination: { page, pages: 1, size, total: items.length },
      keyword: q,
    };
  },
  detail({ id }) {
    const found = CATALOG.find((x) => x.id === Number(id)) || CATALOG[0];
    return {
      ...found,
      counts: { like: found.like_count, collect: found.collect_count, comment: found.comment_count, hot: found.hot },
      episodes: Array.from({ length: found.total_episodes }, (_, idx) => ({
        ep_num: idx + 1,
        title: `第 ${idx + 1} 集（沙箱示例）`,
      })),
    };
  },
  playback({ id, ep }) {
    return { id: String(id), ep, video_url: "" };
  },
  hotTags() {
    return { items: [{ name: "沙箱", slug: "sandbox" }, { name: "逆袭", slug: "nixi" }, { name: "都市", slug: "dushi" }] };
  },
};
