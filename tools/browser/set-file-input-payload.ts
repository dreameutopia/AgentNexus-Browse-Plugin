/**
 * file input 装载（注入，自包含）——browser_interact(action="set_files") 的页面侧执行体。
 *
 * 为什么存在：browser_interact 此前没有任何文件通道，隐藏的
 * `input[type=file]`（自定义上传按钮包壳的常态）只能交给用户手动上传。
 * 本路径从会话工作区读出字节、分块注入页面、组装 File 后赋给
 * `input.files` 并派发 input/change 事件（与真实选择文件等价）。
 *
 * 分块协议（宿主驱动）：
 *   - append：把一段 base64 暂存到页面侧缓冲（按 token+fileIndex 键），
 *     避免单次注入参数过大；
 *   - commit：按 specs 组装全部 File → 一次性赋值 → 派发事件 → 回读校验，
 *     finally 清理缓冲。**赋值前不改页面任何状态**，中途失败只残留可清理的
 *     字符串缓冲（这也是 cleanup 动作存在的原因）。
 *
 * 刻意豁免可见性/遮挡检查：隐藏 file input 是该控件族的正确形态，其它动作
 * 的可见性闸门不适用于它；目标合法性由「必须是/必须包含 file input」判定。
 *
 * 注入约束：本函数必须完全自包含（闭包不随注入带入），只能引用自身参数与
 * 页面全局。
 */
export function setFileInputPayload(
  action: 'append' | 'commit' | 'cleanup',
  token: string,
  fileIndex: number,
  chunk: string,
  elementId: string,
  specs: Array<{ name: string; size: number; mime: string }>,
) {
  const scope = window as unknown as Record<string, unknown>;
  const rootKey = '__anxUploadBuffers';
  const buffers = ((scope[rootKey] as Record<string, string[]>) ??
    (scope[rootKey] = {}));
  const prefix = `__anx_up_${token}_`;
  const keyFor = (index: number) => `${prefix}${index}`;

  if (action === 'append') {
    const key = keyFor(fileIndex);
    (buffers[key] ??= []).push(chunk);
    return { success: true, action, fileIndex };
  }
  if (action === 'cleanup') {
    for (const key of Object.keys(buffers))
      if (key.startsWith(prefix)) delete buffers[key];
    if (!Object.keys(buffers).length) delete scope[rootKey];
    return { success: true, action };
  }

  try {
    const registry = (document as unknown as Record<string, unknown> & {
      __agentNexusReferences?: {
        resolve?: (id: string) => Element | null;
      };
    }).__agentNexusReferences;
    let target = registry?.resolve?.(elementId) ?? null;
    if (!target)
      return {
        error:
          'STALE_ELEMENT：目标引用已失效，重新 browser_observe(view="form") 获取 file input 引用',
      };
    const isFileInput =
      target.localName === 'input' &&
      (target as HTMLInputElement).type === 'file';
    let input: HTMLInputElement | null = isFileInput
      ? (target as HTMLInputElement)
      : null;
    if (!input && 'querySelector' in target) {
      const inner = target.querySelector('input[type="file"]');
      if (inner && inner.localName === 'input')
        input = inner as HTMLInputElement;
    }
    if (!input)
      return {
        error:
          'INVALID_TARGET：目标不是 file input，其内部也没有 file input。用 browser_observe(view="form") 找 type=input_file 的字段作为目标。',
      };
    if (!Array.isArray(specs) || !specs.length)
      return { error: 'INVALID_ARGUMENT：没有待装载的文件' };
    if (specs.length > 1 && !input.multiple)
      return {
        error:
          'INVALID_TARGET：该 file input 不支持多选（multiple=false），但传入了多个文件；一次只传一个，或改选支持多选的控件。',
      };

    const files: File[] = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const parts = buffers[keyFor(i)];
      const base64 = parts ? parts.join('') : '';
      if (!base64 && spec.size > 0)
        return {
          error:
            'TRANSFER_INTERRUPTED：文件字节未完整送达页面（缓冲为空），请重新执行 set_files。',
        };
      let bytes: Uint8Array;
      try {
        const binary = atob(base64);
        bytes = new Uint8Array(binary.length);
        for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
      } catch {
        return {
          error:
            'TRANSFER_CORRUPT：base64 缓冲损坏（可能注入中断），请重新执行 set_files。',
        };
      }
      if (bytes.length !== spec.size)
        return {
          error: `TRANSFER_CORRUPT：文件 ${spec.name} 字节数不符（期望 ${spec.size}，实得 ${bytes.length}），请重新执行 set_files。`,
        };
      files.push(
        new File([bytes as unknown as BlobPart], spec.name, {
          type: spec.mime,
        }),
      );
    }

    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    try {
      input.files = transfer.files;
    } catch (error) {
      return {
        error:
          'ASSIGN_REJECTED：浏览器拒绝写入 input.files：' +
          String((error as Error)?.message ?? error).slice(0, 200),
      };
    }
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(
      new Event('change', { bubbles: true, composed: true }),
    );

    // 回读校验：受控组件可能在事件处理里清空/替换文件——以 DOM 实际状态为准，
    // 绝不以「事件已派发」冒充装载成功。
    const actual = input.files
      ? Array.from(input.files).map(f => ({ name: f.name, size: f.size }))
      : [];
    const verified =
      actual.length === files.length &&
      files.every((f, i) => actual[i]?.name === f.name && actual[i]?.size === f.size);
    if (!verified)
      return {
        error:
          'VERIFY_FAILED：事件派发后 input.files 与期望不符（页面可能重置了控件）：' +
          JSON.stringify(actual).slice(0, 300),
      };
    return {
      success: true,
      action,
      outcome: 'files_set',
      files: actual,
      message: `已装载 ${actual.length} 个文件并派发 input/change 事件；input.files 回读一致。业务上仍需确认页面已接收（上传进度/文件名回显）。`,
    };
  } finally {
    for (const key of Object.keys(buffers))
      if (key.startsWith(prefix)) delete buffers[key];
    if (!Object.keys(buffers).length) delete scope[rootKey];
  }
}
