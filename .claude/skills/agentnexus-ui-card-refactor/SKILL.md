---
name: agentnexus-ui-card-refactor
description: AgentNexus 界面组件改造与"空间利用率"优化的标准闭环——先定位组件与契约、再量出空白来源、改模板与 scoped 样式、三层验证（JSDOM 结构断言 + 静态样式断言 + .preview 预览页）、并按红线降级视觉验证。用于用户说"这个组件太占地方/有空白/缩小一点/提高空间利用率/紧凑"，或任何改动侧边栏与 hub 界面卡片的任务。
---

# AgentNexus 界面组件改造闭环（已验证）

本 Skill 沉淀自 2026-11-14 的一轮真实改造（侧边栏"技能沉淀提醒卡片"压缩：消除左下空白 + 整体缩小约 45%），
以及同日 hub 智能体编辑器（工具组卡片）的同类改造。所有步骤都已跑通，**下次直接从这里开始，不要重新摸索**。

## 铁律（先读，违反会返工）

1. **不用命令行改文件内容**——只用 Edit / Write 工具；命令行只用于跑测试、构建、读 git 状态。
2. **重构不得简化功能**——只动布局与尺寸，不删功能、不删文案、不改交互语义；信息要从"删掉"改成"挪到详情层"。
3. **不擅自启动用户的 Chrome**——见下面"视觉验证"。临时 profile 也不行，分类器故障不构成同意。
4. **改界面必须同步三处**：源码 → `.preview/` 预览页 → 测试断言。少一处，下次就发现线上与预览漂移。

## 第 0 步 · 定位组件与它的契约（别凭感觉改）

用户截图里的文案是最快的入口：

```bash
grep -rn "卡片上的某句中文" utils/i18n/locales/zh-CN.ts     # → i18n 键
grep -rn "那个 i18n 键" entrypoints/ --include=*.vue          # → 渲染组件
grep -rn "组件里的 class 名" entrypoints/ tests/              # → 样式与测试
```

找到组件后先确认三件事：

- **单一事实源在哪**：组件往往只是"出口"，数据与规则在 `utils/` 下（如 `skill-capture.ts`、`agent-store`）。
  改布局不要顺手改数据流；反过来，视觉问题多半不在数据层。
- **哪些测试锁住了它**：`tests/<域>/*.test.mjs`。**改动前先读断言**——它们就是不可破的契约。
  本次实例：`tests/chat-ui/skill-capture.test.mjs` 锁住了"确认弹窗 / 永久隐藏 / 手动入口"的行为。
- **样式落在哪**：组件的 scoped 样式写在 SFC 自己的 `<style scoped>` 里；
  hub 侧则集中在 `entrypoints/hub/hub.css`（覆写必须在基类**之后**，见下面"hub 层叠约定"）。

## 第 1 步 · 量出空白到底在哪（先诊断，后动手）

空白有两类来源，处理方式完全不同：

| 类型 | 症状 | 对策 |
| --- | --- | --- |
| **结构型** | 图标/头像独占一列、内容被挤到右列 → 左列下方天然空一块 | 改布局：图标与标题**同行** |
| **尺寸型** | 内边距 / 图标尺寸 / 行高 / 按钮换行堆出来的体积 | 改基线：整体下调一档 |

结构型的识别特征：**截图里空白出现在某一列的下方**，而这一列只有一个图标。
把图标从"左栏"改成"标题行的一个前缀"，左下空白立刻消失，同时右侧正文/按钮能整行铺开、按钮不再换行。

动手前先算一笔账（能直接写进汇报）：

```
旧高度 ≈ 内边距×2 + 图标 + gap + (正文行数 × 行高) + gap + 动作行数 × 按钮高
新高度 ≈ 内边距×2 + 标题行 + gap + (正文行数 × 行高) + gap + 动作行数 × 按钮高
```

## 第 2 步 · 已验证的空间利用率手法

按收益从大到小：

1. **图标与标题同行**——消灭左下空白，正文与动作整行铺开。
2. **正文 / 动作不再被左栏挤窄**——按钮从"被迫换行两排"回到一行，高度直接省掉一整排。
3. **描述改单行 clamp**（`-webkit-line-clamp: 1`），完整文案进 `title` 与详情浮层——省掉一行半。
4. **尺寸基调整体下调一档**：内边距、图标尺寸（42→26）、正文字号与行高（12/1.65→11.5/1.55）、
   按钮 padding（7/12→5/10）、圆角（18→13）、外边距。**一档就够**，不要动到"变形"。
5. **高度按内容分配**：主区 `flex: 1 1 auto` 吸收剩余空间，其余分区 `flex: 0 0 auto` 贴合内容——
   消灭卡片尾部的空白块（hub 三分区 34/26/34 的固定比例是空白源之一）。
6. **删掉纯装饰的分隔与缩进**：虚线 `border-top`、额外的 `padding-left` 内缩，会让条目显得松散。
7. **信息不删、只挪**：重复的说明文字（例如"描述里逐个点名了芯片里已有的工具名"）是冗余，
   收进详情浮层，而不是留在卡片上占行。

**美观底线**：改完仍要像同一套设计语言——中性灰阶、同一字号阶梯、同一圆角档位、
同一交互反馈（hover / focus-visible / disabled 别丢）。

## 第 3 步 · hub 的 CSS 层叠约定（易踩）

`entrypoints/hub/hub.css` 里覆写基类时：

- 覆写块**物理上必须放在基类之后**（同特异性时源顺序决定胜负）；
- 关键声明用**双类选择器**提特异性，例如 `.hub-editor-split.hub-editor-split--agent`（0-2-0 > 基类 0-1-0），
  即使日后被挪位置也不会被反杀；
- 本仓库已经因为把覆写写在基类之前而踩过坑（左卡按内容自身高度溢出行轨道、把外层内容卡顶出滚动条），
  改之前先读该文件里对应的约定注释。

## 第 4 步 · 三层验证（缺一不可）

**① JSDOM 结构断言** —— 模式见 `tests/chat-ui/skill-capture.test.mjs`：
用 `@vue/compiler-sfc` + esbuild 打包 SFC，`jsdom` 挂载后查 DOM。断言**结构契约**：

```js
assert.ok(card.querySelector('.skill-practice-head'), '图标与标题同行：存在头部行');
assert.equal(card.querySelector('.skill-practice-copy'), null, '不再保留图标独占的左栏');
```

**② 静态样式断言** —— JSDOM 没有排版引擎，尺寸类契约必须靠读 CSS 补上（正则直接读 SFC 文本）：

```js
assert.match(componentCss, /\.skill-practice-card\{[^}]*flex-direction:column/, '卡片纵向堆叠');
assert.match(componentCss, /\.skill-practice-icon\{[^}]*width:26px;height:26px/, '图标下调至 26px');
```

**③ 预览页** —— `.preview/` 是本仓库的既有约定（`.claude/launch.json` 注册后可用 Browser 面板打开）。
**预览页要从源码生成，不要手抄样式**（手抄必然漂移）。本次用的做法：
`.preview/build-skill-capture-preview.mjs` 从 SFC 抽 `<style scoped>` 并剥掉 `[data-v-xxx]`，
再从 `utils/i18n/locales/zh-CN.ts` 取真实文案拼出 `.preview/skill-capture-card.html`，
并在 `launch.json` 注册 `skill-capture-card` 条目。

## 第 5 步 · 视觉验证的优先级与红线

| 顺序 | 手段 | 说明 |
| --- | --- | --- |
| 1 | **Browser 面板 MCP**（`preview_start` / `preview_screenshot` / `preview_snapshot`） | 首选，不碰用户浏览器 |
| 2 | **JSDOM + 静态样式断言**，并把预览页地址交给用户自己看 | Browser MCP 分类器故障时的降级路径 |
| 3 | ~~`chrome.exe --headless`~~ | **红线，未经用户明确同意不得使用**（哪怕独立临时 profile、哪怕只访问 localhost） |

分类器故障（`preview_start` 报 "auto mode cannot determine the safety of…"）时**不要**自我授权启动 Chrome。
正确做法：把 ① ② 做扎实 → 明确告诉用户"这次没有拿到截图，预览页在 <URL>"→ 请用户自己看一眼。
（2026-11-06 与 2026-11-10 两次越界均因此发生。）

## 常用命令

```bash
npm run test:chat-ui        # 侧边栏界面（含 skill-capture / 气泡 / 引用条）
npm run test:message-collapse
npm run test:hub            # hub 侧组件回归
npm run compile             # vue-tsc 类型检查
node .preview/build-skill-capture-preview.mjs   # 重新生成卡片预览页
```

## 收尾自检

- [ ] 组件被"定位到"而不是"猜到"（文案 → i18n 键 → 组件 → 测试）
- [ ] 空白来源分类正确（结构型 vs 尺寸型），手段对得上
- [ ] 功能、文案、交互语义零删减
- [ ] JSDOM 结构断言 + 静态样式断言都补了
- [ ] 预览页从源码生成且已重新生成
- [ ] 视觉验证拿到了截图，或**明确告诉用户没拿到**并给了预览页地址
- [ ] 跑过 `npm run test:chat-ui`（或对应域）与 `npm run compile`
