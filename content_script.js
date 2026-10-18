(() => {
  'use strict';

  const SESSIONS_KEY = 'llm_sessions';
  const ACTIVE_ID_KEY = 'llm_active_session_id';
  const CONFIG_KEY = 'llm_config';
  const TOKEN_KEY = 'llm_total_tokens';
  const WORDBOOK_KEY = 'llm_wordbook';        // 单词本（local，不进聊天记录）
  const PENDING_VIEW_KEY = 'llm_pending_view'; // 打开 Popup 时要定位到的视图
  const MAX_SESSIONS = 50;
  const MAX_WORDBOOK = 800;

  // 回答区默认高度：288 是旧默认值，整体上调 30% → 374，减少面板内滚动
  const LEGACY_REPLY_HEIGHT = 288;
  const DEFAULT_REPLY_HEIGHT = 374;

  // 防重复注入。若本页已注入过（插件重载后 background 会重新注入一次），
  // 先让旧实例自报状态：旧实例仍存活 → 本次直接退出；旧实例已失效 → 清理残留后由本次接管。
  if (window.__lumenAskInjected || window.__llmChatInjected) {
    const reboot = window.__lumenAskReboot || window.__llmChatReboot;
    if (typeof reboot === 'function' && reboot()) return;
  }
  window.__lumenAskInjected = true;

  // 框架环境：是否在顶层窗口 / 本 frame 是否值得启用划词
  const LOG_PREFIX = '[Lumen Ask]';
  const FRAME_IS_TOP = (() => { try { return window.top === window.self; } catch { return false; } })();
  const FRAME_TOO_SMALL = (() => {
    try { return window.innerWidth < 160 || window.innerHeight < 160; } catch { return false; }
  })();

  // 扩展被更新/重载后，旧页面的 content script 会与扩展断开连接。
  // 此时划词会静默失效，这里给用户一条可见提示，避免"莫名其妙不能用"。
  let contextDeadWarned = false;
  function notifyContextDead() {
    if (contextDeadWarned) return;
    contextDeadWarned = true;
    console.warn(LOG_PREFIX, '扩展上下文已失效（插件被更新/重新加载），请刷新本页面，划词功能才会恢复。');
    showToast('插件已更新，请刷新本页面后再使用划词');
  }

  function showToast(text, ms = 10000) {
    try {
      if (!document.body) return;
      const el = document.createElement('div');
      el.textContent = text;
      Object.assign(el.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        zIndex: '2147483647',
        maxWidth: '320px',
        padding: '10px 14px',
        background: '#3C3C3C',
        color: '#FFFFFF',
        border: '2px solid #FF9600',
        borderRadius: '10px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
        font: '600 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        cursor: 'pointer',
      });
      el.addEventListener('click', () => el.remove());
      document.body.appendChild(el);
      setTimeout(() => { try { el.remove(); } catch {} }, ms);
    } catch {}
  }

  // 统一挂载点：优先 html 元素。body 常被站点设置 position:relative / transform，
  // 会成为绝对定位的包含块，导致浮动按钮位置偏移；html 元素的坐标系最贴近文档原点。
  function mountTarget() {
    return document.documentElement || document.body;
  }

  function isInvalidatedError(err) {
    const m = String((err && err.message) || err || '');
    return m.includes('Extension context invalidated') || m.includes('message port closed');
  }

  // ===== Cached config (avoid calling chrome.storage on every mouseup) =====
  let cachedConfig = null;

  function isExtensionAlive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  async function loadConfig() {
    if (!isExtensionAlive()) { notifyContextDead(); return; }
    try {
      const data = await chrome.storage.sync.get(CONFIG_KEY);
      cachedConfig = data[CONFIG_KEY] || null;
    } catch { /* extension context invalidated, ignore */ }
  }

  // Initial load
  loadConfig();

  // Keep cache in sync when user saves settings
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[CONFIG_KEY]) {
        cachedConfig = changes[CONFIG_KEY].newValue || null;
      }
    });
  } catch { /* context already gone */ }

  let floatBtn = null;
  let panel = null;
  let shadowRoot = null;
  let shadowHost = null;
  let replyAutoScroll = null;   // 回答区贴底滚动控制（见 autoscroll.js）
  let currentSelection = '';
  let currentRange = null;
  let isStreaming = false;
  let lastUsedModel = null;  // 划词实际请求使用的模型（用于准确显示 badge）

  // ===== Create floating button =====
  function createFloatBtn() {
    floatBtn = document.createElement('div');
    floatBtn.id = '__llm_float_btn';
    floatBtn.innerHTML = `
      <img src="${chrome.runtime.getURL('icons/icon48.png')}" width="36" height="36" alt="" aria-hidden="true">
    `;
    Object.assign(floatBtn.style, {
      position: 'absolute',
      zIndex: '2147483646',
      width: '36px',
      height: '36px',
      background: 'transparent',
      border: '0',
      borderRadius: '12px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      boxShadow: 'none',
      filter: 'drop-shadow(0 7px 10px rgba(25,20,96,0.34))',
      transition: 'transform 0.18s ease, filter 0.18s ease',
      userSelect: 'none',
    });

    floatBtn.addEventListener('mouseenter', () => {
      floatBtn.style.transform = 'translateY(-1px) scale(1.06)';
      floatBtn.style.filter = 'drop-shadow(0 10px 14px rgba(25,20,96,0.44)) brightness(1.05)';
    });
    floatBtn.addEventListener('mouseleave', () => {
      floatBtn.style.transform = 'scale(1)';
      floatBtn.style.filter = 'drop-shadow(0 7px 10px rgba(25,20,96,0.34))';
    });
    floatBtn.addEventListener('mousedown', e => e.stopPropagation());
    floatBtn.addEventListener('click', e => {
      e.stopPropagation();
      hideFloatBtn();
      showPanel();
    });

    mountTarget().appendChild(floatBtn);
  }

  let btnShownAt = 0;

  function showFloatBtn(x, y) {
    // SPA / 页面脚本可能把按钮从 DOM 中移除，每次显示前自愈重建，
    // 否则 floatBtn 变量还在但已脱离 DOM，按钮永远不再出现。
    if (!floatBtn || !floatBtn.isConnected) {
      floatBtn = null;
      createFloatBtn();
    }
    btnShownAt = Date.now();
    floatBtn.style.left = (x + window.scrollX + 4) + 'px';
    floatBtn.style.top = (y + window.scrollY + 4) + 'px';
    floatBtn.style.display = 'flex';
    floatBtn.style.opacity = '0';
    floatBtn.style.transform = 'scale(0.5)';
    requestAnimationFrame(() => {
      floatBtn.style.transition = 'opacity 0.15s, transform 0.15s';
      floatBtn.style.opacity = '1';
      floatBtn.style.transform = 'scale(1)';
    });
  }

  function hideFloatBtn() {
    if (floatBtn) floatBtn.style.display = 'none';
  }

  // ===== Create Shadow DOM Panel =====
  function createPanelIfNeeded() {
    // host 被页面移除时重新挂回，否则面板再也显示不出来
    if (shadowHost) {
      if (!shadowHost.isConnected) mountTarget().appendChild(shadowHost);
      return;
    }

    shadowHost = document.createElement('div');
    shadowHost.id = '__llm_chat_host';
    Object.assign(shadowHost.style, {
      position: 'absolute',
      zIndex: '2147483647',
      display: 'none',
      top: '0',
      left: '0',
    });
    mountTarget().appendChild(shadowHost);

    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    // Inject styles into shadow DOM
    // KaTeX 样式先注入，面板样式后注入，面板里的字号/间距覆盖才能生效
    try {
      const katexCss = window.__LUMEN_KATEX_CSS;
      if (katexCss) {
        const katexStyle = document.createElement('style');
        katexStyle.textContent = katexCss.replace(
          /__LUMEN_FONT_BASE__/g,
          chrome.runtime.getURL('katex/fonts/')
        );
        shadowRoot.appendChild(katexStyle);
      }
    } catch { /* 缺少 katex 资源时忽略，公式会退化为原文 */ }

    const style = document.createElement('style');
    style.textContent = getPanelCSS();
    shadowRoot.appendChild(style);

    // Panel HTML
    const wrapper = document.createElement('div');
    wrapper.id = 'panel-wrapper';
    wrapper.innerHTML = getPanelHTML();
    shadowRoot.appendChild(wrapper);

    bindPanelEvents();
  }

  // ===== 面板尺寸（设置页可配）=====
  // 默认宽度 468 = 原 360×1.3；回答区 374 = 原 288×1.3
  function getPanelWidth() {
    const w = Number(cachedConfig && cachedConfig.panelWidth);
    return Number.isFinite(w) && w >= 320 ? Math.min(w, 800) : 468;
  }
  function getReplyHeight() {
    const h = Number(cachedConfig && cachedConfig.replyHeight);
    if (!Number.isFinite(h) || h < 120) return DEFAULT_REPLY_HEIGHT;
    // 旧默认 288 视为未自定义，直接按新默认 374 渲染（老配置也能立即变高）
    if (h === LEGACY_REPLY_HEIGHT) return DEFAULT_REPLY_HEIGHT;
    return Math.min(h, 800);
  }

  // 「配置」浮层：模型 / 思考深度都收在这里，避免常驻占地方
  function setConfigMenuOpen(open) {
    if (!shadowRoot) return;
    const menu = shadowRoot.getElementById('config-menu');
    const btn = shadowRoot.getElementById('config-btn');
    if (btn) btn.classList.toggle('active', !!open);
    if (!menu) return;
    if (!open) { menu.style.display = 'none'; return; }

    menu.style.display = 'flex';
    if (!btn || !shadowHost) return;
    // 右对齐齿轮按钮、向下展开；下方空间不够就翻到按钮上方
    const b = btn.getBoundingClientRect();
    const host = shadowHost.getBoundingClientRect();
    menu.style.left = Math.max(6, b.right - host.left - menu.offsetWidth) + 'px';
    const below = b.bottom - host.top + 8;
    const flip = b.bottom + 8 + menu.offsetHeight > window.innerHeight;
    menu.style.top = (flip ? Math.max(6, b.top - host.top - menu.offsetHeight - 8) : below) + 'px';
  }

  function showPanel() {
    createPanelIfNeeded();

    // 按配置应用面板宽度 / 回答区高度
    const panelEl = shadowRoot.getElementById('panel');
    const replyAreaEl = shadowRoot.getElementById('reply-area');
    if (panelEl) panelEl.style.width = getPanelWidth() + 'px';
    if (replyAreaEl) replyAreaEl.style.maxHeight = getReplyHeight() + 'px';

    // Position near the selection
    let rect = currentRange ? currentRange.getBoundingClientRect() : null;
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0 && rect.left === 0)) {
      rect = { right: lastPointer.x, bottom: lastPointer.y, top: lastPointer.y, left: lastPointer.x };
    }
    const panelW = getPanelWidth();
    // 高度估算：回答区之外的部分（标题/工具栏/输入区/保存按钮）约占 240px
    const panelH = 240 + getReplyHeight();
    const vpW = window.innerWidth, vpH = window.innerHeight;

    let left = rect.right + window.scrollX - panelW;
    let top = rect.bottom + window.scrollY + 8;

    if (left < window.scrollX + 8) left = window.scrollX + 8;
    if (left + panelW > window.scrollX + vpW - 8) left = window.scrollX + vpW - panelW - 8;
    if (top + panelH > window.scrollY + vpH - 8) top = rect.top + window.scrollY - panelH - 8;
    if (top < window.scrollY + 8) top = window.scrollY + 8;

    shadowHost.style.left = left + 'px';
    shadowHost.style.top = top + 'px';
    shadowHost.style.display = 'block';

    // 标题即划词原文（最多两行，悬停可看全文）
    const titleEl = shadowRoot.getElementById('panel-title-text');
    if (titleEl) {
      titleEl.textContent = currentSelection.replace(/\s+/g, ' ').trim() || '划词提问';
      titleEl.title = currentSelection;
    }

    // 「体检」默认隐藏，每次打开面板都收起（右键「配置」可显隐）；配置浮层也收起
    const thinkTestBtn = shadowRoot.getElementById('panel-think-test');
    if (thinkTestBtn) thinkTestBtn.classList.remove('is-visible');
    setConfigMenuOpen(false);

    // 渲染快捷按钮（使用缓存配置，无需 async）
    renderPresetButtons(cachedConfig);

    // Clear previous state
    const replyEl = shadowRoot.getElementById('reply-content');
    const replyArea = shadowRoot.getElementById('reply-area');
    const customInput = shadowRoot.getElementById('custom-input');
    const saveBtn = shadowRoot.getElementById('save-session-btn');
    if (replyEl) replyEl.textContent = '';
    if (replyArea) replyArea.style.display = 'none';
    if (customInput) customInput.value = '';
    if (saveBtn) saveBtn.style.display = 'none';
    if (replyAutoScroll) replyAutoScroll.reset();   // 重新打开面板：恢复自动贴底
    isStreaming = false;
    setSendBtnState(false);

    // Animate in
    const panel = shadowRoot.getElementById('panel');
    if (panel) {
      panel.style.opacity = '0';
      panel.style.transform = 'scale(0.85) translateY(10px)';
      requestAnimationFrame(() => {
        panel.style.transition = 'opacity 0.25s cubic-bezier(0.34,1.56,0.64,1), transform 0.25s cubic-bezier(0.34,1.56,0.64,1)';
        panel.style.opacity = '1';
        panel.style.transform = 'scale(1) translateY(0)';
      });
    }
  }

  function hidePanel() {
    if (!shadowHost) return;
    setConfigMenuOpen(false);
    const panel = shadowRoot.getElementById('panel');
    if (panel) {
      panel.style.opacity = '0';
      panel.style.transform = 'scale(0.9) translateY(6px)';
      setTimeout(() => { shadowHost.style.display = 'none'; }, 200);
    } else {
      shadowHost.style.display = 'none';
    }
  }

  // ===== Panel HTML =====
  function getPanelHTML() {
    return `
      <div id="panel">
        <div class="panel-header">
          <div class="panel-title">
            <img class="lumen-icon" src="${chrome.runtime.getURL('icons/icon32.png')}" width="19" height="19" alt="" aria-hidden="true">
            <span class="panel-title-text" id="panel-title-text"></span>
          </div>
          <div class="header-actions">
            <div class="config-wrap" id="config-wrap">
              <button class="config-btn" id="config-btn" title="配置：切换模型 / 思考深度" aria-label="配置">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 008 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H2a2 2 0 010-4h.09A1.65 1.65 0 004.6 8a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V2a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H22a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"></path>
                </svg>
              </button>
            </div>
            <button class="close-btn" id="close-btn">×</button>
          </div>
        </div>

        <div class="panel-toolbar" id="panel-toolbar">
          <div class="preset-btns" id="preset-btns">
            <!-- 由配置动态渲染 -->
          </div>
          <span class="toolbar-divider" aria-hidden="true"></span>
          <div class="custom-area">
            <input type="text" id="custom-input" class="custom-input" placeholder="输入自定义问题...">
            <button class="send-btn" id="send-btn">
              <svg id="send-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                <line x1="22" y1="2" x2="11" y2="13"></line>
                <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
              </svg>
            </button>
          </div>
        </div>

        <div id="reply-area" class="reply-area" style="display:none;">
          <div class="reply-header">
            <span>AI 回复</span>
            <div id="reply-loading" class="reply-loading" style="display:none;">
              <div class="dot-pulse"></div>
            </div>
            <span id="reply-status" class="reply-status"></span>
            <div id="save-session-btn" class="save-session-btn" style="display:none;">
              <button id="btn-save-session" title="点击打开 Popup 继续对话">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"></path>
                </svg>
                打开 Popup 继续对话
              </button>
            </div>
          </div>
          <div id="reply-content" class="reply-content"></div>
        </div>
      </div>

      <!-- 「配置」浮层挂在 #panel 外面：面板是 overflow:hidden，放里面会被裁掉 -->
      <div class="config-menu" id="config-menu" style="display:none;">
        <div class="config-menu-title">本次划词使用</div>
        <label class="ctrl">
          <span class="ctrl-label">模型</span>
          <select id="panel-model-select" class="panel-select" title="划词使用的模型"></select>
        </label>
        <label class="ctrl">
          <span class="ctrl-label">思考深度</span>
          <select id="panel-think-select" class="panel-select" title="划词的思考强度"></select>
        </label>
        <button id="panel-think-test" class="panel-mini-btn" title="实测哪个思考参数真正生效（默认隐藏，右键此处可显隐）">体检</button>
      </div>
    `;
  }

  // ===== Panel CSS =====
  function getPanelCSS() {
    return `
      @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@600;700;800&display=swap');
      * { box-sizing: border-box; margin: 0; padding: 0; }

      @keyframes panelIn {
        from { opacity: 0; transform: scale(0.88) translateY(10px); }
        60%  { opacity: 1; transform: scale(1.03) translateY(-3px); }
        to   { transform: scale(1) translateY(0); }
      }
      @keyframes blink { 0%,100%{opacity:1}50%{opacity:0} }
      @keyframes dotAnim { 0%,80%,100%{transform:scale(0.6);opacity:0.4}40%{transform:scale(1);opacity:1} }
      @keyframes spin { to { transform: rotate(360deg); } }
      @keyframes msgPop {
        from { opacity:0; transform: translateY(8px) scale(0.94); }
        60%  { transform: translateY(-3px) scale(1.02); }
        to   { opacity:1; transform: translateY(0) scale(1); }
      }

      #panel {
        width: 468px;
        max-width: calc(100vw - 16px);
        background: #FFFFFF;
        border: 3px solid #AFAFAF;
        border-radius: 18px;
        box-shadow: 0 8px 0 #AFAFAF, 0 14px 30px rgba(0,0,0,0.15);
        overflow: hidden;
        font-family: 'Nunito', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        color: #3C3C3C;
        animation: panelIn 0.35s cubic-bezier(0.34,1.56,0.64,1);
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 11px 14px;
        border-bottom: 2px solid #E5E5E5;
        background: linear-gradient(135deg, #E8F9E0, #F0FAFF);
      }

      .panel-title {
        display: flex;
        align-items: center;
        gap: 7px;
        flex: 1;
        min-width: 0;
        font-size: 13px;
        font-weight: 800;
        color: #46A302;
      }
      .panel-title .lumen-icon {
        flex-shrink: 0;
        display: block;
        filter: drop-shadow(0 2px 3px rgba(37,31,118,0.2));
      }
      /* 标题直接显示划词原文，最多两行，全文见 title 提示 */
      .panel-title-text {
        min-width: 0;
        font-size: 12px;
        font-weight: 800;
        line-height: 1.45;
        color: #3C3C3C;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        word-break: break-word;
      }

      /* 头部右侧：配置 + 关闭 */
      .header-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
      }
      .config-wrap { flex-shrink: 0; }
      /* 与 close-btn 同尺寸的小齿轮图标按钮 */
      .config-btn {
        width: 24px;
        height: 24px;
        padding: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: inherit;
        color: #3C3C3C;
        background: #FFFFFF;
        border: 2px solid #AFAFAF;
        border-radius: 8px;
        cursor: pointer;
        box-shadow: 0 2px 0 #AFAFAF;
        transition: all 0.15s;
      }
      .config-btn svg { display: block; }
      .config-btn:hover { background: #F0F0F0; }
      .config-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 #AFAFAF; }
      .config-btn.active {
        background: #E8F4FF;
        border-color: #1CB0F6;
        color: #0090D4;
        box-shadow: 0 2px 0 #0090D4;
      }
      /* 挂在 #panel 外面（面板 overflow:hidden 会裁掉浮层），位置由 JS 按齿轮按钮算 */
      .config-menu {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 50;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-width: 236px;
        padding: 10px;
        background: #FFFFFF;
        border: 2px solid #AFAFAF;
        border-radius: 12px;
        box-shadow: 0 6px 0 rgba(175,175,175,0.35), 0 12px 24px rgba(0,0,0,0.14);
      }
      .config-menu-title {
        font-size: 10px;
        font-weight: 800;
        color: #777777;
        letter-spacing: 0.04em;
      }

      /* 一行工具栏：快捷提问按钮 ｜ 自定义问题 */
      .panel-toolbar {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 12px;
        background: #F7FBFF;
        border-bottom: 2px solid #E5E5E5;
      }
      .toolbar-divider {
        flex: 0 0 auto;
        align-self: stretch;
        width: 2px;
        min-height: 18px;
        border-radius: 2px;
        background: #E0E0E0;
      }
      .ctrl {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
      }
      .ctrl-label {
        width: 40px;
        font-size: 10px;
        font-weight: 800;
        color: #777777;
        flex-shrink: 0;
      }
      .panel-select {
        flex: 1;
        min-width: 0;
        font-size: 11px;
        font-weight: 700;
        font-family: inherit;
        color: #3C3C3C;
        background: #FFFFFF;
        border: 1.5px solid #AFAFAF;
        border-radius: 8px;
        padding: 4px 6px;
        cursor: pointer;
        outline: none;
        box-shadow: 0 2px 0 #AFAFAF;
      }
      .panel-select:focus { border-color: #1CB0F6; box-shadow: 0 2px 0 #0090D4; }
      .panel-select option { color: #3C3C3C; background: #FFFFFF; }
      .panel-mini-btn {
        flex-shrink: 0;
        font-size: 10px;
        font-weight: 800;
        font-family: inherit;
        color: #0090D4;
        background: #E8F4FF;
        border: 1.5px solid #0090D4;
        border-radius: 8px;
        padding: 3px 8px;
        cursor: pointer;
        box-shadow: 0 2px 0 #0090D4;
      }
      .panel-mini-btn:hover:not(:disabled) { background: #D6ECFF; }
      .panel-mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      /* 「体检」默认隐藏，右键齿轮区域可显隐 */
      #panel-think-test { display: none; }
      #panel-think-test.is-visible { display: inline-flex; align-items: center; align-self: flex-start; }

      .close-btn {
        width: 24px; height: 24px;
        background: #F0F0F0;
        border: 2px solid #AFAFAF;
        border-radius: 8px;
        cursor: pointer;
        color: #777777;
        font-size: 14px;
        line-height: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.15s;
        box-shadow: 0 2px 0 #AFAFAF;
      }
      .close-btn:hover {
        background: #FFE5E5;
        border-color: #CC3333;
        color: #FF4B4B;
        box-shadow: 0 2px 0 #CC3333;
      }
      .close-btn:active { transform: translateY(1px); box-shadow: 0 1px 0 #AFAFAF; }

      /* 与自定义输入同处一行；空间不够时输入框整体换到下一行 */
      .preset-btns {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 0 0 auto;
        flex-wrap: wrap;
      }

      /* 彩色预设按钮，依次绿/橙/蓝/紫 */
      .preset-btn {
        padding: 4px 7px;
        background: #E8F9E0;
        border: 2px solid #46A302;
        border-radius: 99px;
        color: #46A302;
        font-size: 10px;
        font-weight: 800;
        cursor: pointer;
        font-family: inherit;
        transition: transform 0.12s, box-shadow 0.12s;
        box-shadow: 0 3px 0 #46A302;
      }
      .preset-btn:nth-child(2) { background:#FFF3E0; border-color:#CC7800; color:#CC7800; box-shadow:0 3px 0 #CC7800; }
      .preset-btn:nth-child(3) { background:#E8F4FF; border-color:#0090D4; color:#0090D4; box-shadow:0 3px 0 #0090D4; }
      .preset-btn:nth-child(4) { background:#F8EEFF; border-color:#9B45CC; color:#9B45CC; box-shadow:0 3px 0 #9B45CC; }
      .preset-btn:hover {
        transform: translateY(-2px);
      }
      .preset-btn:hover:nth-child(1) { box-shadow:0 5px 0 #46A302; }
      .preset-btn:hover:nth-child(2) { box-shadow:0 5px 0 #CC7800; }
      .preset-btn:hover:nth-child(3) { box-shadow:0 5px 0 #0090D4; }
      .preset-btn:hover:nth-child(4) { box-shadow:0 5px 0 #9B45CC; }
      .preset-btn:active { transform: translateY(2px) !important; }
      .preset-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
        transform: none !important;
      }

      /* 自定义问题：与快捷按钮同一行 */
      .custom-area {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 1 1 190px;
        min-width: 190px;
      }

      .custom-input {
        flex: 1;
        min-width: 0;
        background: #F7F7F7;
        border: 2px solid #AFAFAF;
        border-radius: 9px;
        padding: 5px 8px;
        color: #3C3C3C;
        font-size: 11px;
        font-weight: 700;
        font-family: inherit;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
        box-shadow: 0 2px 0 #AFAFAF;
      }
      .custom-input::placeholder { color: #AFAFAF; }
      .custom-input:focus {
        border-color: #1CB0F6;
        box-shadow: 0 2px 0 #0090D4;
        background: #FFFFFF;
      }

      .send-btn {
        width: 27px; height: 27px;
        background: #1CB0F6;
        border: none;
        border-radius: 9px;
        cursor: pointer;
        color: white;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.12s, box-shadow 0.12s;
        flex-shrink: 0;
        box-shadow: 0 3px 0 #0090D4;
      }
      .send-btn:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 5px 0 #0090D4; }
      .send-btn:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 1px 0 #0090D4; }
      .send-btn:disabled { opacity: 0.45; cursor: not-allowed; }

      .reply-area {
        max-height: 374px;
        overflow-y: auto;
        border-bottom: 2px solid #E5E5E5;
        background: #F7F7F7;
      }
      .reply-area::-webkit-scrollbar { width: 3px; }
      .reply-area::-webkit-scrollbar-thumb { background: #E5E5E5; border-radius: 3px; }

      .reply-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 14px 4px;
        font-size: 11px;
        font-weight: 900;
        color: #58CC02;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        position: sticky;
        top: 0;
        background: #F7F7F7;
        border-bottom: 1px solid #E5E5E5;
      }

      /* 连接/思考状态：避免"一直转圈但没有内容"的观感 */
      .reply-status {
        margin-left: auto;
        font-size: 10px;
        font-weight: 800;
        color: #AFAFAF;
        text-transform: none;
        letter-spacing: 0;
        max-width: 160px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .reply-content {
        padding: 8px 14px 12px;
        font-size: 13px;
        font-weight: 600;
        color: #3C3C3C;
        line-height: 1.65;
        word-break: break-word;
        animation: msgPop 0.3s cubic-bezier(0.34,1.56,0.64,1);
      }
      /* 内容较长时整体缩小一号 */
      .reply-content.compact { font-size: 12px; line-height: 1.55; }

      /* ===== Markdown 元素 ===== */
      .md-p { margin: 0 0 6px; }
      .md-p:last-child { margin-bottom: 0; }
      .md-h {
        font-weight: 800;
        color: #3C3C3C;
        margin: 8px 0 4px;
        line-height: 1.4;
      }
      .md-h:first-child { margin-top: 0; }
      h2.md-h { font-size: 16px; }
      h3.md-h { font-size: 15px; }
      h4.md-h { font-size: 14px; }
      h5.md-h { font-size: 13px; }
      .reply-content.compact h2.md-h { font-size: 15px; }
      .reply-content.compact h3.md-h { font-size: 14px; }
      .reply-content.compact h4.md-h { font-size: 13px; }
      .reply-content.compact h5.md-h { font-size: 12px; }

      .md-code {
        background: #2F2F2F;
        color: #EDEDED;
        border-radius: 8px;
        padding: 8px 10px;
        margin: 6px 0;
        overflow-x: auto;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 11.5px;
        line-height: 1.5;
        white-space: pre;
      }
      .reply-content.compact .md-code { font-size: 10.5px; }
      .md-code code { font-family: inherit; background: none; padding: 0; }

      .md-inline-code {
        background: rgba(99,102,241,0.12);
        color: #5B54D9;
        border-radius: 4px;
        padding: 1px 5px;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 0.92em;
      }

      .md-list {
        margin: 4px 0 6px;
        padding-left: 20px;
      }
      .md-list li { margin: 2px 0; }
      /* 子项（模型把「音标 / 词性」缩进一层时按层级缩进显示） */
      .md-list .md-list { margin: 2px 0; padding-left: 16px; }
      .md-list .md-list li { margin: 1px 0; }
      /* 「**标签：**内容」词条行：不带圆点，像词典一样紧凑 */
      .md-defs { margin: 3px 0 6px; display: flex; flex-direction: column; gap: 3px; }
      .md-def { margin: 0; line-height: 1.55; }

      .md-quote {
        border-left: 3px solid #1CB0F6;
        background: #E8F4FF;
        border-radius: 0 8px 8px 0;
        padding: 6px 10px;
        margin: 6px 0;
        color: #555555;
      }

      .md-hr {
        border: none;
        border-top: 1.5px solid #E5E5E5;
        margin: 8px 0;
      }

      /* ===== 数学公式（KaTeX）===== */
      .math-inline { display: inline-block; vertical-align: baseline; }
      .math-display {
        display: block;
        margin: 7px 0;
        padding: 2px 0;
        overflow-x: auto;
        overflow-y: hidden;
        text-align: center;
      }
      .math-display .katex-display { margin: 0; }
      .katex { font-size: 1.06em; }
      .reply-content.compact .katex { font-size: 1em; }
      .math-fallback { color: #CC3333; }
      /* 公式过长时横向滚动条细一点 */
      .math-display::-webkit-scrollbar { height: 3px; }
      .math-display::-webkit-scrollbar-thumb { background: #D9D9D9; border-radius: 3px; }

      .md-table-wrap {
        overflow-x: auto;
        margin: 6px 0;
      }
      .md-table {
        border-collapse: collapse;
        font-size: 12px;
        min-width: 100%;
      }
      .reply-content.compact .md-table { font-size: 11px; }
      .md-table th, .md-table td {
        border: 1px solid #E0E0E0;
        padding: 4px 8px;
        text-align: left;
      }
      .md-table th { background: #EFEFEF; font-weight: 800; }

      .reply-content a {
        color: #0090D4;
        text-decoration: underline;
        word-break: break-all;
      }

      .cursor {
        display: inline-block;
        width: 2px; height: 13px;
        background: #58CC02;
        border-radius: 1px;
        margin-left: 1px;
        vertical-align: text-bottom;
        animation: blink 0.8s step-end infinite;
      }

      .dot-pulse { display: flex; gap: 4px; align-items: center; }
      .dot-pulse span {
        width: 6px; height: 6px;
        border-radius: 50%;
        animation: dotAnim 1.4s ease-in-out infinite;
      }
      .dot-pulse span:nth-child(1) { background: #58CC02; }
      .dot-pulse span:nth-child(2) { background: #FF9600; animation-delay: 0.2s; }
      .dot-pulse span:nth-child(3) { background: #1CB0F6; animation-delay: 0.4s; }

      /* 保存状态按钮：跟在「AI 回复」同一行靠右，比原来小一号 */
      .save-session-btn {
        display: flex;
        flex-shrink: 0;
        margin-left: 2px;
      }
      .save-session-btn button {
        display: flex;
        align-items: center;
        gap: 4px;
        background: #FF9600;
        border: 1.5px solid #CC7800;
        border-radius: 8px;
        color: white;
        font-size: 10px;
        font-weight: 800;
        font-family: inherit;
        letter-spacing: 0;
        padding: 3px 8px;
        cursor: pointer;
        box-shadow: 0 2px 0 #CC7800;
        transition: transform 0.12s, box-shadow 0.12s;
      }
      .save-session-btn button:hover { transform: translateY(-1px); box-shadow: 0 3px 0 #CC7800; }
      .save-session-btn button:active { transform: translateY(1px); box-shadow: 0 1px 0 #CC7800; }
      /* 保存成功：整颗按钮转绿 + 白字（原来在橙底上把字改成绿色，糊成一片） */
      .save-session-btn button.saved {
        background: #58CC02;
        border-color: #46A302;
        color: #FFFFFF;
        box-shadow: 0 2px 0 #46A302;
      }
      .save-session-btn button.saved:hover { box-shadow: 0 3px 0 #46A302; }
      .save-session-btn button.saved:active { box-shadow: 0 1px 0 #46A302; }

      .spinner {
        width: 11px; height: 11px;
        border: 2px solid rgba(255,255,255,0.4);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }
    `;
  }

  // ===== Bind Panel Events =====
  function bindPanelEvents() {
    const closeBtn = shadowRoot.getElementById('close-btn');
    const sendBtn = shadowRoot.getElementById('send-btn');
    const customInput = shadowRoot.getElementById('custom-input');
    const saveSessionBtn = shadowRoot.getElementById('btn-save-session');

    closeBtn.addEventListener('click', hidePanel);

    // 回答区：流式输出自动贴底，但用户一上滑就停（见 autoscroll.js）
    replyAutoScroll = window.LumenAutoScroll
      ? window.LumenAutoScroll.create(shadowRoot.getElementById('reply-area'))
      : null;

    // 动态渲染的快捷按钮使用事件委托
    const presetContainer = shadowRoot.getElementById('preset-btns');
    presetContainer.addEventListener('click', e => {
      if (isStreaming) return;
      const btn = e.target.closest('.preset-btn');
      if (!btn) return;
      const prompt = btn.dataset.prompt.replace('{text}', currentSelection);
      const sink = btn.dataset.save === 'wordbook' ? 'wordbook' : 'chat';
      askAI(prompt, [{ role: 'user', content: prompt }], {
        sink,
        term: currentSelection,
      });
    });

    sendBtn.addEventListener('click', () => handleCustomSend());
    customInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); handleCustomSend(); }
    });

    saveSessionBtn.addEventListener('click', () => {
      // 同一个按钮承载两种去向：翻译结果 → 单词本，其他 → 聊天记录
      if (saveSessionBtn.dataset.mode === 'wordbook') openWordbook();
      else openPopupForSession();
    });

    // 面板内直接切模型 / 调思考强度（写回配置，与设置页同步）
    const patchConfig = async (patch) => {
      try {
        const data = await chrome.storage.sync.get(CONFIG_KEY);
        const cfg = data[CONFIG_KEY] || {};
        Object.assign(cfg, patch);
        await chrome.storage.sync.set({ [CONFIG_KEY]: cfg });
        cachedConfig = cfg;
      } catch (e) {
        if (isInvalidatedError(e)) notifyContextDead();
      }
    };

    const modelSelect = shadowRoot.getElementById('panel-model-select');
    if (modelSelect) {
      modelSelect.addEventListener('change', () => {
        lastUsedModel = null;
        patchConfig({ selectionModel: modelSelect.value });
      });
    }

    const thinkSelect = shadowRoot.getElementById('panel-think-select');
    if (thinkSelect) {
      thinkSelect.addEventListener('change', () => {
        patchConfig({ selectionReasoningEffort: thinkSelect.value });
      });
    }

    const thinkTestBtn = shadowRoot.getElementById('panel-think-test');
    if (thinkTestBtn) {
      thinkTestBtn.addEventListener('click', () => runPanelThinkTest());
    }

    // 齿轮浮层：模型 / 思考深度都在里面，点其他地方自动收起
    const configBtn = shadowRoot.getElementById('config-btn');
    const configMenu = shadowRoot.getElementById('config-menu');
    const configWrap = shadowRoot.getElementById('config-wrap');
    if (configBtn && configMenu) {
      configBtn.addEventListener('click', e => {
        e.stopPropagation();
        setConfigMenuOpen(configMenu.style.display === 'none');
      });
    }
    shadowRoot.addEventListener('mousedown', e => {
      if (!configMenu || configMenu.style.display === 'none') return;
      if (configWrap && configWrap.contains(e.target)) return;
      if (configMenu.contains(e.target)) return;
      setConfigMenuOpen(false);
    });

    // 「体检」默认隐藏（暂时用不上）：右键齿轮按钮 / 浮层才显隐，避免日常误点
    const toggleThinkTest = e => {
      e.preventDefault();
      if (thinkTestBtn) thinkTestBtn.classList.toggle('is-visible');
    };
    if (configWrap) configWrap.addEventListener('contextmenu', toggleThinkTest);
    if (configMenu) configMenu.addEventListener('contextmenu', toggleThinkTest);
  }

  // 面板内置的思考参数体检：同一问题用不同思考参数各请求一次，直接看哪行真正生效
  async function runPanelThinkTest() {
    if (isStreaming) return;
    setConfigMenuOpen(false);   // 收起浮层，让体检结果完整露出来

    const btn = shadowRoot.getElementById('panel-think-test');
    const replyArea = shadowRoot.getElementById('reply-area');
    const replyContent = shadowRoot.getElementById('reply-content');
    const statusEl = shadowRoot.getElementById('reply-status');

    replyArea.style.display = 'block';
    replyContent.textContent = '正在用同一个问题分别测试不同思考参数，请稍候…';
    if (statusEl) statusEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = '测试中'; }

    try {
      const data = await chrome.storage.sync.get(CONFIG_KEY);
      const cfg = data[CONFIG_KEY];
      if (!cfg || !cfg.apiKey) {
        replyContent.textContent = '⚠ 请先在插件设置中配置 API Key';
        return;
      }
      const model = cfg.selectionModel || cfg.model;
      const r = await chrome.runtime.sendMessage({
        type: 'THINK_TEST',
        payload: { cfg: { ...cfg, model }, model }
      });

      if (!r || !r.results) {
        replyContent.textContent = '⚠ 体检失败：' + ((r && r.error) || '后台无返回');
        return;
      }

      const lines = [`模型 ${r.model} ｜ 协议 ${r.protocol}`, ''];
      r.results.forEach(x => {
        lines.push(`${x.variant}　${x.verdict || ''}`);
        lines.push(`　耗时 ${x.elapsedMs}ms ｜ 思考 ${x.reasoningLen} 字 ｜ 正文 ${x.contentLen} 字`);
        if (x.error) lines.push(`　错误：${String(x.error).slice(0, 100)}`);
        lines.push('');
      });
      lines.push('想不思考：挑标了「✅ 关掉了思考」的那行，把上面的「思考」下拉设成对应值。');
      lines.push('想深度思考：Claude 端点选 medium / high / xhigh / max（发 adaptive + effort），OpenAI 端点选 minimal / low / medium / high。');
      lines.push('如果每一行都在思考或超时，说明这个端点不支持关闭思考，建议把模型换成非推理模型（如 glm-5.3）。');
      replyContent.textContent = lines.join('\n');
    } catch (e) {
      replyContent.textContent = '⚠ ' + (e.message || '体检失败');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '体检'; }
    }
  }

  // 翻译按钮的提示词：单词给音标 / 词根 / 助记 / 联想，句子给译文 + 关键词拆解
  // 排版刻意要求「词典条目式」——每项一行、标签加粗、少用列表，避免面板里满屏圆点
  const TRANSLATE_PROMPT = `请把下面的内容翻译成中文，并整理成一张紧凑的学习卡片。

选中内容：
"""
{text}
"""

排版要求（像词典条目一样紧凑，不要堆小标题和圆点）：
- 第一行直接给结论：单词/短语写「**词性. 中文释义**」，后面可接一句简短说明；句子/段落直接给中文翻译。
- 之后每一项各占一行，统一用「**标签：**内容」的行内写法，标签加粗、内容紧跟其后，不要把内容另起一行。
- 除「联想」「例句」确有 3 项以上并列外，不要用列表；并列项在同一行用「｜」隔开。
- 不要用 # 标题、--- 分割线，也不要给每一项单独开 bullet。

按下面的顺序给出（能省则省，不要重复）：
**音标：**英 /…/ ｜ 美 /…/（不确定就写「待核实」，不要编造）
**释义：**词性 + 中文释义 —— 一句英文释义
**词根词缀：**拆分前缀 / 词根 / 后缀，说明含义与来源
**助记：**一条具体、可复述的联想 / 谐音 / 构词记忆法
**联想：**同根词 … ｜ 近义词 … ｜ 反义词 … ｜ 常见搭配 …
**例句：**英文例句 —— 中文翻译（1-2 条）

如果选中内容是句子或段落：先给整句中文翻译，再用同样格式挑 2-4 个关键词逐个讲，关键词之间空一行。
内容里若有数学公式，用 $...$（行内）或 $$...$$（独立成行）。不确定的信息直接说明，不要编造。`;

  // 根据配置渲染划词面板的快捷按钮
  const DEFAULT_PRESETS = [
    { label: '简介', prompt: '请用150字以内简明扼要地介绍以下内容是什么，不要超过150字：\n\n{text}' },
    { label: '解释', prompt: '请详细解释以下内容：\n\n{text}' },
    { label: '翻译', prompt: TRANSLATE_PROMPT, save: 'wordbook' },
    { label: '总结', prompt: '请总结以下内容的要点：\n\n{text}' },
    { label: '润色', prompt: '请优化以下内容的表达：\n\n{text}' },
  ];

  // 历史版本的翻译提示词：命中说明用户没改过，可以安全升级成新版学习卡片提示词
  // 用特征串匹配而不是全文比对，旧版长提示词也能被识别
  const LEGACY_TRANSLATE_MARKS = [
    '请将以下内容翻译成中文',
    '整理成一张便于记忆的学习卡片',   // v1.1.0 的翻译提示词
  ];
  function isLegacyTranslatePrompt(prompt) {
    const s = String(prompt || '').trim();
    return LEGACY_TRANSLATE_MARKS.some(m => s.includes(m));
  }

  // 统一预设结构：{ label, prompt, save: 'chat' | 'wordbook' }
  // 老配置没有 save 字段，标签为「翻译」的按单词本处理
  function normalizePresets(cfg) {
    const list = (cfg && Array.isArray(cfg.presetPrompts) && cfg.presetPrompts.length)
      ? cfg.presetPrompts
      : DEFAULT_PRESETS;

    return list
      .filter(p => p && p.label && p.prompt)
      .map(p => {
        const label = String(p.label).trim();
        let prompt = String(p.prompt);
        let save = p.save === 'wordbook' || p.save === 'chat' ? p.save : '';

        if (!save) {
          save = /^(翻译|translate)/i.test(label) || isLegacyTranslatePrompt(prompt)
            ? 'wordbook' : 'chat';
        }
        // 只要提示词还是旧版模板就升级（即使 save 已显式保存过）
        if (save === 'wordbook' && isLegacyTranslatePrompt(prompt)) prompt = TRANSLATE_PROMPT;

        return { label, prompt, save };
      });
  }

  function renderPresetButtons(cfg) {
    const container = shadowRoot.getElementById('preset-btns');
    if (!container) return;
    const presets = normalizePresets(cfg);
    container.innerHTML = '';
    presets.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'preset-btn';
      btn.dataset.prompt = p.prompt;
      btn.dataset.save = p.save;
      btn.textContent = p.label;
      container.appendChild(btn);
    });

    renderModelSelect(cfg);
    renderThinkSelect(cfg);
  }

  // 划词面板可切换的模型：与设置页「划词使用的模型」同一套，按厂商分组
  const PANEL_MODEL_GROUPS = [
    {
      label: '',
      options: [{ value: '', label: '跟随主配置' }],
    },
    {
      label: '腾讯 Token Plan',
      options: [
        { value: 'tc-code-latest', label: 'Auto（智能路由）' },
        { value: 'hy4-preview', label: 'Hy4 Preview（混元）' },
        { value: 'hy3', label: 'Hy3（混元）' },
        // 腾讯云 TokenHub 官方 model 参数（2026-09-10 上线，1M 上下文 / 384k 输出）
        { value: 'deepseek/deepseek-flash', label: 'DeepSeek V4.1 Flash 原厂直供（最新）' },
        { value: 'deepseek-v4-pro-202606', label: 'DeepSeek V4 Pro 正式版' },
        { value: 'deepseek-v4-flash-202605', label: 'DeepSeek V4 Flash 正式版' },
        { value: 'glm-5.3', label: 'GLM-5.3' },
        { value: 'glm-5.3-flash', label: 'GLM-5.3-Flash' },
        { value: 'glm-5.3-flashx', label: 'GLM-5.3-FlashX' },
        { value: 'glm-5.2', label: 'GLM-5.2' },
        { value: 'minimax-m3', label: 'MiniMax M3' },
        { value: 'minimax-m2.7', label: 'MiniMax M2.7' },
        { value: 'kimi-k3', label: 'Kimi K3' },
        { value: 'kimi-k2.8-preview', label: 'Kimi K2.8 Preview' },
        { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code' },
      ],
    },
    {
      label: 'OpenAI',
      options: [
        { value: 'gpt-6-astra', label: 'GPT-6 Astra（最新旗舰）' },
        { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
        { value: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
        { value: 'gpt-5.6-luna', label: 'GPT-5.6 Luna' },
        { value: 'gpt-5.5', label: 'GPT-5.5' },
        { value: 'gpt-5.4', label: 'GPT-5.4' },
        { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
        { value: 'gpt-5.4-nano', label: 'GPT-5.4 Nano' },
        { value: 'gpt-5.2', label: 'GPT-5.2（旧版）' },
        { value: 'gpt-5.1', label: 'GPT-5.1（旧版）' },
      ],
    },
    {
      label: 'Anthropic Claude',
      options: [
        { value: 'claude-fable-5', label: 'Claude Fable 5（最强）' },
        { value: 'claude-opus-5', label: 'Claude Opus 5' },
        { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
        { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
      ],
    },
    {
      label: 'DeepSeek',
      options: [
        { value: 'deepseek-flash', label: 'DeepSeek V4.1 Flash（最新）' },
        { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      ],
    },
    {
      label: '通义千问',
      options: [
        { value: 'qwen3.8-max', label: '通义千问 3.8-Max' },
        { value: 'qwen3.7-plus', label: '通义千问 3.7-Plus' },
      ],
    },
  ];

  function renderModelSelect(cfg) {
    const sel = shadowRoot.getElementById('panel-model-select');
    if (!sel) return;

    const mainModel = (cfg && cfg.model) || '';
    const current = (cfg && cfg.selectionModel) || '';
    const known = new Set();

    sel.innerHTML = '';
    PANEL_MODEL_GROUPS.forEach((group, gi) => {
      const parent = group.label ? document.createElement('optgroup') : sel;
      if (group.label) {
        parent.label = group.label;
        sel.appendChild(parent);
      }
      group.options.forEach((o, oi) => {
        const opt = document.createElement('option');
        opt.value = o.value;
        // 第一项显示「跟随主配置（当前模型）」，一眼看出实际用的是哪个
        opt.textContent = (gi === 0 && oi === 0 && mainModel)
          ? `跟随主配置（${mainModel}）`
          : o.label;
        known.add(o.value);
        parent.appendChild(opt);
      });
    });

    // 设置页里填了列表外的自定义模型时，单独补一组
    if (current && !known.has(current)) {
      const grp = document.createElement('optgroup');
      grp.label = '自定义（来自设置页）';
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      grp.appendChild(opt);
      sel.appendChild(grp);
    }

    sel.value = current;
    sel.title = `划词使用的模型：${current || mainModel || '跟随主配置'}`;
  }

  // 划词思考强度：面板上直接可调，'' 表示不向接口发送该参数
  // 列表对各端点是共用的：Claude 端认 low/medium/high/xhigh/max，
  // OpenAI 端认 minimal/low/medium/high，腾讯混元认 no_think
  const THINK_OPTIONS = [
    { value: 'no_think', label: '不思考 no_think' },
    { value: 'minimal', label: '最快 minimal' },
    { value: 'low', label: '低 low' },
    { value: 'medium', label: '中 medium' },
    { value: 'high', label: '高 high（Claude 默认）' },
    { value: 'xhigh', label: '更高 xhigh（Claude）' },
    { value: 'max', label: '最深 max（Claude）' },
    { value: '', label: '不发送参数' },
  ];

  function currentThinkValue(cfg) {
    let cur = cfg ? cfg.selectionReasoningEffort : undefined;
    if (cur === undefined) cur = 'no_think';   // 未配置时默认不思考
    return cur;
  }

  function renderThinkSelect(cfg) {
    const sel = shadowRoot.getElementById('panel-think-select');
    if (!sel) return;

    const cur = currentThinkValue(cfg);
    const opts = THINK_OPTIONS.map(o => ({ ...o }));
    // 用户在设置页填了自定义值时补一项
    if (cur && !opts.some(o => o.value === cur)) {
      opts.splice(opts.length - 1, 0, { value: cur, label: cur });
    }

    sel.innerHTML = '';
    opts.forEach(o => {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    sel.value = cur;
  }

  function handleCustomSend() {
    if (isStreaming) return;
    const input = shadowRoot.getElementById('custom-input');
    const text = input.value.trim();
    if (!text) return;
    const prompt = `关于以下内容：\n\n${currentSelection}\n\n${text}`;
    askAI(prompt, [{ role: 'user', content: prompt }], { sink: 'chat' });
    input.value = '';
  }

  let lastMessages = [];

  // opts.sink: 'chat' 存进聊天记录（默认）；'wordbook' 只进单词本
  async function askAI(displayPrompt, messages, opts = {}) {
    const sink = opts.sink === 'wordbook' ? 'wordbook' : 'chat';
    const term = (opts.term || currentSelection || '').trim();
    let cfg;
    try {
      const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
      cfg = cfgData[CONFIG_KEY];
    } catch (err) {
      notifyContextDead();
      showReply('⚠ 插件已更新，请刷新本页面后再试', true);
      return;
    }
    if (!cfg || !cfg.apiKey) {
      showReply('⚠ 请先在插件设置中配置 API Key', true);
      return;
    }

    // 面板已打开即视为划词已启用，此处不再重复检查 enableSelection，
    // 避免缓存(open)与实时配置(false)不一致时「面板能开、点了没反应」。

    // 划词面板支持独立选择模型：cfg.selectionModel 优先，其次跟随主配置
    if (cfg.selectionModel) cfg = { ...cfg, model: cfg.selectionModel };

    // 划词思考强度：面板 / 设置页都能直接调，未配置时默认 no_think（不思考）。
    // '' 表示不向接口发送该参数。刻意不回落到全局设置，保证「划词=快」的预期可预测。
    cfg = { ...cfg, reasoningEffort: currentThinkValue(cfg) };

    lastUsedModel = cfg.model || null;
    renderModelSelect(cfg);
    renderThinkSelect(cfg);

    lastMessages = messages;

    const replyArea = shadowRoot.getElementById('reply-area');
    const replyContent = shadowRoot.getElementById('reply-content');
    const saveBtn = shadowRoot.getElementById('save-session-btn');
    const loading = shadowRoot.getElementById('reply-loading');

    replyArea.style.display = 'block';
    replyContent.innerHTML = '';
    // 新一轮输出：重新开启自动贴底（上一轮用户可能上滑停过）
    if (replyAutoScroll) { replyAutoScroll.reset(); replyAutoScroll.forceBottom(); }
    if (saveBtn) saveBtn.style.display = 'none';
    if (loading) {
      loading.style.display = 'flex';
      loading.innerHTML = '<div class="dot-pulse"><span></span><span></span><span></span></div>';
    }

    setSendBtnState(true);
    isStreaming = true;

    const statusEl = shadowRoot.getElementById('reply-status');
    const setStatus = t => { if (statusEl) statusEl.textContent = t || ''; };
    setStatus('');

    let fullReply = '';
    try {
      await streamChat(cfg, messages, {
        onStatus: () => setStatus('已连接，等待模型输出…'),
        // 推理模型（hy4-preview 等）先吐思考过程，这里明确提示，避免看起来像卡死
        onReasoning: (_text, len) => {
          if (loading) loading.style.display = 'none';
          // 明明设了「不思考」却还在思考 → 直接点明是端点不认这个参数，别让用户以为配置没保存
          const eff = cfg.reasoningEffort;
          const shouldBeOff = eff === 'no_think' || eff === 'minimal' || eff === 'low';
          setStatus(shouldBeOff
            ? `思考中…（${len || 0} 字）· 设置未生效`
            : `模型思考中…（${len || 0} 字）`);
        },
        onChunk: chunk => {
          if (loading) loading.style.display = 'none';
          if (statusEl && statusEl.textContent) setStatus('');
          fullReply += chunk;
          renderReply(fullReply, true);
        },
      });
    } catch (err) {
      if (loading) loading.style.display = 'none';
      setStatus('');
      if (isInvalidatedError(err)) {
        notifyContextDead();
        showReply('⚠ 插件已更新，请刷新本页面后再试', true);
      } else {
        showReply('⚠ ' + (err.message || '请求失败'), true);
      }
      fullReply = null;
    }

    try {
      if (fullReply !== null) {
        // Remove cursor
        renderReply(fullReply, false);
        lastMessages.push({ role: 'assistant', content: fullReply });

        // 计入 token 用量（提示词 + 回复），与 popup 的统计口径一致
        recordTokenUsage(lastMessages.filter(m => m.role === 'user').map(m => m.content).join('\n'), fullReply);

        if (sink === 'wordbook') {
          // 翻译类结果只入库单词本，不写入聊天记录
          const entry = await saveToWordbook(term, fullReply);
          setReplyAction('wordbook', entry);
        } else {
          // 自动保存本次划词对话到聊天记录
          const savedId = await saveCurrentToSession();
          setReplyAction('chat', savedId);
        }
      }
    } catch (e) {
      // 保存失败不影响回复显示
      console.warn('保存划词结果失败:', e);
    } finally {
      isStreaming = false;
      setSendBtnState(false);
      if (loading) loading.style.display = 'none';
      setStatus('');
    }
  }

  // ===== Reply 渲染（Markdown + 长文自动缩小字号）=====
  // 内容超过 COMPACT_THRESHOLD 字后加 .compact 类，整体小一号显示
  const COMPACT_THRESHOLD = 500;

  function renderReply(text, streaming) {
    const replyContent = shadowRoot.getElementById('reply-content');
    if (!replyContent) return;
    replyContent.classList.toggle('compact', text.length > COMPACT_THRESHOLD);
    replyContent.innerHTML = LumenMD.render(text) + (streaming ? '<span class="cursor"></span>' : '');
    // 贴底只在「用户没有上滑」时生效，上滑期间不动滚动位置
    if (replyAutoScroll && streaming) replyAutoScroll.toBottom();
  }

  // 粗略估算 token 数（与 popup 同一算法：CJK ≈ 1.5 字符/token，其余 ≈ 4 字符/token）
  function estimateTokens(text) {
    if (!text) return 0;
    const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
    const rest = text.length - cjk;
    return Math.ceil(cjk / 1.5 + rest / 4);
  }

  // 把本次划词请求的 token 用量累加进 llm_total_tokens（popup 的宠物进度条读取该值）。
  // 读-加-写而非整值覆盖，避免与 popup 同时写入时互相吃掉对方的增量。
  async function recordTokenUsage(promptText, replyText) {
    const added = estimateTokens(promptText) + estimateTokens(replyText);
    if (!added) return;
    try {
      const data = await chrome.storage.local.get(TOKEN_KEY);
      await chrome.storage.local.set({ [TOKEN_KEY]: (data[TOKEN_KEY] || 0) + added });
    } catch { /* context invalidated 时静默忽略 */ }
  }

  function showReply(text, isError = false) {
    const replyArea = shadowRoot.getElementById('reply-area');
    const replyContent = shadowRoot.getElementById('reply-content');
    replyArea.style.display = 'block';
    // 浅色背景上原来的 #F1F5F9 / #FCA5A5 几乎看不见，换成能读的深色
    replyContent.innerHTML = `<span style="color:${isError ? '#CC3333' : '#3C3C3C'}">${text}</span>`;
  }

  function setSendBtnState(disabled) {
    const sendBtn = shadowRoot.getElementById('send-btn');
    const sendIcon = shadowRoot.getElementById('send-icon');
    const presetBtns = shadowRoot.querySelectorAll('.preset-btn');
    const customInput = shadowRoot.getElementById('custom-input');
    if (sendBtn) sendBtn.disabled = disabled;
    if (customInput) customInput.disabled = disabled;
    presetBtns.forEach(b => b.disabled = disabled);

    if (sendIcon) {
      sendIcon.outerHTML = disabled
        ? '<div id="send-icon" class="spinner"></div>'
        : `<svg id="send-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    }
  }

  // ===== Save to Wordbook（翻译结果进单词本，不写聊天记录）=====
  // 同一个词再次翻译时覆盖旧结果并顶到最前，而不是堆一堆重复条目
  async function saveToWordbook(term, result) {
    const text = String(term || '').trim();
    if (!text || !result) return null;

    const data = await chrome.storage.local.get(WORDBOOK_KEY);
    const list = Array.isArray(data[WORDBOOK_KEY]) ? data[WORDBOOK_KEY].slice() : [];
    const key = text.toLowerCase();
    const idx = list.findIndex(e => String(e.term || '').trim().toLowerCase() === key);
    const prev = idx >= 0 ? list[idx] : null;
    const now = Date.now();

    const entry = {
      id: (prev && prev.id) || `w${now}${Math.random().toString(36).slice(2, 7)}`,
      term: text,
      result,
      model: lastUsedModel || '',
      url: location.href,
      title: (document.title || '').slice(0, 120),
      createdAt: (prev && prev.createdAt) || now,
      updatedAt: now,
      hits: ((prev && prev.hits) || 0) + 1,
    };

    if (idx >= 0) list.splice(idx, 1);
    list.unshift(entry);
    while (list.length > MAX_WORDBOOK) list.pop();

    await chrome.storage.local.set({ [WORDBOOK_KEY]: list });
    return entry.id;
  }

  // 回复区右上角那颗按钮：聊天记录 / 单词本两种去向共用同一个元素
  function setReplyAction(mode, detail) {
    const wrap = shadowRoot.getElementById('save-session-btn');
    const btn = shadowRoot.getElementById('btn-save-session');
    if (!wrap || !btn) return;

    wrap.style.display = 'flex';
    btn.dataset.mode = mode;
    btn.classList.add('saved');

    if (mode === 'wordbook') {
      btn.dataset.wordId = detail || '';
      btn.title = '已存入单词本，点击查看';
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> 已存入单词本`;
    } else {
      btn.dataset.sessionId = detail || '';
      btn.title = '点击打开 Popup 继续对话';
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> 已保存到聊天记录`;
    }
  }

  async function openWordbook() {
    try {
      await chrome.storage.local.set({ [PENDING_VIEW_KEY]: 'wordbook' });
      await chrome.runtime.sendMessage({ type: 'OPEN_WORDBOOK' });
    } catch { /* popup 没开 / 上下文失效时忽略 */ }
    showToast('单词本已更新：可点插件图标 →「单词本」查看', 4000);
  }

  // ===== Save to Session（自动保存本次划词对话到聊天记录）=====
  async function saveCurrentToSession() {
    if (!lastMessages || lastMessages.length === 0) return null;

    const data = await chrome.storage.local.get(SESSIONS_KEY);
    let sessions = data[SESSIONS_KEY] || [];

    const id = Date.now().toString();
    const firstUserMsg = lastMessages.find(m => m.role === 'user');
    const rawTitle = firstUserMsg
      ? firstUserMsg.content.slice(0, 24) + (firstUserMsg.content.length > 24 ? '…' : '')
      : '划词对话';
    // 侧栏已有「划词」徽标标明来源，标题不再重复加前缀
    const title = rawTitle;

    const session = {
      id,
      title,
      messages: lastMessages,
      source: 'selection',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    sessions.push(session);
    if (sessions.length > MAX_SESSIONS) sessions.shift();

    await chrome.storage.local.set({
      [SESSIONS_KEY]: sessions,
      [ACTIVE_ID_KEY]: id
    });

    // Notify popup if open
    try {
      await chrome.runtime.sendMessage({
        type: 'NEW_SESSION_FROM_SELECTION',
        sessions,
        activeSessionId: id
      });
    } catch {}

    return id;
  }

  // 手动按钮：在 Popup 中继续对话（划词结果已自动保存，直接跳转）
  async function openPopupForSession() {
    const saveBtn = shadowRoot.getElementById('save-session-btn');
    const sessionId = saveBtn && saveBtn.dataset.sessionId;
    // 通知 popup 定位到已保存的会话
    if (sessionId) {
      try {
        await chrome.runtime.sendMessage({
          type: 'OPEN_SESSION_FROM_SELECTION',
          activeSessionId: sessionId
        });
      } catch {}
    }
  }

  // ===== Stream Chat（通过 background 中转，规避 CORS）=====
  // handlers: { onChunk, onStatus, onReasoning }
  function streamChat(cfg, messages, handlers) {
    const h = typeof handlers === 'function' ? { onChunk: handlers } : (handlers || {});
    return new Promise((resolve, reject) => {
      const requestId = Date.now().toString() + Math.random().toString(36).slice(2);

      // 兜底硬超时：即使 background 完全没回音（如 SW 被杀），也不会永远转圈
      const hardTimer = setTimeout(() => {
        cleanup();
        reject(new Error('请求超时（150 秒内没有收到任何响应）'));
      }, 150000);

      let settled = false;
      function cleanup() {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        try { chrome.runtime.onMessage.removeListener(onMessage); } catch {}
      }

      // 监听 background 的流式回包
      function onMessage(msg) {
        if (msg.type !== 'STREAM_CHUNK' || msg.requestId !== requestId) return;
        if (msg.error) {
          cleanup();
          reject(new Error(msg.error));
        } else if (msg.done) {
          cleanup();
          resolve();
        } else if (msg.chunk) {
          if (h.onChunk) h.onChunk(msg.chunk);
        } else if (msg.reasoning) {
          if (h.onReasoning) h.onReasoning(msg.reasoning, msg.reasoningLen);
        } else if (msg.status) {
          if (h.onStatus) h.onStatus(msg.status);
        }
      }

      chrome.runtime.onMessage.addListener(onMessage);

      // 发送请求给 background
      chrome.runtime.sendMessage({
        type: 'STREAM_CHAT',
        requestId,
        payload: { cfg, messages }
      }).catch(err => {
        cleanup();
        reject(new Error(err.message || 'Failed to connect to background'));
      });
    });
  }

  // ===== Selection Listener =====
  // 关键点：一律用「捕获阶段」监听。Notion / Figma / 各类富文本编辑器会在自身节点上
  // stopPropagation，冒泡阶段监听会被吞掉，表现就是"这个网站上划词完全没反应"。
  let lastPointer = { x: 200, y: 200 };
  let hideTimer = null;
  let keySelTimer = null;

  function selectionEnabled() {
    return !(cachedConfig && cachedConfig.enableSelection === false);
  }

  function refreshFromSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideFloatBtn(); return; }

    const text = sel.toString().trim();
    if (!text || text.length < 2) { hideFloatBtn(); return; }

    currentSelection = text;

    let rect = null;
    try {
      currentRange = sel.getRangeAt(0).cloneRange();
      rect = currentRange.getBoundingClientRect();
    } catch { currentRange = null; }

    // 拿不到有效矩形时（input/textarea 内选区、跨异常节点），用鼠标位置兜底
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      showFloatBtn(lastPointer.x, lastPointer.y);
    } else {
      showFloatBtn(rect.right, rect.bottom);
    }
  }

  function insideOurUI(target) {
    try {
      if (shadowHost && shadowHost.contains(target)) return true;
      if (floatBtn && floatBtn.contains(target)) return true;
    } catch {}
    return false;
  }

  function onMouseUp(e) {
    if (e.button !== undefined && e.button !== 0) return;  // 只响应左键
    if (typeof e.clientX === 'number') lastPointer = { x: e.clientX, y: e.clientY };

    if (insideOurUI(e.target)) return;
    if (!isExtensionAlive()) { notifyContextDead(); return; }
    if (FRAME_TOO_SMALL) return;
    if (!selectionEnabled()) return;

    refreshFromSelection();
    // 部分页面（自定义编辑器）会在 mouseup 后异步改写选区，首次没拿到就再补一次
    setTimeout(() => {
      if (!floatBtn || floatBtn.style.display === 'none') refreshFromSelection();
    }, 40);
  }

  document.addEventListener('mouseup', onMouseUp, true);

  // 键盘选词（Shift+方向键 / Ctrl+A）不触发 mouseup，单独补上
  document.addEventListener('keyup', e => {
    if (!isExtensionAlive()) { notifyContextDead(); return; }
    if (FRAME_TOO_SMALL || !selectionEnabled()) return;

    const k = e.key || '';
    const isNav = k.startsWith('Arrow') || k === 'Home' || k === 'End' ||
                  k === 'PageUp' || k === 'PageDown' || k === 'Shift';
    const isSelectAll = (k === 'a' || k === 'A') && (e.ctrlKey || e.metaKey);
    if (!isNav && !isSelectAll) return;

    clearTimeout(keySelTimer);
    keySelTimer = setTimeout(refreshFromSelection, 80);
  }, true);

  document.addEventListener('mousedown', e => {
    if (!shadowHost && !floatBtn) return;
    if (insideOurUI(e.target)) return;
    hidePanel();
  }, true);

  // 选区被清空后收起浮动按钮（加防抖，避免刚显示就被抖掉）
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (sel && sel.toString().trim()) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (Date.now() - btnShownAt < 500) return;
      const s = window.getSelection();
      if (!s || !s.toString().trim()) hideFloatBtn();
    }, 250);
  });

  // ===== 诊断入口（控制台执行 __lumenAskDiag() 可自排查）=====
  window.__lumenAskDiag = () => {
    const info = {
      extensionAlive: isExtensionAlive(),
      frameIsTop: FRAME_IS_TOP,
      frameTooSmall: FRAME_TOO_SMALL,
      selectionEnabled: selectionEnabled(),
      hasConfig: !!cachedConfig,
      enableSelection: cachedConfig ? cachedConfig.enableSelection : '(未配置)',
      model: cachedConfig ? (cachedConfig.selectionModel || cachedConfig.model) : '(未配置)',
      baseUrl: cachedConfig ? cachedConfig.baseUrl : '(未配置)',
      reasoningEffort: cachedConfig ? (cachedConfig.reasoningEffort || '(默认)') : '(未配置)',
      hasApiKey: !!(cachedConfig && cachedConfig.apiKey),
      floatBtnInDom: !!floatBtn && floatBtn.isConnected,
      panelInDom: !!shadowHost && shadowHost.isConnected,
      isStreaming,
    };
    console.table(info);
    return info;
  };

  // 实测当前配置：发一次非流式请求，打印 HTTP 状态与原始响应片段
  // 用法：控制台执行 await __lumenAskProbe()
  window.__lumenAskProbe = async (overrideModel) => {
    let cfg;
    try {
      const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
      cfg = cfgData[CONFIG_KEY];
    } catch (e) {
      console.warn(LOG_PREFIX, '上下文已失效，请刷新页面后重试');
      return null;
    }
    if (!cfg) { console.warn(LOG_PREFIX, '尚未配置 API Key / 模型'); return null; }

    const model = overrideModel || cfg.selectionModel || cfg.model;
    console.info(LOG_PREFIX, `探测中 → model=${model}, baseUrl=${cfg.baseUrl}`);
    const r = await chrome.runtime.sendMessage({
      type: 'RAW_TEST',
      payload: { cfg: { ...cfg, model }, messages: [{ role: 'user', content: '请只回复：pong' }] }
    });
    console.log(LOG_PREFIX, '探测结果：', r);
    return r;
  };

  // 思考参数体检：同一问题用不同思考参数各请求一次，实测哪个真正生效
  // 用法：控制台执行 await __lumenAskThinkTest()  或  await __lumenAskThinkTest('hy4-preview')
  window.__lumenAskThinkTest = async (overrideModel) => {
    let cfg;
    try {
      const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
      cfg = cfgData[CONFIG_KEY];
    } catch (e) {
      console.warn(LOG_PREFIX, '上下文已失效，请刷新页面后重试');
      return null;
    }
    if (!cfg) { console.warn(LOG_PREFIX, '尚未配置 API Key / 模型'); return null; }

    const model = overrideModel || cfg.selectionModel || cfg.model;
    console.info(LOG_PREFIX, `正在对 model=${model} 做思考参数体检（多次请求，请稍候）…`);
    const r = await chrome.runtime.sendMessage({
      type: 'THINK_TEST',
      payload: { cfg: { ...cfg, model }, model }
    });
    if (r && r.results) console.table(r.results);
    console.log(LOG_PREFIX, '体检结果：', r);
    return r;
  };

  if (FRAME_IS_TOP) {
    console.info(LOG_PREFIX, '划词脚本已注入，控制台执行 __lumenAskDiag() 可查看状态');
  }

  // 供「新注入的实例」询问：本实例是否还活着。
  // 返回 true（活着）→ 新实例退出；返回 false（已失效）→ 清理残留，由新实例接管。
  window.__lumenAskReboot = () => {
    if (isExtensionAlive()) return true;
    try {
      if (floatBtn) floatBtn.remove();
      if (shadowHost) shadowHost.remove();
    } catch {}
    return false;
  };

  // 旧名别名：改名（LLM Chat → Lumen Ask）前的控制台调用习惯继续可用
  window.__llmChatDiag = window.__lumenAskDiag;
  window.__llmChatProbe = window.__lumenAskProbe;
  window.__llmChatThinkTest = window.__lumenAskThinkTest;
  window.__llmChatReboot = window.__lumenAskReboot;

})();
