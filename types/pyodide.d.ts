/**
 * Pyodide 相关类型声明
 *
 * 1. 'pyodide/pyodide.asm.mjs'：Emscripten 胶水模块（默认导出模块工厂）。
 *    npm 包的 exports 未附带该子路径的 .d.ts，这里按运行时形状声明最小类型。
 *    官方文档（JS API / PyodideConfig.createPyodideModule）明确支持把该工厂
 *    经 createPyodideModule 选项传入 loadPyodide，用于跳过对 indexURL 的
 *    动态 import()——这正是扩展页 CSP（script-src 'self'）所要求的加载方式。
 * 2. 'pyodide/pyodide-lock.json'：随 npm 包分发的锁文件（PackageCatalog 数据源）。
 */

declare module 'pyodide/pyodide.asm.mjs' {
  /**
   * 模块工厂：接收 Emscripten 设置并初始化 wasm 运行时，返回 emscripten Module。
   * 参数/返回值按"不透明负载"声明（unknown 参数 + never 返回的底部类型组合），
   * 使本声明可无条件赋值给 pyodide.d.ts 内部的 CreatePyodideModuleFn 形状，
   * 同时避免与包内 EmscriptenSettings 结构耦合（跨版本稳定）。
   */
  export type CreatePyodideModule = (settings: unknown) => Promise<never>;

  const createPyodideModule: CreatePyodideModule;
  export default createPyodideModule;
}

declare module 'pyodide/pyodide-lock.json' {
  /** 锁文件中的单个包条目（仅声明本扩展消费的字段） */
  export interface PyodideLockPackage {
    name: string;
    version: string;
    file_name: string;
    /** 包提供的顶层导入名（loadPackagesFromImports 依赖） */
    imports: string[];
    depends: string[];
    install_dir: string;
    package_type: string;
    sha256: string;
  }

  /** pyodide-lock.json 顶层结构 */
  const lockfile: {
    info: {
      arch: string;
      platform: string;
      version: string;
      python: string;
      abi_version: string;
    };
    packages: Record<string, PyodideLockPackage>;
  };

  export default lockfile;
}
