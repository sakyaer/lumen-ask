// background.js - Service Worker，负责中转 API 请求（规避 CORS）

const REINJECT_MIN_INTERVAL = 15000;
let lastReinjectAt = 0;

// 插件被更新/重新加载后，已打开页面的 content script 会与新扩展上下文断开
// （"Extension context invalidated"），表现为划词突然全部失效。
// 这里主动给所有已打开的页面重新注入一次，让划词自动恢复，无需手动刷新页面。
async function reinjectToOpenTabs() {
  const now = Date.now();
  if (now - lastReinjectAt < REINJECT_MIN_INTERVAL) return;
  lastReinjectAt = now;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab.id) continue;
      if (tab.url && !/^https?:/i.test(tab.url)) continue;
      chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['md-renderer.js', 'content_script.js'],
      }).catch(() => {});   // chrome:// 等不可注入的页面，忽略
    }
  } catch (e) {
    // 忽略：权限或环境不支持时不阻断主流程
  }
}

chrome.runtime.onInstalled.addListener(() => {
  lastReinjectAt = 0;
  reinjectToOpenTabs();
});

// Service Worker 每次唤醒兜底一次（内部有节流）
reinjectToOpenTabs();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STREAM_CHAT') {
    handleStreamChat(msg.payload, sender.tab?.id, msg.requestId);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'RAW_TEST') {
    // 诊断用：非流式请求一次，把原始响应交给前端，便于判定端点/模型是否匹配
    probeRaw(msg.payload)
      .then(sendResponse)
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'THINK_TEST') {
    // 诊断用：同一问题分别用不同思考参数各请求一次，实测哪个参数真正生效
    runThinkTest(msg.payload || {})
      .then(sendResponse)
      .catch(e => sendResponse({ error: e.message }));
    return true;
  }
});

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || '请求'}超时（${Math.round(ms / 1000)} 秒）`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// 思考参数体检：故意把 max_tokens 设小，如果思考吃光额度会看到
// reasoningLen 很大而 contentLen=0 —— 正是「思考字数一直涨、没有正文」的现场
async function runThinkTest({ cfg, model, prompt }) {
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isAnthropic = baseUrl.toLowerCase().includes('anthropic');
  const useModel = model || cfg.model;
  const messages = [{ role: 'user', content: prompt || '用一句话说明什么是机器学习' }];

  // 各家关闭思考的字段名都不一样，把已知可能一次列全，用实测筛出真正生效的那个
  const variants = isAnthropic
    ? [
        { name: '基准（不传 thinking）', params: {} },
        { name: 'thinking={type:disabled}', params: { thinking: { type: 'disabled' } } },
        { name: 'thinking budget=0', params: { thinking: { type: 'enabled', budget_tokens: 0 } } },
      ]
    : [
        { name: '基准（不传思考参数）', params: {} },
        { name: 'reasoning_effort=no_think', params: { reasoning_effort: 'no_think' } },
        { name: 'reasoningEffort=no_think（驼峰）', params: { reasoningEffort: 'no_think' } },
        { name: 'enable_thinking=false', params: { enable_thinking: false } },
        { name: 'thinking={type:disabled}', params: { thinking: { type: 'disabled' } } },
        { name: 'thinking_budget=0', params: { thinking_budget: 0 } },
      ];

  const doFetch = (params) => {
    if (isAnthropic) {
      const body = {
        model: useModel,
        max_tokens: 400,
        stream: false,
        messages: messages.map(m => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
        ...params,
      };
      return fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    }
    const body = { model: useModel, max_tokens: 400, stream: false, messages, ...params };
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  };

  const results = [];
  for (const v of variants) {
    const started = Date.now();
    try {
      // 限时 30s：如果某个参数真能关掉思考，几秒内就该返回；超时本身就说明它没生效
      const resp = await withTimeout(doFetch(v.params), 30000, v.name);
      const elapsedMs = Date.now() - started;
      const text = await resp.text();
      let content = '', reasoning = '', finish = '', apiError = '';
      try {
        const j = JSON.parse(text);
        apiError = j.error ? (j.error.message || JSON.stringify(j.error)) : '';
        if (isAnthropic) {
          const blocks = Array.isArray(j.content) ? j.content : [];
          content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
          reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
          finish = j.stop_reason || '';
        } else {
          const c = j.choices?.[0] || {};
          content = c.message?.content || '';
          reasoning = c.message?.reasoning_content || c.message?.reasoning || '';
          finish = c.finish_reason || '';
        }
      } catch {
        apiError = text.slice(0, 200);
      }
      results.push({
        variant: v.name,
        httpStatus: resp.status,
        elapsedMs,
        reasoningLen: reasoning.length,
        contentLen: content.length,
        finishReason: finish,
        verdict: resp.ok && !reasoning.length && content.length
          ? '✅ 关掉了思考'
          : (apiError ? '❌ 参数被拒' : (reasoning.length ? '仍有思考' : '')),
        error: apiError,
      });
    } catch (e) {
      results.push({
        variant: v.name,
        httpStatus: 0,
        elapsedMs: Date.now() - started,
        reasoningLen: 0,
        contentLen: 0,
        finishReason: '',
        verdict: '❌ 超时（疑似仍在思考）',
        error: e.message,
      });
    }
  }

  return {
    protocol: isAnthropic ? 'anthropic' : 'openai',
    model: useModel,
    baseUrl,
    results,
  };
}

// 首个数据块最长等待：推理模型（hy4-preview 深度思考）较慢，给足 90s
const FIRST_BYTE_TIMEOUT_MS = 90000;
// 两个数据块之间的最长间隔
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

// 思考强度：值各家不同（腾讯认 no_think，OpenAI 系认 low/minimal）
function normalizeReasoningEffort(baseUrl, value) {
  if (!value) return null;
  const u = String(baseUrl || '').toLowerCase();
  const isTencent = u.includes('lkeap') || u.includes('tencentmaas') ||
                    u.includes('tencent') || u.includes('hunyuan');
  if (isTencent) return value;
  if (value === 'no_think') return 'low';
  return value;
}

function isTencentBase(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  return u.includes('lkeap') || u.includes('tencentmaas') ||
         u.includes('tencent') || u.includes('hunyuan');
}

// 关闭思考的写法各家完全不同，不再猜 —— 按"一次命中率"排序列出所有候选：
//   GLM / 智谱系：thinking:{type:"disabled"}
//   Qwen / vLLM 系：enable_thinking:false
//   OpenAI 系：reasoning_effort:low
//   腾讯文档：reasoningEffort（驼峰）
//   通用兜底：thinking_budget:0
// 宽松网关会忽略无关字段，所以第一组"全带上"通常一次命中；
// 严格网关会对未知字段报 400，那就逐组退到能用的那一组（400 返回很快，开销可接受）。
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

// 记住「端点 + 模型」下真正可用的参数组合，避免每次请求都重新试错
const paramProfile = new Map();

function httpErrMsg(status, text) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || j.message || msg;
  } catch { if (text) msg += ' ' + String(text).slice(0, 200); }
  return String(msg);
}

// 依次尝试候选参数组合，返回第一个能通的响应
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
      return { error: (e && e.message) || 'Failed to fetch' };
    }
    if (resp.ok) {
      paramProfile.set(key, c);
      return { resp, paramUsed: c.label };
    }
    lastText = await resp.text();
    lastStatus = resp.status;

    // 只有「疑似参数不被支持」的 400 才值得换下一组，其他错误直接上报
    const retriable = resp.status === 400 &&
      /reasoning|thinking|parameter|unknown|unsupported|invalid|unexpected/i.test(lastText);
    if (!retriable) return { error: httpErrMsg(lastStatus, lastText) };
  }

  return { error: httpErrMsg(lastStatus, lastText) };
}

// 网关忽略 stream:true、直接返回一次性 JSON 时的兜底解析
function handleNonStreamBody(text, isAnthropic, send) {
  let content = '';
  let reasoning = '';
  try {
    const j = JSON.parse(text);
    if (j.error) {
      send({ error: j.error.message || JSON.stringify(j.error).slice(0, 300) });
      return;
    }
    if (isAnthropic) {
      const blocks = Array.isArray(j.content) ? j.content : [];
      content = blocks.filter(b => b.type === 'text').map(b => b.text || '').join('');
      reasoning = blocks.filter(b => b.type === 'thinking').map(b => b.thinking || '').join('');
    } else {
      const choice = j.choices?.[0] || {};
      content = choice.message?.content || choice.text || '';
      reasoning = choice.message?.reasoning_content || choice.message?.reasoning || '';
    }
  } catch (e) {
    send({ error: '响应既不是 SSE 也不是可解析的 JSON：' + String(text).slice(0, 200) });
    return;
  }
  if (reasoning) send({ reasoning, reasoningLen: reasoning.length });
  if (!content) {
    if (reasoning && reasoning.trim()) {
      send({
        chunk: '（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容）\n\n'
             + reasoning.trim()
      });
      send({ done: true });
      return;
    }
    send({ error: '模型没有返回任何正式内容（响应中只有思考过程或空内容）' });
    return;
  }
  send({ chunk: content });
  send({ done: true });
}

async function handleStreamChat(payload, tabId, requestId) {
  const { cfg, messages } = payload;
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isAnthropic = baseUrl.toLowerCase().includes('anthropic');

  const send = (data) => {
    if (tabId == null) return;
    // 页面已刷新 / 插件刚重载导致 content script 失效时，这里会抛错，静默忽略即可
    Promise.resolve(chrome.tabs.sendMessage(tabId, { type: 'STREAM_CHUNK', requestId, ...data }))
      .catch(() => {});
  };

  // 长流式请求期间保活，避免 MV3 Service Worker 被回收导致流莫名中断
  const keepAlive = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch {}
  }, 20000);

  let reader = null;

  try {
    // params 为本次要附加的思考参数（由 sendWithReasoning 逐组尝试得出）
    const buildRequest = (params) => {
      if (isAnthropic) {
        const userMessages = messages
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: [{ type: 'text', text: m.content }] }));

        const body = {
          model: cfg.model || 'claude-opus-5',
          max_tokens: cfg.maxTokens || 8192,
          stream: true,
          messages: userMessages
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
      }

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

    const sent = await sendWithReasoning(
      (params) => buildRequest(params),
      baseUrl,
      cfg.reasoningEffort,
      isAnthropic
    );
    if (sent.error) {
      send({ error: sent.error });
      return;
    }
    const resp = sent.resp;

    if (!resp.ok) {
      send({ error: httpErrMsg(resp.status, await resp.text()) });
      return;
    }

    // 已连上，先告知前端，避免"一直转圈但什么都没发生"的观感
    send({ status: 'connected' });

    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      handleNonStreamBody(await resp.text(), isAnthropic, send);
      return;
    }

    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let gotContent = false;
    let gotReasoning = false;
    let reasoningLen = 0;
    let reasoningBuf = '';   // 累积思考内容，只思考无正文时兜底回给用户
    let firstPacket = true;
    let streamEnded = false;

    while (!streamEnded) {
      let done, value;
      try {
        ({ done, value } = await readWithTimeout(
          reader,
          firstPacket ? FIRST_BYTE_TIMEOUT_MS : IDLE_TIMEOUT_MS,
          firstPacket
        ));
      } catch (e) {
        send({ error: e.message });
        return;
      }
      firstPacket = false;
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;      // 空行或注释（心跳）
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed.slice(5).trim();
        if (!jsonStr) continue;
        if (jsonStr === '[DONE]') { streamEnded = true; break; }

        let data;
        try { data = JSON.parse(jsonStr); } catch { continue; }

        if (data.error) {
          send({ error: data.error.message || JSON.stringify(data.error).slice(0, 300) });
          return;
        }

        if (isAnthropic) {
          const t = data.type;
          if (t === 'content_block_delta') {
            const d = data.delta || {};
            if (d.type === 'thinking_delta' && d.thinking) {
              gotReasoning = true;
              reasoningLen += d.thinking.length;
              if (reasoningBuf.length < 6000) reasoningBuf += d.thinking;
              send({ reasoning: d.thinking, reasoningLen });
            } else if (d.type === 'text_delta' && d.text) {
              gotContent = true;
              send({ chunk: d.text });
            }
          } else if (t === 'message_stop') {
            streamEnded = true; break;
          } else if (t === 'error') {
            send({ error: data.error?.message || 'API 返回错误' });
            return;
          }
        } else {
          const choice = data.choices?.[0];
          const delta = choice?.delta || {};

          // 推理模型的思考过程：hy4-preview、DeepSeek-R 等放在 reasoning_content
          const reasoning = delta.reasoning_content || delta.reasoning || '';
          if (reasoning) {
            gotReasoning = true;
            reasoningLen += reasoning.length;
            if (reasoningBuf.length < 6000) reasoningBuf += reasoning;
            send({ reasoning, reasoningLen });
          }

          const content = delta.content || '';
          if (content) { gotContent = true; send({ chunk: content }); }

          // 少数实现把完整内容放在 message 上
          if (!gotContent && choice?.message?.content) {
            gotContent = true;
            send({ chunk: choice.message.content });
          }

          if (choice?.finish_reason) { streamEnded = true; break; }
        }
      }
    }

    // 收尾：只思考没正文时，把思考内容兜出来，别让用户白等一场
    if (!gotContent) {
      if (gotReasoning && reasoningBuf.trim()) {
        send({
          chunk: `（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容。\n`
               + `可将「划词思考强度」设为 no_think，或换用非推理模型）\n\n`
               + reasoningBuf.trim()
        });
        send({ done: true });
        return;
      }
      send({
        error: '模型没有返回任何内容。请检查模型名与 Base URL 是否匹配（腾讯 OpenAI 兼容为 /plan/v3，Anthropic 兼容为 /plan/anthropic）'
      });
      return;
    }
    send({ done: true });
  } catch (err) {
    send({ error: (err && err.message) || 'Failed to fetch' });
  } finally {
    clearInterval(keepAlive);
    try { if (reader) await reader.cancel(); } catch {}
  }
}

// 诊断：非流式请求一次，返回 HTTP 状态与原始响应片段
async function probeRaw({ cfg, messages }) {
  const baseUrl = (cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  const isAnthropic = baseUrl.toLowerCase().includes('anthropic');
  const url = isAnthropic ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;

  const headers = isAnthropic
    ? { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` };

  const body = isAnthropic
    ? {
        model: cfg.model,
        max_tokens: 256,
        stream: false,
        messages: messages
          .filter(m => m.role !== 'system')
          .map(m => ({ role: m.role, content: [{ type: 'text', text: m.content }] }))
      }
    : { model: cfg.model, stream: false, messages };

  const started = Date.now();
  const resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    url,
    protocol: isAnthropic ? 'anthropic' : 'openai',
    contentType: resp.headers.get('content-type') || '',
    elapsedMs: Date.now() - started,
    bodySnippet: text.slice(0, 1500),
  };
}
