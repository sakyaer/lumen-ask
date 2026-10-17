// autoscroll.js - 流式输出时的「贴底」滚动控制，popup 聊天与划词面板共用。
// 暴露 window.LumenAutoScroll.create(el, opts)，须先于 content_script.js / popup.js 加载
// （manifest 的 content_scripts 与 background 重注入的 files 数组里都排在 content_script.js 之前）。
//
// 解决什么问题：逐字流式输出时每个 chunk 都把 scrollTop 拍到底部，
// 用户刚往上滑就被拽回去 —— 滚动条进度反复跳、字在眼前刷新，根本滑不上去。
//
// 规则：
//   1. 用户一有滚动意图（滚轮 / 触摸 / 键盘 / 拖滚动条）就立刻停掉自动贴底，
//      必须赶在下一个 chunk 之前生效，否则「滑一下又被拍回去」的抖动依旧存在；
//   2. 手还在动的时候不再重新开启贴底（否则慢速上滑时会被反复拉回），
//      等手停下（GESTURE_IDLE_MS 内没有新的滚动输入）再按真实位置判定；
//   3. 用户自己滚回底部附近，自动贴底恢复。
(() => {
  'use strict';

  const NEAR_BOTTOM_PX = 24;     // 距底部 24px 内算「还在底部」
  const AT_BOTTOM_PX = 2;        // 距底部 2px 内算「已经到底」
  const GESTURE_IDLE_MS = 140;   // 最后一次滚动输入后多久算「手停了」

  // el: 可滚动的消息容器（overflow-y: auto）
  // opts.threshold: 判定「贴底」的像素距离，默认 24
  // opts.idleMs:    手势结束判定的静默时长，默认 140ms
  function create(el, opts) {
    if (!el) return null;
    const threshold = Number.isFinite(opts && opts.threshold) ? opts.threshold : NEAR_BOTTOM_PX;
    const idleMs = Number.isFinite(opts && opts.idleMs) ? opts.idleMs : GESTURE_IDLE_MS;

    let stick = true;          // true = 跟随流式输出自动贴底
    let programmatic = false;  // 程序自己滚动引发的 scroll 事件，不代表用户意图
    let gestureUntil = 0;      // 手势窗口截止时间戳（0 = 手停了）
    let idleTimer = null;

    const distanceToBottom = () => Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
    const canScroll = () => el.scrollHeight > el.clientHeight;
    const gesturing = () => Date.now() < gestureUntil;

    // 标记「手还在动」：窗口内只允许停用贴底、不允许恢复，
    // 否则慢速上滑时每个 scroll 事件都因为还贴着底而重新开回自动滚动，来回拉扯。
    function markGesture() {
      gestureUntil = Date.now() + idleMs;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        gestureUntil = 0;
        idleTimer = null;
        // 手停了：按真实位置决定是否恢复跟随
        if (!programmatic) stick = distanceToBottom() <= threshold;
      }, idleMs);
    }

    // force=true 时无视用户当前位置强制贴底（新消息、切会话）
    function toBottom(force) {
      if (!force && !stick) return;
      programmatic = true;
      el.scrollTop = el.scrollHeight;
      // 同一次渲染更新里 scroll 事件先于 rAF 回调派发：
      // 清标记时程序滚动引发的 scroll 事件已被跳过，不会被误判成「用户在滑」
      requestAnimationFrame(() => { programmatic = false; });
    }

    // 新一轮输出开始：重新开启自动贴底
    function reset() { stick = true; }

    function isSticking() { return stick; }

    // 用户主动上滑：必须赶在下一个 chunk 之前停掉贴底。
    // 内容还没超出可视区时上滑不会有任何位移，此时停贴底会导致再也回不来。
    function onWheel(e) {
      if (e.deltaY < 0 && canScroll()) stick = false;
      markGesture();   // 向下滚也算「手在动」：先别急着恢复跟随
    }

    function onKeyDown(e) {
      if (e.key === 'ArrowUp' || e.key === 'PageUp' || e.key === 'Home') stick = false;
      markGesture();
    }

    function onMouseDown(e) {
      // mousedown 的 target 是容器本身 = 按在滚动条上，拖动前先解除贴底
      if (e.target === el) { stick = false; markGesture(); }
    }

    function onTouchMove() { stick = false; markGesture(); }

    // 滚动位置变化：滑离底部立刻停；已经滑到底就恢复跟随。
    // 滚动事件本身也是「手还在动」的信号（拖滚动条、惯性滑动都会持续派发）。
    function onScroll() {
      if (programmatic) return;
      markGesture();
      const d = distanceToBottom();
      if (d > threshold) stick = false;
      else if (d <= AT_BOTTOM_PX) stick = true;
    }

    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('keydown', onKeyDown);
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('scroll', onScroll, { passive: true });

    return {
      toBottom,                                // 流式 chunk：仅在贴底状态下跟随
      forceBottom: () => toBottom(true),       // 强制贴底
      reset,                                   // 重新开启自动贴底
      isSticking,
      isGesturing: gesturing,
      destroy() {
        clearTimeout(idleTimer);
        idleTimer = null;
        gestureUntil = 0;
        el.removeEventListener('wheel', onWheel);
        el.removeEventListener('keydown', onKeyDown);
        el.removeEventListener('mousedown', onMouseDown);
        el.removeEventListener('touchmove', onTouchMove);
        el.removeEventListener('scroll', onScroll);
      },
    };
  }

  window.LumenAutoScroll = { create };
})();
