# 工具注册总览（Tool Registration Overview）

> 权威事实源不是本文档，而是代码本身。本文档只做导览与命名约定说明；
> 任何时候请以下面三处为准：
>
> 1. `tools/index.ts` → `registerAllTools()`：全部注册入口
> 2. `tools/registry.ts` → `toolRegistry`：运行时唯一注册表（`getTool(name)` 可验证某个名字是否存在）
> 3. `common/constants.ts` → `TOOL_NAMES`：浏览器类工具的规范命名
>
> `npm run test:tools` 会对本文档「三、分类清单」做防漂移校验：
> 分类集合、每行数量、工具名与注册表不一致时测试立即失败。

## 一、注册链路

```
registerAllTools()                      (tools/index.ts)
 ├─ registerBaseTools()                 tools/base/
 ├─ registerBrowserTools()              tools/browser/
 ├─ registerSearchTools()               tools/search/
 ├─ registerTextCompressionTools()      tools/text-compression/
 ├─ registerAutomationTools()           tools/automation/
 ├─ registerCommonTools()               tools/common/
 ├─ registerVisionTools()               tools/vision/
 ├─ registerCodeTools()                 tools/code/
 ├─ registerNoteTools()                 tools/note/
 ├─ registerExcalidrawTools()           tools/excalidraw/
 ├─ registerSkillTools()                tools/skill/
 ├─ registerOfficeTools()               tools/office/
 ├─ registerDocumentTools()             tools/document/
 ├─ registerInteractTools()             tools/interact/
 ├─ registerJavaScriptTools()           tools/javascript/
 ├─ registerPythonTools()               tools/python/
 ├─ registerPlanTools()                 tools/plan/
 ├─ registerDataTools()                 tools/data/
 └─ registerFileUtilTools()             tools/file-util/
```

- **background 端**：`registerAllTools()` 在 background 启动时调用
 （`background/tools/tool-registry.ts` 的单例构造）。
- **sidepanel 端**：`openai-tools-converter.ts` 在模块初始化时自行调用
 （`toolRegistry` 是模块级单例，注册无副作用，仅写内存 Map；同名重复注册
 在 `ToolRegistry.register` 内按幂等/换代语义处理，不会在分类桶中产生重复项）。
- **仅 sidepanel 注册的工具**：`document_tool`（Markdown → Word/PDF）在
 sidepanel 单独注册（`sidepanel/utils/tools/document-tools-registration.ts`，
 由 `sidepanel/main.ts` 最先导入）。原因：它的重依赖（docx 1.6MB、
 katex 0.6MB、markdown-it、highlight.js）约 2.7MB，而 background 是
 service worker 入口——Vite 对其强制内联动态 import，任何静态可达的
 重依赖都拆不出按需加载的独立 chunk，会白白拖慢扩展冷启动。文档工具全程
 在 sidepanel 执行（执行路由第 1 步即命中当前上下文注册表），因此不需要
 background 注册它。代价：它不出现在 background 的 WebSocket 工具清单里
 （即不支持经 WebSocket 远程调用），与「暂不关联给任何智能体」的定位一致。
- **执行路由**（sidepanel `tool-executor.ts`）：
  1. 先在 `toolRegistry` 查找并在当前上下文执行；
  2. 需要 background 上下文的工具（`BaseBrowserTool.ensureBackgroundContext()` 抛错）
     转发 `chrome.runtime.sendMessage({ type: 工具名, ...参数 })`；
  3. background `tools-manager-listener.ts` 按 **「白名单 ∪ 注册表」** 路由回
     `handleCallTool()`：白名单只覆盖 `browser_set_zoom` 这类
     无注册工具的内联处理器；凡已注册工具名（`browser_navigation`、`browser_tabs`、
     `browser_vector_search`、`browser_history_bookmarks` 等全部）一律由注册表命中，
     新增工具无需同步维护白名单。
  4. PDF 渲染是反向的一跳：`document_tool` 在 sidepanel 把 HTML 发给
     background 的 `pdf-channel.ts`（CDP `Page.printToPDF` 只在 background
     可用），渲染在**后台标签页**内完成，用户看不到打印对话框或预览页。
     两端的消息类型常量、请求/结果类型与纸张几何收敛在
     `tools/document/pdf-protocol.ts`（零依赖的唯一事实源）：常量各写一份
     迟早会漂移，漂移后的表现是「PDF 渲染失败」这种指向不明的结果。
     文档工具目录里的其余模块（docx/katex/markdown-it）仍是重依赖，
     因此该协议模块是**唯一**允许被 background 引用的文档侧模块。

## 二、命名约定

- 新一代工具统一 **`browser_` 前缀 + snake_case**：`browser_navigation`、`read_website`（正文读取与落盘）。
- 例外（保持既有调用方兼容）：`task-submit`、`task-result`、`formFiller`、`semantic_compressor`、`interact`。
- **`getPageMarkdown` 已下线**：结构化 Markdown 提取已并入 `read_website`
  （共用引擎 `tools/browser/page-doc-engine.ts` + `tools/browser/structured-page-payload.ts`：
  结构化正文 + url/tabId 直读 + 单页 3000 字符分页 + `content/*.md` 落盘，后续页用 `file_util(action="read", path, index)` 续读），
  预设与 Agent 提示词不要再引用旧名。
- **`browser_get_page_text` 不再是默认注入工具**：正文读取统一走 `read_website`
  （`content/<url-slug>-<4位随机字母>.md` 交付物，CSV 列 `content,page,totalPages,path`）。
  历史文本通道保留注册（ref 缓存 + `ref + page` 续读）供显式调用，
  但预设、Agent 提示词、技能 allowed-tools 与插件 hostTools 一律不得再引用它。
- **`browser_screenshot` 已下线**：视觉截图统一由 `screenshot`（`tools/vision/screenshot-tool.ts`）提供，预设与 Agent 提示词里不要混用两个名字。
- **导航与标签页工具已按域合并（项目未发布，无兼容别名）**：
  `browser_navigate` / `browser_go_back_or_forward` / `wait_page_load` / `browser_refresh`（原内联）→
  **`browser_navigation`**（action: open / refresh / back / forward / wait）；
  `browser_get_all_tabs` / `browser_switch_tab` / `browser_close_tab` / `browser_close_tabs` / `browser_create_tab` / `browser_window` →
  **`browser_tabs`**（action: list / switch / close / create / windows）。
  预设、Agent 提示词、技能 allowed-tools 与工具面板里不得再出现旧名（旧名调用会报「工具不存在」）。
- **历史与书签工具已按域合并（项目未发布，无兼容别名）**：
  `quick_navigation` / `history_navigation` / `bookmark_navigation` /
  `browser_search_history` / `browser_search_bookmarks` /
  `browser_bookmark_create` / `browser_bookmark_delete` →
  **`browser_history_bookmarks`**（action: search / open / create / update / delete / clear / recent / top / folders）。
  旧名全仓禁绝（预设、Agent 提示词、技能 allowed-tools、工具面板与插件 hostTools 引用里都不得再出现）；
  插件公开宿主工具表同步换成新名（见 `utils/plugins/host-tools.ts` 的 PUBLIC_HOST_TOOLS）。
- **资源与下载工具已按域合并（项目未发布，无兼容别名）**：
  `resource_sniffer` / `resource_downloader` / `start_download_interception` /
  `stop_download_interception` / `list_captured_files` / `get_captured_file_by_id` /
  `clear_captured_files` / `get_downloads_status` →
  **`browser_resources`**（action: sniff / list / download / fetch / intercept / captured / export / status）
  + **`browser_downloads`**（action: list / cancel / pause / resume / erase / show / open）。
  + **`browser_download_click`**（action: click / status）。限时关联下载并返回持久化插件 ID，后台按已登记的 ID 对账及导入。旧版全局请求捕获已停用。
  download/fetch/export 的交付文件统一保存到当前会话工作区 outputs/，返回 workspace-file 卡片标记。
  捕获副本库保留原始来源；browser_downloads 继续管理独立的浏览器下载队列。
  工作区保存与下载到电脑是两件事，默认通过文件卡片交付。
  旧名全仓禁绝（预设、Agent 提示词、技能 allowed-tools 与工具面板里都不得再出现）。
- **`page-source` 已下线**：并入 **`browser_get_page_html`**（format=html/text 与
  includeIframes 现已真正生效，并加了 maxChars 硬上限；旧实现的 format/includeIframes
  是死参数）。`browser_vector_search` 已从空壳改为真实的跨标签页正文检索。
- **轻量页面操作已合并（项目未发布，无兼容别名）**：`browser_scroll`（按屏滚动）+
  `browser_wait_for_element`（等待 CSS 选择器出现）→ **`browser_page_ops`**
  （action: scroll / wait_element）。二者都是不需要 DOM 引用体系的页面操作，
  与 browser_interact 的引用式交互（必须带 elementId）是两套定位方式。
- **快捷键与剪贴板独立为 `browser_input`（默认注入的核心工具）**：
  action = keys / type / clipboard_write / clipboard_read / clipboard_paste。
  与 `browser_interact` 的分工：前者负责「快捷键 + 系统剪贴板 + 整表粘贴」，
  后者负责「定位到具体 DOM/AX 引用后的交互」。两者的按键派发共用
  `tools/browser/key-dispatch.ts`（按下顺序、反序释放、失败成对释放只有一处定义）。
  **剪贴板走扩展侧通道**（manifest 剪贴板权限 + 离屏文档的 `execCommand('copy')`），
  不经过页面 origin——页面上下文的异步剪贴板 API 会挂在**浏览器级权限气泡**上
  （气泡在浏览器 UI 层、不在页面 DOM，任何 DOM 观察工具都看不到，脚本因此永不 settle）。
  读取在离屏文档不可靠（无焦点），由持有焦点的扩展页面上下文承担。
  `browser_input` 不在插件公开宿主工具表内（属页面操作，非插件可申请的能力）。
- **DOM 引用不再强制要求 frameId**：ElementId 的随机文档标识段**每 frame 独立生成**，
  唯一确定归属 → 省略 frameId 时按 ElementId 自动定位（宿主侧索引命中即用，
  未命中则全 frame 只读探测）。显式传入则直接采信。`browser_interact` 与
  `browser_input` 共用 `tools/browser/frame-resolution.ts` 这一套推导。
- **消息类型别名已删除**：`browser_go_back` / `browser_go_forward` / `browser_refresh` 不再是可发送的消息类型——
  统一走 `browser_navigation` 的 back / forward / refresh action。会话脚本求值统一为全局 `js_run`；backend 保留原内联入口。
- `browser_set_zoom` **没有注册工具**，只在 `tools-manager-listener.ts` 内联处理——仅当调用方直接发 `{ type: 'browser_set_zoom' }` 消息时可用。
- 分类（`metadata.category`）是**运行期分组**（`toolRegistry.getStats()` / `getByCategory()`），
  与磁盘目录不必一一对应（如 `browser_interact` 属 `browser`、`python_run` 属 `code`）；
  文档表格按运行期分类记录，由测试强制对齐。

## 三、分类清单（截至本次核对，共 56 个；`generic_wait` 已删除，由 `browser_wait` 取代）

| 分类 | 数量 | 工具名 |
| --- | --- | --- |
| automation | 8 | `ai_action`、`ai_locate`、`check_restricted_url`、`extract_data`、`file_upload_getter`、`file_uploader`、`formFiller`、`xiaozhi_config` |
| base | 2 | `task-result`、`task-submit` |
| browser | 26 | `browser_clean_page`、`browser_console`、`browser_dom_explore`、`browser_download_click`、`browser_downloads`、`browser_extract_data`、`browser_get_page_html`、`browser_get_page_info`、`browser_get_page_text`、`browser_history_bookmarks`、`browser_input`、`browser_interact`、`browser_media_control`、`browser_navigation`、`browser_network_capture`、`browser_network_request`、`browser_observe`、`browser_page_exec`、`browser_page_http`、`browser_page_ops`、`browser_resources`、`browser_send_command_to_inject_script`、`browser_tabs`、`browser_vector_search`、`browser_wait`、`read_website` |
| code | 3 | `js_run`、`mermaid_renderer`、`python_run` |
| data | 1 | `data_ref_tool` |
| excalidraw | 3 | `draw_on_canvas`、`excalidraw_tool`、`setup_excalidraw_canvas` |
| file-util | 1 | `file_util` |
| interact | 1 | `interact` |
| note | 1 | `note_tool` |
| office | 2 | `xlsx_tool`, `document_tool` |
| plan | 1 | `plan_tool` |
| search | 2 | `web_search`、`platform_search` |
| skill | 1 | `skill_tool` |
| text-processing | 1 | `semantic_compressor` |
| vision | 3 | `ocr`、`screenshot`、`vision_gui` |

## 四、消费方

- **Agent 场景预设**：`utils/tools/tool-presets.ts`（按 `ToolScenario` 组装工具 ID 列表，
  `SCENARIO_PRESETS` 全量导出供契约测试枚举）。
- **预置智能体**：`utils/agents/presets/*.ts`（system 提示词里写的工具名必须与本清单一致，
  否则模型调用会报“工具未找到”），`utils/agents/agent-store.ts` 汇总冻结。
- **工具测试面板**：`entrypoints/sidepanel/components/tool/tool-definitions.ts`（静态目录，新增/改名工具时需同步；契约测试校验目录 ⊆ 注册表）。
- **UI 文案与分组**：`entrypoints/sidepanel/components/tool/`（`CategoryTabs`/`ToolList`/`ToolTestPanel`）。

## 五、自检方法

```ts
import { toolRegistry } from '@/tools/registry';
toolRegistry.getTool('browser_navigation');  // undefined = 未注册
toolRegistry.getToolIds();                  // 全量已注册工具名
```

新增工具的检查清单：
1. 在对应 `tools/<category>/index.ts` 里注册（漏注册 = 目录里有、调用报 not found，历史上的 `ocr` 即此类问题）；
2. 若属于浏览器类，命名走 `TOOL_NAMES.BROWSER`；
3. 同步 `tool-presets.ts`（如需暴露给 Agent）与 `tool-definitions.ts`（如需出现在测试面板）；
4. Agent system 提示词中的工具名与注册名保持一致；
5. 运行 `npm run test:tools`——注册契约、预设、测试面板目录、本文档四者会被同时校验。

会话内脚本：工作区文件统一由 `file_util` 承载（create/read/edit/delete/list/search/grep/copy，文本文件按每页 3000 字符分页，Office 文件只读转 Markdown），`js_run` 只负责 run/crawl，`python_run` 只负责 run；run/crawl 的执行结果自动落盘工作区 `results/` 结果文件（`data_ref_tool` 治理与 `xlsx_tool` dataFiles 数据源共用该通道）。`browser_page_exec` 保留原实现（含 dataRef 暂存），仅供 backend；两者都不出现在智能体创建/编辑的可选工具组。
