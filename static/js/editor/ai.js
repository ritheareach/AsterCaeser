// AI integration — Ask agent, copilot, go-to-reference.
import uiModule from '../ui.js';

let _copilotEnabled = true;
let _ghostText = '';
let _ghostDecoration = null;
let _completionTimeout = null;

export function askAgent(selectedText, filePath, language) {
  const chatInput = document.querySelector('#message');
  if (!chatInput) return uiModule.showToast?.('Chat input not found');
  const context = `**File:** \`${filePath}\`\`\`${language}\n${selectedText}\n\`\`\`\n\nAnalyze this code:`;
  chatInput.value = context;
  chatInput.dispatchEvent(new Event('input'));
  chatInput.focus();
  // Submit automatically if configured
  const sendBtn = document.querySelector('#send-btn, #voice-send-btn');
  if (sendBtn && !sendBtn.disabled) setTimeout(() => sendBtn.click(), 300);
}

export function copilotEnabled() { return _copilotEnabled; }
export function setCopilotEnabled(v) { _copilotEnabled = v; }

export function triggerCompletion(textarea, before, after, lang) {
  if (!_copilotEnabled) return;
  if (_completionTimeout) clearTimeout(_completionTimeout);
  _completionTimeout = setTimeout(async () => {
    try {
      const res = await fetch('/api/copilot/complete', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ before, after, language: lang }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.completion) {
        _showGhost(textarea, data.completion);
      }
    } catch (e) { /* silently fail */ }
  }, 500);
}

function _showGhost(textarea, text) {
  _ghostText = text;
  const start = textarea.selectionStart;
  const before = textarea.value.substring(0, start);
  const after = textarea.value.substring(start);
  textarea.value = before + text + after;
  textarea.setSelectionRange(start, start + text.length);
  textarea.focus();
}

export function acceptGhost(textarea) {
  if (!_ghostText) return false;
  _ghostText = '';
  return true;
}

export function dismissGhost(textarea) {
  if (!_ghostText) return false;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  if (start !== end) {
    textarea.value = textarea.value.substring(0, start) + textarea.value.substring(end);
    textarea.setSelectionRange(start, start);
  }
  _ghostText = '';
  return true;
}

export async function goToReferences(word, projectId, callback) {
  if (!word || !projectId) return;
  try {
    const res = await fetch(`/api/workspace/${projectId}/files/grep`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: word, max_results: 50 }),
    });
    const data = await res.json();
    if (callback) callback(data.results || []);
  } catch (e) {
    uiModule.showError?.(`Reference search failed: ${e.message}`);
  }
}

export default { askAgent, triggerCompletion, acceptGhost, dismissGhost, goToReferences, copilotEnabled, setCopilotEnabled };
