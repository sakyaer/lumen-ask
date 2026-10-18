const STORAGE_KEY = 'llm_config';
const TOKEN_KEY = 'llm_total_tokens';
const DEFAULT_TOKEN_LIMIT = 30000000;

const $ = id => document.getElementById(id);

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

// 默认划词快捷按钮（label + 提示词，{text} 会被替换为选中文字）
// save: 'wordbook' = 结果只进单词本，不写聊天记录；'chat' = 存进聊天记录
const DEFAULT_PRESETS = [
  { label: '简介', prompt: '请用150字以内简明扼要地介绍以下内容是什么，不要超过150字：\n\n{text}', save: 'chat' },
  { label: '解释', prompt: '请详细解释以下内容：\n\n{text}', save: 'chat' },
  { label: '翻译', prompt: TRANSLATE_PROMPT, save: 'wordbook' },
  { label: '总结', prompt: '请总结以下内容的要点：\n\n{text}', save: 'chat' },
  { label: '润色', prompt: '请优化以下内容的表达：\n\n{text}', save: 'chat' },
];

// 老版本翻译提示词：命中说明用户没改过，升级成新版学习卡片提示词
// 用特征串匹配，旧版长提示词也能识别
const LEGACY_TRANSLATE_MARKS = [
  '请将以下内容翻译成中文',
  '整理成一张便于记忆的学习卡片',
];
function isLegacyTranslatePrompt(prompt) {
  const s = String(prompt || '').trim();
  return LEGACY_TRANSLATE_MARKS.some(m => s.includes(m));
}

function migratePresets(presets) {
  return presets.map(p => {
    const label = String(p.label || '').trim();
    const prompt = String(p.prompt || '');
    let save = p.save === 'wordbook' || p.save === 'chat' ? p.save : '';
    if (!save) {
      save = /^(翻译|translate)/i.test(label) || isLegacyTranslatePrompt(prompt)
        ? 'wordbook' : 'chat';
    }
    if (isLegacyTranslatePrompt(prompt) && save === 'wordbook') {
      return { label, prompt: TRANSLATE_PROMPT, save };
    }
    return { label, prompt, save };
  });
}

// DOM refs
const apiKeyInput = $('apiKey');
const baseUrlInput = $('baseUrl');
const modelSelect = $('modelSelect');
const customModelInput = $('customModel');
const customModelGroup = $('customModelGroup');
const systemPromptInput = $('systemPrompt');
const enableSelectionInput = $('enableSelection');
const selectionModelInput = $('selectionModel');
const reasoningEffortInput = $('reasoningEffort');
const selectionReasoningEffortInput = $('selectionReasoningEffort');
const panelWidthInput = $('panelWidth');
const replyHeightInput = $('replyHeight');
const presetEditor = $('presetEditor');
const btnAddPreset = $('btnAddPreset');
const tokenLimitInput = $('tokenLimit');
const btnResetToken = $('btnResetToken');
const saveBtn = $('saveBtn');
const saveBtnText = $('saveBtnText');
const saveBtnIcon = $('saveBtnIcon');
const saveMsg = $('saveMsg');
const toggleApiKeyBtn = $('toggleApiKey');
const eyeIcon = $('eyeIcon');
const themeValueInput = $('themeValue');

// === Theme picker ===
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}

function setActiveThemeCard(theme) {
  document.querySelectorAll('.theme-card').forEach(card => {
    card.classList.toggle('active', card.dataset.theme === theme);
  });
  themeValueInput.value = theme;
  applyTheme(theme);
}

document.querySelectorAll('.theme-card').forEach(card => {
  card.addEventListener('click', () => setActiveThemeCard(card.dataset.theme));
});

// === Load config ===
chrome.storage.sync.get(STORAGE_KEY, result => {
  const cfg = result[STORAGE_KEY] || {};
  if (cfg.apiKey) apiKeyInput.value = cfg.apiKey;
  if (cfg.baseUrl) baseUrlInput.value = cfg.baseUrl;
  if (cfg.systemPrompt) systemPromptInput.value = cfg.systemPrompt;
  if (cfg.enableSelection !== undefined) enableSelectionInput.checked = cfg.enableSelection;
  if (cfg.selectionModel) selectionModelInput.value = cfg.selectionModel;
  if (cfg.reasoningEffort && reasoningEffortInput) reasoningEffortInput.value = cfg.reasoningEffort;
  // 划词默认最低思考；未配置过的老用户也展示为 no_think
  if (selectionReasoningEffortInput) {
    selectionReasoningEffortInput.value =
      cfg.selectionReasoningEffort !== undefined ? cfg.selectionReasoningEffort : 'no_think';
  }
  tokenLimitInput.value = cfg.tokenLimit || DEFAULT_TOKEN_LIMIT;
  // 面板尺寸：默认宽度 468 = 原 360×1.3，回答区 374 = 原 288×1.3（整体上调 30%）
  panelWidthInput.value = cfg.panelWidth || 468;
  // 旧默认 288 视为未自定义，展示为新默认值
  replyHeightInput.value = (!cfg.replyHeight || cfg.replyHeight === 288) ? 374 : cfg.replyHeight;

  // Load preset prompts
  const presets = Array.isArray(cfg.presetPrompts) && cfg.presetPrompts.length
    ? migratePresets(cfg.presetPrompts)
    : DEFAULT_PRESETS;
  renderPresetEditor(presets);

  // Apply saved theme
  const savedTheme = cfg.theme || 'duolingo';
  setActiveThemeCard(savedTheme);

  // Set model
  if (cfg.model) {
    const opt = modelSelect.querySelector(`option[value="${cfg.model}"]`);
    if (opt) {
      modelSelect.value = cfg.model;
    } else {
      modelSelect.value = 'custom';
      customModelInput.value = cfg.model;
      customModelGroup.style.display = 'block';
    }
  }
});

// === Model select change ===
modelSelect.addEventListener('change', () => {
  if (modelSelect.value === 'custom') {
    customModelGroup.style.display = 'block';
    customModelInput.focus();
  } else {
    customModelGroup.style.display = 'none';
  }
});

// === Toggle API Key visibility ===
let apiKeyVisible = false;
toggleApiKeyBtn.addEventListener('click', () => {
  apiKeyVisible = !apiKeyVisible;
  apiKeyInput.type = apiKeyVisible ? 'text' : 'password';
  eyeIcon.innerHTML = apiKeyVisible
    ? `<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line>`
    : `<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle>`;
});

// === Reset token count ===
btnResetToken.addEventListener('click', async () => {
  await chrome.storage.local.set({ [TOKEN_KEY]: 0 });
  btnResetToken.textContent = '已重置 ✓';
  btnResetToken.style.color = '#86EFAC';
  setTimeout(() => { btnResetToken.textContent = '重置'; btnResetToken.style.color = ''; }, 2000);
});

// === Save config ===
saveBtn.addEventListener('click', async () => {
  const apiKey = apiKeyInput.value.trim();
  const baseUrl = (baseUrlInput.value.trim() || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = modelSelect.value === 'custom'
    ? customModelInput.value.trim()
    : modelSelect.value;
  const systemPrompt = systemPromptInput.value.trim();
  const enableSelection = enableSelectionInput.checked;
  const selectionModel = selectionModelInput.value;
  const tokenLimit = parseInt(tokenLimitInput.value) || DEFAULT_TOKEN_LIMIT;
  const theme = themeValueInput.value || 'duolingo';

  if (!apiKey) {
    showMsg('请输入 API Key', 'error');
    apiKeyInput.focus();
    return;
  }
  if (!model) {
    showMsg('请选择或输入模型名称', 'error');
    return;
  }

  // 值可能带空格（从别处粘进来的），trim 后再存，避免 " high" 这类非法参数被原样发出去
  const reasoningEffort = reasoningEffortInput ? reasoningEffortInput.value.trim() : '';

  const selectionReasoningEffort = selectionReasoningEffortInput
    ? selectionReasoningEffortInput.value.trim()
    : 'no_think';

  const panelWidth = Math.min(Math.max(parseInt(panelWidthInput.value) || 468, 320), 800);
  const replyHeight = Math.min(Math.max(parseInt(replyHeightInput.value) || 374, 120), 800);

  const config = {
    apiKey, baseUrl, model, systemPrompt, enableSelection, selectionModel,
    reasoningEffort, selectionReasoningEffort,
    panelWidth, replyHeight,
    presetPrompts: collectPresets(), tokenLimit, theme
  };

  try {
    await chrome.storage.sync.set({ [STORAGE_KEY]: config });
    showSaveSuccess();
  } catch (e) {
    showMsg('保存失败: ' + e.message, 'error');
  }
});

// === Preset prompts editor ===
function renderPresetEditor(presets) {
  presetEditor.innerHTML = '';
  presets.forEach((p, i) => {
    presetEditor.appendChild(createPresetRow(p.label || '', p.prompt || '', i, p.save || 'chat'));
  });
}

function createPresetRow(label, prompt, index, save) {
  const row = document.createElement('div');
  row.className = 'preset-row';

  const top = document.createElement('div');
  top.className = 'preset-row-top';

  const badge = document.createElement('span');
  badge.className = 'preset-badge';
  badge.textContent = '按钮 ' + (index + 1);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'preset-label-input';
  labelInput.placeholder = '按钮名称，如：简介';
  labelInput.value = label;

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-preset';
  removeBtn.textContent = '×';
  removeBtn.title = '删除此按钮';
  removeBtn.addEventListener('click', () => {
    row.remove();
  });

  top.appendChild(badge);
  top.appendChild(labelInput);
  top.appendChild(removeBtn);

  // 结果去向：聊天记录 / 单词本（翻译类默认进单词本）
  const sinkRow = document.createElement('div');
  sinkRow.className = 'preset-sink-row';

  const sinkLabel = document.createElement('span');
  sinkLabel.className = 'preset-sink-label';
  sinkLabel.textContent = '结果存入';

  const sinkSelect = document.createElement('select');
  sinkSelect.className = 'preset-sink-select';
  [
    { value: 'chat', text: '聊天记录' },
    { value: 'wordbook', text: '单词本（不写聊天记录）' },
  ].forEach(o => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.text;
    sinkSelect.appendChild(opt);
  });
  sinkSelect.value = save === 'wordbook' ? 'wordbook' : 'chat';

  sinkRow.appendChild(sinkLabel);
  sinkRow.appendChild(sinkSelect);

  const promptInput = document.createElement('textarea');
  promptInput.className = 'preset-prompt-input';
  promptInput.placeholder = '提示词，可用 {text} 代表选中的文字';
  promptInput.value = prompt;

  row.appendChild(top);
  row.appendChild(sinkRow);
  row.appendChild(promptInput);
  return row;
}

btnAddPreset.addEventListener('click', () => {
  presetEditor.appendChild(createPresetRow('', '', presetEditor.children.length, 'chat'));
});

function collectPresets() {
  const presets = [];
  presetEditor.querySelectorAll('.preset-row').forEach(row => {
    const label = row.querySelector('.preset-label-input').value.trim();
    const prompt = row.querySelector('.preset-prompt-input').value.trim();
    const save = row.querySelector('.preset-sink-select')?.value === 'wordbook' ? 'wordbook' : 'chat';
    if (!label || !prompt) return;
    presets.push({ label, prompt, save });
  });
  return presets;
}

function showSaveSuccess() {
  saveBtn.classList.add('success');
  saveBtnIcon.innerHTML = `<polyline points="20 6 9 17 4 12"></polyline>`;
  saveBtnText.textContent = '已保存';
  showMsg('✓ 设置已保存', 'success');

  setTimeout(() => {
    saveBtn.classList.remove('success');
    saveBtnIcon.innerHTML = `<path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline>`;
    saveBtnText.textContent = '保存设置';
  }, 2500);
}

function showMsg(text, type) {
  saveMsg.textContent = text;
  saveMsg.className = 'save-msg ' + type;
  if (type === 'error') {
    setTimeout(() => { saveMsg.className = 'save-msg'; }, 3000);
  }
}
