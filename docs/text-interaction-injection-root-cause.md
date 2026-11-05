# 文本交互无法推进：日志分析与修复

## 结论

本次故障由生产构建破坏注入函数的自包含性引起，同时存在 click 可选参数不可序列化和错误分类误导恢复的问题。反复重采元素无法修复构建产物。

分析依据是用户提供的 BOSS 直聘杭州首页日志、相关工具与注入代码、修复前后的生产产物，以及真实 Chromium 回归。日志没有完整记录失败调用的入参和页面异常堆栈；底层异常通过本地复现确认，未重新操作用户的招聘网站或发送消息。

## 日志各阶段对应的代码

| 日志现象 | 对应实现与解释 |
| --- | --- |
| navigate、page info 和 page text 正常 | 标签页和页面可达；这些成功不能证明所有注入函数正常。 |
| observe 多次成功，输入引用保持相同，FrameId=0 | `elementScanPayload`、`validateElementReferences` 和属性检查函数为同步函数，可独立注入；同一节点重新注册返回同一引用是预期行为。日志没有证据支持主 frame 编号错误。 |
| fill/focus 在约 3–5ms 内报 frame 无结果 | `domActionPayload` 和 `textTargetPayload` 均为 async 函数。构建降级引入外部 helper，独立注入后立即异常，尚未执行目标操作。宿主将缺失 result 错报为 STALE_ELEMENT。 |
| 重采后继续失败 | 重采只更新 DOM 观察结果；下一次仍注入同一份有缺陷的函数。切换 fill/focus 也都依赖受影响的异步注入路径。 |
| element 视图缺少必要参数、省略 FrameId 被拒绝 | 这是独立的调用参数错误，校验符合工具契约，不能解决注入故障。 |
| 普通 page_exec 连最简单 return 都无结果 | `pageConsoleEvaluate` 同样是 async 注入函数，受相同构建问题影响；并非用户脚本缺少 return。 |
| 强制 CDP 后脚本可用，输入框仍为空 | CDP 直接求值表达式，不序列化受损的注入包装函数。这与注入层故障一致，也说明检查时之前的填充没有生效。 |
| click 报 args 第 2 项 Value is unserializable | `args: [action, elementId, value]` 中 click 不带 value，第三项为 undefined，Chrome 在调用校验阶段即拒绝。它与前面的 async helper 问题相互独立。 |
| 最终只有 CDP 脚本赋值取得进展 | 默认交互与默认脚本回退恰好共享构建缺陷；换引用和动作无法绕开，显式 CDP 才绕开了它。日志结束于赋值后准备点击，不能认定搜索已提交或后续任务完成。 |

## 构建层根因

原 `wxt.config.ts` 指定 `build.target = 'es2015'`，Vite/esbuild 将 async 函数降级为普通函数，借助模块作用域的 helper 执行 generator。

修复前真实 `.output/chrome-mv3/background.js` 中三处均形如：

```js
function domActionPayload(...) {
  return ct(this, null, function* () { /* ... */ });
}
```

`chrome.scripting.executeScript({func})` 只复制该函数源码，不携带模块闭包。页面中没有 `ct`，因此函数在进入实际 DOM 操作之前就失败。`textTargetPayload` 和 `pageConsoleEvaluate` 具有相同问题。源文件里“完全自包含”的设计，在构建降级后不再成立。

原真实浏览器测试单独指定 `target: 'es2022'`，且未启用压缩；它测试的函数没有生产环境中的降级 helper，因此原先通过测试仍不能防住本次故障。其模拟注入还用 `JSON.stringify(args)`，会将数组中的 undefined 自动转成 null，掩盖 click 的参数问题。

## 修复

1. 使用共享的 `scripts/browser-build-target.mjs` 将生产与浏览器测试目标统一为 ES2022，保留原生 async/await 和对象展开，避免注入函数依赖降级 helper；浏览器测试同时启用压缩。此变更面向现代浏览器，构建产物不再宣称 ES2015 语法兼容。
2. click/fill 注入参数改用 `value ?? ''`。fill 仍在入口校验字符串，空字符串清空语义保持有效；click 不再传入 undefined。
3. 没有注入返回值时返回 `INJECTION_NO_RESULT`，提示执行结果不确定、先观察现状，明确重采不能修复注入故障。真正由节点解析返回的 `STALE_ELEMENT` 保留原义。
4. 保留无返回值和传输异常时不自动重放的行为，避免已生效输入或提交被重复执行。

## 验证

- 将浏览器测试改为原 ES2015 生产目标后，真实 Chromium 首次 fill 即复现外部 helper 未定义的 ReferenceError。
- 改为共享 ES2022 目标后，压缩构建的真实浏览器测试通过：DOM click（不传 value）、fill、focus、原生按键与输入、AX、滚动、iframe、Shadow DOM、网络正文、MAIN/ISOLATED page_exec，以及无结果不重放。
- 模拟输入事件已触发但注入回传丢失：事件仅触发一次，值确实写入，错误分类为 INJECTION_NO_RESULT；focus 无返回值同样不误报 STALE_ELEMENT。
- `npm run test:tools`：2580 项通过，0 项失败。
- `npm run build`：Chrome MV3 生产构建成功；检查产物确认三处函数保留原生 async。
- `npm run compile`：本次修改没有遗留诊断；全库检查仍被设置表单、channel-validation、model-registry 和 channels 测试中的 6 条无关类型错误阻断。

构建完成后，需要在浏览器扩展管理页重新加载 `.output/chrome-mv3`，才会使用修复后的后台代码；已运行的旧扩展不会仅因磁盘文件变化自动替换。
