const STORAGE_KEY = 'llm_config';
const TOKEN_KEY = 'llm_total_tokens';
const DEFAULT_TOKEN_LIMIT = 30000000;

const $ = id => document.getElementById(id);

// 默认划词快捷按钮（label + 提示词，{text} 会被替换为选中文字）
const DEFAULT_PRESETS = [
  { label: '简介', prompt: '请用150字以内简明扼要地介绍以下内容是什么，不要超过150字：\n\n{text}' },
  { label: '解释', prompt: '请详细解释以下内容：\n\n{text}' },
  { label: '翻译', prompt: '请将以下内容翻译成中文：\n\n{text}' },
  { label: '总结', prompt: '请总结以下内容的要点：\n\n{text}' },
  { label: '润色', prompt: '请优化以下内容的表达：\n\n{text}' },
];

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

  // Load preset prompts
  const presets = Array.isArray(cfg.presetPrompts) && cfg.presetPrompts.length
    ? cfg.presetPrompts
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

  const reasoningEffort = reasoningEffortInput ? reasoningEffortInput.value : '';

  const selectionReasoningEffort = selectionReasoningEffortInput ? selectionReasoningEffortInput.value : 'no_think';

  const config = {
    apiKey, baseUrl, model, systemPrompt, enableSelection, selectionModel,
    reasoningEffort, selectionReasoningEffort,
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
    presetEditor.appendChild(createPresetRow(p.label || '', p.prompt || '', i));
  });
}

function createPresetRow(label, prompt, index) {
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

  const promptInput = document.createElement('textarea');
  promptInput.className = 'preset-prompt-input';
  promptInput.placeholder = '提示词，可用 {text} 代表选中的文字';
  promptInput.value = prompt;

  row.appendChild(top);
  row.appendChild(promptInput);
  return row;
}

btnAddPreset.addEventListener('click', () => {
  presetEditor.appendChild(createPresetRow('', '', presetEditor.children.length));
});

function collectPresets() {
  const presets = [];
  presetEditor.querySelectorAll('.preset-row').forEach(row => {
    const label = row.querySelector('.preset-label-input').value.trim();
    const prompt = row.querySelector('.preset-prompt-input').value.trim();
    if (!label || !prompt) return;
    presets.push({ label, prompt });
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
