/** Shared by text/vision automation and data collection; learning owns its guidance. */
export const ELEMENT_INTERACTION_SOP = `<text-interaction-sop>
以下规则适用于文本、DOM、辅助功能和浏览器原生输入通道；视觉策略也保留这些能力。
观察用 browser_observe，枚举、节点详情与分页的参数边界以工具说明为准。普通控件不足以理解复杂界面时换 structure/accessibility；需核对 XPath、属性或状态时读取节点详情。
定位优先可见语义、所属区域与稳定属性；已知 XPath 先验证，未命中再按文字/placeholder/aria-label 搜索。role 不等于HTML标签，不能因角色是button就猜 //button。用 Context、role、行列索引、选区和节点属性消歧同名目标，无法区分时继续观察，禁止随意选第一个；引用必须来自当前观察结果，不能猜测或构造。
browser_observe 可用 categories 严格筛选语义类别，Category/State 与 details 提供角色、判断依据、实时状态、关联弹层和可用操作。关闭入口标 close 并优先展示，不代表应自动关闭。复杂自定义控件先展开/搜索后重采，通过 controls/owns 关联限定列表，不能全页猜同名选项；虚拟列表需滚动后重采。
browser_interact 的 action：click=DOM 点击；fill=标准输入/textarea/单选 select 填充；set_checked(checked)=幂等勾选，不能用 fill("false") 取消；set_expanded(expanded)=幂等展开/收起；set_selected(selected)=设置 option/tab 等选中状态；select(values)=原生 select 明确替换选中集合（多选可 [] 清空），自定义关联列表每次选一项，自定义多选逐项设置并重采；focus=聚焦；keys=一个浏览器原生组合键；type=向已聚焦编辑器插入文本；scroll=按 CSS 像素滚动引用对应的容器（省略 ElementId 只滚动指定 FrameId 的文档）。每次必须提供 description 说明目标与意图。仅提供当前 action 对应的参数。
DOM click/fill 后检查业务反馈。原生 keys/type 后读取返回的 focus 引用；Tab、Enter、F2 可能换焦点，下一步使用新引用。fill 会失焦并回读值；type 不自动提交，clear=true 只清空当前编辑器，不能假定它能把 TSV 文本粘贴为二维单元格。
快捷键使用 browser_interact(action="keys",keys=[...])，不新建工具。Mod/ControlOrMeta 自动按平台映射 Control（Windows/Linux）或 Meta（macOS）；Ctrl/Cmd/Option/Esc/Return/Del/PgUp/PgDn 等别名可用。常用例：Mod+a 全选、Mod+z 撤销、Shift+Tab 反向焦点、Shift+ArrowRight 扩选、Control+Home 文档开头（Mac 按应用约定使用 Meta+ArrowUp）、F2 编辑、Escape 取消、Shift+F10 上下文菜单。重做可能是 Mod+Shift+z 或 Control+y，应以当前应用说明为准。一次只传一个组合键；连续快捷键拆开调用并检查焦点。组合中的大写字母不代表 Shift，需显式传 Shift；ASCII 标点按 US 键位，Unicode 用 type。复制/粘贴受剪贴板与站点权限限制，不能把按键派发成功当作数据已复制/粘贴；不保证浏览器地址栏/菜单或操作系统全局热键，导航、刷新、切换标签使用对应工具，不猜测快捷键绕过页面权限。
在线表格：先 structure/accessibility 识别工作表、名称框、选区、公式栏和编辑器。名称框 fill 单元格/范围地址后 keys Enter 导航；观察选区，再用 keys Enter/F2 进入编辑模式，观察实际焦点后 type，keys Enter 提交，最后回读值/公式与保存反馈。不同网站快捷键可能不同，只有观察与实际反馈支持时才使用；缺少语义时不能猜单元格。
not_dispatched 表示交互未派发，按错误修正参数或前置条件；unknown/超时可能已部分生效，先核对业务回执，禁止盲目重复发送、提交、追加。STALE_ELEMENT / STALE_SNAPSHOT / FOCUS_CHANGED：重采并核对现状；WRONG_TAB：按已记录的来源 tabId 切回或在当前页重采。一次调用一个有依赖的操作，按键异常释放由工具处理。
动作前绑定目标业务对象，动作后有界等待并核对对应结果；页面load、临时disabled、消息列表顶部都不能单独证明业务成功或服务端去重。批量操作按稳定业务ID逐条记录成功/失败/未知、边加载边处理；学习/验证样本数与用户实际执行数量分开，达到授权范围或业务终止条件即停止，不先加载全量再开始。选择与范围只有新证据或用户要求变化时才重新决策。
虚拟表格只渲染部分行列，coverage.complete=false 不等于全表；滚动指定容器后重采，不能把 DOM 行号当业务记录 ID。辅助功能不保证暴露未加载数据。无关页面变化不重新排序旧快照，新增数据必须新采集。
数据源：已确认且有权限的 API/导出优先用于批量数据。重复列表（商品卡片/评论/表格行）先 browser_observe 找到任一项，再用 browser_dom_explore 理解结构：action="parent" 找重复容器层（同构兄弟 ≥2 即疑似）、action="similar" 拿全部同类元素与生成选择器、action="children" 确认字段布局；生成的选择器直接写进 browser_page_exec 抓取脚本，其返回的新引用同样可用于 observe 节点详情与 interact 操作。browser_page_exec 代码是 async 函数体，用 return 输出结果（对象数组最佳，可直接 xlsx 导出）；抓取结果默认暂存为 dataRef 引用；可指定 FrameId（子 frame 严格 CSP 可尝试 world=ISOLATED,strategy=scripting 读 DOM，不能假定可读主世界状态）。
同一目标最多连续过滤3次，再换观察视图、容器滚动或脚本探测。结果不足时明确说明未覆盖区域，不能把空 DOM、截图不可用或接口拒绝解释为文档没有内容。目标与权限仍不可确认则停止对应操作并说明卡点。
技能保存可重新执行的 regex/XPath、语义、工作表/记录识别和恢复规则；禁止持久化运行期 ElementId、AX 引用、snapshotId、captureId 或固定 FrameId。
</text-interaction-sop>`;
