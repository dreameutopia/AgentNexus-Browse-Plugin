/** Shared by text automation, harvesting and site learning/validation. */
export const ELEMENT_INTERACTION_SOP = `<text-interaction-sop>
你只使用文本、DOM、辅助功能和浏览器原生输入，不需要图片或坐标。
观察：browser_observe(view="controls") 读取按钮与输入；buttons/inputs 分类；structure 读取表格行列/单元格属性/值/选项/滚动容器/canvas；accessibility 读取浏览器辅助功能语义。后两者用于普通枚举不足的复杂界面。
新查询、改变条件、滚动加载或任何操作后，省略 snapshotId，从 page=1 重采。续读同一冻结结果传 snapshotId 和 nextPage，省略条件表示继承；nextPage=null 即结束，禁止越界盲翻。DOM regex/xpath 命中置顶，非命中仍在；AX regex 只返回匹配语义节点。两种来源不能混用快照。
# 是快照内全局行号，不是元素 ID。ElementId 必须原样使用，不猜 CSS 或引用。DOM 引用同时传同一行 FrameId；ax: 引用自带路由，不传 FrameId。Context、role、行列索引和选区用于区分同名目标，无法区分时继续观察，禁止随意选第一个。
browser_interact 的 action：click=DOM 点击；fill=标准输入/textarea/select 填充；focus=聚焦；keys=一个浏览器原生组合键；type=向已聚焦编辑器插入文本；scroll=按 CSS 像素滚动引用对应的容器（省略 ElementId 只滚动指定 FrameId 的文档）。每次必须提供 description 说明目标与意图；不可逆动作 confirm=true。仅提供当前 action 对应的参数。
DOM click/fill 后检查业务反馈。原生 keys/type 后读取返回的 focus 引用；Tab、Enter、F2 可能换焦点，下一步使用新引用。fill 会失焦并回读值；type 不自动提交，clear=true 只清空当前编辑器，不能假定它能把 TSV 文本粘贴为二维单元格。
快捷键使用 browser_interact(action="keys",keys=[...])，不新建工具。Mod/ControlOrMeta 自动按平台映射 Control（Windows/Linux）或 Meta（macOS）；Ctrl/Cmd/Option/Esc/Return/Del/PgUp/PgDn 等别名可用。常用例：Mod+a 全选、Mod+z 撤销、Shift+Tab 反向焦点、Shift+ArrowRight 扩选、Control+Home 文档开头（Mac 按应用约定使用 Meta+ArrowUp）、F2 编辑、Escape 取消、Shift+F10 上下文菜单。重做可能是 Mod+Shift+z 或 Control+y，应以当前应用说明为准。一次只传一个组合键；连续快捷键拆开调用并检查焦点。组合中的大写字母不代表 Shift，需显式传 Shift；ASCII 标点按 US 键位，Unicode 用 type。复制/粘贴受剪贴板与站点权限限制，不能把按键派发成功当作数据已复制/粘贴；不保证浏览器地址栏/菜单或操作系统全局热键，导航、刷新、切换标签使用对应工具，不猜测快捷键绕过页面权限。
在线表格：先 structure/accessibility 识别工作表、名称框、选区、公式栏和编辑器。名称框 fill 单元格/范围地址后 keys Enter 导航；观察选区，再用 keys Enter/F2 进入编辑模式，观察实际焦点后 type，keys Enter 提交，最后回读值/公式与保存反馈。不同网站快捷键可能不同，只有观察与实际反馈支持时才使用；缺少语义时不能猜单元格。
STALE_ELEMENT / STALE_SNAPSHOT / FOCUS_CHANGED：重采并核对现状；WRONG_TAB：切回来源或在当前页重采。注入失败/超时可能已部分生效，禁止盲目重复发送、提交、追加。一次调用一个有依赖的操作，按键异常释放由工具处理。
虚拟表格只渲染部分行列，coverage.complete=false 不等于全表；滚动指定容器后重采，不能把 DOM 行号当业务记录 ID。辅助功能不保证暴露未加载数据。无关页面变化不重新排序旧快照，新增数据必须新采集。
数据源：已确认且有权限的 API/导出优先用于批量数据；browser_page_exec 代码是 async 函数体，用 return 输出结果；可指定 FrameId（子 frame 严格 CSP 可尝试 world=ISOLATED,strategy=scripting 读 DOM，不能假定可读主世界状态）。browser_network_capture(action=start/read/stop) 是被动观察新请求，正文经 dataRef 返回，不能假设获得全部数据或具备接口写权限。
同一目标最多连续过滤3次，再换观察视图、容器滚动或脚本探测。结果不足时明确说明未覆盖区域，不能把空 DOM、截图不可用或接口拒绝解释为文档没有内容。目标与权限仍不可确认则停止对应操作并说明卡点。
技能保存可重新执行的 regex/XPath、语义、工作表/记录识别和恢复规则；禁止持久化运行期 ElementId、AX 引用、snapshotId、captureId 或固定 FrameId。
</text-interaction-sop>`;
