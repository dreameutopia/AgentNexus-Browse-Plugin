/** One tool-level policy for DOM, script and visual actions; never agent-specific. */
export const CONFIRM_GUIDANCE =
  'confirm 是请求用户审批，不是已获批准。仅当本次操作涉及资金或敏感后果时设为 true：' +
  '购买、下单、支付、转账、退款、付费订阅；使用账号密码或验证码登录、修改账号安全设置或权限；' +
  '获取、生成、读取、复制、导出、使用 API Key、Token、Cookie、私钥等访问凭据；' +
  '读取非公开个人隐私、导出或向第三方传输隐私/机密数据；删除重要数据、注销账号、撤销访问权限。' +
  '搜索、提交搜索/筛选、翻页、打开详情或登录页、滚动、填写普通字段、保存普通草稿、' +
  '读取公开 API/文档或任务所需的普通业务数据，以及任务已明确要求的普通发送/发布，不因“点击、提交、发送”字样而审批，省略 confirm 或设 false。' +
  '判断实际操作后果，不按按钮名称或 description 里的单个词判断。' +
  '风险操作只传 confirm=true，由工具审批回调询问一次，不先额外调用 interact 重复请求同一授权；' +
  '工具不代办的登录、验证码等用 interact 请用户手动处理，不要求用户在聊天里提供明文密码、验证码或密钥。' +
  '拒绝或未获批准后停止该操作，不换按键、脚本、工具或措辞绕过。';

export const CONFIRM_PARAMETER_DESCRIPTION =
  '按本工具说明的资金/敏感操作规则设置；true=暂停并请求用户审批，非已批准。普通搜索、导航和填写省略或 false。';
