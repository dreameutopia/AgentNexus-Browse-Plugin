/**
 * Pyodide 执行超时中断 Worker（静态资源，随扩展打包）
 *
 * 背景：Pyodide 在调用线程上同步执行 Python 字节码，主线程 JS 计时器在
 * 死循环期间无法触发。官方中断机制是 SharedArrayBuffer 中断缓冲区：
 * Python 解释器在字节码求值循环中轮询该缓冲区，另一个线程写入信号
 * 值（2 = SIGINT）即可让解释器抛出 KeyboardInterrupt。
 *
 * 本 Worker 即"另一个线程"：收到 arm 消息后启动定时器，超时向缓冲区
 * 写入 2；收到 disarm 消息取消定时器。扩展页已通过 manifest 的
 * cross_origin_embedder_policy / cross_origin_opener_policy 获得
 * 跨域隔离（crossOriginIsolated），SharedArrayBuffer 可用。
 *
 * 消息协议：
 *   { type: 'arm', timeoutMs: number, buffer: SharedArrayBuffer }
 *   { type: 'disarm' }
 *   { type: 'interrupt' }  —— 立即中断（用户停止 / 强制中断）
 */

/** 当前挂起的超时定时器（arm 重复调用时先清旧定时器） */
let pendingTimer = null;

/** 最近一次 arm 时登记的中断缓冲区（interrupt 消息据此立即写入 SIGINT） */
let armedBuffer = null;

/**
 * 立即中断：向中断缓冲区写入 SIGINT。
 *
 * 与超时路径同源，但**不等定时器**——用户点停止时立刻生效，不受剩余超时
 * 时间影响。清掉待触发定时器，避免中断后又补一次 SIGINT。
 */
function fireInterrupt(reason) {
  const target = armedBuffer;
  if (!target) return false;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
  const signal = new Int32Array(target);
  // 2 = SIGINT → Python 侧抛出 KeyboardInterrupt
  // Record the reason separately: CPython clears slot 0 after handling SIGINT.
  if (Atomics.compareExchange(signal, 1, 0, reason) === 0) Atomics.store(signal, 0, 2);
  return true;
}

self.onmessage = event => {
  const data = event.data || {};
  if (data.type === 'arm' && typeof data.timeoutMs === 'number' && data.buffer) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    armedBuffer = data.buffer;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      fireInterrupt(1);
    }, data.timeoutMs);
    return;
  }
  if (data.type === 'disarm') {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    armedBuffer = null;
    return;
  }
  if (data.type === 'interrupt') {
    // 立即中断（用户停止 / 引擎强制终止）：不等超时定时器
    fireInterrupt(2);
  }
};
