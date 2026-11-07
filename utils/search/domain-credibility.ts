/**
 * 域名可信度评估（搜索结果标注用，纯函数无副作用）
 *
 * 目标：给 web_search 结果表的每一条链接一个可解释的可信度标注，
 * 让模型的交叉验证决策（要不要再找一个独立来源）有统一的参考刻度，
 * 而不是凭感觉。评级刻意保守：识别不了的域名一律「未评级」而不是猜低，
 * 把判断责任留给模型 + 交叉验证纪律（提示词侧约定：C/D/未评级来源的
 * 关键结论必须两个独立来源交叉）。
 *
 * 分层（从高到低，先命中先用）：
 *   A 权威     —— 政府 / 军事 / 教育机构 TLD，国际组织，一级学术出版与预印本
 *   B 可靠     —— 通讯社与主流媒体，官方技术文档，大厂官方工程博客
 *   C 参考     —— 百科 / 开发者社区 / UGC 平台（知乎、CSDN、GitHub 仓库等）：
 *                 内容质量方差大，作为线索入口可靠，作为唯一定论不可靠
 *   D 谨慎     —— 自媒体托管平台与论坛（贴吧、blogspot 等）：营销与臆测密度高
 *   ? 未评级   —— 未知域名：按内容自行判断，关键结论必须独立交叉验证
 *
 * 刻度来源：主流图书馆信源评价准则（CRAAP / 约翰霍普金斯 AI 信源指南）
 * 的领域化裁剪；不包含任何「事实正确性」判断——可信度 ≠ 正确性，
 * 高可信来源也可能出错，低可信来源也可能正确，差异只在「出错的先验概率」。
 */

/** 可信度档位（'?' = 未评级，单独于 D：未知 ≠ 差） */
export type CredibilityTier = 'A' | 'B' | 'C' | 'D' | '?';

export interface DomainCredibility {
  tier: CredibilityTier;
  /** 结果表单元格用的紧凑标注 */
  badge: string;
  /** 判定依据（面向模型的解释） */
  reason: string;
}

// ==================== 规则表（域名按注册域后缀匹配，含子域） ====================

/** A 级：国际组织 / 一级学术出版 / 预印本 / 标准 组织（TLD 级另判） */
const TIER_A_DOMAINS: readonly string[] = [
  'who.int', 'un.org', 'worldbank.org', 'imf.org', 'oecd.org', 'europa.eu', 'unesco.org',
  'arxiv.org', 'nature.com', 'science.org', 'sciencedirect.com', 'springer.com',
  'springeropen.com', 'wiley.com', 'tandfonline.com', 'ieee.org', 'acm.org',
  'iet.org', 'aps.org', 'pnas.org', 'nih.gov', 'pmc.ncbi.nlm.nih.gov',
  'cnki.net', 'wanfangdata.com.cn', 'cqvip.com',
  'ietf.org', 'w3.org', 'whatwg.org', 'ecma-international.org', 'iso.org', 'itu.int',
  'nist.gov', 'nasa.gov', 'cdc.gov', 'fda.gov', 'esa.int',
];

/** B 级：通讯社 / 主流媒体 / 官方技术文档 / 大厂官方发布 */
const TIER_B_DOMAINS: readonly string[] = [
  // 通讯社与国际主流媒体
  'reuters.com', 'apnews.com', 'afp.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com',
  'wsj.com', 'bloomberg.com', 'ft.com', 'economist.com', 'theguardian.com',
  'washingtonpost.com', 'cnn.com', 'aljazeera.com', 'nikkei.com',
  // 中文主流媒体
  'xinhuanet.com', 'news.cn', 'people.com.cn', 'cctv.com', 'caixin.com',
  'thepaper.cn', 'yicai.com', 'jiemian.com', '21jingji.com', 'stcn.com',
  // 官方技术文档（一级域名或 docs 子域）
  'developer.mozilla.org', 'react.dev', 'vuejs.org', 'angular.dev', 'svelte.dev',
  'python.org', 'go.dev', 'rust-lang.org', 'kernel.org', 'nodejs.org',
  'typescriptlang.org', 'java.com', 'docs.oracle.com', 'learn.microsoft.com',
  'developer.apple.com', 'developer.android.com', 'chromium.org', 'web.dev',
  'postgresql.org', 'mysql.com', 'mongodb.com', 'redis.io', 'sqlite.org',
  'nginx.org', 'docker.com', 'kubernetes.io', 'openresty.org',
  // 官方机构发布
  'openai.com', 'anthropic.com', 'deepmind.com', 'googleblog.com', 'github.blog',
  'stripe.com', 'aws.amazon.com', 'cloud.google.com', 'azure.microsoft.com',
  'apache.org', 'linuxfoundation.org', 'gnu.org', 'fsf.org',
];

/** C 级：百科 / 开发者社区 / UGC 平台（入口可靠，定论需交叉） */
const TIER_C_DOMAINS: readonly string[] = [
  'wikipedia.org', 'wikimedia.org', 'zh.wikipedia.org',
  'zhihu.com', 'zhuanlan.zhihu.com', 'csdn.net', 'blog.csdn.net', 'juejin.cn',
  'segmentfault.com', 'cnblogs.com', 'jianshu.com', 'oschina.net', '51cto.com',
  'infoq.cn', 'geeksforgeeks.org', 'tutorialspoint.com', 'runoob.com',
  'stackoverflow.com', 'serverfault.com', 'superuser.com', 'stackexchange.com',
  'github.com', 'gitlab.com', 'gitee.com', 'stackoverflow.blog',
  'medium.com', 'dev.to', 'habr.com', 'hashnode.dev',
  'baike.baidu.com', 'baike.so.com', 'kb.cnblogs.com',
  'icourse163.org', 'mooc.cn', 'bilibili.com', 'xiaohongshu.com',
  'weibo.com', 'x.com', 'twitter.com',
];

/** D 级：自媒体托管 / 低门槛论坛（营销与臆测密度高，只当线索不当依据） */
const TIER_D_DOMAINS: readonly string[] = [
  'tieba.baidu.com', 'blogspot.com', 'wordpress.com', 'weebly.com', 'wixsite.com',
  '360doc.com', 'docin.com', 'doc88.com', 'wenku.baidu.com',
  'sohu.com', '163.com', 'qq.com', 'toutiao.com', 'baijiahao.baidu.com',
];

// ==================== 匹配工具 ====================

/** 政府 / 军事 / 教育 TLD（含二级后缀形态，如 .gov.cn / .edu.au） */
const AUTHORITY_TLD_PATTERN = /\.(gov|mil|edu)(\.[a-z]{2})?$/i;

/** 从 URL 提取小写主机名；解析失败返回空串 */
function extractHostname(url: string): string {
  const text = (url ?? '').trim();
  if (!text) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return parsed.hostname.toLowerCase();
  } catch {
    // 无路径裸域名（如 "example.com/path" 少见形态）直接按主机名候选处理
    const candidate = text.split(/[/?#]/)[0];
    return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(candidate) ? candidate.toLowerCase() : '';
  }
}

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

function findTier(hostname: string, domains: readonly string[]): boolean {
  return domains.some(domain => matchesDomain(hostname, domain));
}

// ==================== 评级结果 ====================

const TIER_META: Record<CredibilityTier, { badge: string; reason: string }> = {
  A: {
    badge: 'A·权威',
    reason: '政府/学术/国际组织或一级学术出版（可信度先验最高）',
  },
  B: {
    badge: 'B·可靠',
    reason: '通讯社/主流媒体/官方技术文档（可信度先验较高）',
  },
  C: {
    badge: 'C·参考',
    reason: '百科/开发者社区/UGC 平台（入口可靠，作为唯一定论不可靠，关键结论需独立来源交叉）',
  },
  D: {
    badge: 'D·谨慎',
    reason: '自媒体托管/低门槛论坛（营销与臆测密度高，只当线索，不当依据）',
  },
  '?': {
    badge: '?·未评级',
    reason: '未知域名（按内容自行判断，关键结论必须两个独立来源交叉验证）',
  },
};

/**
 * 评估单个 URL / 域名的可信度档位。
 * 任何异常输入（空串 / 非法 URL）都归入未评级，绝不抛错——
 * 该函数跑在搜索结果装配热路径上，防御优先。
 */
export function assessDomainCredibility(url: string): DomainCredibility {
  const hostname = extractHostname(url);
  if (!hostname) return { tier: '?', ...TIER_META['?'] };

  // 判定顺序：权威 TLD > A 表 > B 表 > C 表 > D 表 > 未评级
  if (AUTHORITY_TLD_PATTERN.test(hostname) || findTier(hostname, TIER_A_DOMAINS)) {
    return { tier: 'A', ...TIER_META.A };
  }
  if (findTier(hostname, TIER_B_DOMAINS)) return { tier: 'B', ...TIER_META.B };
  if (findTier(hostname, TIER_C_DOMAINS)) return { tier: 'C', ...TIER_META.C };
  if (findTier(hostname, TIER_D_DOMAINS)) return { tier: 'D', ...TIER_META.D };
  return { tier: '?', ...TIER_META['?'] };
}

/** 结果表单元格标注（紧凑形态：档位 + 一句话定位） */
export function credibilityBadge(url: string): string {
  const { tier } = assessDomainCredibility(url);
  return `${TIER_META[tier].badge}（${shortHint(tier)}）`;
}

function shortHint(tier: CredibilityTier): string {
  switch (tier) {
    case 'A': return '官方/学术';
    case 'B': return '主流媒体/官方文档';
    case 'C': return '社区/百科，需交叉';
    case 'D': return '自媒体/论坛，谨慎';
    default: return '未知域名，自行判断';
  }
}
