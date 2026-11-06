# 文本网页控件感知与交互

## 设计依据

优先级为原生 HTML 行为、显式 ARIA 角色/状态、框架公开的状态属性、交互外观线索。
不读取 React/Vue 私有实例，不依赖某个组件库的混淆类名，不直接修改 ARIA 属性伪造交互成功。
`evidence` 区分 native、aria-role、label-control、name、attribute-hint、interaction-hint 与 generic。
关闭标记和排序只是帮助发现，不会自动关闭页面或代替操作后果判断。

参考官方资料：

- [WAI-ARIA APG 控件模式目录](https://www.w3.org/WAI/ARIA/apg/patterns/)
- [Combobox：关联 listbox/grid/tree/dialog、活动后代和焦点](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/)
- [日期选择器：输入、弹窗和日历网格的组合](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/examples/datepicker-dialog/)
- [HTML input：类型、值与约束](https://html.spec.whatwg.org/multipage/input.html)
- [Radix Select：Trigger/Portal/Content](https://www.radix-ui.com/primitives/docs/components/select)
- [Radix Checkbox：data-state 与半选](https://www.radix-ui.com/primitives/docs/components/checkbox)
- [Headless UI Listbox：多选与状态属性](https://headlessui.com/react/listbox)
- [Element Plus Select：多选、搜索、远程数据和 Teleport](https://element-plus.org/en-US/component/select.html)
- [Ant Design Select：搜索、多选、Portal 与虚拟化](https://ant.design/components/select/)
- [MUI Select：原生/自定义、多选](https://mui.com/material-ui/react-select/)

这些资料用于提炼通用机制，不构成对所有版本组件库的兼容认证。

补充审计参考：[ARIA Grid](https://www.w3.org/WAI/ARIA/apg/patterns/grid/)、[Treegrid](https://www.w3.org/WAI/ARIA/apg/patterns/treegrid/)、[AG Grid Accessibility](https://www.ag-grid.com/javascript-data-grid/accessibility/)、[React Aria DateRangePicker](https://react-aria.adobe.com/DateRangePicker)、[MUI 日期区间](https://mui.com/x/react-date-pickers/date-range-picker/)、[Element Plus DatePicker](https://element-plus.org/en-US/component/date-picker)。

## 感知契约

`browser_observe` 的 DOM 枚举保留原有前六列表格，增加 Category/State。
`details` 返回类别、原始角色、判断依据、名称、实时状态、关联引用和可用操作。
原有 Type（如 input_date）保留；自定义 ARIA 控件会返回有意义的语义 Type。

`categories` 是严格的 OR 类别筛选，支持所有枚举视图。regex 仍然只把命中项置顶，
XPath 保持原有范围语义。三者可以组合。节点详情不接受 categories。
快照绑定排序后的类别集合；续读省略继承，改变集合必须新查询。
冻结分页成员与顺序，但交付时更新 value/checked/expanded 等状态；操作使旧快照失效。

类别：button、close、link、text、search、password、number、date、time、color、slider、
spinbutton、checkbox、radio、switch、toggle、select、multiselect、combobox、listbox、option、
menu、menuitem、tab、tablist、tree、treeitem、grid、gridcell、dialog、disclosure、group、
toolbar、tooltip、status、progress、meter、separator、file、editor、scroll、element。

补充基础类别：table、row、cell、columnheader、rowheader、tabpanel。
复合模式 calendar、date-range、time-range、date-segment 同样可通过 categories 筛选，
但保留原来的基础类别，例如同一节点可同时是 grid 和 calendar；结果通过 patterns 标出复合模式。
calendar/range 只根据明确的 data 标记或组件 slot 标记识别，不把所有 grid 或任意两个日期字段猜成日历/区间。
未提供这些标记的组件仍通过原生输入、ARIA grid/group/spinbutton 等基础语义发现。

类别筛选限制在所选 view 的范围内。状态提示、进度、提示气泡、普通表格等信息节点优先用
structure/accessibility；inputs 只列可填充输入，buttons 主要列点击入口。
DOM 与 AX 反映各自的数据源：例如原生单选 select 在 DOM 中为 select，在 Chromium AX 中可能是 combobox。

## 控件适配矩阵

| 控件族 | 感知内容 | 操作与核对 |
|---|---|---|
| 文本/搜索/email/url/tel/password/textarea | 类型、标签、只读/禁用、值与约束；密码不返回值 | fill 或原生 type；核对回读，遵守实际焦点 |
| contenteditable/富文本 | editor、可编辑状态 | fill/type/keys；复杂编辑器仍需业务核对 |
| date/datetime-local/month/week/time | 原生类型、值、min/max/step/valid | 按标准格式 fill；不接受格式或约束违规不报成功 |
| 日期范围、多月面板、时间段选择 | 组合框、dialog、grid/gridcell、按钮、选中/禁用状态 | 展开后重采，逐步选日期/时间，再确认输入值；不按“5”猜月份 |
| 原生 select | 全部选项中的前100项、选中/禁用、截断标记 | select(values)；先按 value，再按唯一文字；禁用 optgroup 也拒绝 |
| 原生 multiple select | selectedValues、每项 selected | 明确替换整个集合，[] 清空；先验证全部目标，避免部分修改 |
| 自定义 combobox/autocomplete | expanded、autocomplete、controls/owns、activedescendant | set_expanded、fill/type 搜索、重采、select；限定明确关联列表 |
| 原生 datalist | 建议值/label、list 关联、截断 | input fill/keys；不将浏览器原生建议菜单假定为页面 DOM |
| 自定义单选/多选 listbox | multiselectable、option selected、组关联 | 单项 select；多选逐项 set_selected，重采并核对集合 |
| checkbox | checked/mixed、原生 indeterminate | set_checked；不会用 fill 修改 value 冒充取消勾选 |
| radio/radiogroup | checked、name、组上下文 | set_checked(true)；取消通过选中同组另一项 |
| switch/toggle/menuitemcheckbox/menuitemradio | checked/pressed，Radix data-state 辅助状态 | set_checked 幂等事件交互与回读 |
| 隐藏原生 input＋可见 label | label-control 显式关联、原生状态 | 对可见 label 设置勾选；不强点隐藏 input |
| tabs、可选树节点、网格选区 | selected、level、posinset/setsize、组关联 | set_selected 或 focus/keys；树/级联按层展开重采 |
| menu/menuitem | 菜单角色、弹层关联、禁用项 | 展开/重采，普通命令用 click；有选择状态的项可设置状态 |
| details/summary、accordion、树展开 | 原生 open 或 aria-expanded | set_expanded；无状态时显式 click 后观察 |
| slider/spinbutton/color/range | 原生约束或 aria-valuemin/max/now/text | 原生 input 可 fill；自定义用 focus/keys 后观察值，无通用拖拽承诺 |
| dialog/alertdialog、关闭入口 | modal、所属 dialog、close 类别与识别依据 | 关闭入口提高排序；click 后核对弹窗是否消失 |
| 上传 | file、accept、多文件属性可通过节点详情读取 | 使用已有上传工具；fill 拒绝 file |
| 滚动/虚拟列表/树/级联/异步搜索 | 已渲染边界、滚动状态、busy、活动后代 | scroll/搜索后重采，不宣称抓到全部未加载项 |
| toolbar、tooltip、status/alert/log、progress/meter、separator | 角色、状态、数值/说明 | structure/AX 取证；有交互语义时配合 keys/click |
| React/Vue 自定义点击 div | 原生/ARIA 优先，否则外层 pointer 表面 | 外观线索只标 interaction-hint；不猜框架内部状态 |
| Canvas/WebGL、仅 CSS 绘制而无语义的控件 | 只能报告暴露的 DOM/AX | 不推断像素控件；使用已有其他通道或让页面提供语义 |

## 多轮调用

```json
{"view":"controls","categories":["combobox","select","multiselect"]}
```

复制行上的 elementId/frameId；若自定义控件已暴露 expanded=false：

```json
{"action":"set_expanded","elementId":"<观察引用>","frameId":0,"expanded":true,"description":"展开目标城市字段"}
```

操作后重新观察，确认 relation.controls/owns 对应正确弹层。可以对组合框执行
`select(values:["目标值"])`，也可以直接对明确 option 执行 set_selected。
缺少关联、重名、目标未加载或未暴露状态时返回明确错误；不会全页查找同名文字并点击。
需要先搜索、滚动或通过 keys 导航时，完成一步后继续重采。

原生多选直接使用 `select(values:["a","b"])`；自定义多选按选项逐次设置。
set_checked/set_selected/set_expanded 在已经达到目标状态时返回 changed=false，避免反复切换。
点击引发节点替换、传输丢失或回读不一致时保守返回 unknown，不自动重放。
常见的“选项被卸载但组合框仍在”会额外核对原组合框的值：仅当它从原值变为目标选项的精确值/文字，才独立确认成功；自定义多选不使用这一单值推断。
原生约束失败时，值可能已经写入，修正前先读取现状。

## 防御与验证

- DOM 引用仍按 tab/frame/文档/节点身份与语义复核，不接受 CSS/行号冒充引用。
- 支持可注入 frame、可访问 Shadow roots；ARIA ID 关系限定本作用域，避免跨根同名碰撞。
- 原生 property 优先于静态 checked/selected 属性；ARIA 优先于框架 data-state。
- data-state/data-headlessui-state/data-selected 仅在明确角色下补充状态，不根据样式 class 伪造状态。
- 祖先 aria-disabled/inert/data-disabled 也阻止 DOM、焦点和键盘输入；data-disabled="false" 不当作禁用。
- 候选值、重复项、歧义、禁用、readonly 先校验。事件造成替换时不继续操作旧节点。
- Pointer/Mouse 事件仍是合成事件；要求 isTrusted、真实拖拽、用户激活或系统原生窗口的控件可能需要其他通道。
- 不自动打开未知弹层再猜目标，也不直接写框架状态或无限等待异步结果。
- 统一运行时负责 native/ARIA/框架状态读取与跨祖先渲染判断，版本变化会换发引用；避免观察与操作各自实现不同的状态规则。
- 对祖先透明、content-visibility:hidden、重复 aria-controls/owns ID、嵌套列表、聚焦后禁用/只读等情况分别防御。
- 原生表格的 domRowIndex/domCellIndex 是零起始 DOM 序号，不等于含合并单元格或虚拟化的逻辑地址；逻辑索引只采用页面声明的 ARIA 值。
- 日期区间字段保留独立引用和值，按页面格式和约束逐个操作；不猜时区、历法、夏令时或起止字段，不将局部成功当成区间业务已保存。
- 错误返回保留 errorCode/phase，并由交互宿主在 data.cause 中提供原因；null、字符串等异常也会得到有界可读信息。
- 选项最多100项，每项值/文字最多500字符；截断会明确标记，不能把截断的前缀当作完整选项值。

`npm run test:tools` 覆盖序列化注入、状态、类别筛选和多轮快照。
`npm run test:semantic-controls:unit` 独立运行 DOM/AX 公共工具回归，便于区分注册表或脚本执行等其他工作区改动。
`npm run test:semantic-controls` 在真实 Chromium 中验证原生/ARIA、Pointer-down 展开、Portal、
多选、日期约束、AX 类别、幂等与节点替换，以及已有焦点/按键/frame/shadow 流程。
`npm run test:text-browser` 还会运行独立的脚本执行/dataRef 回归。

新增 complex-controls 场景覆盖日期/时间区间、分段日期、日历网格、排序与合并表头、虚拟行复用（包括深层包装）、重复 ID、嵌套列表、聚焦竞态和非 Error 异常。
