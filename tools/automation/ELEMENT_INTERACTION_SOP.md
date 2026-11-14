# 纯文本网页交互协议

文本通用助手不配置视觉模型、截图或坐标动作。工具参数契约以工具 schema 为准；动作智能体和数据采集助手使用 utils/agents/element-interaction-sop.ts，网站学习/验证独立维护任务指南。

## 工具分工

控件语义、类别筛选、幂等状态操作与复杂列表多轮协议详见 [文本控件适配矩阵](../../docs/analysis/text-control-semantics.md)。
`categories` 是严格筛选，`regex` 仍是命中置顶；默认结果包含 Category/State，details 包含关联弹层和实时状态。
勾选用 set_checked，展开用 set_expanded，选项状态用 set_selected；原生多选使用 select + values 明确替换集合。
自定义控件展开、搜索、滚动或选择后重新观察，限定已确认关联列表；节点替换或回读不一致时不自动重放。

| 工具 | 能力 | 不代表什么 |
| --- | --- | --- |
| browser_observe | DOM 控件、输入、表格结构、选项、滚动容器、当前焦点、浏览器辅助功能树 | 未加载内容或整张工作簿的完整数据 |
| browser_interact | click/fill/focus/keys/type/scroll，按节点引用操作 | 页面业务已保存、任意画布均可编辑 |
| browser_network_capture | start/read/stop，被动观察 start 之后的真实请求与文本响应（urlIncludes/urlExcludes/types/includeHeaders/durationSec 可选过滤与窗口；read 支持 onlyMissing 对账），完整正文进入 dataRef（**仅数据采集 / 网站学习 / 技能验证场景具备；文本通用助手与视觉通用助手 不携带**） | start 之前的历史请求、二进制协议解码、接口写权限 |
| js_run | 指定 tab/frame 的脚本执行与工作区结果文件数据通道（每次执行结果自动落盘 results/，持久可分页核对） | 任意闭包、Worker、跨域 frame 自动可读 |
| browser_get_page_text | 全部可注入 frame、可访问 shadow root 的结构化 Markdown 正文（标题/表格/列表/代码块/链接；超 15000 字符 ref 分页，url= 可直读指定页） | 对 Canvas 像素的识别 |

页面菜单和少量编辑用交互；批量取数优先使用已确认且有权限的数据接口/导出。当前没有凭据配置的厂商 API 不作为可用工具承诺。

## 观察与分页

- controls：按钮与输入；buttons/inputs：分类观察。
- 枚举自动覆盖可访问 frame，不传 elementId/frameId（包括 0/null）。只有 view=element 使用同一行的 DOM elementId 与 frameId 读取节点详情，且不接受过滤或分页参数；schema 分支与运行时均校验这两种调用互斥。
- structure：标准 table、ARIA grid/row/gridcell、选区属性、输入值、select 选项、滚动范围和 canvas 的存在信息。字段值/选项有输出边界，未渲染行列不在此视图中。
- accessibility：实际浏览器 Accessibility 树，返回角色、名称、值和状态。根据后端 DOM 节点生成 ax: 引用；没有可映射 DOM 节点的语义项不提供可操作引用。
- DOM 的 regex/xpath 是命中置顶（同时提供为 AND，零命中仍返回候选）；AX regex 只返回匹配语义项，不支持 XPath。
- 新查询从 page=1 开始，不传 snapshotId。续读传返回的 snapshotId，page 取 nextPage 的值；省略过滤条件表示继承。改变条件/view、导航、操作后重新采集。nextPage=null 即结束，越界明确报错。
- 每页最多40条；DOM 与 AX 各自最多8份120秒快照。快照冻结成员和排序，新的行列需重采，不会静默重排旧数据。交付前核验节点身份；AX 页会重新读取并核对对应语义节点。
- # 是单个快照内跨页连续的展示行号。不是单元格地址，也不是业务记录 ID。

## 引用与范围

DOM ElementId 包含来源 tab、随机文档标识和递增编号，绑定实际节点（WeakRef）。不使用网站 HTML id 或位置 CSS 路径；不向网页添加定位属性。签名核对标签、关键属性、文字、关联标签、上下文；输入值不是节点身份。节点替换、导航或过期会失败，不猜测其他节点。HTTP 页面使用 getRandomValues 生成标识，不依赖 secure-context-only 的 randomUUID。

调用 browser_observe(view="element") 或 browser_interact 操作 DOM 引用时，同时提交返回行的 FrameId；枚举不使用节点引用。AX 引用自带 frame/文档/调试会话路由，省略 FrameId；目前只用于 focus/keys/type。AX 操作前重新核对后端节点身份和焦点，失效就重采，禁止拿 AX 行号构造 DOM 引用。

DOM 扫描及命中测试使用开放或扩展可访问的封闭 ShadowRoot。浏览器权限仍可能阻止注入。AX 对跨进程 frame 可能仅部分覆盖，响应 warnings/coverage 会明确显示；不能以空结果证明页面无内容。

## 交互参数与结果

所有交互必须给 description 说明目标和意图。只传对应 action 的字段。

| action | 参数 | 行为与校验 |
| --- | --- | --- |
| click | elementId, frameId | DOM 点击，滚动与事件后核验节点/遮挡；返回 dispatched，业务结果仍需回读 |
| fill | elementId, frameId, value | 标准控件赋值；select 按值或唯一文字；只读/禁用拒绝，失焦后核对值 |
| focus | elementId；DOM 另给 frameId | 聚焦并返回当前焦点；不修改 tabindex 来伪造可聚焦性 |
| keys | elementId, keys；DOM 另给 frameId | 一个主键与至多4个修饰键，CDP 原生按下/释放；支持 F1-F12、标点和导航 |
| type | elementId, value, clear?；DOM 另给 frameId | 当前可编辑焦点插入 Unicode 文本，不提交；clear 通过当前平台全选/退格 |
| scroll | deltaX/deltaY, frameId, elementId? | 滚动指定容器；省略 elementId 仅滚动该 frame 文档；返回实际前后位置、边界与 moved |

原生操作检查来源 tab、文档、节点语义、焦点和调试会话。焦点被替换、取消、超时或目标变化时停止后续事件；异常路径反序释放已按键，释放失败或派发不确定时脱离会话。文本与其他浏览器手势共用输入队列，避免不同聊天并发干扰。

keys/type 后读取返回的 focus。Tab、Enter、F2 可能切换到新编辑器，下一步使用新焦点引用，不沿用旧单元格引用。原生 type 返回 dispatched，不保证框架或云端保存接受内容；需要观察值、选区、公式和保存反馈。它不是剪贴板二维粘贴工具，不能假定 TSV 会自动形成多行列。

## 通用快捷键

已有 `browser_interact(action="keys")` 承担按键能力，不增加独立快捷键工具。调用必须包含目标引用与 description；DOM 引用同时提供 frameId，AX 引用省略。每次一个主键和至多四个修饰键，自动先按修饰键、最后反序释放；取消与异常沿用输入防护。连续按键需要分次调用、检查返回的焦点。

`Mod`/`ControlOrMeta`：Windows/Linux 为 Control，macOS 为 Meta；Ctrl、Cmd、Command、Option、Esc、Return、Del、PgUp、PgDn 等别名会标准化。重复修饰键（包括别名重复）拒绝执行。支持 ASCII 字母数字标点、F1–F24、导航编辑键、ContextMenu 与常见锁定键。字面大写在含 Control/Alt/Meta 的组合中不隐式添加 Shift；需要 Shift 时显式指定。标点按 US 键位解释，Unicode 文本用 type。

| 意图 | keys 示例 | 核验 |
|---|---|---|
| 全选 | `["Mod","a"]` | 当前编辑器的选区 |
| 撤销／重做 | `["Mod","z"]` / `["Mod","Shift","z"]` | 应用历史状态；部分应用重做使用 Control+y |
| 前后焦点 | `["Tab"]` / `["Shift","Tab"]` | 返回的新 focus |
| 光标／选区 | `["ArrowLeft"]` / `["Shift","ArrowRight"]` | 当前选区；整词导航按平台使用 Control 或 Alt |
| 首尾／翻页 | `["Home"]` / `["End"]` / `["PageDown"]` | 应用响应；Mac 文档首尾常按 Meta+ArrowUp/Down |
| 提交／取消 | `["Enter"]` / `["Escape"]` | 提交反馈或编辑状态 |
| 表格编辑／换行 | `["F2"]` / `["Alt","Enter"]` | 以应用真实快捷键与当前模式为准 |
| 上下文菜单 | `["ContextMenu"]` / `["Shift","F10"]` | 是否实际出现菜单 |
| 应用组合键 | `["Control","Alt","Shift","s"]` | 不把示例解释为任何站点都支持 |

按键是发给页面的浏览器输入事件，不是操作系统自动化。浏览器菜单、地址栏、系统全局热键及硬件功能不保证响应；导航和切标签使用专用工具。剪贴板复制/粘贴仍受权限限制；不得宣称 Ctrl+C/V 已成功搬运数据。映射完整不代表每个应用实现了同样的快捷键。

## 在线表格流程

1. structure/accessibility 确认文档类型、工作表、名称框、选区、公式栏、编辑器和权限。
2. 有名称框时，fill 范围地址，再 keys Enter 导航；重新确认选区。
3. 按实际应用约定使用 Enter/F2 进入编辑状态，读取新 focus，再 type。
4. 提交后重新观察单元格值或公式以及保存反馈。
5. 批量数据先小范围核验，再使用已授权数据通道；多维表格需要字段/记录语义，不能一律套 A1。
6. 名称框、快捷键或辅助功能未提供足够证据时，明确说明卡点；不能猜格子、隐藏公式或未加载数据。

## 网络与脚本

网络 start 后才捕获请求，read 分页返回元信息/受限预览及 dataRef（stats 给出预算对账：已存/缺失/在途/丢弃），stop 结束当前观察，停止后仍可读取已捕获结果。默认上限100请求、正文每条1M字符/合计4M字符、正文抓取并发4（超出排队不丢弃）、默认55秒（durationSec 10–300 可调）。非文本、超限或缓冲逐出的正文明确标记 unavailable 原因；掉包与未覆盖子 target 会声明，不宣称全量。两个 action agent（文本通用助手 / 视觉通用助手）不携带网络观察工具：它们的职责是操作页面，观察网络对定位与操作是噪声，且该工具占用与视觉 GUI 共享的调试会话互斥队列。

脚本支持 Chrome FrameId，不会在子 frame 不可执行时静默改用主页面。编译权限探测失败才能安全切换引擎；用户代码已经开始、无返回或传输异常均不自动重放。代码统一为 async 函数体，使用 return 返回结果；不再猜测表达式完成值或通过错误文案重试。CDP 执行失败不再自动去另一个 world 重放。

## 恢复与技能记录

STALE_ELEMENT/STALE_SNAPSHOT/FOCUS_CHANGED 重采；WRONG_TAB 切回来源或在当前页面重采；QUERY_MISMATCH 新建查询；无数据结合 coverage 判断。对结果不确定的发送、提交、追加先读取现状，禁止盲目重试。

技能保存 regex/XPath、语义、工作表/记录识别和恢复规则，不能保存 ElementId、AX 引用、snapshotId、captureId 或固定 FrameId。

## 验证与边界

| 场景 | 本轮支持与处理规则 |
|---|---|
| 重复 ID、特殊字符 ID、节点重排 | 使用文档内节点引用，不根据 CSS 顺序猜测 |
| SPA、同 URL 重载、frameId 复用、标签切换 | 文档标识、来源标签与语义复核；失效后重采 |
| Shadow DOM | 遍历开放根和扩展 API 可访问的封闭根；不宣称跨所有嵌入环境 |
| 虚拟列表、懒加载、多级滚动 | 指定容器双轴滚动后重采；只报告当前已加载范围 |
| 在线表格、富文本编辑器 | DOM/AX 找入口，名称框或键盘导航，读取实际编辑焦点，再原生输入并验证 |
| 纯 Canvas/WebGL、远程桌面、游戏 | 仅在应用另行暴露 DOM/AX/授权数据源时可推进；像素本身不能由文本工具恢复 |
| 跨进程 frame、Worker、二进制同步协议 | 明示未覆盖范围；不能把空树或无网络记录解释为无数据 |
| 原生文件/权限窗口、验证码、登录验证 | 不属于页面节点工具的通用处理范围，需要用户完成相应步骤 |
| 协作修改、保护区域、筛选/隐藏行列 | 业务身份与当前权限再次核对；索引不等于记录身份，不绕过保护 |

会话脚本求值统一由全局 js_run 提供，先创建脚本再按相对路径运行；内容脚本命令发送是不同能力，仍单独保留。

- tests/tools/element-interaction.test.ts：实际 DOM 引用、快照、跨 tab/frame、过期、竞态、Shadow DOM、标准输入校验。
- tests/tools/text-automation.test.ts：辅助功能引用、原生键盘释放/取消、状态变更与真实响应捕获的协议模拟。
- npm run test:text-browser：真实 Chromium 的名称框/F2/Unicode/Enter、可信按键、AX 激活、容器双轴滚动、iframe/shadow 输入、响应正文 dataRef、大结果完整暂存、脚本错误/无结果不重放；断言零截图调用。

以上不是对 Google/飞书/钉钉全部账号与版本的站点认证。纯文本能力取决于应用暴露的 DOM/辅助功能/接口；纯像素且没有语义的数据、未获授权区域和未加载内容不能凭空恢复。浏览器级输入并不绕过文档权限。

依据：[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[扩展 ShadowRoot API](https://developer.chrome.com/docs/extensions/reference/api/dom)、[CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)、[CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)、[Google Sheets 键盘与辅助功能](https://support.google.com/docs/answer/1632199?hl=en)。
