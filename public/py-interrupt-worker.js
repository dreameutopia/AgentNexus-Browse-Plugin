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
 */

/** 当前挂起的超时定时器（arm 重复调用时先清旧定时器） */
let pendingTimer = null;

self.onmessage = event => {
  const data = event.data || {};
  if (data.type === 'arm' && typeof data.timeoutMs === 'number' && data.buffer) {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    const signal = new Int32Array(data.buffer);
    // 先复位残留信号，再武装定时器（官方示例同款防御）
    signal[0] = 0;
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      // 2 = SIGINT → Python 侧抛出 KeyboardInterrupt
      signal[0] = 2;
      // 回报触发事实：主线程据此把 KeyboardInterrupt 归类为超时中断
      self.postMessage({ type: 'fired' });
    }, data.timeoutMs);
    return;
  }
  if (data.type === 'disarm') {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }
};
