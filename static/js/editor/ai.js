/**
 * Project-editor AI helpers.
 *
 * The chat bridge intentionally receives only a caller-provided selection
 * together with its relative path and line range. It never reads the rest of
 * an editor document or falls back to an unscoped chat endpoint.
 */
const API_ROOT = '/api/workspace';

function editorEndpoint(context, suffix) {
  return `${API_ROOT}/${encodeURIComponent(context.workspaceId)}`
    + `/project/${encodeURIComponent(context.projectId)}/${suffix}`;
}

function lineRange(startLine, endLine) {
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
}

/** Build the exact text sent to chat: location metadata and selected code only. */
export function buildSelectionPrompt({ text, path, startLine, endLine }) {
  const selectedText = String(text || '');
  const relativePath = String(path || '');
  if (!selectedText || !relativePath || !Number.isInteger(startLine) || !Number.isInteger(endLine)) return null;
  return `Please review this selected code. Explain what it does, flag likely issues, and suggest the next safe improvement.\n\nFile: ${relativePath}\n${lineRange(startLine, endLine)}\n\n\`\`\`\n${selectedText}\n\`\`\``;
}

/**
 * Hand off a bounded selection to the normal sessions/chat UI.
 *
 * `sessions.js` documents and owns the corresponding `aster:editor-ask-agent`
 * bridge so the editor does not create sessions or send messages itself.
 */
export function askAgentAboutSelection(selection, { onAccepted = null, onError = null } = {}) {
  const prompt = buildSelectionPrompt(selection || {});
  if (!prompt || !selection?.projectId) return false;
  document.dispatchEvent(new CustomEvent('aster:editor-ask-agent', {
    detail: {
      projectId: String(selection.projectId),
      prompt,
      // Function callbacks stay entirely in-page. They make the user-visible
      // editor→chat transition explicit without expanding the project-scoped
      // prompt sent to the server.
      onAccepted,
      onError,
    },
  }));
  return true;
}

/**
 * Ask the project-scoped completion contract whether a real completion service
 * is available. A false/503 result is surfaced by the editor; no completion is
 * invented locally.
 */
export async function requestInlineCompletion(context, body, { signal } = {}) {
  if (!context?.workspaceId || !context?.projectId) {
    return { available: false, reason: 'Open a project before requesting inline completion.' };
  }
  let response;
  try {
    response = await fetch(editorEndpoint(context, 'completion'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') return { available: false, aborted: true };
    return { available: false, reason: `Completion request failed: ${error.message}` };
  }
  let payload = {};
  try { payload = await response.json(); } catch (_) { /* The status is still meaningful. */ }
  if (!response.ok || !payload.available) {
    return {
      available: false,
      reason: payload.reason || payload.detail || `Inline completion is unavailable (${response.status}).`,
      status: response.status,
    };
  }
  return { available: true, completion: typeof payload.completion === 'string' ? payload.completion : '' };
}

// Compatibility exports for callers from the old textarea-based editor. They
// intentionally do not resurrect the previous unscoped `/api/copilot` path.
export const askAgent = askAgentAboutSelection;
export function copilotEnabled() { return false; }
export function setCopilotEnabled() {}
export async function triggerCompletion() {
  return { available: false, reason: 'Use the project-scoped completion action in the code editor.' };
}
export function acceptGhost() { return false; }
export function dismissGhost() { return false; }
export async function goToReferences() {
  return [];
}

export default {
  askAgent,
  askAgentAboutSelection,
  buildSelectionPrompt,
  requestInlineCompletion,
  triggerCompletion,
  acceptGhost,
  dismissGhost,
  goToReferences,
  copilotEnabled,
  setCopilotEnabled,
};
