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
const NATIVE_HOST = 'com.kyberion.browser_bridge';

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) await chrome.sidePanel.open({ windowId: tab.windowId });
});

// Serialize every read-modify-write of the persisted state. Without this, the
// burst of DOM events from a single interaction (input + change + click + submit)
// runs through loadState→push→saveState concurrently and the last write clobbers
// the others — leaving only one recorded step.
let stateLock = Promise.resolve();
function withStateLock(fn) {
  const next = stateLock.then(fn, fn);
  stateLock = next.then(() => undefined, () => undefined);
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  withStateLock(() => handleMessage(message, sender))
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  withStateLock(() => handleTabUpdate(tabId, changeInfo, tab)).catch(() => undefined),
);

async function handleTabUpdate(tabId, changeInfo, tab) {
  if (changeInfo.status === 'loading') {
    const state = await loadState();
    if (!state.recording || state.recording.tabId !== tabId || state.recording.pausedReason) return;
    state.recording.pausedReason = 'ページ遷移を検出しました。自動で続行します（別サイトへの遷移は handoff として記録します）。';
    state.notice = state.recording.pausedReason;
    await saveState(state);
    await broadcastState();
    return;
  }
  if (changeInfo.status === 'complete') {
    await maybeAutoResume(tabId, tab);
  }
}

// Resume recording after a navigation without a manual reconnect. Same-origin
// navigations continue transparently; cross-origin navigations are recorded as a
// `navigate` handoff marker and the recording continues on the new origin as a
// new segment (segmented recording). Requires granted host access.
async function maybeAutoResume(tabId, tab) {
  const state = await loadState();
  const recording = state.recording;
  if (!recording || recording.tabId !== tabId || !recording.pausedReason) return;
  const origin = originOf(tab?.url || '');
  if (!origin) return;
  if (!(await hasHostAccess())) return;
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'bridge:set-recording', enabled: true });
  } catch (_) {
    return;
  }

  const crossOrigin = origin !== recording.origin;
  if (crossOrigin) {
    // Capture the origin transition so the cross-origin flow stays one recording.
    const fromOrigin = recording.origin;
    recording.actions.push({
      action_id: `step-${crypto.randomUUID()}`,
      op: 'navigate',
      summary: `${hostLabel(fromOrigin)} → ${hostLabel(origin)} に移動`,
      risk: 'observe',
      captured_at: new Date().toISOString(),
      navigation: { from_origin: fromOrigin, to_origin: origin },
    });
    recording.origins = Array.from(new Set([...(recording.origins || [fromOrigin]), origin]));
    recording.origin = origin; // current segment origin
  }

  recording.pausedReason = null;
  recording.title = String(tab?.title || recording.title);
  state.connected = {
    tabId,
    origin,
    title: recording.title,
    url: String(tab?.url || ''),
    observedAt: new Date().toISOString(),
  };
  state.notice = crossOrigin
    ? `別サイト（${hostLabel(origin)}）への遷移を handoff として記録し、記録を継続しました。`
    : '同一 origin のページ遷移を検出し、記録を自動再開しました。';
  await saveState(state);
  await broadcastState();
}

/** Short host label for notices/summaries, e.g. "https://news.yahoo.co.jp" → "news.yahoo.co.jp". */
function hostLabel(origin) {
  return String(origin || '').replace(/^https?:\/\//, '');
}

async function hasHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
  } catch {
    return false;
  }
}

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
    case 'bridge:preflight-draft': return preflightDraft();
    case 'bridge:request-execution': return requestExecution(message.values || {});
    case 'bridge:resolve-intent': return resolveIntent(message.intent, message.origin);
    case 'bridge:report-mfa-challenge': return handleMfaChallenge(message.lease, message.recording, message.session);
    case 'bridge:prepare-procedure': return prepareProcedure(message.procedureId, message.origin);
    case 'bridge:execute-procedure': return executeProcedure(message.procedureId, message.origin, message.values || {});
    case 'bridge:execution-interrupted': return handleExecutionInterrupted(message.reason, message.detail);
    case 'bridge:apply-repair': return applyRepair(message.procedureId);
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
    origins: [origin], // all origins touched (segmented recording); origins[0] = initial
    title: String(observation?.title || tab.title || ''),
    startedAt: new Date().toISOString(),
    actions: [],
    sensitiveInputOmitted: 0,
    pausedReason: null,
  };
  state.lastDraft = null;
  state.execution = null;
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
  // tab.origin is the INITIAL origin (origins[0]); after cross-origin handoffs
  // recording.origin holds the current segment. navigate actions carry the rest.
  const initialOrigin = recording.origins?.[0] || recording.origin;
  const draft = {
    schema_version: 'browser-recording.v1',
    recording_id: recording.recordingId,
    source: 'chrome-extension',
    created_at: recording.startedAt,
    tab: {
      origin: initialOrigin,
      origin_hash: await sha256(initialOrigin),
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
  state.execution = null;
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

function approvedActionableActions(draft) {
  const decisions = new Map((draft.review?.decisions || []).map((entry) => [entry.action_id, entry.status]));
  return draft.actions.filter((action) => action.op !== 'sensitive_input_omitted' && decisions.get(action.action_id) === 'approved');
}

function buildSessionRequest(draft, mode, tabId) {
  return {
    kind: 'browser-extension-session.v1',
    mission_id: `MSN-EXT-${draft.recording_id}`,
    pipeline_id: `browser-extension-${draft.recording_id}`,
    tab_id: String(tabId),
    origin: draft.tab.origin,
    mode,
    recording_id: draft.recording_id,
    requested_operations: [...new Set(approvedActionableActions(draft).map((action) => action.op))],
  };
}

function nativeHostError(message) {
  if (/not found|forbidden|Access to the specified native messaging host/i.test(message || '')) {
    return [
      'Native Messaging host (com.kyberion.browser_bridge) が見つかりません。',
      'Register it with: tools/adf-replay-extension/native-host/install.sh <CHROME_EXTENSION_ID>',
      'Copy the extension ID from chrome://extensions after loading the unpacked extension for that machine.',
    ].join(' ');
  }
  return message || 'Native Bridge との通信に失敗しました。';
}

function callNativeHost(payload) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) return reject(new Error(nativeHostError(lastError.message)));
        resolve(response);
      });
    } catch (error) {
      reject(new Error(nativeHostError(error instanceof Error ? error.message : String(error))));
    }
  });
}

async function actionHash(action) {
  return sha256(JSON.stringify({
    action_id: action.action_id,
    op: action.op,
    target: action.target,
    variable: action.variable,
    selection: action.selection,
  }));
}

async function preflightDraft() {
  const state = await loadState();
  const draft = state.lastDraft;
  if (draft?.review?.status !== 'approved') throw new Error('承認済みの下書きがありません。');
  const tabId = state.connected?.tabId ?? 0;
  const response = await callNativeHost({ type: 'preflight', recording: draft, session: buildSessionRequest(draft, 'record', tabId) });
  if (!response?.ok) throw new Error((response?.errors || []).join('; ') || response?.error || 'preflight に失敗しました。');
  state.execution = { status: 'preflighted', preflight: response };
  state.notice = `Kyberion preflight: ${response.status}${response.approval_required ? '（承認が必要です）' : ''}`;
  await saveState(state);
  await broadcastState();
  return { state, preflight: response };
}

function buildReceipt(session, lease, status, results) {
  const done = results.filter((entry) => entry.status === 'done').length;
  return {
    kind: 'browser-extension-receipt.v1',
    receipt_id: `RCP-${crypto.randomUUID()}`,
    mission_id: session.mission_id,
    pipeline_id: session.pipeline_id,
    recording_id: session.recording_id,
    tab_id: session.tab_id,
    origin: session.origin,
    status,
    lease_id: lease.lease_id,
    summary: `${done}/${results.length} 操作を実行しました（${status}）`,
    created_at: new Date().toISOString(),
  };
}

async function requestExecution(values) {
  let state = await loadState();
  const draft = state.lastDraft;
  if (draft?.review?.status !== 'approved') throw new Error('承認済みの下書きがありません。');
  if (!state.connected) throw new Error('実行対象のタブが接続されていません。');
  if (state.connected.origin !== draft.tab.origin) {
    throw new Error('接続中のタブの origin が記録と異なります。同じ origin に再接続してください。');
  }

  const session = buildSessionRequest(draft, 'execute', state.connected.tabId);
  const response = await callNativeHost({ type: 'request_execution', recording: draft, session });
  if (!response?.ok) throw new Error(response?.error || 'Native Bridge がリクエストを拒否しました。');

  if (response.status === 'approval_required') {
    state.execution = { status: 'approval_required', requestId: response.request_id || null, session };
    state.notice = `高リスク操作の承認待ちです（${response.request_id || '承認要求を作成しました'}）。Kyberion で承認後にもう一度実行してください。`;
    await saveState(state);
    await broadcastState();
    return { state, status: 'approval_required' };
  }
  if (response.status !== 'authorized' || !response.lease) {
    throw new Error('実行リースを取得できませんでした。');
  }
  return runApprovedExecution(draft, session, response.lease, values);
}

async function runApprovedExecution(draft, session, lease, values) {
  const steps = approvedActionableActions(draft);
  const tabId = session.tab_id;
  const connectedTabId = (await loadState()).connected?.tabId;
  await ensureContentScript(connectedTabId);

  const results = [];
  let finalStatus = 'completed';
  for (const step of steps) {
    if (HIGH_RISK_OPERATIONS.has(step.op)) {
      const hash = await actionHash(step);
      if (!lease.approved_step_hashes.includes(hash)) {
        results.push({ action_id: step.action_id, op: step.op, status: 'blocked', detail: 'lease に承認ハッシュがありません' });
        finalStatus = 'blocked';
        break;
      }
    }
    let outcome;
    try {
      outcome = await chrome.tabs.sendMessage(connectedTabId, {
        type: 'bridge:execute-step',
        step,
        value: step.op === 'fill_ref' ? (values[step.variable?.name] ?? null) : null,
      });
    } catch (error) {
      outcome = { status: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
    results.push({ action_id: step.action_id, op: step.op, status: outcome?.status || 'error', detail: outcome?.detail });

    const progress = await loadState();
    progress.execution = { status: 'running', lease, total: steps.length, completed: results.length, results, session };
    await saveState(progress);
    await broadcastState();

    if (outcome?.status !== 'done' && outcome?.status !== 'skipped') {
      finalStatus = outcome?.status === 'ambiguous' || outcome?.status === 'not_found' ? 'cancelled' : 'failed';
      break;
    }
  }

  const receipt = buildReceipt(session, lease, finalStatus, results);
  let receiptAck = null;
  try {
    receiptAck = await callNativeHost({ type: 'submit_receipt', receipt });
  } catch (error) {
    receiptAck = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const done = await loadState();
  done.execution = { status: finalStatus, lease, total: steps.length, completed: results.length, results, receipt, receiptAck, session };
  done.notice = `実行 ${finalStatus}: ${results.filter((entry) => entry.status === 'done').length}/${steps.length} 操作。receipt ${receipt.receipt_id} を生成しました。`;
  await saveState(done);
  await broadcastState();
  return { state: done, status: finalStatus, receipt };
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
    // No content script yet — inject below (needs host access or an activeTab grant).
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (_) {
    throw new Error('このページにアクセスできません。Side Panel の「このタブを接続」でサイトへのアクセスを許可してください。許可後はページ遷移や再接続でも継続できます。');
  }
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

// ---------------------------------------------------------------------------
// Intent resolution (Layer②)
// ---------------------------------------------------------------------------

async function resolveIntent(intent, origin) {
  if (typeof intent !== 'string' || !intent.trim()) throw new Error('intent が空です。');
  const effectiveOrigin = origin || (await loadState()).connected?.origin;
  const response = await callNativeHost({ type: 'resolve_intent', intent: intent.trim(), origin: effectiveOrigin });
  if (!response?.ok) throw new Error(response?.error || 'intent 解決に失敗しました。');
  const state = await loadState();
  state.intentResolution = {
    intent: intent.trim(),
    outcome: response.resolution?.outcome,
    best: response.resolution?.best || null,
    candidates: response.resolution?.candidates || [],
    recommendedPattern: response.resolution?.recommendedPattern,
    resolvedAt: new Date().toISOString(),
  };
  state.notice = formatResolutionNotice(response.resolution);
  await saveState(state);
  await broadcastState();
  return { state, resolution: response.resolution };
}

function formatResolutionNotice(resolution) {
  if (!resolution) return 'intent 解決の結果を取得できませんでした。';
  if (resolution.outcome === 'matched' && resolution.best) {
    const pct = Math.round((resolution.best.confidence || 0) * 100);
    return `手順が見つかりました: "${resolution.best.procedure_id}" (信頼度 ${pct}%) → Pattern B 実行可能`;
  }
  if (resolution.outcome === 'ambiguous') return `複数の候補が見つかりました。候補を選択してください。`;
  return '一致する手順がありません。Pattern A: 新しい操作を記録してください。';
}

// ---------------------------------------------------------------------------
// MFA self-repair (Layer③/④)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pattern B — procedure catalog execution (Layer①→③)
// ---------------------------------------------------------------------------

// #1: report the user inputs a procedure needs (no side effects) so the side
// panel can render fields before execution.
async function prepareProcedure(procedureId, origin) {
  if (!procedureId) throw new Error('procedureId が必要です。');
  const response = await callNativeHost({ type: 'prepare_procedure', procedure_id: procedureId });
  if (!response?.ok) throw new Error(response?.error || '手順の準備に失敗しました。');
  const state = await loadState();
  state.pendingProcedure = {
    procedureId,
    origin: origin || state.connected?.origin || null,
    inputs: response.inputs || [],
  };
  state.notice = response.has_inputs
    ? '実行前に入力値を指定してください（値は保存されません）。'
    : 'この手順は入力不要です。実行できます。';
  await saveState(state);
  await broadcastState();
  return { state, inputs: response.inputs || [], hasInputs: Boolean(response.has_inputs) };
}

async function executeProcedure(procedureId, origin, values = {}) {
  if (!procedureId) throw new Error('procedureId が必要です。');
  const state = await loadState();
  if (!state.connected) throw new Error('実行対象のタブが接続されていません。');
  const effectiveOrigin = origin || state.connected.origin;

  const response = await callNativeHost({
    type: 'dispatch_procedure',
    procedure_id: procedureId,
    origin: effectiveOrigin,
    tab_id: String(state.connected.tabId),
  });
  if (!response?.ok) throw new Error(response?.error || '手順の配信に失敗しました。');

  if (response.status === 'approval_required') {
    state.execution = { status: 'approval_required', requestId: response.request_id || null, procedureId };
    state.notice = `手順の実行承認待ちです（${response.request_id || 'approval_required'}）。Kyberion で承認後にもう一度実行してください。`;
    await saveState(state);
    await broadcastState();
    return { state, status: 'approval_required' };
  }

  if (response.status === 'dispatched_segmented' && Array.isArray(response.segments)) {
    const out = await runSegmentedExecution(procedureId, response.segments, response.session, values);
    await verifyGoldenScenario(procedureId, response.golden_scenario, out.status);
    return out;
  }

  if (response.status !== 'dispatched' || !response.lease) {
    throw new Error('実行リースを取得できませんでした。');
  }

  const out = await runCompiledSteps(procedureId, response.compiled_steps || [], response.session, response.lease, values);
  await verifyGoldenScenario(procedureId, response.golden_scenario, out.status);
  return out;
}

// #3: after execution, verify the golden scenario's success conditions against
// the live page (content script). Records the verdict on the execution state.
async function verifyGoldenScenario(procedureId, golden, runStatus) {
  if (!golden || !Array.isArray(golden.success_conditions) || golden.success_conditions.length === 0) return;
  if (runStatus !== 'completed') return; // only verify a run that actually finished
  const connectedTabId = (await loadState()).connected?.tabId;
  if (!connectedTabId) return;
  let verdict;
  try {
    verdict = await chrome.tabs.sendMessage(connectedTabId, {
      type: 'bridge:verify-golden',
      conditions: golden.success_conditions,
    });
  } catch (error) {
    verdict = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const passed = Boolean(verdict?.ok) && (verdict.results || []).every((r) => r.pass);
  const state = await loadState();
  if (state.execution) {
    state.execution.golden = {
      scenario_id: golden.scenario_id,
      passed,
      results: verdict?.results || [],
    };
    if (!passed) state.execution.status = 'verification_failed';
  }
  state.notice = passed
    ? `手順「${procedureId}」を実行し、成功条件 ${golden.success_conditions.length} 件を満たしました。`
    : `手順「${procedureId}」は実行しましたが、成功条件の検証に失敗しました。結果を確認してください。`;
  await saveState(state);
  await broadcastState();
}

// #2 (loop closure): apply the corrective recording (the just-finalized draft)
// to the failed procedure as a delta, then merge + persist for re-promotion.
async function applyRepair(procedureId) {
  const state = await loadState();
  const repair = state.repairPending;
  const draft = state.lastDraft;
  if (!repair || repair.procedure_id !== procedureId) throw new Error('対象の修復対象が見つかりません。');
  if (draft?.review?.status !== 'approved') throw new Error('承認済みの修正記録がありません。先に Review を確定してください。');

  // 1. Persist the corrective recording into the allowlisted store.
  const saved = await callNativeHost({ type: 'save_recording', recording: draft });
  if (!saved?.ok) throw new Error(saved?.error || '修正記録の保存に失敗しました。');

  // 2. Create + save a ProcedureDelta anchored at the failed step.
  const deltaResp = await callNativeHost({
    type: 'save_procedure_delta',
    procedure_id: procedureId,
    anchor_step_index: repair.anchor_step_index,
    error: repair.reason,
    delta_recording_ref: saved.recording_ref,
  });
  if (!deltaResp?.ok || !deltaResp.delta_path) throw new Error(deltaResp?.error || 'デルタの保存に失敗しました。');

  // 3. Merge the delta into the base recording (re-promotion stays human-gated).
  const applied = await callNativeHost({ type: 'apply_procedure_delta', procedure_id: procedureId, delta_path: deltaResp.delta_path });
  if (!applied?.ok) throw new Error(applied?.error || 'デルタの適用に失敗しました。');

  state.repairPending = null;
  state.lastDraft = null;
  state.notice = `修正をマージしました（${applied.merged_recording_ref}）。レビュー後に promote_procedure で再昇格してください。`;
  await saveState(state);
  await broadcastState();
  return { state, merged_recording_ref: applied.merged_recording_ref };
}

// Poll until the connected tab's origin matches `expectedOrigin` (a cross-origin
// handoff completing), or time out. Returns the live origin reached.
async function waitForOrigin(tabId, expectedOrigin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { tab = null; }
    const current = originOf(tab?.url || '');
    if (current === expectedOrigin) return current;
    await new Promise((r) => setTimeout(r, 250));
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return originOf(tab?.url || '');
}

// Multi-origin (segmented) execution: run each origin segment under its own
// origin-bound lease, waiting for the cross-origin navigation between segments.
async function runSegmentedExecution(procedureId, segments, session, values) {
  let last = { status: 'completed' };
  for (const segment of segments) {
    const connectedTabId = (await loadState()).connected?.tabId;
    if (!connectedTabId) throw new Error('実行対象のタブが接続されていません。');

    // Segment 0 should already be on its origin; later segments require the
    // preceding segment's navigation to have landed on this origin.
    if (segment.segment_index > 0) {
      const reached = await waitForOrigin(connectedTabId, segment.origin);
      if (reached !== segment.origin) {
        const s = await loadState();
        s.execution = { status: 'failed', procedureId, total: segments.length, completed: segment.segment_index, session };
        s.notice = `セグメント ${segment.segment_index + 1} の遷移先 ${segment.origin} に到達できませんでした（現在: ${reached || '不明'}）。`;
        await saveState(s);
        await broadcastState();
        return { state: s, status: 'failed' };
      }
    }

    // Bind the segment's lease to its origin: refuse to act if the live tab
    // origin disagrees with the lease's origin.
    if (segment.lease?.origin && segment.lease.origin !== segment.origin) {
      throw new Error(`セグメント ${segment.segment_index} のリース origin が不一致です。`);
    }

    const segSession = { ...session, origin: segment.origin };
    last = await runCompiledSteps(procedureId, segment.steps || [], segSession, segment.lease, values, {
      segmentIndex: segment.segment_index,
      segmentCount: segments.length,
    });
    if (last.status !== 'completed') return last; // stop the chain on any segment failure
  }
  return last;
}

async function runCompiledSteps(procedureId, steps, session, lease, values, segmentInfo = null) {
  const connectedTabId = (await loadState()).connected?.tabId;
  if (!connectedTabId) throw new Error('実行対象のタブが接続されていません。');
  await ensureContentScript(connectedTabId);

  // Arm the popup sentinel in the content script
  await chrome.tabs.sendMessage(connectedTabId, { type: 'bridge:set-execution-active' }).catch(() => undefined);

  const results = [];
  let finalStatus = 'completed';

  try {
    for (const step of steps) {
      // Adapt compiled step shape to what content.js executeStep expects
      const contentStep = {
        op: step.op,
        target: step.ref ? { ref: step.ref, role: step.role || '', name: step.name || '' } : undefined,
        selection: step.selection,
      };
      let outcome;
      try {
        outcome = await chrome.tabs.sendMessage(connectedTabId, {
          type: 'bridge:execute-step',
          step: contentStep,
          value: step.op === 'fill_ref' ? (values[step.variable?.name] ?? null) : null,
        });
      } catch (error) {
        outcome = { status: 'error', detail: error instanceof Error ? error.message : String(error) };
      }

      results.push({ step_index: step.step_index, op: step.op, status: outcome?.status || 'error', detail: outcome?.detail });

      const progress = await loadState();
      progress.execution = { status: 'running', procedureId, lease, total: steps.length, completed: results.length, results, session, segment: segmentInfo };
      await saveState(progress);
      await broadcastState();

      if (outcome?.status !== 'done' && outcome?.status !== 'skipped') {
        const errorMsg = outcome?.detail || 'ステップ実行に失敗しました';
        finalStatus = outcome?.status === 'ambiguous' || outcome?.status === 'not_found' ? 'cancelled' : 'failed';
        // Authoritative classification comes from the host (single source of
        // truth); fall back to the local heuristic only if the host is offline.
        let reason;
        try {
          const classified = await callNativeHost({
            type: 'save_procedure_delta',
            procedure_id: procedureId,
            anchor_step_index: step.step_index,
            error: errorMsg,
            step: { op: step.op, summary: step.summary },
          });
          reason = classified?.ok && classified.reason ? classified.reason : classifyStepFailure(errorMsg, step.op);
        } catch (_) {
          reason = classifyStepFailure(errorMsg, step.op);
        }
        const repairState = await loadState();
        repairState.repairPending = {
          procedure_id: procedureId,
          anchor_step_index: step.step_index,
          reason,
          failed_at: new Date().toISOString(),
        };
        repairState.notice = `手順「${procedureId}」の step ${step.step_index + 1} で失敗しました: ${errorMsg}`;
        await saveState(repairState);
        await broadcastState();
        break;
      }
    }
  } finally {
    // Always disarm sentinel
    await chrome.tabs.sendMessage(connectedTabId, { type: 'bridge:set-execution-inactive' }).catch(() => undefined);
  }

  // Submit receipt (best-effort)
  const receipt = {
    kind: 'browser-extension-receipt.v1',
    receipt_id: `RCP-${crypto.randomUUID()}`,
    mission_id: session?.mission_id || `MSN-PROC-${procedureId}`,
    pipeline_id: session?.pipeline_id || `proc-${procedureId}`,
    recording_id: session?.recording_id || procedureId,
    tab_id: String(session?.tab_id || ''),
    origin: session?.origin || '',
    status: finalStatus,
    lease_id: lease.lease_id,
    summary: `${results.filter((r) => r.status === 'done').length}/${results.length} 操作を実行 (${finalStatus})`,
    created_at: new Date().toISOString(),
  };
  try {
    await callNativeHost({ type: 'submit_receipt', receipt });
  } catch (_) { /* best-effort */ }

  const done = await loadState();
  done.execution = { status: finalStatus, procedureId, lease, total: steps.length, completed: results.length, results, receipt, session };
  if (finalStatus === 'completed') {
    done.notice = `手順「${procedureId}」を正常に完了しました。`;
  } else if (!done.repairPending) {
    done.notice = `手順「${procedureId}」が ${finalStatus} で終了しました。`;
  }
  await saveState(done);
  await broadcastState();
  return { state: done, status: finalStatus };
}

function classifyStepFailure(errorDetail, op) {
  if (/mfa|otp|二段階|authenticat|ワンタイム/i.test(errorDetail)) return 'mfa';
  if (/modal|dialog|popup|ダイアログ|ポップアップ/i.test(errorDetail)) return 'new_popup';
  if (/origin|navigate|遷移|href/i.test(errorDetail)) return 'handoff';
  return 'ambiguity';
}

async function handleExecutionInterrupted(reason, detail) {
  const state = await loadState();
  if (!state.execution || state.execution.status !== 'running') return { state };
  const procedureId = state.execution.procedureId;
  const stepIndex = state.execution.completed || 0;
  state.repairPending = {
    procedure_id: procedureId,
    anchor_step_index: stepIndex,
    reason: reason || 'new_popup',
    failed_at: new Date().toISOString(),
  };
  state.execution.status = reason === 'mfa' ? 'mfa_in_progress' : 'interrupted';
  state.notice = reason === 'mfa'
    ? 'MFA チャレンジが検出されました。認証完了後に続行します。'
    : `実行中に予期しないダイアログが表示されました（${detail || ''}）。修正操作を記録してください。`;
  await saveState(state);
  await broadcastState();
  return { state };
}

async function handleMfaChallenge(lease, recording, session) {
  if (!lease || !recording || !session) throw new Error('mfa-challenge には lease / recording / session が必要です。');
  const response = await callNativeHost({ type: 'extend_lease', lease, recording, session });
  if (!response?.ok) throw new Error(response?.error || 'MFA リース延長に失敗しました。');
  const state = await loadState();
  if (state.execution) {
    state.execution.lease = response.lease;
    state.execution.status = 'mfa_in_progress';
  }
  state.repairPending = null;
  state.notice = 'MFA チャレンジを検出しました。認証完了後、続行できます（リースを延長しました）。';
  await saveState(state);
  await broadcastState();
  return { state, lease: response.lease };
}
