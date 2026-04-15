// options.js - Options page logic

document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    defaultTargetLang: document.getElementById('defaultTargetLang'),
    defaultMode: document.getElementById('defaultMode'),
    intentMode: document.getElementById('intentMode'),
    contextHistoryLimit: document.getElementById('contextHistoryLimit'),
    autoTranslate: document.getElementById('autoTranslate'),
    manualTriggerSection: document.getElementById('manualTriggerSection'),
    showTriggerIcon: document.getElementById('showTriggerIcon'),
    shortcutBtn: document.getElementById('shortcutBtn'),
    shortcutDisplay: document.getElementById('shortcutDisplay'),
    shortcutHint: document.getElementById('shortcutHint'),
    showContextMenu: document.getElementById('showContextMenu'),
    minSelectionLength: document.getElementById('minSelectionLength'),
    maxSelectionLength: document.getElementById('maxSelectionLength'),
    bubblePosition: document.getElementById('bubblePosition'),
    showCopyButton: document.getElementById('showCopyButton'),
    llmEndpoint: document.getElementById('llmEndpoint'),
    llmApiKey: document.getElementById('llmApiKey'),
    toggleKeyBtn: document.getElementById('toggleKeyBtn'),
    llmModel: document.getElementById('llmModel'),
    testLlmBtn: document.getElementById('testLlmBtn'),
    llmTestResult: document.getElementById('llmTestResult'),
    userProfile: document.getElementById('userProfile'),
    customPromptAgentMeaning: document.getElementById('customPromptAgentMeaning'),
    customPromptAgentGrammar: document.getElementById('customPromptAgentGrammar'),
    customPromptDeep: document.getElementById('customPromptDeep'),
    resetPromptsBtn: document.getElementById('resetPromptsBtn'),
    openStatsBtn: document.getElementById('openStatsBtn'),
    ttsRate: document.getElementById('ttsRate'),
    ttsRateValue: document.getElementById('ttsRateValue'),
    ttsVoice: document.getElementById('ttsVoice'),
    ttsPreviewBtn: document.getElementById('ttsPreviewBtn'),
    saveBtn: document.getElementById('saveBtn'),
    resetBtn: document.getElementById('resetBtn'),
    statusMsg: document.getElementById('statusMsg'),
  };

  const DEFAULTS = {
    defaultTargetLang: 'zh',
    defaultMode: 'agent',
    intentMode: 'auto',
    contextHistoryLimit: 5,
    autoTranslate: true,
    showTriggerIcon: true,
    customShortcut: 'Alt+Shift+T',
    showContextMenu: true,
    minSelectionLength: 1,
    maxSelectionLength: 1000,
    bubblePosition: 'below',
    showCopyButton: true,
    llmEndpoint: 'https://api.openai.com/v1',
    llmApiKey: '',
    llmModel: 'gpt-4o-mini',
    userProfile: '',
    ttsRate: 1,
    ttsVoice: '',
  };

  loadSettings();
  loadVoices();

  elements.openStatsBtn.addEventListener('click', () => {
    window.open(chrome.runtime.getURL('stats/stats.html'), '_blank');
  });

  // ─── Event listeners ───
  elements.saveBtn.addEventListener('click', saveSettings);
  elements.resetBtn.addEventListener('click', resetToDefaults);

  elements.autoTranslate.addEventListener('change', () => {
    elements.manualTriggerSection.style.display = elements.autoTranslate.checked ? 'none' : 'block';
  });

  elements.toggleKeyBtn.addEventListener('click', () => {
    const input = elements.llmApiKey;
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    elements.toggleKeyBtn.textContent = isPassword ? 'Hide' : 'Show';
  });

  elements.testLlmBtn.addEventListener('click', testLLM);

  elements.resetPromptsBtn.addEventListener('click', () => {
    elements.customPromptAgentMeaning.value = '';
    elements.customPromptAgentGrammar.value = '';
    elements.customPromptDeep.value = '';
    chrome.storage.local.remove(['customPrompt_agent_meaning', 'customPrompt_agent_grammar', 'customPrompt_deep']);
    showStatus('Prompts reset to defaults', 'success');
  });

  elements.ttsRate.addEventListener('input', () => {
    elements.ttsRateValue.textContent = parseFloat(elements.ttsRate.value).toFixed(1);
  });

  elements.ttsPreviewBtn.addEventListener('click', () => {
    const utterance = new SpeechSynthesisUtterance('Hello, this is a preview of the text-to-speech feature.');
    utterance.lang = 'en-US';
    utterance.rate = parseFloat(elements.ttsRate.value);
    const voiceName = elements.ttsVoice.value;
    if (voiceName) {
      const voice = speechSynthesis.getVoices().find(v => v.name === voiceName);
      if (voice) utterance.voice = voice;
    }
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  });

  // ─── Shortcut key recorder ───
  let _isRecording = false;
  elements.shortcutBtn.addEventListener('click', startRecordingShortcut);

  function startRecordingShortcut() {
    _isRecording = true;
    elements.shortcutBtn.classList.add('recording');
    elements.shortcutDisplay.textContent = '...';
    elements.shortcutHint.textContent = 'Press your key combination now';

    const onKey = (e) => {
      e.preventDefault();
      e.stopPropagation();

      const parts = [];
      if (e.ctrlKey || e.metaKey) parts.push(e.metaKey ? 'Cmd' : 'Ctrl');
      if (e.altKey) parts.push('Alt');
      if (e.shiftKey) parts.push('Shift');

      if (!e.key || ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;

      let keyName = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      if (keyName === ' ') keyName = 'Space';
      parts.push(keyName);

      const shortcutStr = parts.join('+');
      stopRecording(shortcutStr);
    };

    document.addEventListener('keydown', onKey, true);
    document.addEventListener('blur', () => stopRecording(null), { once: true });

    function stopRecording(result) {
      _isRecording = false;
      document.removeEventListener('keydown', onKey, true);

      if (result) {
        elements.customShortcut = result;
        elements.shortcutDisplay.textContent = result;
        chrome.storage.local.set({ customShortcut: result });
        showStatus(`Shortcut set: ${result}`, 'success');
      } else if (!elements.customShortcut) {
        elements.shortcutDisplay.textContent = DEFAULTS.customShortcut;
      }

      elements.shortcutBtn.classList.remove('recording');
      elements.shortcutHint.textContent = 'Click to change shortcut';
    }
  }

  // ─── TTS voices ───
  function loadVoices() {
    const populate = () => {
      const voices = speechSynthesis.getVoices();
      elements.ttsVoice.innerHTML = '<option value="">Default</option>';
      voices.forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        elements.ttsVoice.appendChild(opt);
      });
      // Restore saved selection
      chrome.storage.local.get(['ttsVoice'], r => {
        if (r.ttsVoice) elements.ttsVoice.value = r.ttsVoice;
      });
    };
    populate();
    if (speechSynthesis.onvoiceschanged !== undefined) {
      speechSynthesis.onvoiceschanged = populate;
    }
  }

  // ─── LLM test ───
  async function testLLM() {
    const endpoint = elements.llmEndpoint.value.trim();
    const apiKey = elements.llmApiKey.value.trim();
    const model = elements.llmModel.value.trim();

    if (!apiKey || !model) {
      elements.llmTestResult.className = 'llm-test-result error';
      elements.llmTestResult.textContent = 'API Key and Model are required.';
      return;
    }

    elements.testLlmBtn.disabled = true;
    elements.testLlmBtn.textContent = 'Testing...';
    elements.llmTestResult.className = 'llm-test-result loading';
    elements.llmTestResult.textContent = 'Connecting to LLM...';

    try {
      const response = await sendMessageToBackground({
        type: 'TEST_LLM',
        settings: { llmEndpoint: endpoint, llmApiKey: apiKey, llmModel: model },
      });

      if (response.success) {
        elements.llmTestResult.className = 'llm-test-result success';
        elements.llmTestResult.textContent = `Connected! Response: "${response.data?.trim() || 'OK'}"`;
      } else {
        elements.llmTestResult.className = 'llm-test-result error';
        elements.llmTestResult.textContent = `Failed: ${response.error || 'Unknown error'}`;
      }
    } catch (e) {
      elements.llmTestResult.className = 'llm-test-result error';
      elements.llmTestResult.textContent = `Error: ${e.message}`;
    } finally {
      elements.testLlmBtn.disabled = false;
      elements.testLlmBtn.textContent = 'Test Connection';
    }
  }

  // ─── Load settings ───
  function loadSettings() {
    chrome.storage.local.get(Object.keys(DEFAULTS), (result) => {
      elements.defaultTargetLang.value = result.defaultTargetLang || DEFAULTS.defaultTargetLang;
      elements.defaultMode.value = result.defaultMode || DEFAULTS.defaultMode;
      elements.intentMode.value = result.intentMode || DEFAULTS.intentMode;
      elements.contextHistoryLimit.value = result.contextHistoryLimit || DEFAULTS.contextHistoryLimit;
      elements.autoTranslate.checked = result.autoTranslate !== undefined ? result.autoTranslate : DEFAULTS.autoTranslate;
      elements.showTriggerIcon.checked = result.showTriggerIcon !== undefined ? result.showTriggerIcon : DEFAULTS.showTriggerIcon;
      const savedShortcut = result.customShortcut || DEFAULTS.customShortcut;
      elements.shortcutDisplay.textContent = savedShortcut;
      elements.customShortcut = savedShortcut;
      elements.showContextMenu.checked = result.showContextMenu !== undefined ? result.showContextMenu : DEFAULTS.showContextMenu;
      elements.minSelectionLength.value = result.minSelectionLength || DEFAULTS.minSelectionLength;
      elements.maxSelectionLength.value = result.maxSelectionLength || DEFAULTS.maxSelectionLength;
      elements.bubblePosition.value = result.bubblePosition || DEFAULTS.bubblePosition;
      elements.showCopyButton.checked = result.showCopyButton !== undefined ? result.showCopyButton : DEFAULTS.showCopyButton;
      elements.llmEndpoint.value = result.llmEndpoint || DEFAULTS.llmEndpoint;
      elements.llmApiKey.value = result.llmApiKey || DEFAULTS.llmApiKey;
      elements.llmModel.value = result.llmModel || DEFAULTS.llmModel;
      elements.userProfile.value = result.userProfile || DEFAULTS.userProfile;
      elements.customPromptAgentMeaning.value = result.customPrompt_agent_meaning || '';
      elements.customPromptAgentGrammar.value = result.customPrompt_agent_grammar || '';
      elements.customPromptDeep.value = result.customPrompt_deep || '';
      elements.ttsRate.value = result.ttsRate || DEFAULTS.ttsRate;
      elements.ttsRateValue.textContent = parseFloat(elements.ttsRate.value).toFixed(1);

      // Toggle manual trigger section
      elements.manualTriggerSection.style.display =
        elements.autoTranslate.checked ? 'none' : 'block';
    });
  }

  // ─── Save settings ───
  function saveSettings() {
    const settings = {
      defaultTargetLang: elements.defaultTargetLang.value,
      defaultMode: elements.defaultMode.value,
      intentMode: elements.intentMode.value,
      contextHistoryLimit: parseInt(elements.contextHistoryLimit.value) || DEFAULTS.contextHistoryLimit,
      autoTranslate: elements.autoTranslate.checked,
      showTriggerIcon: elements.showTriggerIcon.checked,
      customShortcut: elements.customShortcut || DEFAULTS.customShortcut,
      showContextMenu: elements.showContextMenu.checked,
      minSelectionLength: parseInt(elements.minSelectionLength.value) || DEFAULTS.minSelectionLength,
      maxSelectionLength: parseInt(elements.maxSelectionLength.value) || DEFAULTS.maxSelectionLength,
      bubblePosition: elements.bubblePosition.value,
      showCopyButton: elements.showCopyButton.checked,
      llmEndpoint: elements.llmEndpoint.value.trim(),
      llmApiKey: elements.llmApiKey.value.trim(),
      llmModel: elements.llmModel.value.trim(),
      userProfile: elements.userProfile.value.trim(),
      customPrompt_agent_meaning: elements.customPromptAgentMeaning.value.trim(),
      customPrompt_agent_grammar: elements.customPromptAgentGrammar.value.trim(),
      customPrompt_deep: elements.customPromptDeep.value.trim(),
      ttsRate: parseFloat(elements.ttsRate.value) || DEFAULTS.ttsRate,
      ttsVoice: elements.ttsVoice.value,
    };

    chrome.storage.local.set(settings, () => {
      showStatus('Settings saved!', 'success');
      chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', settings }, () => {
        void chrome.runtime.lastError;
      });
    });
  }

  // ─── Reset ───
  function resetToDefaults() {
    if (!confirm('Reset all settings to defaults?')) return;

    chrome.storage.local.clear(() => {
      Object.keys(DEFAULTS).forEach(key => {
        const el = elements[key];
        if (!el) return;
        if (typeof DEFAULTS[key] === 'boolean') {
          el.checked = DEFAULTS[key];
        } else {
          el.value = DEFAULTS[key];
        }
      });
      elements.ttsRateValue.textContent = '1.0';
      elements.manualTriggerSection.style.display =
        elements.autoTranslate.checked ? 'none' : 'block';
      showStatus('Settings reset to defaults', 'success');
    });
  }

  // ─── Helpers ───
  function showStatus(message, type) {
    elements.statusMsg.textContent = message;
    elements.statusMsg.className = `status-msg show ${type}`;
    setTimeout(() => elements.statusMsg.classList.remove('show'), 2500);
  }

  function sendMessageToBackground(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }
});
