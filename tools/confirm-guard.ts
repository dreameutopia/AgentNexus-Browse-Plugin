/**
 * 不可逆操作守卫（confirm 守卫）—— 第三级人审门的判定实现
 *
 * 与 ToolMetadata 中两级既有审批的关系（三者取并集，任一命中即审批）：
 *   1. requiresApproval          整工具级：删除笔记这类天然破坏性工具；
 *   2. requiresApprovalActions   action 级：note_tool 的 delete 等单工具多操作；
 *   3. requiresConfirm           参数语义级（本模块）：click / fill 这类
 *                                「是否破坏性取决于模型意图」的工具。
 *
 * 为什么需要第三级：enhance_click 每次点击都是同一个工具，既不能整工具审批
 * （会弹窗淹没用户），也没有 action 字段。破坏性只体现在「点了什么」上——
 * 而模型是否意识到这一点并不确定，所以采用「模型自报 + 关键词兜底」双通道：
 *
 *   (a) confirm=true  —— 模型按 prompt / schema 约定主动声明不可逆；
 *   (b) 关键词兜底    —— 模型漏传时，扫描可定位文本字段命中词表即强制人审。
 *
 * 词表设计（有意只收中文）：
 *   - 目标站点是中文站点（招聘 / 电商），用户意图与可见文案都是中文，
 *     中文子串匹配精度高且无分词边界问题；
 *   - 英文类名 / 哈希 id（btn-x7f2、submitBtn）作为兜底扫描对象会大量误伤
 *     （.order-list 只读列表、.payment-method 支付方式选择），误伤成本是
 *     无意义的弹窗——因此英文意图一律走 (a) 通道由模型显式声明。
 *
 * 扫描字段只取「定位与意图」语义（selector / description / text / xpath /
 * target），**不取 value / content / message**：正在输入的正文里出现「提交」
 * 属正常内容（简历、留言），按词表拦截会把每一次填充都变成弹窗。
 */

/** 允许参与关键词扫描的字段（定位 / 意图语义；不含正在输入的正文） */
const CONFIRM_SCANNED_FIELDS = ['selector', 'description', 'text', 'xpath', 'target'] as const;

/**
 * 破坏性意图词表（中文，子串匹配）。
 *
 * 收录标准：点击后造成**对外发出 / 资金变动 / 数据不可逆**的后果。
 * 刻意排除高频但可逆或纯导航的词，避免误伤：
 *   关闭（关弹窗是常规操作）、退出（下拉菜单）、清空（清搜索框）、
 *   查询 / 搜索 / 打开 / 查看（只读）。
 */
const DESTRUCTIVE_WORDS = [
  // 对外发出：消息、内容、简历
  '发送', '提交', '投稿', '发布', '投递', '打招呼',
  // 资金：下单到付款链路
  '购买', '下单', '支付', '结算', '付款', '打款', '转账',
  '立即购买', '确认收货', '加入购物车',
  // 资金回流 / 售后
  '退款', '退货', '退订', '申请退款',
  // 数据不可逆
  '删除', '移除', '注销', '解绑', '拉黑', '屏蔽',
  '取消订单', '关闭订单', '注销账号', '注销账户', '删除账户',
] as const;

/** 组合后的匹配正则（子串匹配，无需边界——中文无空格分词） */
const DESTRUCTIVE_RE = new RegExp(DESTRUCTIVE_WORDS.join('|'));

/**
 * 判断一段文本是否含破坏性意图信号。
 * 空输入恒为 false（防御 undefined / null / 空串）。
 */
export function matchesDestructiveText(text: unknown): boolean {
  return typeof text === 'string' && text.length > 0 && DESTRUCTIVE_RE.test(text);
}

/**
 * 判断工具入参是否携带破坏性信号（关键词兜底通道）。
 *
 * 只扫描 CONFIRM_SCANNED_FIELDS 中存在的字符串字段；对象整体非对象
 * （数组 / 原始值）时返回 false——参数形态防御由各工具自身负责。
 */
export function hasDestructiveSignal(args: unknown): boolean {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  for (const field of CONFIRM_SCANNED_FIELDS) {
    if (matchesDestructiveText(record[field])) return true;
  }
  return false;
}

/**
 * 不可逆操作守卫的完整判定（第三级人审门）。
 *
 * @param requiresConfirm 该工具是否声明了 requiresConfirm（未声明直接 false）
 * @param args            工具入参（可为 undefined）
 */
export function requiresConfirmApproval(requiresConfirm: boolean | undefined, args: unknown): boolean {
  if (!requiresConfirm) return false;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    // (a) 模型显式声明
    if ((args as Record<string, unknown>).confirm === true) return true;
  }
  // (b) 关键词兜底
  return hasDestructiveSignal(args);
}

/** 导出词表供文档 / 测试断言使用（不参与运行期逻辑） */
export const DESTRUCTIVE_WORD_LIST: readonly string[] = DESTRUCTIVE_WORDS;
