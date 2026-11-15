/**
 * 注入安全层回归测试（tools/common/script-injection + tools/vision/injection）。
 *
 * 背景：chrome.scripting.executeScript 的参数走 JSON 语义序列化，顶层 undefined
 * 直接被拒（"Error at index 0: Value is unserializable."）——曾导致
 * vision_gui(action="check") 不带 point 时 100% INTERNAL_ERROR。
 * 本文件锁定三类行为：
 *   1. 参数净化：undefined 归一、危险值定位报错、合法值原样通过；
 *   2. Chrome 错误分类：原始文案 → 稳定分类 + 可读原因 + 恢复建议；
 *   3. 视觉域封装：分类映射成 GuiError，guiFailure 把关键字段透出到 error 字符串。
 */
import assert from "node:assert/strict";
import {
  normalizeInjectionArgs,
  classifyInjectionError,
  classifyInjectedFunctionError,
  noResultFailure,
  InjectionArgumentError,
} from "../../tools/common/script-injection";

// ---- 1. 参数净化 ----
{
  // 顶层 undefined → null（历史缺陷的回归锚点：check 无 point）
  const [first, second] = normalizeInjectionArgs([undefined, { expect: {} }]);
  assert.equal(first, null);
  assert.deepEqual(second, { expect: {} });

  // 对象内的 undefined 属性被丢弃（JSON 语义），已定义值原样保留
  const payload = normalizeInjectionArgs([
    { point: null, region: undefined, direction: "down" },
  ])[0] as Record<string, unknown>;
  assert.deepEqual(payload, { point: null, direction: "down" });
  assert.ok(!("region" in payload), "undefined 属性必须整键消失，而非变 null");

  // 嵌套结构里的 undefined 同样收敛；NaN/Infinity 归 null（JSON 语义）
  const nested = normalizeInjectionArgs([
    { a: { b: undefined, c: [[undefined]] }, n: Number.NaN, i: Number.POSITIVE_INFINITY },
  ])[0] as any;
  assert.deepEqual(nested, { a: { c: [[null]] }, n: null, i: null });

  // JSON 可表达的值原样通过
  const passthrough = normalizeInjectionArgs([
    "text",
    0,
    false,
    { list: [1, "two", null, { three: 3 }] },
  ]);
  assert.deepEqual(passthrough, ["text", 0, false, { list: [1, "two", null, { three: 3 }] }]);

  // Date/RegExp 退化为字符串表示（与 JSON 序列化一致）
  const coerced = normalizeInjectionArgs([new Date(0), /abc/gi])[0];
  assert.equal(coerced, "1970-01-01T00:00:00.000Z");

  // 危险值逐一定位报错
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const rejections: [unknown, string][] = [
    [() => {}, "function"],
    [Symbol("x"), "symbol"],
    [1n, "bigint"],
    [cycle, "circular"],
  ];
  for (const [value, kind] of rejections) {
    assert.throws(
      () => normalizeInjectionArgs([value]),
      (error: unknown) => {
        assert.ok(error instanceof InjectionArgumentError);
        assert.match(error.message, new RegExp(`args\\[0\\]`, "i"));
        assert.equal(error.detail.kind, kind);
        return true;
      },
      `${kind} 必须在发出前被拒绝并定位`,
    );
  }

  // 定位要延伸到嵌套路径
  assert.throws(
    () => normalizeInjectionArgs([{ ok: 1, bad: { deep: () => {} } }]),
    (error: unknown) => {
      assert.ok(error instanceof InjectionArgumentError);
      assert.match(error.message, /args\[0\]\.bad\.deep/);
      return true;
    },
  );
}

// ---- 2. Chrome 错误分类 ----
{
  const unserializable = classifyInjectionError(
    new Error(
      "Error in invocation of scripting.executeScript(scripting.ScriptInjection injection, optional function callback): " +
        "Error at parameter 'injection': Error at property 'args': Error at index 0: Value is unserializable.",
    ),
    { operation: "Check visual target" },
  );
  assert.equal(unserializable.code, "ARGUMENT_NOT_SERIALIZABLE");
  assert.equal(unserializable.argIndex, 0);
  assert.match(unserializable.message, /JSON-serializable/);
  assert.ok(unserializable.recovery.length > 0, "必须给出恢复建议");

  const permission = classifyInjectionError(
    new Error("Cannot access contents of the page. Extension manifest must request permission to access the respective host."),
    { operation: "Read page" },
  );
  assert.equal(permission.code, "PERMISSION_DENIED");

  const restricted = classifyInjectionError(
    new Error("Cannot access a chrome:// URL"),
    { operation: "Read page" },
  );
  assert.equal(restricted.code, "RESTRICTED_PAGE");

  const frameRemoved = classifyInjectionError(
    new Error("A frame with ID 123 was removed."),
    { operation: "Read page" },
  );
  assert.equal(frameRemoved.code, "FRAME_REMOVED");

  const tabGone = classifyInjectionError(
    new Error("No tab with id: 42."),
    { operation: "Read page" },
  );
  assert.equal(tabGone.code, "TAB_GONE");

  // 未命中已知模式 → 兜底分类，仍带可读原因
  const fallback = classifyInjectionError(new Error("Something odd happened"), {
    operation: "Read page",
  });
  assert.equal(fallback.code, "INJECTION_FAILED");
  assert.match(fallback.message, /Read page failed: Something odd happened/);

  const thrown = classifyInjectedFunctionError(new Error("TypeError: x is not a function"), {
    operation: "visual check payload",
  });
  assert.equal(thrown.code, "INJECTION_FAILED");
  assert.equal(thrown.reason, "injected-function-threw");

  const none = noResultFailure({ operation: "Read page" });
  assert.equal(none.code, "NO_RESULT");
  assert.match(none.message, /no result frame/i);
}

// ---- 3. 视觉域封装：GuiError 映射与 error 字符串透出 ----
{
  const { guiFailure } = await import("../../tools/vision/gui-errors");

  const failure = guiFailure(
    new (await import("../../tools/vision/gui-errors")).GuiError(
      "INVALID_ARGUMENT",
      "Unexpected parameter for check: elementId. This action accepts: screenshotId, point, expect.",
      { allowedFields: ["screenshotId", "point", "expect"], fields: ["elementId"] },
      "Capture a fresh screenshot.",
      "Remove the rejected field and resend.",
    ),
    { action: "check" },
  );
  assert.equal(failure.success, false);
  assert.match(
    String(failure.error),
    /Unexpected parameter for check: elementId/,
    "error 字符串必须自带关键诊断（模型常只看得到这一行）",
  );
  assert.match(String(failure.error), /allowed fields: screenshotId/);
  assert.match(String(failure.error), /Fix: Remove the rejected field/);
  assert.equal(failure.data!.diagnostic.retryable, false);

  // 非 GuiError → INTERNAL_ERROR 兜底 + 修复提示
  const internal = guiFailure(new Error("boom"), { action: "check" });
  assert.equal(internal.data!.diagnostic.code, "INTERNAL_ERROR");
  assert.match(String(internal.error), /\[INTERNAL_ERROR\] boom/);
  assert.ok(internal.data!.diagnostic.hint, "未预期失败也要给修复方向");
}
console.log(
  "[script-injection] 参数净化、Chrome 错误分类与视觉域错误透出全部通过。",
);
