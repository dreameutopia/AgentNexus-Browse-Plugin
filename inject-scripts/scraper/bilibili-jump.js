/* eslint-disable */
// Bilibili 视频控制（主世界脚本）
(() => {
  if (window.__BILIBILI_JUMP_MAIN_READY__) return;
  window.__BILIBILI_JUMP_MAIN_READY__ = true;

  const EVENT = {
    EXECUTE: 'chrome-mcp:execute',
    RESPONSE: 'chrome-mcp:response',
  };

  const log = (...args) => console.log('[BilibiliJump]', ...args);
  const err = (...args) => console.error('[BilibiliJump]', ...args);

  const getVideo = () => {
    const wrapper = document.getElementById('bilibili-player');
    const v = wrapper?.querySelector('video');
    return v || document.querySelector('video');
  };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const formatTime = (seconds) => {
    seconds = Math.max(0, Number(seconds) || 0);
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s
      .toString()
      .padStart(2, '0')}`;
  };

  const parseTimeString = (time) => {
    if (typeof time === 'number') return time;
    const str = String(time || '').trim();
    if (/^\d+(\.\d+)?$/.test(str)) return Number(str);
    const parts = str.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    throw new Error('无效的时间格式');
  };

  const actions = {
    ping() {
      return { ok: true };
    },
    jumpToTime(payload) {
      const video = getVideo();
      if (!video) throw new Error('未找到视频元素');
      const p = payload || {};
      const t = parseTimeString(p.time);
      video.currentTime = clamp(t, 0, Number(video.duration) || t);
      return { currentTime: video.currentTime, formattedTime: formatTime(video.currentTime) };
    },
    getStatus() {
      const video = getVideo();
      if (!video) throw new Error('未找到视频元素');
      return {
        currentTime: video.currentTime,
        duration: video.duration,
        formattedTime: formatTime(video.currentTime),
        formattedDuration: formatTime(video.duration || 0),
        paused: video.paused,
        volume: video.volume,
        playbackRate: video.playbackRate,
        muted: video.muted,
      };
    },
    play() {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      v.play();
      return { paused: v.paused };
    },
    pause() {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      v.pause();
      return { paused: v.paused };
    },
    togglePlayPause() {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      v.paused ? v.play() : v.pause();
      return { paused: v.paused };
    },
    fastForward(payload) {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      const sec = Number(payload?.seconds ?? 10);
      v.currentTime = clamp(v.currentTime + Math.abs(sec), 0, v.duration || v.currentTime + Math.abs(sec));
      return { currentTime: v.currentTime, formattedTime: formatTime(v.currentTime) };
    },
    rewind(payload) {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      const sec = Number(payload?.seconds ?? 10);
      v.currentTime = clamp(v.currentTime - Math.abs(sec), 0, v.duration || v.currentTime);
      return { currentTime: v.currentTime, formattedTime: formatTime(v.currentTime) };
    },
    setSpeed(payload) {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      const sp = clamp(Number(payload?.speed ?? 1.0), 0.1, 4.0);
      v.playbackRate = sp;
      return { playbackRate: v.playbackRate };
    },
    setVolume(payload) {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      const vol = clamp(Number(payload?.volume ?? 1.0), 0, 1);
      v.volume = vol;
      return { volume: v.volume };
    },
    toggleMute() {
      const v = getVideo();
      if (!v) throw new Error('未找到视频元素');
      v.muted = !v.muted;
      return { muted: v.muted };
    },
  };

  window.addEventListener(EVENT.EXECUTE, (ev) => {
    const { action, payload, requestId } = ev.detail || {};
    const respond = (data, error) => {
      window.dispatchEvent(
        new CustomEvent(EVENT.RESPONSE, { detail: { requestId, data, error } })
      );
    };

    try {
      log('EXECUTE', action, payload);
      const p = typeof payload === 'string' ? (() => { try { return JSON.parse(payload); } catch { return {}; } })() : (payload || {});
      if (!action || !actions[action]) throw new Error(`未知操作: ${String(action)}`);
      const result = actions[action](p);
      respond(result, undefined);
    } catch (e) {
      err('执行失败:', e);
      respond(undefined, e?.message || String(e));
    }
  });

  log('主世界控制脚本已就绪');
})();