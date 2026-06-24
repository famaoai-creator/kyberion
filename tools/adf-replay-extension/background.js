const SAFE_OPERATIONS = new Set([
  'snapshot',
  'click_ref',
  'fill_ref',
  'select_ref',
  'submit_form',
  'sensitive_input_omitted',
]);
const HIGH_RISK_OPERATIONS = new Set(['submit_form']);
const STATE_KEY = 'browserBridgeState';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const state = await loadState();
  if (!state.recording || state.recording.tabId !== tabId || state.recording.pausedReason) return;
  state.recording.pausedReason = 'ページ遷移を検出しました。対象が同じ origin なら「再接続して続行」を選べます。';
  state.notice = state.recording.pausedReason;
  await saveState(state);
  await broadcastState();
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'bridge:get-state': return { state: await loadState() };
    case 'bridge:connect-active-tab': return connectActiveTab();
    case 'bridge:disconnect': return disconnect();
    case 'bridge:start-recording': return startRecording();
    case 'bridge:resume-recording': return resumeRecording();
    case 'bridge:stop-recording': return stopRecording();
    case 'bridge:discard-last-action': return discardLastAction();
    case 'bridge:review-action': return reviewAction(message.actionId, message.decision, message.reason);
    case 'bridge:finalize-review': return finalizeReview();
    case 'bridge:reject-draft': return rejectDraft();
    case 'bridge:record-event': return recordEvent(message.event, sender);
    case 'bridge:request-execution':
      throw new Error('Native Messaging bridge is not installed. An approved draft cannot be executed yet.');
    default: throw new Error('Unsupported Browser Bridge message.');
  }
}

async function connectActiveTab() {
  const tab = await activeTab();
  const origin = assertSupportedTab(tab);
  await ensureContentScript(tab.id);
  const observation = await chrome.tabs.sendMessage(tab.id, { type: 'bridge:observe' });
  const state = await loadState();
  state.connected = {
    tabId: tab.id,
    origin,
    title: String(observation?.title || tab.title || ''),
    url: String(observation?.url || tab.url || ''),
    observedAt: new Date().toISOString(),
  };
  const resumable = state.recording
    && state.recording.pausedReason
    && state.recording.tabId === tab.id
    && state.recording.origin === origin;
  state.notice = resumable
    ? '同じ origin に再接続しました。記録を続行できます。'
    : 'このタブを接続しました。ページ内の文言は外部データとして扱われます。';
  await saveState(state);
  await broadcastState();
  return { state, observation };
}

async function disconnect() {
  const state = await loadState();
  if (state.recording) throw new Error('記録中は解除できません。記録を停止して Review に送ってから解除してください。');
  state.connected = null;
  state.notice = 'タブとの接続を解除しました。';
  await saveState(state);
  await broadcastState();
  return { state };
}

async function startRecording() {
  const tab = await activeTab();
  const origin = assertSupportedTab(tab);
  let state = await loadState();
  if (state.recording) throw new Error('記録が残っています。続行または停止して Review に送ってください。');
  if (!state.connected || state.connected.tabId !== tab.id || state.connected.origin !== origin) {
    await connectActiveTab();
    state = await loadState();
  }
  await ensureContentScript(tab.id);
  const observation = await chrome.tabs.sendMessage(tab.id, { type: 'bridge:observe' });
  state.recording = {
    recordingId: `REC-${crypto.randomUUID()}`,
    tabId: tab.id,
    origin,
    title: String(observation?.title || tab.title || ''),
    startedAt: new Date().toISOString(),
    actions: [],
    sensitiveInputOmitted: 0,
    pausedReason: null,
  };
  state.lastDraft = null;
  state.notice = '記録中です。入力値は保存されません。';
  await saveState(state);
  await chrome.tabs.sendMessage(tab.id, { type: 'bridge:set-recording', enabled: true });
  await broadcastState();
  return { state };
}

async function resumeRecording() {
  const tab = await activeTab();
  const origin = assertSupportedTab(tab);
  const state = await loadState();
  const recording = state.recording;
  if (!recording?.pausedReason) throw new Error('再開できる一時停止中の記録がありません。');
  if (recording.tabId !== tab.id || recording.origin !== origin) {
    throw new Error('遷移先が異なる tab または origin です。現在の記録を停止し、新しい recording を開始してください。');
  }
  await ensureContentScript(tab.id);
  const observation = await chrome.tabs.sendMessage(tab.id, { type: 'bridge:observe' });
  recording.title = String(observation?.title || tab.title || recording.title);
  recording.pausedReason = null;
  state.connected = {
    tabId: tab.id,
    origin,
    title: recording.title,
    url: String(observation?.url || tab.url || ''),
    observedAt: new Date().toISOString(),
  };
  state.notice = '記録を続行しました。';
  await saveState(state);
  await chrome.tabs.sendMessage(tab.id, { type: 'bridge:set-recording', enabled: true });
  await broadcastState();
  return { state };
}

async function stopRecording() {
  const state = await loadState();
  const recording = state.recording;
  if (!recording) throw new Error('記録中ではありません。');
  await chrome.tabs.sendMessage(recording.tabId, { type: 'bridge:set-recording', enabled: false }).catch(() => undefined);
  if (recording.actions.length === 0) throw new Error('記録された操作がありません。');

  const highRiskCount = recording.actions.filter((action) => HIGH_RISK_OPERATIONS.has(action.op)).length;
  const draft = {
    schema_version: 'browser-recording.v1',
    recording_id: recording.recordingId,
    source: 'chrome-extension',
    created_at: recording.startedAt,
    tab: {
      origin: recording.origin,
      origin_hash: await sha256(recording.origin),
      title: recording.title,
    },
    extension: { version: chrome.runtime.getManifest().version },
    actions: recording.actions,
    risk_summary: {
      requires_manual_review: true,
      sensitive_input_omitted: recording.sensitiveInputOmitted,
      approval_required_count: highRiskCount,
    },
    review: {
      status: 'pending',
      decisions: recording.actions.map((action) => ({
        action_id: action.action_id,
        status: action.op === 'sensitive_input_omitted' ? 'rejected' : 'pending',
        ...(action.op === 'sensitive_input_omitted' ? { reason: 'Sensitive input is never replayed.' } : {}),
      })),
    },
  };
  state.lastDraft = draft;
  state.recording = null;
  state.notice = '下書きを生成しました。各操作を承認または除外してから確定してください。';
  await saveState(state);
  await broadcastState();
  return { state, draft };
}

async function discardLastAction() {
  const state = await loadState();
  if (!state.recording?.actions.length) throw new Error('破棄できる記録操作がありません。');
  const removed = state.recording.actions.pop();
  if (removed.op === 'sensitive_input_omitted') state.recording.sensitiveInputOmitted--;
  await saveState(state);
  await broadcastState();
  return { state };
}

async function reviewAction(actionId, decision, reason) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('Review decision must be approved or rejected.');
  const state = await loadState();
  const draft = state.lastDraft;
  if (!draft || draft.review.status === 'approved' || draft.review.status === 'rejected') {
    throw new Error('変更できる Review 下書きがありません。');
  }
  const action = draft.actions.find((candidate) => candidate.action_id === actionId);
  if (!action) throw new Error('対象の操作が見つかりません。');
  if (action.op === 'sensitive_input_omitted' && decision === 'approved') {
    throw new Error('秘密入力は承認できません。');
  }
  const entry = draft.review.decisions.find((candidate) => candidate.action_id === actionId);
  if (!entry) throw new Error('Review decision が壊れています。');
  entry.status = decision;
  if (reason) entry.reason = String(reason).slice(0, 500);
  else delete entry.reason;
  draft.review.status = 'in_review';
  state.notice = 'Review decision を更新しました。すべて確認したら下書きを確定してください。';
  await saveState(state);
  await broadcastState();
  return { state };
}

async function finalizeReview() {
  const state = await loadState();
  const draft = state.lastDraft;
  if (!draft || !draft.review) throw new Error('確定できる下書きがありません。');
  const actionable = draft.actions.filter((action) => action.op !== 'sensitive_input_omitted');
  const decisions = new Map(draft.review.decisions.map((entry) => [entry.action_id, entry.status]));
  if (actionable.some((action) => !decisions.has(action.action_id) || decisions.get(action.action_id) === 'pending')) {
    throw new Error('すべての操作を承認または除外してください。');
  }
  if (!actionable.some((action) => decisions.get(action.action_id) === 'approved')) {
    throw new Error('少なくとも 1 操作を承認するか、下書きを拒否してください。');
  }
  draft.review.status = 'approved';
  draft.review.reviewed_at = new Date().toISOString();
  state.notice = '下書きを確定しました。承認済み操作だけが pipeline candidate に含まれます。';
  await saveState(state);
  await broadcastState();
  return { state };
}

async function rejectDraft() {
  const state = await loadState();
  const draft = state.lastDraft;
  if (!draft?.review) throw new Error('拒否できる下書きがありません。');
  draft.review.status = 'rejected';
  draft.review.reviewed_at = new Date().toISOString();
  state.notice = '下書きを拒否しました。実行対象にはなりません。';
  await saveState(state);
  await broadcastState();
  return { state };
}

async function recordEvent(event, sender) {
  const state = await loadState();
  const recording = state.recording;
  if (!recording || sender.tab?.id !== recording.tabId) return { ignored: true };
  const senderOrigin = originOf(sender.tab.url || '');
  if (!senderOrigin || senderOrigin !== recording.origin || recording.pausedReason) return { ignored: true };
  const action = normalizeRecordedAction(event);
  if (!action) return { ignored: true };
  recording.actions.push(action);
  if (action.op === 'sensitive_input_omitted') recording.sensitiveInputOmitted++;
  await saveState(state);
  await broadcastState();
  return { state };
}

function normalizeRecordedAction(event) {
  if (!event || !SAFE_OPERATIONS.has(event.op)) return null;
  const action = {
    action_id: `step-${crypto.randomUUID()}`,
    op: event.op,
    summary: String(event.summary || '').slice(0, 500),
    risk: HIGH_RISK_OPERATIONS.has(event.op) ? 'high' : event.op === 'sensitive_input_omitted' ? 'sensitive' : event.op === 'snapshot' ? 'observe' : 'low',
    captured_at: new Date().toISOString(),
  };
  if (!action.summary) return null;
  if (event.target) {
    if (!/^@[a-zA-Z0-9_-]+$/.test(String(event.target.ref || ''))) return null;
    if (!/^[a-f0-9]{64}$/.test(String(event.target.snapshot_hash || ''))) return null;
    action.target = {
      ref: String(event.target.ref),
      role: String(event.target.role || '').slice(0, 80),
      name: String(event.target.name || '').slice(0, 500),
      snapshot_hash: String(event.target.snapshot_hash),
    };
  }
  if (event.variable) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(event.variable.name || ''))) return null;
    if (!['user_input', 'secret_ref'].includes(event.variable.classification)) return null;
    action.variable = { name: String(event.variable.name), classification: event.variable.classification };
  }
  if (event.selection) {
    if (!['option', 'toggle'].includes(event.selection.kind)) return null;
    if (event.selection.kind === 'toggle' && typeof event.selection.checked !== 'boolean') return null;
    action.selection = {
      kind: event.selection.kind,
      ...(event.selection.label ? { label: String(event.selection.label).slice(0, 500) } : {}),
      ...(typeof event.selection.checked === 'boolean' ? { checked: event.selection.checked } : {}),
    };
  }
  if (action.op === 'fill_ref' && !action.variable) return null;
  if (action.op === 'select_ref' && !action.selection) return null;
  return action;
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs[0]?.id) throw new Error('操作対象のタブを確認できません。拡張アイコンからもう一度開いてください。');
  return tabs[0];
}

function assertSupportedTab(tab) {
  const origin = originOf(tab.url || '');
  if (!origin) throw new Error('このページは対象外です。http(s) の通常タブを開いてください。');
  return origin;
}

function originOf(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'bridge:ping' });
    if (response?.ok) return;
  } catch (_) {
    // The activeTab grant permits a one-off injection into the current page.
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function loadState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] || { connected: null, recording: null, lastDraft: null, notice: null };
}

async function saveState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

async function broadcastState() {
  const state = await loadState();
  chrome.runtime.sendMessage({ type: 'bridge:state-changed', state }).catch(() => undefined);
}
