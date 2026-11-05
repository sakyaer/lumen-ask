// background.js - Service Worker，负责中转 API 请求（规避 CORS）
//
// 默认配置（DeepSeek 地址/模型）在 config-defaults.js（提交 git）。
// 本地 API Key 在 config.local.js（已 gitignore，不提交；缺失时静默跳过）。
importScripts('config-defaults.js');
try { importScripts('config.local.js'); } catch (e) { /* 没有本地密钥文件时忽略 */ }

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
        files: ['katex/katex.min.js', 'katex/katex-css.js', 'md-renderer.js', 'autoscroll.js', 'config-defaults.js', 'content_script.js'],
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
  if (msg.type === 'OPEN_WORDBOOK') {
    // 划词面板里点「已存入单词本」：Popup 若已打开会自己切视图；
    // 没打开时尝试把它拉起来（Chrome 127+ 允许，旧版本静默失败）
    try { chrome.action.openPopup?.()?.catch?.(() => {}); } catch {}
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
  if (msg.type === 'RESOLVE_CONFIG') {
    // 归一化存储里的旧配置（腾讯等），并补上 config.local.js 里的本地 Key。
    // content script 读不到 background 的全局变量，所以统一交给这里解析。
    let cfg = null;
    try {
      cfg = LumenConfig.resolveConfig(msg.cfg);
    } catch (e) {
      cfg = msg.cfg || null;
    }
    sendResponse({ cfg });
    return true;
  }
});

// 首个数据块最长等待：DeepSeek 思考较慢，给足 90s
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


// 统一的错误信息格式化
function httpErrMsg(status, text) {
  let msg = `HTTP ${status}`;
  try {
    const j = JSON.parse(text);
    msg = j.error?.message || j.error || j.message || msg;
  } catch { if (text) msg += ' ' + String(text).slice(0, 200); }
  return String(msg);
}

// 发一次请求；HTTP 非 2xx 时抛出带接口信息的错误，便于直接展示给用户。
// DeepSeek 走标准 OpenAI 兼容协议，不需要额外的思考强度参数：
// 思考过程（若有）会放在 reasoning_content 字段里。
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

// 网关忽略 stream:true、直接返回一次性 JSON 时的兜底解析
function handleNonStreamBody(text, send) {
  let content = '';
  let reasoning = '';
  try {
    const j = JSON.parse(text);
    if (j.error) {
      send({ error: j.error.message || JSON.stringify(j.error).slice(0, 300) });
      return;
    }
    const choice = j.choices?.[0] || {};
    content = choice.message?.content || choice.text || '';
    reasoning = choice.message?.reasoning_content || choice.message?.reasoning || '';
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
  const { cfg: rawCfg, messages } = payload;
  // 兼容旧版本存下的腾讯配置：这里统一归一化为 DeepSeek
  const cfg = LumenConfig.resolveConfig(rawCfg);
  const baseUrl = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');

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

    // 已连上，先告知前端，避免"一直转圈但什么都没发生"的观感
    send({ status: 'connected' });

    const ctype = (resp.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('application/json')) {
      handleNonStreamBody(await resp.text(), send);
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

        const choice = data.choices?.[0];
        const delta = choice?.delta || {};

        // 思考过程放在 reasoning_content
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

    // 收尾：只思考没正文时，把思考内容兜出来，别让用户白等一场
    if (!gotContent) {
      if (gotReasoning && reasoningBuf.trim()) {
        send({
          chunk: `（模型只输出了思考过程、没有生成正式回复，以下是它的思考内容。\n`
               + `可以改用 DeepSeek V4.1 Flash，或稍后重试）\n\n`
               + reasoningBuf.trim()
        });
        send({ done: true });
        return;
      }
      send({
        error: '模型没有返回任何内容。请检查模型名是否为 deepseek-flash / deepseek-v4-pro，以及 API Key 是否有效'
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
async function probeRaw({ cfg: rawCfg, messages }) {
  const cfg = LumenConfig.resolveConfig(rawCfg);
  const baseUrl = (cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
  const url = `${baseUrl}/chat/completions`;

  const body = { model: cfg.model, stream: false, messages };

  const started = Date.now();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  return {
    ok: resp.ok,
    status: resp.status,
    url,
    protocol: 'openai',
    contentType: resp.headers.get('content-type') || '',
    elapsedMs: Date.now() - started,
    bodySnippet: text.slice(0, 1500),
  };
}
