/**
 * interact 推荐项归一（纯函数）
 *
 * 承载「固定 prompt + 默认工具」契约中「多选项必须给出唯一推荐项、且它排在
 * 选项列表第一位」的执行侧。契约的标记通道是**选项的 description**：
 * 推荐项在 description 开头写「（推荐：一句简短理由）」（文案见
 * interact-prompt.ts 的 RECOMMENDED_OPTION_RULE——本文件只管行为不管措辞）。
 *
 * 归一后交给 UI 的结构满足四条不变量：
 *   - 多选项时**恰有一个**推荐项：落选项的推荐括号标注被剥离，
 *     杜绝列表里出现两个"推荐"；
 *   - 推荐项**排在第一位**：模型放错位置时由本层纠正，而不是静默接受；
 *   - 推荐项在列表中**带可见标注**：模型漏写标注时补一个「（推荐）」前缀，
 *     使"列表第一个 = 推荐项"在 UI 上永远成立；
 *   - 每个选项的 **label 保持纯选项文案**——label 会作为答复原文回传给模型，
 *     标注混进答复等于污染用户的发言。模型若把标注写进了 label，本层把它
 *     搬进 description，而不是让噪声随答复回传。
 *
 * 单选项 / 开放式提问不涉及选择，不做推荐归一（推荐只在多选项时有意义）。
 */

import type { InteractOption } from './interact-ui-bridge';

/**
 * 推荐括号标注（整组匹配）。
 *
 * 形态：`（推荐）` / `（推荐：理由）` / `(Recommended: reason)` 等，
 * 括号可为半角 / 全角 / 方头括号。理由部分不能含右括号。
 * 刻意要求标注后必须紧跟右括号或冒号——这样「使用（推荐配置）」这类
 * 正常词句不会被误判成推荐标注。
 */
const MARKER_GROUP = /[（(【]\s*(?:推荐|Recommended)\s*(?:[：:][^）)】]*)?[）)】]/g;

/** 非全局形态的同一规则（用于 test()——全局正则的 test() 有 lastIndex 陷阱） */
const MARKER_TEST = /[（(【]\s*(?:推荐|Recommended)\s*(?:[：:][^）)】]*)?[）)】]/;

/** 该文本是否带有推荐括号标注 */
export function hasRecommendedMarker(text: string | undefined): boolean {
  return typeof text === 'string' && MARKER_TEST.test(text);
}

/** 从文本中剥离推荐括号标注，返回剩余文本（剩余为空时返回 undefined） */
function stripMarker(text: string): string {
  const stripped = text.replace(MARKER_GROUP, '').trim();
  return stripped;
}

/** 取文本中的第一个推荐括号标注原文（无则 undefined） */
function firstMarker(text: string): string | undefined {
  const match = text.match(MARKER_GROUP);
  return match ? match[0].trim() : undefined;
}

/** 剥离后的选项：label / description 各自的净文案与被摘下的标注 */
interface PeeledOption {
  label: string;
  labelMarker?: string;
  description?: string;
  descriptionMarker?: string;
}

/** 把选项拆成「净文案 + 摘下的推荐标注」 */
function peelOption(option: InteractOption): PeeledOption {
  const labelMarker = firstMarker(option.label);
  const descriptionMarker =
    option.description !== undefined ? firstMarker(option.description) : undefined;
  return {
    label: stripMarker(option.label),
    ...(labelMarker !== undefined ? { labelMarker } : {}),
    ...(option.description !== undefined
      ? {
          description: stripMarker(option.description),
          ...(descriptionMarker !== undefined ? { descriptionMarker } : {}),
        }
      : {}),
  };
}

/**
 * 推荐项归一：
 *   - 选项数 < 2：无选择即无推荐——保留模型原文不动（唯一选项不构成选择，
 *     强行标注反而是噪声）；
 *   - 选项数 ≥ 2：选出唯一推荐项 → 提到首位 → 其余项剥离推荐标注，
 *     推荐项的标注统一落在 description 上、label 保持纯文案。
 *
 * 推荐项的选取：带推荐括号标注的那一项（description 优先，label 兜底）；
 * 都没有标注时取模型给的第一个（模型的排序本身即首选表达），
 * 并补上「（推荐）」标注，使"列表第一个 = 推荐项"在 UI 上永远成立。
 */
export function normalizeRecommendedOption(options: InteractOption[]): InteractOption[] {
  if (options.length < 2) return options;
  const marked = options.findIndex(
    option => hasRecommendedMarker(option.description) || hasRecommendedMarker(option.label),
  );
  const winnerIndex = marked >= 0 ? marked : 0;
  const winnerOption = options[winnerIndex];
  const winner = peelOption(winnerOption);
  const winnerMarker = winner.descriptionMarker ?? winner.labelMarker;
  const winnerDescriptionText = winner.description ?? '';
  // 标注缺位时补一个「（推荐）」，让"列表第一个 = 推荐项"在 UI 上永远成立
  const winnerDescription = winnerMarker
    ? [winnerMarker, winnerDescriptionText].filter(Boolean).join(' ')
    : ['（推荐）', winnerDescriptionText].filter(Boolean).join(' ');

  const rest: InteractOption[] = [];
  for (const option of options) {
    if (option === winnerOption) continue;
    const peeled = peelOption(option);
    // label 剥空说明该选项只剩标注（无实际文案），丢弃它
    if (!peeled.label) continue;
    rest.push({
      label: peeled.label,
      ...(peeled.description !== undefined ? { description: peeled.description } : {}),
    });
  }

  return [
    {
      // label 剥空（模型把整条 label 写成了标注）时保留原 label，不交出空选项
      label: winner.label || winnerOption.label,
      description: winnerDescription,
    },
    ...rest,
  ];
}
