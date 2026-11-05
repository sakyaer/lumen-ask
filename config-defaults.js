// config-defaults.js —— 默认配置（可提交到 git，不含任何密钥）
//
// 敏感信息（API Key）只放在 config.local.js，该文件已被 .gitignore 忽略，不会提交。
// 本文件在 popup / options / content script / background 中都会加载。
(function (root) {
  'use strict';

  // 统一使用 DeepSeek 官方 API（OpenAI 兼容协议）
  const DEFAULTS = {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    selectionModel: 'deepseek-flash',
  };

  // 旧版本（腾讯 Token Plan 等）写入存储的模型名，识别到就整体迁移为 DeepSeek 默认值
  const LEGACY_MODEL_RE = /^(hy4-preview|hy3|tc-code-latest|glm-|minimax-|kimi-|qwen|gpt-|claude-|deepseek\/|deepseek-v4-(?:pro|flash)-20\d{4})/i;

  // 与具体模型无关、迁移时保留的个人偏好
  const PREF_KEYS = [
    'systemPrompt',
    'enableSelection',
    'panelWidth',
    'replyHeight',
    'presetPrompts',
    'tokenLimit',
    'theme',
  ];

  function isDeepSeekBase(baseUrl) {
    return /deepseek/i.test(String(baseUrl || ''));
  }

  function isLegacyModel(model) {
    return LEGACY_MODEL_RE.test(String(model || ''));
  }

  function localKey() {
    const local = root.LUMEN_LOCAL_CONFIG;
    return local && typeof local.apiKey === 'string' ? local.apiKey.trim() : '';
  }

  /**
   * 归一化 chrome.storage.sync 里的配置对象。
   *
   * - 存储为空 / 从未配置：返回 DeepSeek 默认配置 + config.local.js 里的本地 Key。
   * - 检测到旧厂商地址（腾讯 lkeap 等）或旧模型名：整体切换为 DeepSeek 默认值，
   *   只保留与模型无关的个人偏好，避免把腾讯的模型名继续发给 DeepSeek 接口。
   * - 已经是 DeepSeek 配置：沿用用户自己改过的值和 Key。
   */
  function resolveConfig(stored) {
    const s = stored && typeof stored === 'object' ? stored : {};
    const local = localKey();

    const legacy =
      (!!s.baseUrl && !isDeepSeekBase(s.baseUrl)) ||
      isLegacyModel(s.model) ||
      isLegacyModel(s.selectionModel);

    if (legacy) {
      const out = {
        ...DEFAULTS,
        apiKey: local || '',
        // DeepSeek 没有思考强度参数，清掉旧值避免发给接口
        reasoningEffort: '',
        selectionReasoningEffort: '',
      };
      for (const key of PREF_KEYS) {
        if (s[key] !== undefined) out[key] = s[key];
      }
      return out;
    }

    return {
      ...DEFAULTS,
      ...s,
      baseUrl: s.baseUrl || DEFAULTS.baseUrl,
      model: s.model || DEFAULTS.model,
      selectionModel: s.selectionModel || s.model || DEFAULTS.selectionModel,
      apiKey: s.apiKey || local,
      reasoningEffort: '',
      selectionReasoningEffort: '',
    };
  }

  const api = { DEFAULTS, resolveConfig, isDeepSeekBase, isLegacyModel };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.LumenConfig = api;
})(typeof self !== 'undefined' ? self : window);
