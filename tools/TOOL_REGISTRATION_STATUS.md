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
 ├─ registerNavigationTools()           tools/navigation/
 ├─ registerTextCompressionTools()      tools/text-compression/
 ├─ registerAutomationTools()           tools/automation/
 ├─ registerCommonTools()               tools/common/
 ├─ registerVisionTools()               tools/vision/
 ├─ registerCodeTools()                 tools/code/
 ├─ registerNoteTools()                 tools/note/
 ├─ registerExcalidrawTools()           tools/excalidraw/
 ├─ registerResourceTools()             tools/resource/
 ├─ registerBilibiliTools()             tools/bilibili/
 ├─ registerIntegratedSearchTools()     tools/integrated-search/
 ├─ registerSkillTools()                tools/skill/
 ├─ registerOfficeTools()               tools/office/
 ├─ registerInteractTools()             tools/interact/
 ├─ registerPythonTools()               tools/python/
 ├─ registerPlanTools()                 tools/plan/
 ├─ registerDataTools()                 tools/data/
 ├─ registerLearnTools()                tools/learn/
 └─ registerUploadFileTools()           tools/upload-file/
```

- **background 端**：`registerAllTools()` 在 background 启动时调用
 （`background/tools/tool-registry.ts` 的单例构造）。
- **sidepanel 端**：`openai-tools-converter.ts` 在模块初始化时自行调用
 （`toolRegistry` 是模块级单例，注册无副作用，仅写内存 Map；同名重复注册
 在 `ToolRegistry.register` 内按幂等/换代语义处理，不会在分类桶中产生重复项）。
- **执行路由**（sidepanel `tool-executor.ts`）：
  1. 先在 `toolRegistry` 查找并在当前上下文执行；
  2. 需要 background 上下文的工具（`BaseBrowserTool.ensureBackgroundContext()` 抛错）
     转发 `chrome.runtime.sendMessage({ type: 工具名, ...参数 })`；
  3. background `tools-manager-listener.ts` 按 **「白名单 ∪ 注册表」** 路由回
     `handleCallTool()`：白名单覆盖 `browser_refresh` / `browser_set_zoom` 这类
     无注册工具的内联处理器与参数别名；凡已注册工具名（含 `browser_vector_search`、
     `browser_bookmark_create` 等未登记进白名单的 browser_* 工具）一律由注册表命中，
     新增工具无需同步维护白名单。

## 二、命名约定

- 新一代工具统一 **`browser_` 前缀 + snake_case**：`browser_navigate`、`browser_get_page_text`。
- 例外（保持既有调用方兼容）：`page-source`、`task-submit`、`task-result`、`formFiller`、`semantic_compressor`、`interact`。
- **`getPageMarkdown` 已下线**：结构化 Markdown 提取已并入 `browser_get_page_text`
  （`tools/base/page-info-tool.ts` + `tools/browser/structured-page-payload.ts`，
  结构化正文 + url 直读 + 超 15000 字符 ref 分页），预设与 Agent 提示词不要再引用旧名。
- **`browser_screenshot` 已下线**：视觉截图统一由 `screenshot`（`tools/vision/screenshot-tool.ts`）提供，预设与 Agent 提示词里不要混用两个名字。
- 有些名字只是**消息类型别名**，不是注册工具：`browser_go_back` / `browser_go_forward`（映射到 `browser_go_back_or_forward`）。脚本求值统一为 `browser_page_exec`。
- `browser_refresh`、`browser_set_zoom` **没有注册工具**，只在 `tools-manager-listener.ts` 内联处理——仅当调用方直接发 `{ type: 'browser_refresh' }` 消息时可用，`CALL_TOOL` 通道不可达。
- 分类（`metadata.category`）是**运行期分组**（`toolRegistry.getStats()` / `getByCategory()`），
  与磁盘目录不必一一对应（如 `browser_interact` 属 `browser`、`python_run` 属 `code`）；
  文档表格按运行期分类记录，由测试强制对齐。

## 三、分类清单（截至本次核对，共 74 个）

| 分类 | 数量 | 工具名 |
| --- | --- | --- |
| automation | 9 | `ai_action`、`ai_locate`、`check_restricted_url`、`extract_data`、`file_upload_getter`、`file_uploader`、`formFiller`、`get_downloads_status`、`xiaozhi_config` |
| base | 3 | `page-source`、`task-result`、`task-submit` |
| bilibili | 2 | `bilibili_jump_tool`、`bilibili_subtitle_tool` |
| browser | 28 | `browser_bookmark_create`、`browser_bookmark_delete`、`browser_clean_page`、`browser_close_tab`、`browser_close_tabs`、`browser_console`、`browser_create_tab`、`browser_dom_explore`、`browser_extract_data`、`browser_get_all_tabs`、`browser_get_page_html`、`browser_get_page_info`、`browser_get_page_text`、`browser_go_back_or_forward`、`browser_interact`、`browser_navigate`、`browser_network_capture`、`browser_network_request`、`browser_observe`、`browser_page_exec`、`browser_scroll`、`browser_search_bookmarks`、`browser_search_history`、`browser_send_command_to_inject_script`、`browser_switch_tab`、`browser_vector_search`、`browser_wait_for_element`、`browser_window` |
| code | 2 | `mermaid_renderer`、`python_run` |
| common | 2 | `generic_wait`、`wait_page_load` |
| data | 1 | `data_ref_tool` |
| excalidraw | 3 | `draw_on_canvas`、`excalidraw_tool`、`setup_excalidraw_canvas` |
| interact | 1 | `interact` |
| learn | 2 | `submit_skill`、`submit_validation` |
| navigation | 3 | `bookmark_navigation`、`history_navigation`、`quick_navigation` |
| note | 1 | `note_tool` |
| office | 1 | `xlsx_tool` |
| plan | 1 | `plan_tool` |
| resource | 7 | `clear_captured_files`、`get_captured_file_by_id`、`list_captured_files`、`resource_downloader`、`resource_sniffer`、`start_download_interception`、`stop_download_interception` |
| search | 1 | `web_search` |
| skill | 2 | `load_skill`、`read_skill_file` |
| text-processing | 1 | `semantic_compressor` |
| upload-file | 1 | `read_file` |
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
toolRegistry.getTool('browser_navigate');   // undefined = 未注册
toolRegistry.getToolIds();                  // 全量已注册工具名
```

新增工具的检查清单：
1. 在对应 `tools/<category>/index.ts` 里注册（漏注册 = 目录里有、调用报 not found，历史上的 `ocr` 即此类问题）；
2. 若属于浏览器类，命名走 `TOOL_NAMES.BROWSER`；
3. 同步 `tool-presets.ts`（如需暴露给 Agent）与 `tool-definitions.ts`（如需出现在测试面板）；
4. Agent system 提示词中的工具名与注册名保持一致；
5. 运行 `npm run test:tools`——注册契约、预设、测试面板目录、本文档四者会被同时校验。
