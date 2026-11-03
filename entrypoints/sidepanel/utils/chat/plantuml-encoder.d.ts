/**
 * plantuml-encoder 的最小类型声明。
 *
 * 说明：
 * - 该包未自带 TypeScript 类型（package.json 无 types 字段），直接动态 import
 *   会破坏 vue-tsc；在此声明 diagram-renderer 实际用到的 API 面。
 * - 语义与官方 README 一致：encode64 产出 PlantUML 服务器可识别的
 *   deflate + 特制 Base64 编码串（用于 /plantuml/svg/{encoded} 路径）。
 */
declare module 'plantuml-encoder' {
  /** 把 PlantUML 源码编码为服务器 URL 段（UTF-8 → deflate → PlantUML Base64 变体） */
  export function encode64(plantuml: string): string;

  /** decode64 的逆操作（本项目未使用，仅为声明完整性） */
  export function decode64(encoded: string): string;
}
