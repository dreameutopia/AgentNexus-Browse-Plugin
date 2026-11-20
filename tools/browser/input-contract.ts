/**
 * browser_input 工具契约（工具 ID + 系统提示词分区）。
 *
 * 契约与提示词同处一文件的原因：两者必须同步演进——提示词描述的能力面若与
 * 工具实际实现的 action 面漂移，模型会按提示词调用不存在的 action（仓库对此
 * 有明确约定：工具描述与实现必须完全对应，不得有歧义或不支持的引导）。
 */

/** 工具 ID（默认注入的核心工具，无条件在场）。 */
export const BROWSER_INPUT_TOOL_ID = 'browser_input';

/**
 * 快捷键与剪贴板工具的系统提示词分区。
 *
 * 设计背景（一次真实任务的复盘）：把 109 行 × 26 列的数据写进 canvas 渲染的
 * 飞书表格，模型走了 61 次调用、两次 30 秒挂起才成功，根因有三：
 *   1. **页面上下文的异步剪贴板 API 会挂在浏览器级权限气泡上**——气泡在
 *      浏览器 UI 层、不在页面 DOM，任何 DOM 观察工具都看不到，模型只看到脚本
 *      超时，于是反复重试同一条死路；
 *   2. **快捷键与剪贴板没有专属入口**，模型只能拿页面脚本硬造，还常误以为
 *      「派发快捷键不能触发粘贴」而不敢用真正可行的那条路；
 *   3. **表格类页面的能力边界没有说明**，模型不知道 canvas 网格没有 DOM 单元格，
 *      于是反复用名称框/公式栏做四步导航去验证每一次写入。
 *
 * 本分区把三条事实固化为可执行规程，并指向 browser_input 的对应 action。
 */
export const BROWSER_INPUT_SYSTEM_PROMPT_SECTION = `<browser-input>
快捷键与剪贴板统一走 browser_input（默认注入，无需勾选即在场）。它的按键经 CDP 派发**可信**键事件（isTrusted=true），因此**会触发浏览器与页面自身的原生快捷键**（Ctrl+V 粘贴、Ctrl+C 复制、Ctrl+Home 回到文档开头、Ctrl+Z 撤销等）——这是把整批数据写进表格/编辑器等 canvas 应用的**标准路径**，不要因为「按键只是页面事件」而回避它。

剪贴板走**扩展侧**通道（manifest 剪贴板权限 + 离屏文档），**不经过页面 origin**：因此不会触发浏览器权限气泡、不会挂起、也不需要页面处于前台。浏览器 UI 层的权限气泡（「查看复制到剪贴板的文本和图像」等）**不在页面 DOM 里**，任何 DOM 观察工具都看不到——写操作长时间无响应时优先怀疑它，并改用 browser_input 的剪贴板 action，而不是在页面脚本里重试 navigator.clipboard。

**整批数据写进表格/编辑器**（canvas 网格、无 DOM 单元格的页面同样适用）：
1. browser_input(action="clipboard_write", path="outputs/xxx.csv")：把工作区文件写进系统剪贴板（CSV 会自动转成制表符分隔，粘贴即成列）；
2. browser_observe 找到目标单元格/定位方式（表格类页面用名称框或 Ctrl+Home 定位起始格）；
3. browser_input(action="clipboard_paste")：写入剪贴板并派发真实 Ctrl+V。
需要"读剪贴板→判断→再写回"时用 clipboard_read（读取可能含用户复制的凭据，按工具审批规则处理）。

**逐字符输入**用 browser_input(action="type")：向当前焦点编辑器插入文本（可先 clear=true 清空）；它与 browser_interact(action="fill") 的分工是——fill 直接改控件值（适合普通 input/textarea/select），type 走真实输入通道（适合富文本、canvas 编辑器、表格单元格）。

canvas 渲染的表格/画布**没有 DOM 单元格**：不要试图用 browser_observe 找单元格，也不要逐格填（109 行 × 26 列就是 2834 次交互）。观察结果里 canvas 的占位描述（如「暂无当前工作表查看权限」）是渲染占位符，不代表真的没有权限；此时用「名称框定位 + 剪贴板粘贴」或脚本读取，不要反复重扫页面。
</browser-input>`;
