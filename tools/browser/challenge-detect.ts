/**
 * 风控 / 人机验证页探测（共享实现）
 *
 * 从 browser_get_page_text 抽出，供两个工具共用：
 *   - browser_get_page_text：读取正文时识别「这一页是验证页而非正文」；
 *   - browser_crawl        ：批量抓取时命中验证页即停止（交人处理）。
 *
 * 两份实现必然漂移——特征词表会随站点新增而更新，页内探测与批量探测
 * 的判定口径一旦不同，同一个验证页在两条路径上会得到相反结论。
 *
 * 判定策略（三条件缺一不可，避免把正常文章误判成验证页）：
 *   ① 正文极短（真内容不会这么短）；
 *   ② 标题命中验证页特征；
 *   ③ 或正文开头命中强特征词（验证页的标记总在页面顶部）。
 *
 * 刻意不含「安全验证」「请稍候」「人机验证」等通用措辞——它们在正常文章里
 * 频繁出现，误判会把真实内容当成验证页丢弃（比漏判更糟）。
 */

/** 人机验证页判定：正文长度上限（超过即视为有真实内容，不判验证页） */
export const CHALLENGE_MAX_CONTENT_CHARS = 1_200;
/** 判定采样的正文前缀长度（验证页的标记总在页面顶部） */
export const CHALLENGE_SCAN_CHARS = 400;

/**
 * 强标记：出现即高度指向人机验证页——这些是风控页的固定文案，正常正文不会
 * 用它们起头。
 */
const CHALLENGE_STRONG_PATTERN =
  /(Just a moment|Checking your browser|Attention Required|Verify you are human|Enable JavaScript and cookies|正在进行安全验证|正在进行安全检查|请完成安全验证|请完成下列验证)/i;

/**
 * 标题特征（英文风控页固定文案，出现在标题开头即可）。
 */
const CHALLENGE_TITLE_EN_PATTERN =
  /^(just a moment|attention required|checking your browser|verify you are human|access denied|forbidden)/i;

/**
 * 标题特征（中文风控页固定文案：**整条标题就是该词**才算数）。
 * 不能用「包含」——「登录安全验证指南」这类正常标题会被包含匹配命中。
 */
const CHALLENGE_TITLE_ZH_PATTERN =
  /^(请稍候|安全验证|人机验证|访问验证|正在验证|请完成验证|请完成安全验证)[\s。.…·～~]*$/;

/** 探测结果 */
export interface ChallengeDetection {
  /** 是否命中风控 / 人机验证页 */
  detected: boolean;
  /** 命中原因（可读，用于账本与告警） */
  reason?: string;
}

/**
 * 依据标题与正文片段判定是否为风控 / 人机验证页。
 *
 * @param title 页面标题
 * @param bodyText 页面正文（截断到判定需要的长度即可）
 */
export function detectChallengeFromText(
  title: string | undefined | null,
  bodyText: string | undefined | null,
): ChallengeDetection {
  const titleText = (title ?? '').trim();
  const body = (bodyText ?? '').trim();

  // 正文不短 → 有真实内容 → 不判验证页（避免误杀长文章）
  if (body.length > CHALLENGE_MAX_CONTENT_CHARS) {
    return { detected: false };
  }

  if (CHALLENGE_TITLE_EN_PATTERN.test(titleText)) {
    return { detected: true, reason: `标题命中风控特征（${titleText.slice(0, 60)}）` };
  }
  if (CHALLENGE_TITLE_ZH_PATTERN.test(titleText)) {
    return { detected: true, reason: `标题命中风控特征（${titleText.slice(0, 60)}）` };
  }
  const strong = body.slice(0, CHALLENGE_SCAN_CHARS).match(CHALLENGE_STRONG_PATTERN);
  if (strong) {
    return { detected: true, reason: `正文含风控标记（${strong[0]}）` };
  }
  return { detected: false };
}

/**
 * 在标签页里探测是否为风控 / 人机验证页。
 *
 * 探测只读页面标题与正文前缀，不修改页面任何状态。
 * 探测失败（页面不可注入 / 已关闭）一律按「未命中」处理——探测不了
 * 不等于验证页，宁可继续也不误停。
 */
export async function detectChallengePage(
  tabId: number,
): Promise<ChallengeDetection> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: (): { title: string; body: string } => {
        const title = typeof document.title === 'string' ? document.title : '';
        const body =
          typeof document.body?.innerText === 'string'
            ? document.body.innerText.slice(0, 1500)
            : '';
        return { title, body };
      },
      world: 'ISOLATED',
    });
    const payload = results?.[0]?.result as
      | { title?: string; body?: string }
      | undefined;
    if (!payload || typeof payload !== 'object') {
      return { detected: false };
    }
    return detectChallengeFromText(payload.title, payload.body);
  } catch {
    // 探测失败不是命中：受限页 / 已关闭的标签页都不该被当成风控页
    return { detected: false };
  }
}
