# 发布流程（GitHub Actions）

扩展的发布由两个 workflow 负责，职责分开：

| Workflow                        | 触发条件                           | 做什么                                      | 创建 GitHub Release？ |
| ------------------------------- | ---------------------------------- | ------------------------------------------- | --------------------- |
| `.github/workflows/ci.yml`      | push 到 `main`、PR 到 `main`、手动 | 类型检查 + 全量测试 + Chrome/Firefox 双构建 | **永不**              |
| `.github/workflows/release.yml` | 推送 `v*` tag、手动触发            | 类型检查 + 全量测试 + 双浏览器打包          | 仅当版本闸门放行      |

核心原则：**普通提交永远不会产生 Release**。Release 只在显式指定版本时出现，且只发布你选中的那些版本。

## 版本闸门（决定这次到底发不发）

`prepare` job 按顺序判定，任何一步不通过都不会走到创建 Release：

1. **格式**：版本号必须形如 `0.1.0` 或 `0.1.0-rc.1`，否则直接失败。
2. **单一事实源**：版本号必须与 `package.json` 的 `version` 完全一致。
   先改 `package.json` 再触发，否则 workflow 会以 `::error::` 提示版本不一致并终止。
3. **预发布策略**：版本号带 `-` 预发布后缀时，按仓库变量 `RELEASE_PRERELEASE_MODE` 处理：
   - `publish`（默认）：创建 GitHub **预发布** Release，不占用 latest 标记；
   - `skip`：只构建，产物留在 workflow artifact 里，**不创建任何 Release**。
4. **手动只构建**：手动触发时把 `publish` 输入设为 `false`，同样只构建不出 Release。

同一个 tag 重复触发不会重复建 Release：Release 已存在时改为覆盖上传构件（`--clobber`）。

## 发布某个版本

### 方式一：推 tag（推荐，版本号与 tag 一一对应）

```bash
# 1. 先把 package.json 的 version 改成目标版本并提交
# 2. 打同名 tag 并推送
git tag v0.1.0
git push origin v0.1.0
```

推送 `v*` tag 会触发 `release.yml`：校验版本 → 跑测试 → 构建 Chrome(MV3) 与 Firefox(MV2) →
创建 Release `v0.1.0`，附上两个 zip 构件与自动生成的提交说明。

### 方式二：手动触发（不用推 tag）

Actions → **Release extension** → **Run workflow**：

- `version`：目标版本号（可带 `v` 前缀），必须与 `package.json` 一致；
- `publish`：`true` 创建 Release，`false` 只构建。

手动触发且远端还没有该 tag 时，workflow 会在触发它的那个 commit 上创建 tag。

### 只构建、先不发

任选一种：

- 手动触发时把 `publish` 设为 `false`；
- 把仓库变量 `RELEASE_PRERELEASE_MODE` 设为 `skip`，这样预发布版本一律只构建。

两种情况下产物都能在 workflow run 的 **Artifacts** 里下载。

## 构件

Release 只挂两个浏览器包，文件名带版本号：

| 构件                                      | 目标        | 说明                                             |
| ----------------------------------------- | ----------- | ------------------------------------------------ |
| `agentnexus-browse-chrome-<version>.zip`  | Chrome MV3  | 拖入 `chrome://extensions`（开发者模式）解压加载 |
| `agentnexus-browse-firefox-<version>.zip` | Firefox MV2 | `about:debugging` → 载入临时附加组件             |

`wxt zip` 额外产出的 `-sources.zip` 不上传到 Release。

## 仓库配置

Settings → Secrets and variables → Actions：

**Variables（可选）**

| 名称                      | 取值                       | 作用                                        |
| ------------------------- | -------------------------- | ------------------------------------------- |
| `RELEASE_PRERELEASE_MODE` | `publish`（默认）\| `skip` | 预发布版本是否出 Release                    |
| `RELEASE_DRAFT`           | `true`                     | 先建草稿，人工确认后再点 Publish            |
| `BROWSER_UUID`            | UUID                       | 注入 `__BROWSER_UUID__`，与本地 `.env` 同义 |

**Secrets（可选）**

| 名称                   | 作用                                                     |
| ---------------------- | -------------------------------------------------------- |
| `CHROME_EXTENSION_KEY` | 固定 Chrome 扩展 ID（生产发布建议配置；本地对应 `.env`） |

## 本地等价命令

```bash
npm ci
npm run compile        # 类型检查
npm run test:all       # 全量测试（真实浏览器的 test:text-browser / test:semantic-controls 不在内）
npx wxt zip -b chrome  # 产出 .output/agentnexus-browse-helper-<version>-chrome.zip
npx wxt zip -b firefox # 产出 .output/agentnexus-browse-helper-<version>-firefox.zip
```
