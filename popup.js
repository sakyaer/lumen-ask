// ===== Constants =====
const SESSIONS_KEY = 'llm_sessions';
const ACTIVE_ID_KEY = 'llm_active_session_id';
const CONFIG_KEY = 'llm_config';
const MAX_SESSIONS = 50;
const TOKEN_KEY = 'llm_total_tokens';
const WORDBOOK_KEY = 'llm_wordbook';
const PENDING_VIEW_KEY = 'llm_pending_view';
const DEFAULT_TOKEN_LIMIT = 30000000;
let TOKEN_BAR_MAX = DEFAULT_TOKEN_LIMIT;

// 把 storage 中的配置归一化为 DeepSeek（config-defaults.js 提供），
// 并补上 config.local.js 里的本地 Key。
function resolveCfg(stored) {
  return window.LumenConfig ? LumenConfig.resolveConfig(stored) : (stored || null);
}

// 统一使用 DeepSeek 官方 API：baseUrl 匹配到 deepseek（或尚未配置）时展示这两个模型
const MODEL_GROUPS = [
  {
    label: 'DeepSeek',
    match: cfg => !cfg.baseUrl || cfg.baseUrl.includes('deepseek'),
    models: [
      { id: 'deepseek-flash',     name: 'DeepSeek V4.1 Flash（最新）' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（更强，深度思考）' },
    ]
  },
];

// ===== ASCII Cat Frames =====
// 体型根据累计 token 变化：slim / normal / chubby
const CAT_FRAMES = {
  idle: {
    slim: [
` /\\_/\\  `,
`( o.o ) `,
` > ^ <  `
    ],
    normal: [
` /\\_/\\   `,
`( ^.^ )  `,
` (> v <) `
    ],
    chubby: [
`  /\\_/\\   `,
` ( @.@ )  `,
`(( > v < ))`
    ]
  },
  // 吃鱼动画帧序列
  eating: [
    // frame 0
    {
      slim:   [` /\\_/\\ `, `(>o.o)>`, ` -<}~~ `],
      normal: [` /\\_/\\  `, `(>^.^)> `, ` --<}~~ `],
      chubby: [`  /\\_/\\  `, ` (>@.@)> `, ` ---<}~~ `]
    },
    // frame 1
    {
      slim:   [` /\\_/\\ `, `(=o.o) `, `  ~}~  `],
      normal: [` /\\_/\\  `, ` (=^.^) `, `  ~~}~~ `],
      chubby: [`  /\\_/\\  `, ` (=@.@)  `, `  ~~~}~~~ `]
    },
    // frame 2
    {
      slim:   [` /\\_/\\ `, `(*o.o) `, `  nom  `],
      normal: [` /\\_/\\  `, ` (*^.^) `, `  nom~  `],
      chubby: [`  /\\_/\\  `, ` (*@.@)  `, ` nomnomm `]
    },
    // frame 3
    {
      slim:   [` /\\_/\\ `, `( o.o )`, ` ~purr `],
      normal: [` /\\_/\\  `, `( ^.^ ) `, ` ~purr~ `],
      chubby: [`  /\\_/\\  `, ` ( @.@ ) `, ` ~purrrr `]
    }
  ]
};

// ===== Pet State =====
let petTotalTokens = 0;  // 本次会话累计
let petEating = false;
let petEatTimer = null;
let petEatFrame = 0;
let petFrameInterval = null;

// ===== State =====
let sessions = [];
let activeSessionId = null;
let config = null;
let streamingSessionId = null;  // 正在流式的 session id，null 表示空闲
let wordbook = [];              // 单词本条目（chrome.storage.local）
let currentView = 'chat';       // 'chat' | 'wordbook'
const wbExpanded = new Set();   // 已展开的词条 id

// ===== DOM =====
const sessionListEl = document.getElementById('sessionList');
const messagesEl = document.getElementById('messagesContainer');
const emptyStateEl = document.getElementById('emptyState');
const userInputEl = document.getElementById('userInput');
const btnSend = document.getElementById('btnSend');
const chatTitleEl = document.getElementById('chatTitle');
const btnNewChat = document.getElementById('btnNewChat');
const btnClear = document.getElementById('btnClear');
const btnSettings = document.getElementById('btnSettings');
const configBanner = document.getElementById('configBanner');
const bannerGoSettings = document.getElementById('bannerGoSettings');
const chatHeaderEl = document.getElementById('chatHeader');
const inputAreaEl = document.getElementById('inputArea');
const btnWordbook = document.getElementById('btnWordbook');
const wordbookViewEl = document.getElementById('wordbookView');
const wbListEl = document.getElementById('wbList');
const wbEmptyEl = document.getElementById('wbEmpty');
const wbSearchEl = document.getElementById('wbSearch');
const wbTotalEl = document.getElementById('wbTotal');
const wordbookCountEl = document.getElementById('wordbookCount');

// 流式输出时自动贴底；用户一上滑就停，滑回底部再恢复（见 autoscroll.js）
// 取不到控制器时降级为 null（等同于旧行为里不再自动滚动），不影响聊天主流程
const autoScroll = window.LumenAutoScroll ? window.LumenAutoScroll.create(messagesEl) : null;

// ===== Init =====
async function init() {
  const data = await chrome.storage.local.get([SESSIONS_KEY, ACTIVE_ID_KEY, TOKEN_KEY, WORDBOOK_KEY, PENDING_VIEW_KEY]);
  sessions = data[SESSIONS_KEY] || [];
  activeSessionId = data[ACTIVE_ID_KEY] || null;
  petTotalTokens = data[TOKEN_KEY] || 0;
  wordbook = Array.isArray(data[WORDBOOK_KEY]) ? data[WORDBOOK_KEY] : [];
  updateWordbookBadge();

  // 划词面板点了「已存入单词本」后打开 Popup：直接落在单词本视图
  const pendingView = data[PENDING_VIEW_KEY] || '';
  if (pendingView) chrome.storage.local.remove(PENDING_VIEW_KEY);

  const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
  config = resolveCfg(cfgData[CONFIG_KEY]);
  TOKEN_BAR_MAX = config?.tokenLimit || DEFAULT_TOKEN_LIMIT;

  // Apply theme
  const theme = config?.theme || 'duolingo';
  document.documentElement.setAttribute('data-theme', theme);

  if (!config || !config.apiKey) {
    configBanner.style.display = 'flex';
  }

  renderModelBar();

  if (sessions.length === 0) {
    createSession();
  } else {
    if (!activeSessionId || !sessions.find(s => s.id === activeSessionId)) {
      activeSessionId = sessions[sessions.length - 1].id;
    }
    renderSidebar();
    renderMessages();
  }

  // 初始化宠物猫
  updateTokenBar(0);
  petIdle();

  if (pendingView === 'wordbook') setView('wordbook');
}

// ===== Session CRUD =====
function createSession(fromSelection = false) {
  const id = Date.now().toString();
  const session = {
    id,
    title: '新对话',
    messages: [],
    source: fromSelection ? 'selection' : 'popup',
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  sessions.push(session);
  if (sessions.length > MAX_SESSIONS) {
    sessions.shift();
  }
  activeSessionId = id;
  saveSessions();
  renderSidebar();
  renderMessages();
  return session;
}

function getActiveSession() {
  return sessions.find(s => s.id === activeSessionId);
}

function deleteSession(id) {
  sessions = sessions.filter(s => s.id !== id);
  if (activeSessionId === id) {
    activeSessionId = sessions.length > 0 ? sessions[sessions.length - 1].id : null;
  }
  if (sessions.length === 0) {
    createSession();
    return;
  }
  saveSessions();
  renderSidebar();
  renderMessages();
}

function switchSession(id) {
  activeSessionId = id;
  chrome.storage.local.set({ [ACTIVE_ID_KEY]: id });
  if (currentView !== 'chat') setView('chat');
  renderSidebar();
  renderMessages();
}

async function saveSessions() {
  await chrome.storage.local.set({
    [SESSIONS_KEY]: sessions,
    [ACTIVE_ID_KEY]: activeSessionId
  });
}

// ===== Render Sidebar =====
function renderSidebar() {
  sessionListEl.innerHTML = '';
  const sorted = [...sessions].reverse();
  sorted.forEach(session => {
    const item = document.createElement('div');
    item.className = 'session-item' + (session.id === activeSessionId ? ' active' : '');
    item.dataset.id = session.id;

    const sourceTag = session.source === 'selection'
      ? '<span class="session-source">划词</span>' : '';

    item.innerHTML = `
      <span class="session-name">${escHtml(displayTitle(session.title))}${sourceTag}</span>
      <span class="session-time">${relativeTime(session.updatedAt)}</span>
      <button class="session-delete" data-id="${session.id}" title="删除">×</button>
    `;

    item.addEventListener('click', e => {
      if (e.target.classList.contains('session-delete')) return;
      switchSession(session.id);
    });

    item.querySelector('.session-delete').addEventListener('click', e => {
      e.stopPropagation();
      deleteSession(session.id);
    });

    sessionListEl.appendChild(item);
  });
}

// ===== Render Messages =====
// keepScroll=true：流式结束后的原地重渲染——用户正在上滑看历史时别把他拽回底部
// 默认 false：切会话 / 新建 / 清空，直接跳到最新消息并恢复自动贴底
function renderMessages(keepScroll = false) {
  const session = getActiveSession();
  // 整体重渲染会重置滚动位置，先按「是否仍在贴底」决定渲染后是跳底还是留在原处
  const stayPut = !!(keepScroll && autoScroll && !autoScroll.isSticking());
  const prevTop = messagesEl.scrollTop;
  messagesEl.innerHTML = '';

  if (!session || session.messages.length === 0) {
    messagesEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = 'flex';
    chatTitleEl.textContent = session ? displayTitle(session.title) : 'Lumen Ask';
    if (!stayPut) autoScroll?.reset();
    return;
  }

  emptyStateEl.style.display = 'none';
  chatTitleEl.textContent = displayTitle(session.title);

  session.messages.forEach(msg => {
    if (msg.role === 'system') return;
    appendMessageDOM(msg.role, msg.content);
  });

  // 等浏览器完成布局后再定位。
  // 清空 innerHTML 会先把 scrollTop 夹到 0 并派发一次 scroll 事件，
  // 所以 reset 要放在 rAF 里紧挨着 forceBottom，别被那次事件带偏。
  if (!stayPut) autoScroll?.reset();
  requestAnimationFrame(() => {
    if (!autoScroll) return;
    if (stayPut) { messagesEl.scrollTop = prevTop; return; }   // 恢复用户当前的阅读位置
    autoScroll.reset();
    autoScroll.forceBottom();
  });
}

function appendMessageDOM(role, content, isStreaming = false) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  div.innerHTML = `
    <div class="msg-content">${role === 'user' ? escHtml(content) : LumenMD.render(content)}${isStreaming ? '<span class="cursor"></span>' : ''}</div>
  `;

  if (emptyStateEl.parentNode === messagesEl) {
    messagesEl.removeChild(emptyStateEl);
  }

  messagesEl.appendChild(div);
  return div.querySelector('.msg-content');
}

// ===== Send Message =====
async function sendMessage() {
  if (streamingSessionId) return;  // 已有流式进行中，禁止同时发起第二条
  const text = userInputEl.value.trim();
  if (!text) return;

  const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
  config = resolveCfg(cfgData[CONFIG_KEY]);

  if (!config || !config.apiKey) {
    configBanner.style.display = 'flex';
    return;
  }

  userInputEl.value = '';
  userInputEl.style.height = 'auto';

  let session = getActiveSession();
  if (!session) session = createSession();

  // 记录本次流式归属的 session id
  const thisSessionId = session.id;
  streamingSessionId = thisSessionId;

  // Update title from first user message
  if (session.messages.filter(m => m.role === 'user').length === 0) {
    session.title = text.slice(0, 24) + (text.length > 24 ? '…' : '');
    chatTitleEl.textContent = session.title;
  }

  session.messages.push({ role: 'user', content: text });
  appendMessageDOM('user', text);

  setStreaming(true);
  const contentEl = appendMessageDOM('assistant', '', true);
  // 新回复开始：重新开启自动贴底（上一轮用户可能上滑停过）
  autoScroll?.reset();
  scrollToBottom();

  let fullReply = '';
  try {
    await streamChat(
      config,
      session.messages,
      {
        onStatus: () => {
          if (activeSessionId === thisSessionId && !fullReply) {
            contentEl.innerHTML = '<span class="msg-status">已连接，等待模型输出…</span><span class="cursor"></span>';
          }
        },
        // 推理阶段会先输出思考过程，明确提示避免看起来像卡死
        onReasoning: (_t, len) => {
          if (activeSessionId === thisSessionId && !fullReply) {
            contentEl.innerHTML = `<span class="msg-status">模型思考中…（${len || 0} 字）</span><span class="cursor"></span>`;
            scrollToBottom();
          }
        },
        onChunk: chunk => {
          fullReply += chunk;
          // 只有用户仍在查看这个 session 时才实时更新 DOM
          if (activeSessionId === thisSessionId) {
            contentEl.innerHTML = LumenMD.render(fullReply);
            contentEl.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
            scrollToBottom();
          }
        },
      }
    );
  } catch (err) {
    if (activeSessionId === thisSessionId) {
      contentEl.className = 'msg-content';
      contentEl.closest('.message').className = 'message error';
      contentEl.textContent = '⚠ ' + (err.message || '请求失败');
    }
    fullReply = null;
  } finally {
    const cursor = contentEl.querySelector('.cursor');
    if (cursor) cursor.remove();

    if (fullReply !== null) {
      session.messages.push({ role: 'assistant', content: fullReply });
      // 划词请求也会累加 TOKEN_KEY，这里先读回最新总量再追加本次增量，
      // 避免整值覆盖时吃掉划词期间新增的用量
      const addedTokens = estimateTokens(text) + estimateTokens(fullReply);
      try {
        const tdata = await chrome.storage.local.get(TOKEN_KEY);
        petTotalTokens = tdata[TOKEN_KEY] || 0;
        await chrome.storage.local.set({ [TOKEN_KEY]: petTotalTokens + addedTokens });
      } catch {}
      updateTokenBar(addedTokens);
      petStartEating(addedTokens);
    }

    session.updatedAt = Date.now();
    streamingSessionId = null;
    await saveSessions();
    renderSidebar();
    setStreaming(false);

    // 如果用户此时切回了这个 session，重新渲染显示完整回复
    // keepScroll：用户正上滑看历史时保持阅读位置，别在收尾时把人拽回底部
    if (activeSessionId === thisSessionId) {
      renderMessages(true);
    }
  }
}

// ===== Stream Chat =====
// 首个数据块最长等待：DeepSeek 思考较慢，给足 90s
const FIRST_BYTE_TIMEOUT_MS = 90000;
const IDLE_TIMEOUT_MS = 90000;

function readWithTimeout(reader, ms, isFirst) {
  let timer;
  return Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(isFirst
          ? `等待模型响应超时（${Math.round(ms / 1000)} 秒内没有任何数据返回）`
          : `响应中断（${Math.round(ms / 1000)} 秒没有新数据）`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// DeepSeek 走标准 OpenAI 兼容协议，不需要任何思考强度参数：
// 模型清单：deepseek-flash（V4.1 Flash）/ deepseek-v4-pro（V4 Pro）。
function httpErrMsg(status, text) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || j.message || msg;
  } catch { if (text) msg += ' ' + String(text).slice(0, 200); }
  return String(msg);
}

// 发一次请求；HTTP 非 2xx 时抛出带接口信息的错误
async function fetchChat(doFetch) {
  let resp;
  try {
    resp = await doFetch();
  } catch (e) {
    throw new Error((e && e.message) || 'Failed to fetch');
  }
  if (!resp.ok) throw new Error(httpErrMsg(resp.status, await resp.text()));
  return resp;
}

// handlers: { onChunk, onStatus, onReasoning }
async function streamChat(cfg, messages, handlers) {
  const h = typeof handlers === 'function' ? { onChunk: handlers } : (handlers || {});
  const baseUrl = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
  await streamChatOpenAI(cfg, baseUrl, messages, h);
}

// ===== OpenAI-compatible（DeepSeek）=====
async function streamChatOpenAI(cfg, baseUrl, messages, h) {
  const body = {
    model: cfg.model || 'deepseek-flash',
    messages: cfg.systemPrompt
      ? [{ role: 'system', content: cfg.systemPrompt }, ...messages]
      : messages,
    stream: true
  };

  const resp = await fetchChat(() => fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`
    },
    body: JSON.stringify(body)
  }));

  if (h.onStatus) h.onStatus('connected');

  // 网关忽略 stream:true、直接返回一次性 JSON 时兜底
  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json')) {
    const text = await resp.text();
    let content = '', reasoning = '';
    try {
      const j = JSON.parse(text);
      if (j.error) throw new Error(j.error.message || 'API 返回错误');
      const choice = j.choices?.[0] || {};
      content = choice.message?.content || choice.text || '';
      reasoning = choice.message?.reasoning_content || '';
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error('响应无法解析：' + text.slice(0, 200));
      throw e;
    }
    if (reasoning && h.onReasoning) h.onReasoning(reasoning, reasoning.length);
    if (!content) {
      if (reasoning && reasoning.trim()) {
        if (h.onChunk) {
          h.onChunk('（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容）\n\n' + reasoning.trim());
        }
        return;
      }
      throw new Error('模型没有返回任何内容（响应中只有思考过程或空内容）');
    }
    if (h.onChunk) h.onChunk(content);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let gotContent = false;
  let gotReasoning = false;
  let reasoningLen = 0;
  let reasoningBuf = '';   // 累积思考内容，只思考无正文时兜底显示
  let firstPacket = true;
  let streamEnded = false;

  try {
    while (!streamEnded) {
      let done, value;
      ({ done, value } = await readWithTimeout(
        reader,
        firstPacket ? FIRST_BYTE_TIMEOUT_MS : IDLE_TIMEOUT_MS,
        firstPacket
      ));
      firstPacket = false;
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;   // 空行或心跳注释
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        if (jsonStr === '[DONE]') { streamEnded = true; break; }

        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }
        if (data.error) throw new Error(data.error.message || 'API 返回错误');

        const choice = data.choices?.[0];
        const delta = choice?.delta || {};

        // 思考过程放在 reasoning_content
        const reasoning = delta.reasoning_content || delta.reasoning || '';
        if (reasoning) {
          gotReasoning = true;
          reasoningLen += reasoning.length;
          if (reasoningBuf.length < 6000) reasoningBuf += reasoning;
          if (h.onReasoning) h.onReasoning(reasoning, reasoningLen);
        }

        const content = delta.content || choice?.message?.content || '';
        if (content) {
          gotContent = true;
          if (h.onChunk) h.onChunk(content);
        }

        if (choice?.finish_reason) { streamEnded = true; break; }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  if (!gotContent) {
    if (gotReasoning && reasoningBuf.trim()) {
      if (h.onChunk) {
        h.onChunk(`（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容。\n`
                + `可以改用 DeepSeek V4.1 Flash，或稍后重试）\n\n` + reasoningBuf.trim());
      }
      return;
    }
    throw new Error('模型没有返回任何内容。请检查模型名是否为 deepseek-flash / deepseek-v4-pro，以及 API Key 是否有效');
  }
}

// ===== UI Helpers =====
function setStreaming(val) {
  btnSend.disabled = val;
  userInputEl.disabled = val;
  btnSend.innerHTML = val
    ? '<div class="spinner"></div>'
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
       </svg>`;
}

function scrollToBottom() {
  if (autoScroll) autoScroll.toBottom();
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 连续换行折叠为一个换行，避免提示词里的空段落在气泡中撑出一大段空白
    .replace(/\n+/g, '<br>');
}

// 兼容旧数据：侧栏徽标已标明划词来源，展示时去掉旧版保存的「[划词] 」标题前缀
function displayTitle(t) {
  return (t || '').replace(/^\[划词\]\s*/, '');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return Math.floor(diff / 86400000) + '天前';
}

// ===== Event Listeners =====
btnNewChat.addEventListener('click', () => {
  createSession();
  if (currentView !== 'chat') setView('chat');
  userInputEl.focus();
});

btnClear.addEventListener('click', () => {
  const session = getActiveSession();
  if (!session || session.messages.length === 0) return;
  // 正在流式的 session 不允许清空
  if (streamingSessionId === session.id) return;
  session.messages = [];
  session.title = '新对话';
  session.updatedAt = Date.now();
  saveSessions();
  renderMessages();
  renderSidebar();
});

btnSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

bannerGoSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

btnSend.addEventListener('click', sendMessage);

userInputEl.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
userInputEl.addEventListener('input', () => {
  userInputEl.style.height = 'auto';
  userInputEl.style.height = Math.min(userInputEl.scrollHeight, 72) + 'px';
});

// Listen for new sessions from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'NEW_SESSION_FROM_SELECTION') {
    sessions = msg.sessions || sessions;
    activeSessionId = msg.activeSessionId;
    chrome.storage.local.set({ [ACTIVE_ID_KEY]: activeSessionId });
    renderSidebar();
    renderMessages();
  }
  // 定位到已保存的划词会话（划词结果已自动保存）
  if (msg.type === 'OPEN_SESSION_FROM_SELECTION' && msg.activeSessionId) {
    activeSessionId = msg.activeSessionId;
    chrome.storage.local.set({ [ACTIVE_ID_KEY]: activeSessionId });
    if (currentView !== 'chat') setView('chat');
    renderSidebar();
    renderMessages();
  }
  // 划词面板里点了「已存入单词本」
  if (msg.type === 'OPEN_WORDBOOK') {
    setView('wordbook');
  }
});

// ===== Model Bar (combobox) =====
function renderModelBar() {
  const barEl = document.getElementById('modelBar');
  const btnEl = document.getElementById('modelSelectBtn');
  const labelEl = document.getElementById('modelSelectLabel');
  const dropEl = document.getElementById('modelDropdown');
  if (!barEl || !btnEl || !dropEl) return;

  dropEl.innerHTML = '';

  if (!config) { barEl.style.display = 'none'; return; }

  const group = MODEL_GROUPS.find(g => g.match(config));
  if (!group || group.models.length <= 1) {
    barEl.style.display = 'none';
    return;
  }

  barEl.style.display = 'flex';

  // 当前模型名
  const current = group.models.find(m => m.id === config.model);
  labelEl.textContent = current ? current.name : (config.model || '选择模型');

  // 构建下拉选项
  group.models.forEach(m => {
    const opt = document.createElement('button');
    opt.className = 'model-option' + (config.model === m.id ? ' active' : '');
    opt.textContent = m.name;
    opt.title = m.id;
    opt.addEventListener('click', async () => {
      if (streamingSessionId) return;
      config.model = m.id;
      labelEl.textContent = m.name;
      dropEl.querySelectorAll('.model-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      dropEl.classList.remove('open');
      // 持久化：写回归一化后的配置，顺便清掉旧厂商残留；本地 Key 不落 storage
      const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
      const next = { ...(resolveCfg(cfgData[CONFIG_KEY]) || {}), model: m.id };
      const localKey = (window.LUMEN_LOCAL_CONFIG && window.LUMEN_LOCAL_CONFIG.apiKey) || '';
      if (next.apiKey === localKey) delete next.apiKey;
      await chrome.storage.sync.set({ [CONFIG_KEY]: next });
    });
    dropEl.appendChild(opt);
  });

  // toggle 下拉
  btnEl.onclick = (e) => {
    e.stopPropagation();
    dropEl.classList.toggle('open');
  };
}

// 点击空白处关闭下拉
document.addEventListener('click', () => {
  const dropEl = document.getElementById('modelDropdown');
  if (dropEl) dropEl.classList.remove('open');
});

// ===== Pet Cat =====
function getPetSize(tokens) {
  if (tokens < 5000) return 'slim';
  if (tokens < 20000) return 'normal';
  return 'chubby';
}

function renderPetFrame(frames) {
  const el = document.getElementById('petAscii');
  if (!el) return;
  el.textContent = frames.join('\n');
}

function petIdle() {
  const size = getPetSize(petTotalTokens);
  const el = document.getElementById('petAscii');
  if (el) el.classList.remove('eating');
  renderPetFrame(CAT_FRAMES.idle[size]);
}

function petStartEating(tokenCount) {
  if (petFrameInterval) clearInterval(petFrameInterval);
  if (petEatTimer) clearTimeout(petEatTimer);

  const size = getPetSize(petTotalTokens);
  const el = document.getElementById('petAscii');
  if (el) el.classList.add('eating');

  petEatFrame = 0;
  // 根据 token 数量决定吃多久（最少1.2s，最多4s）
  const eatDuration = Math.min(4000, Math.max(1200, tokenCount * 8));
  // 帧速：token多就吃得快
  const fps = tokenCount > 500 ? 120 : 220;

  petFrameInterval = setInterval(() => {
    const frame = CAT_FRAMES.eating[petEatFrame % CAT_FRAMES.eating.length][size];
    renderPetFrame(frame);
    petEatFrame++;
  }, fps);

  petEatTimer = setTimeout(() => {
    clearInterval(petFrameInterval);
    petFrameInterval = null;
    petIdle();
  }, eatDuration);
}

function updateTokenBar(addedTokens) {
  petTotalTokens += addedTokens;

  const countEl = document.getElementById('petTokenCount');
  const fillEl = document.getElementById('petTokenFill');
  if (!countEl || !fillEl) return;

  countEl.textContent = petTotalTokens >= 1000
    ? (petTotalTokens / 1000).toFixed(1) + 'k'
    : petTotalTokens;

  const pct = Math.min(100, (petTotalTokens / TOKEN_BAR_MAX) * 100);
  fillEl.style.width = pct + '%';
  fillEl.classList.toggle('hot', pct >= 70);
}

// 粗略估算 token 数（1 token ≈ 4 chars for English, 2 chars for CJK）
function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.5 + rest / 4);
}

// ===== Wordbook（单词本）=====
function updateWordbookBadge() {
  if (!wordbookCountEl) return;
  wordbookCountEl.textContent = String(wordbook.length);
  wordbookCountEl.classList.toggle('has-items', wordbook.length > 0);
}

function setView(view) {
  const isWb = view === 'wordbook';
  currentView = isWb ? 'wordbook' : 'chat';

  wordbookViewEl.style.display = isWb ? 'flex' : 'none';
  chatHeaderEl.style.display = isWb ? 'none' : '';
  messagesEl.style.display = isWb ? 'none' : '';
  inputAreaEl.style.display = isWb ? 'none' : '';
  btnWordbook.classList.toggle('active', isWb);

  if (isWb) {
    configBanner.style.display = 'none';
    chatTitleEl.textContent = '单词本';
    renderWordbook();
  } else {
    if (!config || !config.apiKey) configBanner.style.display = 'flex';
    const s = getActiveSession();
    chatTitleEl.textContent = s ? displayTitle(s.title) : 'Lumen Ask';
  }
}

async function persistWordbook() {
  await chrome.storage.local.set({ [WORDBOOK_KEY]: wordbook });
}

function renderWordbook() {
  if (!wbListEl) return;
  const q = (wbSearchEl.value || '').trim().toLowerCase();
  const items = wordbook.filter(e => {
    if (!q) return true;
    return `${e.term || ''}\n${e.result || ''}\n${e.title || ''}`.toLowerCase().includes(q);
  });

  wbTotalEl.textContent = wordbook.length ? '· ' + wordbook.length : '';
  wbListEl.innerHTML = '';

  if (items.length === 0) {
    wbListEl.style.display = 'none';
    wbEmptyEl.style.display = 'flex';
    document.getElementById('wbEmptyTitle').textContent =
      wordbook.length ? '没有匹配的条目' : '单词本还是空的';
    document.getElementById('wbEmptySub').textContent =
      wordbook.length ? '换个关键词试试' : '在网页里划词，点「翻译」就会自动收进来';
    return;
  }

  wbListEl.style.display = 'block';
  wbEmptyEl.style.display = 'none';

  const frag = document.createDocumentFragment();
  items.forEach(entry => {
    const open = wbExpanded.has(entry.id);
    const url = /^https?:/i.test(entry.url || '') ? entry.url : '';
    const card = document.createElement('article');
    card.className = 'wb-card' + (open ? ' open' : '');
    card.dataset.id = entry.id;
    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-term" title="点击展开/收起">${escHtml(entry.term || '')}</span>
        <span class="wb-time">${relativeTime(entry.updatedAt || entry.createdAt || Date.now())}</span>
      </div>
      <div class="wb-body">${LumenMD.render(entry.result || '')}</div>
      <div class="wb-foot">
        <button class="wb-btn" data-act="toggle">${open ? '收起' : '展开'}</button>
        <button class="wb-btn" data-act="copy">复制</button>
        ${url ? `<a class="wb-btn" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer">原文</a>` : ''}
        <button class="wb-btn danger" data-act="del">删除</button>
        <span class="wb-meta" title="${escHtml(entry.title || '')}">${escHtml(entry.model || '')}</span>
      </div>
    `;
    frag.appendChild(card);
  });
  wbListEl.appendChild(frag);
}

function toggleWordbookCard(id) {
  if (wbExpanded.has(id)) wbExpanded.delete(id);
  else wbExpanded.add(id);
  const keepTop = wbListEl.scrollTop;
  renderWordbook();
  wbListEl.scrollTop = keepTop;
}

if (wbListEl) {
  wbListEl.addEventListener('click', async e => {
    const card = e.target.closest('.wb-card');
    if (!card) return;
    const id = card.dataset.id;
    const actEl = e.target.closest('[data-act]');
    const act = actEl ? actEl.dataset.act : '';

    if (act === 'copy') {
      const entry = wordbook.find(x => x.id === id);
      if (!entry) return;
      const text = entry.result || '';
      try {
        await navigator.clipboard.writeText(text);
        const old = actEl.textContent;
        actEl.textContent = '已复制';
        setTimeout(() => { actEl.textContent = old; }, 1200);
      } catch {
        actEl.textContent = '复制失败';
        setTimeout(() => { actEl.textContent = '复制'; }, 1200);
      }
      return;
    }

    if (act === 'del') {
      wordbook = wordbook.filter(x => x.id !== id);
      wbExpanded.delete(id);
      await persistWordbook();
      updateWordbookBadge();
      renderWordbook();
      return;
    }

    // 点展开按钮 / 标题 / 正文空白处：展开或收起（正文里的链接照常可点）
    if (act === 'toggle' || (!act && !e.target.closest('a'))) {
      toggleWordbookCard(id);
    }
  });
}

if (wbSearchEl) {
  wbSearchEl.addEventListener('input', () => renderWordbook());
}

if (btnWordbook) {
  btnWordbook.addEventListener('click', () => setView('wordbook'));
}
document.getElementById('btnWbBack')?.addEventListener('click', () => setView('chat'));

// 清空：两段式确认（Popup 里 confirm() 不可靠）
let wbClearArmed = false;
let wbClearTimer = null;
const btnWbClear = document.getElementById('btnWbClear');
if (btnWbClear) {
  btnWbClear.addEventListener('click', async () => {
    if (wordbook.length === 0) return;
    if (!wbClearArmed) {
      wbClearArmed = true;
      btnWbClear.textContent = '确认清空';
      btnWbClear.classList.add('armed');
      wbClearTimer = setTimeout(() => {
        wbClearArmed = false;
        btnWbClear.textContent = '清空';
        btnWbClear.classList.remove('armed');
      }, 3000);
      return;
    }
    clearTimeout(wbClearTimer);
    wbClearArmed = false;
    btnWbClear.textContent = '清空';
    btnWbClear.classList.remove('armed');
    wordbook = [];
    wbExpanded.clear();
    await persistWordbook();
    updateWordbookBadge();
    renderWordbook();
  });
}

const btnWbExport = document.getElementById('btnWbExport');
if (btnWbExport) {
  btnWbExport.addEventListener('click', () => {
    if (wordbook.length === 0) return;
    const lines = ['# Lumen Ask 单词本', '', `导出时间：${new Date().toLocaleString()}`, ''];
    wordbook.forEach(e => {
      lines.push(`## ${e.term || '(未命名词条)'}`);
      const when = new Date(e.updatedAt || e.createdAt || Date.now()).toLocaleString();
      lines.push(`> ${when}${e.model ? ' · ' + e.model : ''}${e.title ? ' · 来自《' + e.title + '》' : ''}`);
      lines.push('');
      lines.push(String(e.result || '').trim());
      lines.push('');
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lumen-wordbook-${new Date().toISOString().slice(0, 10)}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

// 划词面板存入新词条后，Popup 若开着就即时刷新
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[WORDBOOK_KEY]) return;
  const next = changes[WORDBOOK_KEY].newValue;
  wordbook = Array.isArray(next) ? next : [];
  updateWordbookBadge();
  if (currentView === 'wordbook') renderWordbook();
});

// ===== Start =====
init();
