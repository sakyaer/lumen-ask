// ===== Constants =====
const SESSIONS_KEY = 'llm_sessions';
const ACTIVE_ID_KEY = 'llm_active_session_id';
const CONFIG_KEY = 'llm_config';
const MAX_SESSIONS = 50;
const TOKEN_KEY = 'llm_total_tokens';
const DEFAULT_TOKEN_LIMIT = 30000000;
let TOKEN_BAR_MAX = DEFAULT_TOKEN_LIMIT;

// 各厂商模型组，key = 识别前缀/关键词，用于匹配当前 baseUrl 或 model
const MODEL_GROUPS = [
  {
    label: 'OpenAI',
    match: cfg => !cfg.baseUrl || cfg.baseUrl.includes('openai.com'),
    models: [
      { id: 'gpt-5.2',    name: 'GPT-5.2（旗舰）' },
      { id: 'gpt-5.1',    name: 'GPT-5.1（编码）' },
      { id: 'gpt-5',      name: 'GPT-5' },
      { id: 'gpt-5-mini', name: 'GPT-5 Mini' },
      { id: 'gpt-5-nano', name: 'GPT-5 Nano' },
    ]
  },
  {
    label: 'Anthropic',
    match: cfg => cfg.baseUrl && cfg.baseUrl.includes('anthropic.com'),
    models: [
      { id: 'claude-fable-5',           name: 'Fable 5（最强）' },
      { id: 'claude-opus-5',            name: 'Opus 5' },
      { id: 'claude-sonnet-5',          name: 'Sonnet 5' },
      { id: 'claude-haiku-4-5-20251001',name: 'Haiku 4.5' },
    ]
  },
  {
    label: '腾讯 Token Plan',
    match: cfg => cfg.baseUrl && cfg.baseUrl.includes('lkeap'),
    models: [
      { id: 'tc-code-latest',             name: 'Auto（智能路由）' },
      // 通用 Token Plan
      { id: 'hy4-preview',                name: 'Hy4 Preview（混元）' },
      { id: 'deepseek-v4-pro-202606',     name: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash-202605',   name: 'DeepSeek V4 Flash' },
      { id: 'glm-5.3',                    name: 'GLM-5.3' },
      { id: 'glm-5.2',                    name: 'GLM-5.2' },
      { id: 'glm-5.1',                    name: 'GLM-5.1' },
      { id: 'glm-5',                      name: 'GLM-5' },
      { id: 'minimax-m3',                 name: 'MiniMax M3' },
      { id: 'minimax-m2.7',               name: 'MiniMax M2.7' },
      { id: 'kimi-k2.7-code',             name: 'Kimi K2.7 Code' },
      // Hy Token Plan
      { id: 'hy3',                        name: 'Hy3（混元）' },
    ]
  },
  {
    label: 'DeepSeek',
    match: cfg => cfg.baseUrl && cfg.baseUrl.includes('deepseek'),
    models: [
      { id: 'deepseek-v4-pro',   name: 'V4 Pro' },
      { id: 'deepseek-v4-flash', name: 'V4 Flash' },
    ]
  },
  {
    label: '通义千问',
    match: cfg => cfg.baseUrl && (cfg.baseUrl.includes('aliyun') || cfg.baseUrl.includes('dashscope') || cfg.baseUrl.includes('qwen')),
    models: [
      { id: 'qwen3.8-max',  name: '3.8-Max' },
      { id: 'qwen3.7-plus', name: '3.7-Plus' },
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

// ===== Init =====
async function init() {
  const data = await chrome.storage.local.get([SESSIONS_KEY, ACTIVE_ID_KEY, TOKEN_KEY]);
  sessions = data[SESSIONS_KEY] || [];
  activeSessionId = data[ACTIVE_ID_KEY] || null;
  petTotalTokens = data[TOKEN_KEY] || 0;

  const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
  config = cfgData[CONFIG_KEY] || null;
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
function renderMessages(instant = true) {
  const session = getActiveSession();
  messagesEl.innerHTML = '';

  if (!session || session.messages.length === 0) {
    messagesEl.appendChild(emptyStateEl);
    emptyStateEl.style.display = 'flex';
    chatTitleEl.textContent = session ? displayTitle(session.title) : 'Lumen Ask';
    return;
  }

  emptyStateEl.style.display = 'none';
  chatTitleEl.textContent = displayTitle(session.title);

  session.messages.forEach(msg => {
    if (msg.role === 'system') return;
    appendMessageDOM(msg.role, msg.content);
  });

  // 等浏览器完成布局后直接跳底（instant=true 无动画，切 session 时即时到位）
  requestAnimationFrame(() => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
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
  config = cfgData[CONFIG_KEY] || null;

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
        // 推理模型（hy4-preview 等）先出思考过程，明确提示避免看起来像卡死
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
    if (activeSessionId === thisSessionId) {
      renderMessages();
    }
  }
}

// ===== Stream Chat =====
// 首个数据块最长等待：推理模型（hy4-preview 深度思考）较慢，给足 90s
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

// 思考强度：腾讯系认 no_think，OpenAI 系只认 low/minimal
function normalizeReasoningEffort(baseUrl, value) {
  if (!value) return null;
  if (isTencentBase(baseUrl)) return value;
  if (value === 'no_think') return 'low';
  return value;
}

function isTencentBase(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  return u.includes('lkeap') || u.includes('tencentmaas') ||
         u.includes('tencent') || u.includes('hunyuan');
}

// 关闭思考的写法各家不同，按"一次命中率"排序列出所有候选（与 background.js 保持一致）：
// GLM 系 thinking:{type:"disabled"} / Qwen 系 enable_thinking:false /
// OpenAI 系 reasoning_effort:low / 腾讯文档 reasoningEffort（驼峰）/ 兜底 thinking_budget:0
function reasoningCandidates(baseUrl, effort, isAnthropic) {
  const v = normalizeReasoningEffort(baseUrl, effort);
  if (!v) return [{ label: 'none', params: {} }];

  const isTencent = isTencentBase(baseUrl);
  const isLow = v === 'no_think' || v === 'minimal' || v === 'low';

  if (isAnthropic) {
    if (isLow) {
      return [
        { label: 'thinking:disabled', params: { thinking: { type: 'disabled' } } },
        { label: 'thinking-budget-0', params: { thinking: { type: 'enabled', budget_tokens: 0 } } },
      ];
    }
    return [{
      label: 'thinking:enabled',
      params: { thinking: { type: 'enabled', budget_tokens: v === 'high' ? 2048 : 1024 } },
    }];
  }

  if (isLow) {
    const allOff = {
      enable_thinking: false,
      thinking: { type: 'disabled' },
      thinking_budget: 0,
      reasoning_effort: v,
    };
    if (isTencent) allOff.reasoningEffort = v;

    return [
      { label: 'all-off', params: allOff },
      { label: 'thinking:disabled', params: { thinking: { type: 'disabled' } } },
      { label: 'enable_thinking=false', params: { enable_thinking: false } },
      { label: 'reasoning_effort', params: { reasoning_effort: v } },
      { label: 'reasoningEffort(驼峰)', params: { reasoningEffort: v } },
      { label: 'thinking_budget=0', params: { thinking_budget: 0 } },
    ];
  }

  const hi = { reasoning_effort: v };
  if (isTencent) hi.reasoningEffort = v;
  return [{ label: 'reasoning_effort', params: hi }];
}

const paramProfile = new Map();

function httpErrMsg(status, text) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || j.message || msg;
  } catch { if (text) msg += ' ' + String(text).slice(0, 200); }
  return String(msg);
}

async function sendWithReasoning(doFetch, baseUrl, effort, isAnthropic) {
  const cands = reasoningCandidates(baseUrl, effort, isAnthropic);
  const key = `${baseUrl}|${effort || ''}|${isAnthropic ? 'a' : 'o'}`;

  const order = [];
  const cached = paramProfile.get(key);
  if (cached) order.push(cached);
  for (const c of cands) if (!cached || c.label !== cached.label) order.push(c);
  if (!order.some(c => c.label === 'none')) order.push({ label: 'none', params: {} });

  let lastStatus = 0;
  let lastText = '';

  for (const c of order) {
    let resp;
    try {
      resp = await doFetch(c.params);
    } catch (e) {
      throw new Error((e && e.message) || 'Failed to fetch');
    }
    if (resp.ok) {
      paramProfile.set(key, c);
      return resp;
    }
    lastText = await resp.text();
    lastStatus = resp.status;

    const retriable = resp.status === 400 &&
      /reasoning|thinking|parameter|unknown|unsupported|invalid|unexpected/i.test(lastText);
    if (!retriable) throw new Error(httpErrMsg(lastStatus, lastText));
  }

  throw new Error(httpErrMsg(lastStatus, lastText));
}

// handlers: { onChunk, onStatus, onReasoning }
async function streamChat(cfg, messages, handlers) {
  const h = typeof handlers === 'function' ? { onChunk: handlers } : (handlers || {});
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isAnthropic = baseUrl.toLowerCase().includes('anthropic');

  if (isAnthropic) {
    await streamChatAnthropic(cfg, baseUrl, messages, h);
  } else {
    await streamChatOpenAI(cfg, baseUrl, messages, h);
  }
}

// ===== OpenAI-compatible =====
async function streamChatOpenAI(cfg, baseUrl, messages, h) {
  const doFetch = (params) => {
    const body = {
      model: cfg.model || 'gpt-5',
      messages: cfg.systemPrompt
        ? [{ role: 'system', content: cfg.systemPrompt }, ...messages]
        : messages,
      stream: true
    };
    Object.assign(body, params);
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify(body)
    });
  };

  const resp = await sendWithReasoning(doFetch, baseUrl, cfg.reasoningEffort, false);
  if (!resp.ok) throw new Error(httpErrMsg(resp.status, await resp.text()));

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

        // 推理模型的思考过程放在 reasoning_content
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
                + `可将「思考强度」设为 no_think，或换用非推理模型）\n\n` + reasoningBuf.trim());
      }
      return;
    }
    throw new Error('模型没有返回任何内容。请检查模型名与 Base URL 是否匹配（腾讯 OpenAI 兼容为 /plan/v3，Anthropic 兼容为 /plan/anthropic）');
  }
}

// ===== Anthropic-compatible =====
async function streamChatAnthropic(cfg, baseUrl, messages, h) {
  // Convert messages: filter out system messages, convert content to Anthropic format
  const userMessages = messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role,
      content: [{ type: 'text', text: m.content }]
    }));

  const doFetch = (params) => {
    const body = {
      model: cfg.model || 'claude-opus-5',
      max_tokens: cfg.maxTokens || 8192,
      stream: true,
      messages: [...userMessages]
    };
    if (cfg.systemPrompt) body.system = [{ type: 'text', text: cfg.systemPrompt }];
    Object.assign(body, params);
    return fetch(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
  };

  const resp = await sendWithReasoning(doFetch, baseUrl, cfg.reasoningEffort, true);
  if (!resp.ok) throw new Error(httpErrMsg(resp.status, await resp.text()));

  if (h.onStatus) h.onStatus('connected');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let gotContent = false;
  let gotReasoning = false;
  let reasoningLen = 0;
  let reasoningBuf = '';
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
        if (data.type === 'error') throw new Error(data.error?.message || 'API 返回错误');

        if (data.type === 'content_block_delta') {
          const d = data.delta || {};
          // 推理模型的思考过程：thinking_delta
          if (d.type === 'thinking_delta' && d.thinking) {
            gotReasoning = true;
            reasoningLen += d.thinking.length;
            if (reasoningBuf.length < 6000) reasoningBuf += d.thinking;
            if (h.onReasoning) h.onReasoning(d.thinking, reasoningLen);
          } else if (d.type === 'text_delta' && d.text) {
            gotContent = true;
            if (h.onChunk) h.onChunk(d.text);
          }
        } else if (data.type === 'message_stop') {
          streamEnded = true; break;
        }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }

  if (!gotContent) {
    if (gotReasoning && reasoningBuf.trim()) {
      if (h.onChunk) {
        h.onChunk(`（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容。\n`
                + `可将「思考强度」设为 no_think，或换用非推理模型）\n\n` + reasoningBuf.trim());
      }
      return;
    }
    throw new Error('模型没有返回任何内容。请检查模型名与 Base URL 是否匹配');
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
  messagesEl.scrollTop = messagesEl.scrollHeight;
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
    renderSidebar();
    renderMessages();
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
      // 持久化
      const cfgData = await chrome.storage.sync.get(CONFIG_KEY);
      const stored = cfgData[CONFIG_KEY] || {};
      stored.model = m.id;
      await chrome.storage.sync.set({ [CONFIG_KEY]: stored });
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

// ===== Start =====
init();
