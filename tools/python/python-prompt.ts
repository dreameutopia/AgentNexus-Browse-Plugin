/**
 * Python 脚本规程（系统提示词分区 + 工具 ID）
 *
 * 与 tools/plan/plan-prompt.ts、tools/note/note-prompt.ts 同构的
 * 「固定 prompt + 工具」单一事实源：
 *   - PYTHON_SYSTEM_PROMPT_SECTION：无条件注入所有会话的系统提示词分区
 *     （runtime-builder 装配，位于脚本规范分区之后）；
 *   - PYTHON_RUN_TOOL_ID：python_run 的规范名（工具 ID 单一事实源）。
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
 * 注入条件：仅当本轮工具面真的含 python_run 时注入——规程必须与工具面
 * 一致，否则模型会按规程去调用一个不存在的工具（见 runtime-builder 的
 * 「提示词与工具面不一致会让模型按规程调用一个不存在的工具」注释）。
 */

/** python_run 的规范工具 ID（单一事实源） */
export const PYTHON_RUN_TOOL_ID = 'python_run' as const;

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
Python 脚本执行规范（全局固定注入）——python_run 在会话工作区（/work-space/<chatId>/）内管理文件并运行 Python 3.14 / Pyodide(WASM) 脚本：无终端、无本地文件系统、无子进程，脚本运行期可联网。

工作流（唯一正确顺序）：先 action="create" 把脚本写入工作区（建议 scripts/xxx.py），再 action="run" 执行该已存在的 .py。run 不接收内联代码，也不接受尚未落库的路径。脚本报错时：action="read" 读回出错处 → action="edit" 定点修复 → 再 action="run"；不要 delete 后重建，也不要重复执行同一条失败命令。

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

产出与交付：脚本把交付文件写到 outputs/，并在回复正文里单独一行输出工具返回的 marker（<workspace-file path="outputs/xxx.csv" />）；results/ 是工具产物的结果目录，只能 read/list/delete。
</python-scripting>`;
