/**
 * 官方目录（在线市场）内置配置。
 *
 * 目录签名公钥随扩展分发、绝不从网络获取（否则目录可自签自验）；
 * URL 指向官方目录仓库的 GitHub Pages 产物。两者只在官方目录实际
 * 部署后由维护者填入真实值；空串表示"尚未部署"，发现页据此优雅
 * 隐藏官方目录分区，不影响社区搜索与已安装插件。
 *
 * 变更流程：目录签名密钥轮换或迁移托管时，更新常量并发版扩展；
 * 与发布者密钥同规则（换公钥 = 换信任锚，需随宿主版本分发）。
 */
// 显式标注为 string：常量是字面量类型时 TS 会把 `!== ''` 判定为永真比较，
// 导致「尚未部署」分支在类型层面失效（TS2367）。
export const OFFICIAL_CATALOG_URL: string =
  'https://dreameutopia.github.io/agentnexus-browse-plugin-registry/catalog.json';
export const OFFICIAL_CATALOG_PUBLIC_KEY: string =
  'wYisR27jKk9I44y+9BIf5HKkqD48zFAEwbr5GGqodIE=';

/** 官方目录是否已配置（常量已填入真实部署值）。 */
export function isOfficialCatalogConfigured(): boolean {
  return OFFICIAL_CATALOG_URL !== '' && OFFICIAL_CATALOG_PUBLIC_KEY !== '';
}
