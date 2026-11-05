/** Explicit confirmation plus narrow risk signals. Generic submit/send UI
 * wording (提交搜索、发送普通消息) does not by itself imply risk. */
const SCANNED_FIELDS = ['description', 'text', 'target'] as const;

// Match operations and sensitive objects, never CSS/XPath, code or input values.
const RISK_PATTERNS = [
  /(?:执行|确认|点击|进行|发起|办理|申请).{0,8}(?:购买|支付|付款|转账|退款|下单|结算|付费订阅)(?!方式|记录|列表|说明|文档|页面|入口|设置)/,
  /^(?:购买|支付|付款|转账|打款|退款|下单|结算|开通付费|确认收货)(?!方式|记录|列表|说明|文档|页面)/,
  /(?:输入|填写|提交|使用|读取|获取|复制|导出|发送|传输|保存|生成|创建|重置|修改|轮换|撤销).{0,16}(?:密码|验证码|支付信息|银行卡|API[ _-]?Key|API密钥|访问密钥|密钥|私钥|access[ _-]?token|refresh[ _-]?token|token|cookie|凭据)/i,
  /(?:使用|提交|输入|填写).{0,12}(?:账号|账户).{0,8}(?:登录|登陆)|(?:登录|登陆)(?:账号|账户)/,
  /(?:修改|重置|关闭|禁用|授予|提升|撤销).{0,12}(?:账号安全|账户安全|双重验证|二次验证|访问权限|管理员权限|安全设置|登录凭据)/,
  /(?:读取|获取|导出|上传|公开|分享|发送|传输).{0,12}(?:隐私|机密|身份证|银行卡|通讯录|客户个人信息)/,
  /(?:删除|清除|销毁).{0,8}(?:重要数据|数据库|生产数据|全部记录|所有记录|备份)|注销(?:账号|账户)|删除(?:账号|账户)/,
  /\b(?:pay|purchase|transfer|refund)\s+(?:for\b|money\b|order\b|funds\b|\d)|\b(?:read|retrieve|copy|export|use|create|rotate)\s+(?:(?:an?|the|saved)\s+)?(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|password|credentials|cookies?)\b/i,
];

/** Public helper retained for callers; now detects financial/sensitive intent. */
export function matchesDestructiveText(text: unknown): boolean {
  return typeof text === 'string' && RISK_PATTERNS.some(pattern => pattern.test(text));
}

export function hasDestructiveSignal(args: unknown): boolean {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const record = args as Record<string, unknown>;
  return SCANNED_FIELDS.some(field => matchesDestructiveText(record[field]));
}

export function requiresConfirmApproval(requiresConfirm: boolean | undefined, args: unknown): boolean {
  if (!requiresConfirm) return false;
  if (args && typeof args === 'object' && !Array.isArray(args) &&
      (args as Record<string, unknown>).confirm === true) return true;
  // confirm=false does not suppress a clearly sensitive intent.
  return hasDestructiveSignal(args);
}
