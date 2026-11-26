// Zero-network offline demo source for demonstrating shell UI, QuickJS sandbox,
// and capability gating without built-in site playback.

function makeDemoPoster(c1, c2, badge, line1, line2) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 480">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>` +
    `</linearGradient></defs>` +
    `<rect width="360" height="480" fill="url(#g)"/>` +
    `<circle cx="290" cy="96" r="110" fill="rgba(255,255,255,0.08)"/>` +
    `<circle cx="72" cy="390" r="88" fill="rgba(255,255,255,0.06)"/>` +
    `<rect x="28" y="30" width="112" height="32" rx="16" fill="rgba(0,0,0,0.36)"/>` +
    `<text x="84" y="51" font-family="sans-serif" font-size="14" font-weight="700" fill="#e2f1ff" text-anchor="middle">${badge}</text>` +
    `<rect x="28" y="324" width="304" height="122" rx="18" fill="rgba(7,15,24,0.52)"/>` +
    `<text x="48" y="372" font-family="sans-serif" font-size="24" font-weight="700" fill="#ffffff">${line1}</text>` +
    `<text x="48" y="408" font-family="sans-serif" font-size="16" fill="#cbd5e1">${line2}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

const CATALOG = [
  {
    id: 90001,
    title: "【沙箱示例】穿越后我在云端写插件",
    cover: makeDemoPoster("#0f3d5e", "#1b1445", "DEMO · 01", "QuickJS 示例剧目", "仅演示界面 · 无网络播放"),
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
    description: "由 QuickJS 沙箱本地生成的离线示例卡片，可体验首页、搜索、标签筛选、详情与选集结构，以及按能力隐藏未开启入口（不含播放直链）。",
    author: { id: 1, name: "QuickJS Sandbox" },
  },
  {
    id: 90002,
    title: "【沙箱示例】纯壳插件边界演练录",
    cover: makeDemoPoster("#2f1f54", "#0d4a4a", "DEMO · 02", "能力裁剪演示", "导入真实源后可解锁播放"),
    tags: ["示例", "沙箱", "逆袭", "科幻"],
    score: 9.1,
    episode_count: 8,
    total_episodes: 8,
    hot: 86000,
    like_count: 1900,
    collect_count: 920,
    comment_count: 18,
    is_finished: true,
    is_original: 0,
    description: "演示客户端与站点解析解耦后的能力门控：支持 Ed25519 验签、能力开关裁剪与一键移除返回导入页。",
    author: { id: 1, name: "QuickJS Sandbox" },
  },
];

const HOT_TAGS = [
  { name: "沙箱", slug: "sandbox" },
  { name: "示例", slug: "demo" },
  { name: "都市", slug: "dushi" },
  { name: "逆袭", slug: "nixi" },
  { name: "科幻", slug: "scifi" },
];

function buildTagCategories() {
  const tags = HOT_TAGS.map((item, idx) => ({
    id: idx + 1,
    name: item.name,
    slug: item.slug,
    video_count: CATALOG.filter((v) => v.tags.includes(item.name)).length,
  }));
  return [{ id: 1, name: "示例标签", tags }];
}

module.exports = {
  init() {
    return { ok: true, offline: true, demo: true, items: CATALOG.length };
  },
  home({ page = 1, size = 20 }) {
    return {
      items: page === 1 ? CATALOG : [],
      pagination: { page, pages: 1, size, total: CATALOG.length },
    };
  },
  search({ q = "", page = 1, size = 20 }) {
    const kw = String(q).trim().toLowerCase();
    const items = kw
      ? CATALOG.filter(
          (it) =>
            it.title.toLowerCase().includes(kw) ||
            it.tags.some((t) => t.toLowerCase().includes(kw)),
        )
      : CATALOG;
    return {
      items: page === 1 ? items : [],
      pagination: { page, pages: 1, size, total: items.length },
      keyword: q,
    };
  },
  tags() {
    return { categories: buildTagCategories() };
  },
  hotTags() {
    return { items: HOT_TAGS };
  },
  tagVideos({ tag = "", page = 1, size = 20 }) {
    const key = String(tag).trim().toLowerCase();
    const items = key
      ? CATALOG.filter((it) => it.tags.some((t) => t.toLowerCase() === key))
      : CATALOG;
    return {
      items: page === 1 ? items : [],
      pagination: { page, pages: 1, size, total: items.length },
    };
  },
  detail({ id }) {
    const found = CATALOG.find((x) => x.id === Number(id)) || CATALOG[0];
    return {
      ...found,
      counts: {
        like: found.like_count,
        collect: found.collect_count,
        comment: found.comment_count,
        hot: found.hot,
      },
      episodes: Array.from({ length: found.total_episodes }, (_, idx) => ({
        ep_num: idx + 1,
        title: `第 ${idx + 1} 集（示例占位）`,
        duration: 90,
        status: 1,
      })),
    };
  },
  playback({ id, ep }) {
    const found = CATALOG.find((x) => x.id === Number(id)) || CATALOG[0];
    return {
      id: String(found.id),
      ep: ep || 1,
      title: `${found.title} · 第 ${ep || 1} 集（仅演示，无播放源）`,
      video_url: "",
    };
  },
};
