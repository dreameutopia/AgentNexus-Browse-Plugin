/**
 * Python 脚本规程（系统提示词分区 + 工具 ID）
 *
 * 与 tools/plan/plan-prompt.ts、tools/note/note-prompt.ts 同构的
 * 「固定 prompt + 工具」单一事实源：
 *   - PYTHON_SYSTEM_PROMPT_SECTION：无条件注入所有会话的系统提示词分区
 *     （runtime-builder 装配，位于脚本规范分区之后）；
 *   - PYTHON_RUN_TOOL_ID：从 python-timeout-contract 再导出的规范工具 ID
 *     （ID 单一事实源在彼处，此处只供装配方一站式取用）。
 *
 * ==================== 为什么必须有独立分区 ====================
 *
 * 工具描述（schema.description）是**随请求携带**的静态文本：它在每个
 * 请求里都占着上下文，但模型注意力权重低于系统提示词，且与其它工具的
 * 描述竞争。实测日志（真实会话记录）显示，描述里已经写明「先创建脚本文件，
 * 再运行」，模型仍先调用了 action="run" —— 描述被读到，但没有生效。
 *
 * 规程类内容需要**独立分区 + 固定锚点**：系统提示词分区在每轮请求里位于
 * 固定位置、被整体缓存、且不与其它工具描述争夺注意力。这与 plan/note/
 * upload_file 的既有做法一致：它们都把「决策协议」放在系统提示词分区，
 * 把「调用机制」放在工具描述。
 *
 * 分工（避免重复，两层各司其职）：
 *   - 本分区：**决策协议**——何时用哪个工具、依赖怎么选、失败怎么办；
 *   - 工具描述：**调用机制**——action 与参数的确切形状。
 *
 * 注入条件与防重由 prompt-hooks 的 pythonScriptingHook 承载：工具面含
 * python_run（含技能携带）且注册表真实存在才注入；智能体指令自带完整
 * <python-scripting> 分区时自跳过（分区自治）。规程必须与工具面一致，
 * 否则模型会按规程调用一个不存在的工具。
 */

/** python_run 的规范工具 ID（单一事实源在 python-timeout-contract，此处再导出供提示词装配方使用） */
export { PYTHON_RUN_TOOL_ID } from './python-timeout-contract';

/**
 * 固定系统提示词分区：Python 脚本执行规范。
 *
 * 设计要点：
 *   - 先产出脚本、再运行——不接收内联代码，脚本必须先落库；
 *   - 依赖三通道与「声明 ≠ 解析」的耦合关系（最高频误解点）；
 *   - 失败处置顺序（标准库 → 专用工具 → 显式安装），并明确禁止原样重试；
 *   - 交付规范与产物落盘位置。
 */
export const PYTHON_SYSTEM_PROMPT_SECTION = `<python-scripting>
Python 脚本执行规范（全局固定注入）——python_run 在会话工作区（/work-space/<chatId>/）内执行 Python 3.14 / Pyodide(WASM) 脚本：无终端、无本地文件系统、无子进程，脚本运行期可联网。工作区文件的创建/读取/编辑/删除/复制/盘点/搜索统一由 file_util 承担，python_run 只负责运行已保存的 .py。

工作流（唯一正确顺序）：先用 file_util(action="create", path="scripts/xxx.py", content="…") 把脚本写入工作区，再 python_run(action="run", path="scripts/xxx.py") 执行该已存在的 .py。run 不接收内联代码，也不接受尚未落库的路径。脚本报错时：file_util(action="read") 读回出错处 → file_util(action="edit") 定点修复 → 再 action="run"；不要 delete 后重建，也不要重复执行同一条失败命令。

依赖选择（声明与解析是两件事，最易出错处）：
- 官方目录内的包（numpy、pandas、scipy、matplotlib、scikit-learn 等）按 import 自动加载，无需任何声明；
- 脚本同目录/项目根的 requirements.txt、PEP 723 元数据块、pyproject.toml 会被自动发现，也无需声明；
- 官方目录没有的纯 Python 包才需要显式声明：requirements=["包名"] 且 dependencyMode="pypi"——两者必须同时给。只给 requirements 而不给 dependencyMode="pypi"，该包在默认 catalog 模式下既不会被安装、也不在官方目录内，运行必然失败。dependencyMode="pypi" 会请求用户审批，且只支持纯 Python wheel；含 C 扩展的包只能用官方目录内的版本或自备兼容 .whl（wheels 参数）。
- 拿不准某个包能否安装时：先 action="run" 加 preflight=true 做静态预检（不执行、不安装、不写工作区），它会报告依赖与环境变量限制。

失败处置（按改动量从小到大，不要跳步）：
1. 先问是否真的需要第三方库——能用标准库（csv/json/xml/zipfile）就用标准库；
2. 生成 xlsx/docx/pptx 等办公文件时优先用本轮工具清单里的专用工具（如 xlsx_tool 的 dataFiles 直接读 results/ 数据文件零转录导出），不要为写文件引入第三方库；
3. 确需官方目录外的纯 Python 包时，requirements=["包名"] + dependencyMode="pypi"（会请求用户审批；装成功后进复用清单，后续运行直接 import 即可）；
4. 同一失败不要原样重试——换方案比再试一次快。

产出与交付：脚本把交付文件写到 outputs/，并在回复正文里单独一行输出工具返回的 marker（<workspace-file path="outputs/xxx.csv" />）；results/ 是工具产物的结果目录，只能通过 file_util 的 read/list/delete 访问，不能手工 create/edit/append/copy。

工作区目录与输出回显（写文件前先看这一条）：
- 脚本在会话工作区（/work-space/<chatId>/）内运行，沙箱里已存在的一级目录为 inputs/、outputs/、content/、scripts/、skills/——往这些目录下的文件直接 open(path, "w") 即可，不必先建目录；
- 写更深层级（如 outputs/2026/a.csv）时父目录不存在会抛 FileNotFoundError——脚本内先 os.makedirs(dir, exist_ok=True) 再写。这是脚本自身的职责，不要用 file_util 建占位文件去「试出」目录存在；
- 脚本的 print() 输出会随本次执行结果回显在 [stdout] 段：想看结果就看回显，不要为了「拿到输出」把结果写进文件再读回来（多绕两轮，还可能撞上目录不存在）；
- 脚本报 FileNotFoundError 时先分清是「读不到文件」还是「写不进不存在的目录」：前者核对路径拼写与工作区实际内容，后者按上一条补 os.makedirs。
</python-scripting>`;
