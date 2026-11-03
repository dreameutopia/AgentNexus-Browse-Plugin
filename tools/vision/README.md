# Vision Action：相对坐标 GUI 驱动

Vision Action、网站视觉学习/验证以及 WebSocket 视觉命令共用 CDP 输入驱动。
旧的像素 bbox、数字 ID 点击、simple/advanced 双协议已删除，不提供兼容入口。
需要 Chromium 的 `chrome.debugger`、`scripting` 权限及可访问的网页标签页。
Firefox、不允许调试的页面、浏览器地址栏/菜单、操作系统对话框和桌面不受此驱动控制。

## 坐标和截图

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
| `vision_click` | `point`, `button: left/right`, `count: 1/2/3`；CDP 按下/释放及递增 clickCount |
| `vision_drag` | `from`, `to`, 可选 `durationMs: 200..3000`；起点按住等待、变速曲线移动、终点按住等待再释放 |
| `vision_scroll` | `direction: up/down/left/right`, `percent: 1..300`, 可选 `point`, `durationMs`；先悬停，再分段发送滚轮 |
| `vision_input` | `point`, `text`（最多 10000 UTF-16 单元）, `clickFirst`（默认 true）, `clear`（默认 false）；检查焦点后按 Unicode 字素输入 |
| `vision_hover` | `point`, 可选 `durationMs`，默认停留 500ms |
| `vision_keyboard` | `keys` 按键数组，最多 5 个；如 `["Control","a"]`、`["Shift","Tab"]`、`["Enter"]`；支持键见 schema |
| `vision_mark` | 请求**下一次自动截图**绘制元素框和数字，不直接截图、不点击 |
| `vision_inspect` | `id`：检查该截图数字元素的 CSS/XPath、frameId、shadow scope、属性、文字、状态、选项和祖先信息 |

滚动百分比的基数是当前可见视口的高度（纵向）或宽度（横向），不是总内容高度或剩余可滚动距离。
推荐传组件内部的 point，以便浏览器把滚轮路由到嵌套滚动区域；不传则使用视口中心。
实际滚动可能受容器边界、滚动吸附、overscroll、页面脚本影响，应检查下一张截图。
拖拽轨迹使用加减速和轻微弯曲，精确抵达终点；异常路径尝试释放鼠标。
键盘也在异常路径释放已按下的键。输入保留 Unicode 字素，按长度调整停顿，避免长文本长时间占用输入通道。
手势有 20 秒执行预算，超限或目标切换会中止；可能已部分输入，必须检查后继续。
工具不会自动重试交互。浏览器断开调试或页面关闭时无法保证向已失去的目标送达释放事件。
调试会话更换会使旧截图失效。输入事件不会为了继续旧动作而自动重新附加调试器。
聊天停止和工具超时通过内部请求 ID 传递取消信号，后台在派发下一步前检查并走释放路径；已经发送的浏览器原生事件无法撤回。
排队等待超过 30 秒的请求拒绝执行。单条浏览器命令、脚本注入、清理和文件传输均有独立等待上限。
输入焦点在每个字素前核对同一元素引用；跨平台清空分别使用 Windows/Linux Control+A、macOS Meta+A。

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

## WebSocket 协议

`VisionActionPayload = {action, parameters}`。action 为 `screenshot/click/drag/scroll/input/hover/keyboard/mark/inspect`。
parameters 与函数工具相同，截图可传 `{}`；旧 `screenshotMode`、bbox、elementId 命令已移除。
外部客户端在每个交互后应主动请求 screenshot；mark 后也必须请求 screenshot 才会绘制数字框。

```json
{"action":"click","parameters":{"screenshotId":"从最新截图响应获取","point":{"x":500,"y":500},"button":"left","count":1}}
```

## 验证

`npm run test:vision` 覆盖转换边界/非法输入、独立 realm 注入荷载、手势 CDP 请求、过期截图、页面重载、滚动累计量、Unicode 和打标生命周期。
`node tests/vision/browser-probe.mjs` 使用独立临时配置启动无界面 Chromium，通过真实 CDP 运行生产驱动。
可用 `VISION_CHROMIUM_PATH` 指定浏览器；默认查找 Windows Chrome/Edge。不会连接现有用户配置。
已覆盖 DPR 1/1.25/2、分数物理像素尺寸、有无滚动条、页面滚动后的小目标命中，以及 Unicode 输入、Shift+A、嵌套滚轮路由、拖拽终点、iframe 点击和跨 frame 打标检查。
模拟测试另覆盖旧截图/重载/视口变化、非法参数、并发、取消、焦点抢占、失败清理和结构化诊断。
复杂站点的 HTML5 拖放、跨进程跨域框架与各厂商模型定位效果仍需真实业务验收，不能由驱动测试推断全部通过。
