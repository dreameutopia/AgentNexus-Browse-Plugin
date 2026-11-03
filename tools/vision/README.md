# Vision Action：相对坐标 GUI 驱动

视觉助手的观察工具、能力上限及与 Vision Action 的职责区别见 [视觉助手设计](VISION_ASSISTANT.md)。视觉助手解释并指导用户操作；Vision Action 接受委托后实际执行并验证。

Vision Action、网站视觉学习/验证以及 WebSocket 视觉命令共用 CDP 输入驱动。
旧的像素 bbox、数字 ID 点击、simple/advanced 双协议已删除，不提供兼容入口。
需要 Chromium 的 `chrome.debugger`、`scripting` 权限及可访问的网页标签页。
Firefox、不允许调试的页面、浏览器地址栏/菜单、操作系统对话框和桌面不受此驱动控制。

## 坐标和截图

视觉循环每轮工具完成后，强制等待 **3 秒**再自动截图，可由用户停止提前中断；同一批工具里显式调用 screenshot 也不能绕过操作后的间隔。首截图、无需续拍的只读结果、已返回并复用的截图不额外重拍。动画／异步生成需要更长时间时，Vision Action、视觉助手和 Auto Action 均可用 `generic_wait({waitSeconds})`：有限非负秒数，超过 600 自动限制为 600，支持取消。长等待采用独立执行超时，不会被常规 120 秒工具超时截断；等待时间不消耗主动工作预算，实际总耗时仍照常统计。等待结束须重新核对页面结果。

`screenshot({mode:'observe'})` 使用 `tabs.captureVisibleTab`，不附加调试器；视觉助手的自动和手动截图均强制此模式，观察 ID 不允许执行 GUI 输入。默认 `mode:'action'` 保留 CDP 会话，供 Vision Action / WebSocket 交互使用。

首次附加 debugger 后先等待连续两次视口采样稳定，再截图；捕获期间几何变化最多重拍一次，不重试输入动作。会话保留至少覆盖截图 120 秒有效期及 30 秒余量，避免原来的 60 秒闲置脱离在模型思考期间使提示栏消失。用户主动断开或 DevTools 抢占后，检查旧 ID 不会重新附加调试器，必须取新图。

调试提示栏属于 Chrome 浏览器界面，不能通过页面 DOM 隐藏。采用实际 `innerWidth/innerHeight` 和 PNG 尺寸校验，不减去固定提示栏高度，不通过设置虚拟视口掩盖不一致。截图返回 `captureMode` 和 `timings.totalMs/attempts`，后台 `[VisionCapture]` 日志可区分截图耗时与后续模型请求耗时。

依据：[Chrome 可见标签截图与限频](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)、[debugger 会话及断开事件](https://developer.chrome.com/docs/extensions/reference/api/debugger)、[Chromium 调试提示栏生命周期实现](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc)。

所有位置均为 `{x,y}`，x 从左至右、y 从上至下，独立归一化到 **0–1000**。
原点为整张最新可见视口截图左上角，不是文档全文、元素内部、设备像素或裁剪图。
例如中心为 `{x:500,y:500}`。输入允许小数；1000 边界会定位到最后一个 CSS 像素内部。
映射：`cssX = x / 1000 * window.innerWidth`，y 使用 `window.innerHeight`。
这里的视口**包含滚动条占用的区域**，与未裁剪 PNG 一致；不能用排除滚动条的 `cssVisualViewport.clientWidth/clientHeight` 代替。
真实 Chromium 回归复现过：PNG 对应 1000×700 CSS 像素，但内容视口为 985×685，旧公式会使右下方目标出现约 14px 偏移。
现在截图前后测量完整 CSS 视口、DPR、文档和滚动状态，并从 PNG IHDR 读取真实像素尺寸。
只有 PNG 尺寸与完整 CSS 视口 × DPR 相符（允许光栅化舍入误差）才发布可用的 screenshotId；不一致时返回几何诊断并拒绝输入。
等比改变模型侧图像分辨率不改变相对位置；不要再乘 DPR，不要添加页面 scrollX/scrollY。
普通浏览器页面缩放通过 CSS 视口处理；非 1 倍 pinch zoom 或存在视觉视口偏移时明确拒绝，需先复位。

自动截图附带 `screenshotId`、CSS 视口尺寸和坐标说明。每个交互都必须传最新 ID。
一个截图最多执行一个手势；动作开始后即消耗截图，部分失败也不能重放。
截图有效期 120 秒；切换标签、URL/顶层文档重载、视口/滚动变化均拒绝旧图。
网页自身仍可能在截图后动态改变布局，模型必须结合新图验证结果，不能只依赖 API 成功状态。
截图失败时调用 `screenshot` 恢复，禁止猜测 ID 或沿用历史位置。

## 工具

所有工具均需 `screenshotId`（`screenshot` 除外）。

| 工具 | 参数与行为 |
| --- | --- |
| `screenshot` | 原样截取可见网页，不隐藏滚动条、不移动布局，返回新截图和 ID |
| `vision_click` | `point`, `button: left/right/middle`, `count: 1/2/3`, 可选 `modifiers`, `holdMs: 0..3000`；支持修饰键点击和长按 |
| `vision_drag` | `from`, `to`, 可选最多128个 `waypoints`、`button`、`modifiers`、总移动 `durationMs: 200..3000`、`holdBeforeMs/holdAfterMs: 0..3000`；经过所有中间点，按住等待再释放 |
| `vision_scroll` | `direction + percent: 0.001..300`，或互斥的 `deltaX/deltaY: -20000..20000` CSS像素；支持斜向与精细滚动，可选 `point`, `durationMs`, `modifiers` |
| `vision_input` | `point`, `text`（最多 10000 UTF-16 单元）, `clickFirst`、`clear`；`inputMode: text` 插入Unicode字素，`keys` 对可打印ASCII派发逐键事件 |
| `vision_hover` | `point`, 可选 `durationMs`、`modifiers`，默认停留 500ms |
| `vision_keyboard` | `keys` 同时按下的组合，最多 5 个；支持左右修饰键、F1–F24、编辑导航/锁定键、字母数字和ASCII标点、数字小键盘；大写/移位符号推断Shift，字符键为US布局，别名与物理键重复会拒绝 |
| `vision_mark` | 请求**下一次自动截图**绘制元素框和数字，不直接截图、不点击 |
| `vision_inspect` | `id`：检查该截图数字元素的 CSS/XPath、frameId、shadow scope、属性、文字、状态、选项和祖先信息 |

### 快捷键调用与映射

`vision_keyboard({screenshotId,keys:["Control","Shift","ArrowLeft"]})` 表示一个同时按下的组合键；动作结束逆序释放，失败也会清理。每个后续组合使用自动回传的新截图，不能把连续的多个快捷键拼进同一个数组。先点击目标控件确认焦点。

| 用途 | Windows/Linux 常见组合 | macOS 常见组合 |
| --- | --- | --- |
| 全选、复制、剪切、粘贴 | Control + a/c/x/v | Meta + a/c/x/v |
| 撤销、重做 | Control+z，Control+Shift+z 或 Control+y | Meta+z，Meta+Shift+z |
| 查找、保存 | Control+f/s | Meta+f/s |
| 焦点与激活 | Tab、Shift+Tab、Enter、Space、Escape | 同左 |
| 扩展选区、按词移动 | Shift+方向键、Control+方向键 | Shift+方向键、Alt+方向键 |
| 文档首尾 | Control+Home/End | 应用通常使用 Meta+ArrowUp/Down |

应用可以重定义以上行为，保存/提交等操作仍遵守授权与确认规则。快捷键字母用小写；`A` 和 `!` 会推断 Shift。支持别名 Ctrl、Cmd/Command/Win/Super（Meta）、Option（Alt）、Esc、Return、Del、Ins、Spacebar、Left/Up/Right/Down、PgUp/PgDn。别名区分大小写，不接受 `"Ctrl+C"` 这样的单字符串表达式。

修饰键可指定 ControlLeft/Right、ShiftLeft/Right、AltLeft/Right、MetaLeft/Right。数字小键盘支持 Numpad0–9、NumpadEnter/Add/Subtract/Multiply/Divide/Decimal，按数字/运算符语义派发，不模拟硬件 NumLock 状态切换。其他支持键包括 F1–F24、ContextMenu、CapsLock、NumLock、ScrollLock、Pause、PrintScreen。物理键重复（如 Ctrl 与 ControlLeft）会返回 INVALID_ARGUMENT。

这些是网页内容区的 CDP 键盘事件，不保证触发系统截屏、Alt+Tab、地址栏或浏览器保留快捷键。剪贴板受权限和页面处理影响，必须核验实际结果；输入已知文本可直接使用 vision_input。标签页管理、URL 导航和刷新优先使用专用浏览器工具。字符与物理键不同，US字符映射及位置字段参考 [KeyboardEvent.code](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/code) 和 [CDP Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)。

### 鼠标手势与输入细节

滚动百分比的基数是当前可见视口的高度（纵向）或宽度（横向），不是总内容高度或剩余可滚动距离。
推荐传组件内部的 point，以便浏览器把滚轮路由到嵌套滚动区域；不传则使用视口中心。
实际滚动可能受容器边界、滚动吸附、overscroll、页面脚本影响，应检查下一张截图。
`deltaX/deltaY` 是发送给浏览器的轮事件增量，支持小数；不等于承诺页面最终滚动同样距离。
`modifiers` 可用于 Shift 点击、Control/Meta 多选、Alt 拖动等。按键只保持当前手势，成功/失败均释放，不跨截图留下按住状态。
路径中的坐标仍为当前截图的相对坐标；waypoints 是必须经过的点，不对指定路径额外添加弯曲。显式传 `waypoints: []` 得到精确直线；省略该字段时默认直达拖动有轻微弯曲。
总移动 durationMs 在所有路径段之间分配，不会给每段分别套一整个 durationMs；起终点持有时间另计。
HTML5 拖放终点额外发送一次移动，以覆盖需要第二次移动才触发 dragover 的常见浏览器行为。标准 draggable/drop 场景已实测，不能据此保证所有站点的拖放框架或文件拖放。
`inputMode: keys` 适合依赖 keydown/keyup 的控件，当前仅支持可打印 ASCII，不接收 Enter/Tab 或 Unicode；这些分别使用键盘工具或 text 模式。
text 模式支持 Unicode，但不模拟输入法候选窗或 composition 流程。客户端对 keydown 的 `preventDefault` 会被 keys 模式尊重，输入后仍需观察值和业务状态。
拖拽轨迹使用加减速和轻微弯曲，精确抵达终点；异常路径尝试释放鼠标。
键盘也在异常路径释放已按下的键。输入保留 Unicode 字素，按长度调整停顿，避免长文本长时间占用输入通道。
手势有 20 秒执行预算，超限或目标切换会中止；可能已部分输入，必须检查后继续。
工具不会自动重试交互。浏览器断开调试或页面关闭时无法保证向已失去的目标送达释放事件。
调试会话更换会使旧截图失效。输入事件不会为了继续旧动作而自动重新附加调试器。
聊天停止和工具超时通过内部请求 ID 传递取消信号，后台在派发下一步前检查并走释放路径；已经发送的浏览器原生事件无法撤回。
排队等待超过 30 秒的请求拒绝执行。单条浏览器命令、脚本注入、清理和文件传输均有独立等待上限。
输入焦点在每个字素前核对同一元素引用；跨平台清空分别使用 Windows/Linux Control+A、macOS Meta+A。
截图结果包含 `capabilities`，明确列出能力和不支持项。模型侧视口图像请求 high detail（服务支持时），这只是清晰度请求，不保证厂商保留全部像素或模型定位绝对准确。
可变停顿、变速曲线不是反检测技术：点击前的定位、页面脚本响应和服务端行为都不会因此成为“与真人完全一致”。不承诺不触发风控，不加入指纹伪装、代理轮换或验证码绕过。

## 可分析的错误结果

失败结果保留 `success:false`、可读 `error`，并在 `data.diagnostic` 和文本内容中返回结构化诊断。
`code` 区分参数错误、目标不可用、截图过期、几何变化、焦点变化、取消、超时、传输、打标及清理错误。
诊断包含 `action`、`screenshotId`/`correlationId`（适用时）、恢复建议与 `retryAutomatically:false`。
交互中途失败的 details 还包含 `outcomeUncertain`、最后 CSS 坐标与 `progress`：已释放的点击数、已输入 UTF-16 长度、已发送的滚轮累计量、拖拽阶段。
进度只表示已确认派发的浏览器事件，不宣称页面业务流程完成；超时中的最后一条命令是否生效可能未知。
清理失败会明确返回 `CLEANUP_FAILED` 并隔离该标签页的输入，后续截图需先重置不确定的调试会话。
截图 PNG 只保留在图片数据通道，不重复写入工具文本内容。

发送、提交、发布、购买、支付、删除等动作使用 `confirm:true` 和明确的 `description`，接入现有会话审批机制。
WebSocket 是受信任执行通道，其调用方负责授权；它不经过聊天工具审批界面。

## 按需打标与 RPA 检查

1. 根据原始截图操作。需要 DOM 分析时调用 `vision_mark({screenshotId})`。
2. 会话引擎执行后续自动截图：采集 frame 内可交互 DOM、分配全局数字、绘制、截图、finally 清理覆盖层。
3. 使用新截图 ID 调用 `vision_inspect({screenshotId,id})`。
4. 记录 CSS/XPath 及其 frame/shadow 作用域；后续动作继续用相对坐标。

标记仅保留下一张截图。再次截图后必须使用新 ID；需要更多检查时可以再次请求打标。
打标请求绑定页面文档和视口，页面改变后不会把旧请求静默绘到新页面。
检查使用 frame 内的实际元素引用，元素移除/导航后报错，避免用过期选择器命中另一元素。
rect/capturedRect 是 frame 局部CSS视口坐标，不能直接作为顶层截图坐标。主frame的未移动且中心在视口内的元素可附带 relativeCenter（顶层0–1000坐标）作辅助；仍需检查遮挡与页面状态。
XPath 不跨 shadow root；返回 shadowHosts 的 CSS 路径链和 xpathScope。
检查不返回密码值。DOM 扫描有数量边界，Canvas、WebGL、封闭 shadow DOM 或不可注入 frame 不保证有数字框；相对坐标输入不依赖这些框。
这套检查提供 RPA 定位信息和状态分析，不是任意 DOM 写入或脚本执行工具；需要这些能力时使用项目已有页面工具。

## 支持的视觉模型与厂商约定

这里使用项目自定义函数工具。接入条件是模型/服务同时支持截图输入和工具调用，并能遵守坐标 schema。
没有按模型名称硬编码坐标单位，也没有把各厂商原生 Computer Use 消息自动当成项目工具调用。
下表是官方协议核对结果，**不是所有列出型号都经过本项目真实账号回归测试的声明**。

| 厂商 | 官方定位约定 | 在本项目中使用 |
| --- | --- | --- |
| OpenAI | Computer Use 按截图/环境坐标，缩图后应映射回环境坐标 | 使用支持视觉与函数调用的模型，按本项目提示输出 0–1000 x/y；原生 Computer Use 动作不能直接传入 |
| Google Gemini | 检测框为 `[ymin,xmin,ymax,xmax]`，0–1000 | 按工具输出 x/y 点；如从框取中心，x 使用第二/第四项，y 使用第一/第三项 |
| Alibaba Qwen VL 开权重 | Qwen3-VL 报告采用 0–1000 相对坐标；Qwen2.5-VL 使用绝对坐标 | 推荐能按本工具 schema 调用的 Qwen3-VL 类视觉模型；不自动猜测旧模型像素单位 |
| Alibaba 托管视觉服务 | 百炼文档将 Qwen3-VL、Qwen3.5/3.6/3.7/3.8 定位结果描述为 0–999 | 工具仍要求 0–1000；如果外部解析原生 999 坐标，须显式乘 `1000/999`，不能原样假定一致 |
| 智谱 GLM V | GLM-4.5V 官方模型卡框为 `[x1,y1,x2,y2]`，宽高归一化乘 1000；GLM-4.6V 官方说明支持多模态工具调用 | 使用支持图像与工具调用的视觉版本，遵循项目点坐标 schema；不据此推断所有更新型号协议相同 |

选模型时确认其具体服务端图像输入、工具调用和图像分辨率限制；纯文本型号即使厂商相同也不能执行视觉任务。
模型名称/发布时间不是坐标协议依据。不要仅因名称更“新”而推断其能力或坐标格式。

官方资料（核对日期：2026-11-02）：

- [OpenAI Computer Use](https://developers.openai.com/api/docs/guides/tools-computer-use)
- [Gemini 图像理解与目标检测](https://ai.google.dev/gemini-api/docs/image-understanding)
- [Qwen3-VL 技术报告](https://arxiv.org/abs/2511.21631)
- [阿里云视觉理解和定位](https://help.aliyun.com/en/model-studio/vision)
- [GLM-4.5V 官方模型卡](https://huggingface.co/zai-org/GLM-4.5V)
- [GLM-4.6V 多模态工具调用](https://docs.z.ai/guides/vlm/glm-4.6v)

## 放大定位、目标守卫与结果验收

`vision_zoom({screenshotId,region:{x,y,width,height},scale?})` 裁剪原截图，不改变页面缩放，也不重拍页面。
输出父 `screenshotId`、`viewId`、按源像素边界修正的 `region`、`sourcePixels`、图像尺寸和来源时间。
动作传 `viewId` 时，point/from/to/waypoints **全部**是该局部图0–1000坐标，由驱动映射回原图；不传时仍使用完整截图坐标。
局部范围以 floor/ceil 得到的真实像素边界为准，不用请求时未舍入的region猜测。映射不依赖输出放大倍率。
图像通过多模态图片通道交给模型，并保留原截图身份；只读放大不续拍，避免刚返回的viewId失效。文本结果不重复写入PNG字节。
缓存只保留最新原图（base64上限16MiB），返回 `zoomAvailable` 供调用方判断。解码上限64MP，输出上限2048px/4MP。
源图过大时应调整窗口或使用DOM辅助，不循环重拍相同大图；放大不能恢复源图中不存在的细节。

`vision_check({screenshotId,point?,viewId?,expect?,timeoutMs?,stableMs?})` 只读返回页面状态、ARIA忙碌计数、可见对话框和点位目标。
expect 支持 `urlIncludes`、`textIncludes`、`nameIncludes`、`enabled`、`editable`、`checked`、`valueEquals`，点位条件需传point。
文字检查使用有限预算的已渲染文本节点范围及命中测试；跨节点拆分、裁剪、复杂遮挡、Canvas和iframe可能无法确证。
valueEquals在页面中比较且不返回实际值；密码值检查不开放。结果附 `observedAt`、`sourceCapturedAt` 和覆盖范围。
传了point时还返回原图坐标 `actionPoint`；跨不同局部图拖动，可分别检查取得两个actionPoint，再用原图from/to执行，不传viewId，不让模型猜测或混用坐标空间。
timeoutMs为0–5000的观察预算，stableMs为0–500的稳定观察目标（默认120ms），初始采样另留最多250ms预算；传输另有独立上限。
几何稳定、readyState完成或ariaBusyCount=0，都不等于全部网络、动画或业务已经完成。

| status | 含义 |
| --- | --- |
| passed | 显式条件全部得到符合证据，不是整个任务成功的证明 |
| failed | 至少一项条件明确不符合 |
| unknown | 至少一项条件证据不足，不能当成成功或失败 |
| observed | 未指定验收条件，只返回观察数据 |

稳定、启用、可检查的主frame DOM目标，且显式条件符合时，可以生成 `guardId`。
下一次坐标动作带上它，会在按下前复核目标引用、位置、名称、启用、勾选/展开状态和链接等；目标变化返回 `TARGET_CHANGED`，不重发按下。
drag的guard绑定from点，不能移到另一位置。Canvas/视频/不透明frame不会因宿主DOM稳定就获得内部画面稳定的guard。
guard不是像素校验、授权或业务正确性证明。原图刷新、过期、页面/几何改变或被交互消耗后，viewId和guardId均不可复用。

推荐闭环：完整截图 → 可选放大/检查 → 单个动作 → 新截图 → 验证明确条件 → 更新任务计划。
只重试观察；发送/支付/删除等不确定结果的动作先核实现状，不自动重放。

## WebSocket 协议

`VisionActionPayload = {action, parameters}`。action 为 `screenshot/click/drag/scroll/input/hover/keyboard/mark/inspect/zoom/check`。
parameters 与函数工具相同，截图可传 `{}`；旧 `screenshotMode`、bbox、elementId 命令已移除。
外部客户端在每个交互后应主动请求 screenshot；mark 后也必须请求 screenshot 才会绘制数字框。
zoom/check参数与vision_zoom/vision_check相同。crop经文件通道发送时名称为region.png，响应保留父图ID、viewId和region元数据。
必须区分协议success与检查status；success=true、status=failed表示检查完成且条件不符合。

```json
{"action":"click","parameters":{"screenshotId":"从最新截图响应获取","point":{"x":500,"y":500},"button":"left","count":1}}
```

## 验证

`npm run test:vision` 覆盖转换边界/非法输入、独立 realm 注入荷载、手势 CDP 请求、过期截图、页面重载、滚动累计量、Unicode 和打标生命周期。
`node tests/vision/browser-probe.mjs` 使用独立临时配置启动无界面 Chromium，通过真实 CDP 运行生产驱动。
可用 `VISION_CHROMIUM_PATH` 指定浏览器；默认查找 Windows Chrome/Edge。不会连接现有用户配置。
已覆盖 DPR 1/1.25/2、分数物理像素尺寸、有无滚动条、页面滚动后的小目标命中，以及 Unicode 输入、Shift+A、嵌套滚轮路由、拖拽终点、iframe 点击和跨 frame 打标检查。
扩展回归包含修饰键点击、中键和右键拖动的协议验证、waypoint 路径、ASCII逐键输入，以及真实 Chromium 的标准 HTML5 拖放。
模拟测试另覆盖旧截图/重载/视口变化、非法参数、并发、取消、焦点抢占、失败清理和结构化诊断。
复杂站点的 HTML5 拖放、跨进程跨域框架与各厂商模型定位效果仍需真实业务验收，不能由驱动测试推断全部通过。

完整能力评估、已知边界和官方资料交叉核对见 [能力评估](CAPABILITY_ASSESSMENT.md)。
