# 官方插件目录仓库（AgentNexus-Browse-Plugin-Registry）搭建模板

本目录**不是**宿主仓库的一部分，而是**插件目录仓库**的搭建模板。目录仓库建议独立为
`dreameutopia/AgentNexus-Browse-Plugin-Registry`，其职责是登记插件、构建并签名目录快照、
发布到 GitHub Pages；宿主仓库（`AgentNexus-Browse-Plugin`）只保留本模板，不承载目录内容。

本目录提供三个文件，各自复制到目录仓库的对应位置：

| 本目录文件 | 复制到目录仓库 | 作用 |
| --- | --- | --- |
| `catalog.yml` | `.github/workflows/catalog.yml` | 目录构建与签名发布的工作流 |
| `build-catalog.mjs` | `scripts/build-catalog.mjs` | 校验登记项、生成未签名目录快照 |
| `entry.example.json` | `plugins/web-research.json`（改名） | 单个插件登记项的字段示例 |

扩展内置目录地址与目录公钥（`utils/plugins/official-catalog.ts`），用户在插件中心
搜索/安装/更新全程无需接触密钥。

## 在目录仓库中登记一个插件

1. 先在插件发布者仓库发布 `.anplugin` 到 GitHub Release（tag `vX.Y.Z` 与 `plugin.json`
   的 version 一致；附件恰好一个 `.anplugin`；建议开启 Immutable Releases）。发布模板见
   宿主仓库 `docs/plugin-release-workflow.yml`。
2. 在目录仓库 `plugins/` 下新增 `<pluginId>.json`（文件名仅作整理用，内容才是事实源），
   字段格式见 `entry.example.json`：

   ```json
   {
     "key": "ed25519:<52字符发布者公钥base32>/<pluginId>",
     "name": "网页调研",
     "description": "根据网页信息产生有引用的回答。",
     "repository": "https://github.com/example/web-research",
     "version": "1.0.0",
     "digest": "<安装包 .anplugin 的 64 字符 SHA-256，小写十六进制>"
   }
   ```

3. 提交 PR。CI 会校验：字段格式；Release 资产存在且 GitHub asset digest 与登记
   digest 一致；下载资产用固定 SDK 验签并比对插件身份与版本。校验通过合并后，
   Actions 以递增序号重建签名目录并发布。

发新版本时更新对应登记文件的 `version` 与 `digest` 再提 PR 即可。

## 目录仓库维护者事项

- 目录签名密钥：`catalog-signing` 环境的 secret `CATALOG_PRIVATE_JWK`
  （Ed25519 私钥 JWK）。**私钥绝不入库，必须离线备份**；对应公钥 Base64 内置于
  扩展 `utils/plugins/official-catalog.ts`。丢失私钥 = 无法再签目录，只能生成新
  密钥并随扩展版本分发新公钥。
- 目录有效期 30 天，序号每次发布递增；客户端拒绝过期与重放目录。
- 目录仓库 Variables：`AGENTNEXUS_SDK_REPOSITORY`、`AGENTNEXUS_SDK_COMMIT`（固定
  校验逻辑来源）、`CATALOG_URL`（已部署目录地址）。
- GitHub Pages：部署分支 `gh-pages`（由 Action 维护，单提交历史）。

## 免责

目录签名只证明列表由目录仓库 CI 产出，不背书插件质量与安全性；插件自身的发布者
签名与用户安装前的审查仍是安全边界。恶意或违规条目会被移除并递增序号重新发布；
已安装插件不受目录变化影响。
