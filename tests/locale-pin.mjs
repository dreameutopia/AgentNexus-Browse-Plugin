/**
 * 测试运行期的界面语言钉子。
 *
 * 仓库里的协议/工具契约断言的是**中文产品文案**（参数拒绝指引、错误提示、
 * 终态摘要等）。这些文案随界面语言切换：i18n core 在模块加载时按
 * navigator.language 判定（zh* → zh-CN，其余 → en）。
 *
 * CI runner 的界面语言是 en-US，于是同一批断言在云端拿到英文文案而失败，
 * 在作者的中文机器上却一直绿——这是环境差异，不是代码缺陷。
 *
 * 这里把 navigator.language 钉到 zh-CN，让云端与本机口径一致。
 * 通过 NODE_OPTIONS=--import=./tests/locale-pin.mjs 注入：各套件 runner
 * 派生的 node 进程都会继承 NODE_OPTIONS，无需逐个改测试文件。
 *
 * 需要本地复现「英文环境」时：
 *   AGENTNEXUS_TEST_LOCALE=en-US NODE_OPTIONS=--import=./tests/locale-pin.mjs npm run test:contract
 */
const locale = process.env.AGENTNEXUS_TEST_LOCALE || 'zh-CN';
try {
  Object.defineProperty(globalThis.navigator, 'language', {
    value: locale,
    configurable: true,
  });
} catch {
  // navigator 不可定义时保持运行环境原值（测试仍按运行环境语言执行）
}
