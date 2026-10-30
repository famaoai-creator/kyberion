// Side-effect imports: the shared PII scrubber (globalThis.__kyberionPiiScrub)
// and the pure inbox/send helpers (globalThis.KyberionBridgeInbox).
import './pii-rules.generated.js';
import './bridge-inbox.js';
import { BROWSER_OPERATION_POLICY } from './operation-policy.js';

const SAFE_OPERATIONS = new Set(BROWSER_OPERATION_POLICY.safe);
const HIGH_RISK_OPERATIONS = new Set(BROWSER_OPERATION_POLICY.highRisk);
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
  stateLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  routeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    );
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  withStateLock(() => handleTabUpdate(tabId, changeInfo, tab)).catch(() => undefined)
);

// Mailbox (受信) messages serialize on their own lock so a slow native poll
// never blocks recording events; send-page and the WebMCP probe only read the
// recording state and run unlocked (send-page takes the state lock itself to
// store an intent resolution).
function routeMessage(message, sender) {
  const type = message?.type;
  if (INBOX_MESSAGE_TYPES.has(type) || SIDE_PANEL_ONLY_MESSAGE_TYPES.has(type)) {
    // Mailbox answers, page sends and WebMCP probes are Side Panel actions: a
    // content script (or any other extension page) must never drive them.
    if (!isSidePanelSender(sender)) {
      return Promise.reject(new Error('この操作は Side Panel からのみ実行できます。'));
    }
  }
  // Answering observe_tab reads the page, which the page can stall (an open
  // alert(), a busy main thread): that part runs outside the inbox lock.
  if (type === 'bridge:respond-request') return routeRespondRequest(message);
  if (INBOX_MESSAGE_TYPES.has(type)) return withInboxLock(() => handleInboxMessage(message));
  if (type === 'bridge:send-page') return sendPage(message.form || {});
  if (type === 'bridge:get-send-draft') return getSendDraft();
  if (type === 'bridge:probe-webmcp') return probeConnectedTabWebMcp();
  return withStateLock(() => handleMessage(message, sender));
}

const SIDE_PANEL_ONLY_MESSAGE_TYPES = new Set([
  'bridge:send-page',
  'bridge:get-send-draft',
  'bridge:probe-webmcp',
]);

// The Side Panel is an extension page: it has no `sender.tab` and its URL is
// this extension's sidepanel.html.
function isSidePanelSender(sender) {
  if (!sender || sender.tab) return false;
  const url = typeof sender.url === 'string' ? sender.url : '';
  let expected = '';
  try {
    expected = chrome.runtime.getURL('sidepanel.html');
  } catch {
    return false;
  }
  return (
    Boolean(expected) &&
    (url === expected || url.startsWith(`${expected}?`) || url.startsWith(`${expected}#`))
  );
}

async function handleTabUpdate(tabId, changeInfo, tab) {
  if (changeInfo.status === 'loading') {
    const state = await loadState();
    if (!state.recording || state.recording.tabId !== tabId || state.recording.pausedReason) return;
    state.recording.pausedReason =
      'ページ遷移を検出しました。自動で続行します（別サイトへの遷移は handoff として記録します）。';
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
  if (!(await hasHostAccess([origin]))) return;
  try {
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, { type: 'bridge:set-recording', enabled: true });
    await chrome.tabs.sendMessage(tabId, {
      type: 'bridge:set-extraction-mode',
      enabled: Boolean(state.extractionMode),
    });
    await chrome.tabs.sendMessage(tabId, {
      type: 'bridge:set-conditional-mode',
      enabled: Boolean(state.conditionalMode),
    });
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

function hostPermissionPatterns(origins) {
  return [
    ...new Set(
      (origins || [])
        .map((origin) => {
          try {
            const url = new URL(origin);
            if (!['http:', 'https:'].includes(url.protocol)) return null;
            return `${url.protocol}//${url.host}/*`;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    ),
  ];
}

async function hasHostAccess(origins) {
  const requested = hostPermissionPatterns(origins);
  if (requested.length === 0) return false;
  try {
    return await chrome.permissions.contains({ origins: requested });
  } catch {
    return false;
  }
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case 'bridge:get-state':
      return { state: await loadState() };
    case 'bridge:get-ai-page-source':
      return getAiPageSource();
    case 'bridge:get-ai-target-candidates':
      return getAiTargetCandidates();
    case 'bridge:connect-active-tab':
      return connectActiveTab();
    case 'bridge:disconnect':
      return disconnect();
    case 'bridge:start-recording':
      return startRecording();
    case 'bridge:set-extraction-mode':
      return setExtractionMode(Boolean(message.enabled));
    case 'bridge:set-conditional-mode':
      return setConditionalMode(Boolean(message.enabled));
    case 'bridge:resume-recording':
      return resumeRecording();
    case 'bridge:stop-recording':
      return stopRecording();
    case 'bridge:discard-last-action':
      return discardLastAction();
    case 'bridge:review-action':
      return reviewAction(message.actionId, message.decision, message.reason);
    case 'bridge:finalize-review':
      return finalizeReview();
    case 'bridge:reject-draft':
      return rejectDraft();
    case 'bridge:record-event':
      return recordEvent(message.event, sender);
    case 'bridge:preflight-draft':
      return preflightDraft();
    case 'bridge:request-execution':
      return requestExecution(message.values || {});
    case 'bridge:resolve-intent':
      return resolveIntent(message.intent, message.origin);
    case 'bridge:report-mfa-challenge':
      return handleMfaChallenge(message.lease, message.recording, message.session);
    case 'bridge:prepare-procedure':
      return prepareProcedure(message.procedureId, message.origin);
    case 'bridge:execute-procedure':
      return executeProcedure(message.procedureId, message.origin, message.values || {});
    case 'bridge:promote-procedure':
      return promoteProcedure(message.procedureId, message.intentPhrases || []);
    case 'bridge:execution-interrupted':
      return handleExecutionInterrupted(message.reason, message.detail);
    case 'bridge:webauthn-phase':
      return handleWebauthnPhase(message.phase, message.ok);
    case 'bridge:analyze-observation':
      return analyzeObservation(message.procedureId, message.question);
    case 'bridge:apply-repair':
      return applyRepair(message.procedureId);
    case 'bridge:inspect-page':
      return inspectCurrentPage();
    default:
      throw new Error('Unsupported Browser Bridge message.');
  }
}

async function inspectCurrentPage() {
  const state = await loadState();
  const tabId = state.connected?.tabId;
  if (tabId === undefined || tabId === null) {
    throw new Error('先に Live タブから現在のページを接続してください。');
  }
  const result = await chrome.tabs.sendMessage(tabId, { type: 'bridge:inspect-page' });
  if (!result?.ok) throw new Error(result?.error || 'ページの解析に失敗しました。');
  return { inspection: result.inspection };
}

async function connectActiveTab() {
  return connectTab(await activeTab());
}

async function getAiPageSource() {
  const state = await loadState();
  const tabId = state.connected?.tabId;
  if (tabId === undefined || tabId === null) {
    throw new Error('先に Live タブから現在のページを接続してください。');
  }
  const source = await chrome.tabs.sendMessage(tabId, { type: 'bridge:get-ai-page-source' });
  if (!source?.ok) throw new Error(source?.error || 'ページ内容を取得できませんでした。');
  return { source };
}

async function getAiTargetCandidates() {
  const state = await loadState();
  const tabId = state.connected?.tabId;
  if (tabId === undefined || tabId === null) {
    throw new Error('先に Live タブから現在のページを接続してください。');
  }
  const candidates = await chrome.tabs.sendMessage(tabId, {
    type: 'bridge:get-ai-target-candidates',
  });
  if (!candidates?.ok) throw new Error(candidates?.error || '要素候補を取得できませんでした。');
  return {
    candidates: candidates.candidates || [],
    candidateCount: Number.isInteger(candidates.candidateCount)
      ? candidates.candidateCount
      : (candidates.candidates || []).length,
    truncated: Boolean(candidates.truncated),
    snapshot_hash: typeof candidates.snapshot_hash === 'string' ? candidates.snapshot_hash : null,
  };
}

async function connectTab(tab) {
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
  const resumable =
    state.recording &&
    state.recording.pausedReason &&
    state.recording.tabId === tab.id &&
    state.recording.origin === origin;
  state.notice = resumable
    ? '同じ origin に再接続しました。記録を続行できます。'
    : 'このタブを接続しました。ページ内の文言は外部データとして扱われます。';
  await saveState(state);
  await broadcastState();
  return { state, observation };
}

// Auto-connect for intent-driven execution: reuse the current connection if it
// already points at `targetOrigin`, otherwise find an open tab on that origin
// (or open a new one), focus it, and connect — no manual Live-tab step needed.
async function ensureConnectedToOrigin(targetOrigin) {
  const state = await loadState();
  if (state.connected?.origin === targetOrigin) {
    const tab = await chrome.tabs.get(state.connected.tabId).catch(() => null);
    if (tab && originOf(tab.url || '') === targetOrigin) return state.connected;
  }
  if (!(await hasHostAccess([targetOrigin]))) {
    throw new Error(
      'サイトへのアクセス許可がありません。もう一度ボタンを押して許可するか、Live タブの「このタブを接続」から許可してください。'
    );
  }
  const tabs = await chrome.tabs.query({});
  let tab =
    tabs.find((candidate) => candidate.active && originOf(candidate.url || '') === targetOrigin) ||
    tabs.find((candidate) => originOf(candidate.url || '') === targetOrigin);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    if (tab.windowId !== undefined)
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  } else {
    tab = await chrome.tabs.create({ url: `${targetOrigin}/`, active: true });
  }
  await waitForTabComplete(tab.id);
  tab = await chrome.tabs.get(tab.id);
  const connected = await connectTab(tab);
  return connected.state.connected;
}

async function disconnect() {
  const state = await loadState();
  if (state.recording)
    throw new Error('記録中は解除できません。記録を停止して Review に送ってから解除してください。');
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
  if (state.recording)
    throw new Error('記録が残っています。続行または停止して Review に送ってください。');
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
  await chrome.tabs.sendMessage(tab.id, { type: 'bridge:set-extraction-mode', enabled: false });
  await chrome.tabs.sendMessage(tab.id, { type: 'bridge:set-conditional-mode', enabled: false });
  state.extractionMode = false;
  state.conditionalMode = false;
  await saveState(state);
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
    throw new Error(
      '遷移先が異なる tab または origin です。現在の記録を停止し、新しい recording を開始してください。'
    );
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
  await chrome.tabs.sendMessage(tab.id, {
    type: 'bridge:set-extraction-mode',
    enabled: Boolean(state.extractionMode),
  });
  await chrome.tabs.sendMessage(tab.id, {
    type: 'bridge:set-conditional-mode',
    enabled: Boolean(state.conditionalMode),
  });
  await broadcastState();
  return { state };
}

async function stopRecording() {
  const state = await loadState();
  const recording = state.recording;
  if (!recording) throw new Error('記録中ではありません。');
  await chrome.tabs
    .sendMessage(recording.tabId, { type: 'bridge:set-recording', enabled: false })
    .catch(() => undefined);
  if (recording.actions.length === 0) throw new Error('記録された操作がありません。');

  const highRiskCount = recording.actions.filter((action) =>
    HIGH_RISK_OPERATIONS.has(action.op)
  ).length;
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
        ...(action.op === 'sensitive_input_omitted'
          ? { reason: 'Sensitive input is never replayed.' }
          : {}),
      })),
    },
  };
  state.lastDraft = draft;
  state.recording = null;
  state.extractionMode = false;
  state.conditionalMode = false;
  state.execution = null;
  state.notice = '下書きを生成しました。各操作を承認または除外してから確定してください。';
  await saveState(state);
  await broadcastState();
  return { state, draft };
}

async function setExtractionMode(enabled) {
  const state = await loadState();
  if (!state.recording || !state.connected) {
    throw new Error('分析対象モードは記録中にのみ利用できます。');
  }
  await chrome.tabs.sendMessage(state.recording.tabId, {
    type: 'bridge:set-extraction-mode',
    enabled,
  });
  if (enabled) {
    await chrome.tabs.sendMessage(state.recording.tabId, {
      type: 'bridge:set-conditional-mode',
      enabled: false,
    });
  }
  state.extractionMode = enabled;
  if (enabled) state.conditionalMode = false;
  state.notice = enabled
    ? '分析対象モードです。ページ上の要素をクリックすると抽出対象になります。'
    : '分析対象モードを終了しました。Alt+クリックは引き続き利用できます。';
  await saveState(state);
  await broadcastState();
  return { state };
}

async function setConditionalMode(enabled) {
  const state = await loadState();
  if (!state.recording || !state.connected) {
    throw new Error('条件付きクリック対象の選択には、接続中の記録が必要です。');
  }
  await ensureContentScript(state.recording.tabId);
  if (enabled) {
    await chrome.tabs.sendMessage(state.recording.tabId, {
      type: 'bridge:set-extraction-mode',
      enabled: false,
    });
  }
  await chrome.tabs.sendMessage(state.recording.tabId, {
    type: 'bridge:set-conditional-mode',
    enabled,
  });
  state.conditionalMode = enabled;
  if (enabled) state.extractionMode = false;
  state.notice = enabled
    ? '条件付きクリック対象モードです。ページ上の対象をクリックしてください。通常のクリックは発生しません。'
    : '条件付きクリック対象モードを終了しました。';
  await saveState(state);
  await broadcastState();
  return { state };
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
  if (!['approved', 'rejected'].includes(decision))
    throw new Error('Review decision must be approved or rejected.');
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
  if (
    actionable.some(
      (action) => !decisions.has(action.action_id) || decisions.get(action.action_id) === 'pending'
    )
  ) {
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
  const decisions = new Map(
    (draft.review?.decisions || []).map((entry) => [entry.action_id, entry.status])
  );
  return draft.actions.filter(
    (action) =>
      action.op !== 'sensitive_input_omitted' && decisions.get(action.action_id) === 'approved'
  );
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

function callNativeHost(payload, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let port;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        port?.disconnect();
      } catch (_) {
        // best-effort cleanup
      }
      reject(new Error('Native Bridge の応答がタイムアウトしました。'));
    }, timeoutMs);

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    try {
      // Keep the native connection open until the response frame arrives.
      // sendNativeMessage is convenient for one-shot hosts, but Chrome can
      // report "Native host has exited" when the host drains stdin while the
      // callback is still being delivered.
      port = chrome.runtime.connectNative(NATIVE_HOST);
      port.onMessage.addListener((response) => {
        finish(() => {
          resolve(response);
          try {
            port.disconnect();
          } catch (_) {
            // best-effort cleanup
          }
        });
      });
      port.onDisconnect.addListener(() => {
        if (settled) return;
        const lastError = chrome.runtime.lastError;
        finish(() =>
          reject(
            new Error(
              nativeHostError(lastError?.message || 'Native host has exited before responding.')
            )
          )
        );
      });
      port.postMessage(payload);
    } catch (error) {
      finish(() =>
        reject(new Error(nativeHostError(error instanceof Error ? error.message : String(error))))
      );
    }
  });
}

async function actionHash(action) {
  return sha256(
    JSON.stringify({
      action_id: action.action_id,
      op: action.op,
      target: action.target,
      variable: action.variable,
      selection: action.selection,
    })
  );
}

async function preflightDraft() {
  const state = await loadState();
  const draft = state.lastDraft;
  if (draft?.review?.status !== 'approved') throw new Error('承認済みの下書きがありません。');
  const tabId = state.connected?.tabId ?? 0;
  const response = await callNativeHost({
    type: 'preflight',
    recording: draft,
    session: buildSessionRequest(draft, 'record', tabId),
  });
  if (!response?.ok)
    throw new Error(
      (response?.errors || []).join('; ') || response?.error || 'preflight に失敗しました。'
    );
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
  if (!response?.ok)
    throw new Error(response?.error || 'Native Bridge がリクエストを拒否しました。');

  if (response.status === 'approval_required') {
    state.execution = {
      status: 'approval_required',
      requestId: response.request_id || null,
      session,
    };
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
  await waitForTabComplete(connectedTabId);
  await ensureContentScript(connectedTabId);

  const results = [];
  const draftExtractions = [];
  let finalStatus = 'completed';
  for (const step of steps) {
    if (HIGH_RISK_OPERATIONS.has(step.op)) {
      const hash = await actionHash(step);
      if (!lease.approved_step_hashes.includes(hash)) {
        results.push({
          action_id: step.action_id,
          op: step.op,
          status: 'blocked',
          detail: 'lease に承認ハッシュがありません',
        });
        finalStatus = 'blocked';
        break;
      }
    }
    let outcome;
    if (step.op === 'navigate') {
      // A navigate marker is not a DOM action: the preceding step triggers the
      // navigation; here we wait for the recorded destination origin, then
      // re-inject the content script on the new page.
      const targetOrigin = step.navigation?.to_origin;
      const reached = targetOrigin ? await waitForOrigin(connectedTabId, targetOrigin) : null;
      if (!targetOrigin || reached !== targetOrigin) {
        outcome = {
          status: 'error',
          detail: `遷移先 ${targetOrigin || '不明'} に到達できませんでした（現在: ${reached || '不明'}）`,
        };
      } else {
        try {
          await waitForTabComplete(connectedTabId);
          await ensureContentScript(connectedTabId);
          outcome = { status: 'done', detail: `${targetOrigin} への遷移を確認しました` };
        } catch (error) {
          outcome = {
            status: 'error',
            detail: error instanceof Error ? error.message : String(error),
          };
        }
      }
    } else {
      try {
        outcome = await chrome.tabs.sendMessage(connectedTabId, {
          type: 'bridge:execute-step',
          step,
          value: step.op === 'fill_ref' ? (values[step.variable?.name] ?? null) : null,
        });
      } catch (error) {
        outcome = {
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
    results.push({
      action_id: step.action_id,
      op: step.op,
      status: outcome?.status || 'error',
      detail: outcome?.detail,
    });
    if (
      step.op === 'extract_text_ref' &&
      outcome?.status === 'done' &&
      typeof outcome.text === 'string'
    ) {
      draftExtractions.push({
        name: extractionFieldName({ summary: step.summary, name: step.target?.name }),
        text: outcome.text.slice(0, 20000),
        ...(step.target?.dom_path ? { dom_path: step.target.dom_path } : {}),
      });
    }

    const progress = await loadState();
    progress.execution = {
      status: 'running',
      lease,
      total: steps.length,
      completed: results.length,
      results,
      session,
    };
    await saveState(progress);
    await broadcastState();

    if (outcome?.status !== 'done' && outcome?.status !== 'skipped') {
      finalStatus =
        outcome?.status === 'ambiguous' || outcome?.status === 'not_found' ? 'cancelled' : 'failed';
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

  // Draft runs have no procedure yet — key the observation by recording_id so
  // it can still be analyzed (and later inherited when the draft is promoted).
  const observation =
    finalStatus === 'completed' && draftExtractions.length > 0
      ? await submitObservation(draft.recording_id, session, lease, draft, draftExtractions)
      : null;

  const done = await loadState();
  done.execution = {
    status: finalStatus,
    lease,
    total: steps.length,
    completed: results.length,
    results,
    receipt,
    receiptAck,
    session,
    ...(observation ? { observation } : {}),
  };
  done.notice = `実行 ${finalStatus}: ${results.filter((entry) => entry.status === 'done').length}/${steps.length} 操作。receipt ${receipt.receipt_id} を生成しました。${observation?.fieldCount ? `抽出データ ${observation.fieldCount} 件を保存しました。` : ''}`;
  await saveState(done);
  await broadcastState();
  return { state: done, status: finalStatus, receipt };
}

async function recordEvent(event, sender) {
  const state = await loadState();
  const recording = state.recording;
  if (!recording || sender.tab?.id !== recording.tabId) return { ignored: true };
  const senderOrigin = originOf(sender.tab.url || '');
  if (!senderOrigin || senderOrigin !== recording.origin || recording.pausedReason)
    return { ignored: true };
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
    risk: HIGH_RISK_OPERATIONS.has(event.op)
      ? 'high'
      : event.op === 'sensitive_input_omitted'
        ? 'sensitive'
        : event.op === 'snapshot'
          ? 'observe'
          : 'low',
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
    // Structural anchor for positional replay fallback (volatile-content pages).
    if (typeof event.target.dom_path === 'string' && event.target.dom_path.length <= 600) {
      action.target.dom_path = event.target.dom_path;
    }
  }
  if (event.variable) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(String(event.variable.name || ''))) return null;
    if (!['user_input', 'secret_ref'].includes(event.variable.classification)) return null;
    action.variable = {
      name: String(event.variable.name),
      classification: event.variable.classification,
    };
  }
  if (event.selection) {
    if (!['option', 'toggle'].includes(event.selection.kind)) return null;
    if (event.selection.kind === 'toggle' && typeof event.selection.checked !== 'boolean')
      return null;
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
  if (!tabs[0]?.id)
    throw new Error('操作対象のタブを確認できません。拡張アイコンからもう一度開いてください。');
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
  let contentReady = false;
  let piiScrubberReady = false;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'bridge:ping' });
    contentReady = Boolean(response?.ok);
    piiScrubberReady = Boolean(response?.piiScrubberReady);
  } catch (_) {
    // No content script yet — inject below (needs host access or an activeTab grant).
  }
  if (!contentReady || !piiScrubberReady) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: contentReady ? ['pii-rules.generated.js'] : ['pii-rules.generated.js', 'content.js'],
      });
    } catch (_) {
      throw new Error(
        'このページにアクセスできません。Side Panel の「このタブを接続」でサイトへのアクセスを許可してください。許可後はページ遷移や再接続でも継続できます。'
      );
    }
  }
  // Passkey (WebAuthn) awareness: wrap navigator.credentials in the page's MAIN
  // world so the content script can pause execution while the OS passkey dialog
  // is up. Idempotent; best-effort (a CSP-restricted page just skips it).
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: installWebauthnHook,
    });
  } catch (_) {
    // best-effort
  }
}

// Runs in the page's MAIN world (serialized by chrome.scripting) — wraps
// navigator.credentials.get/create to broadcast passkey start/end markers.
function installWebauthnHook() {
  if (window.__kyberionWebauthnHooked) return;
  window.__kyberionWebauthnHooked = true;
  const wrap = (method) => {
    const original = navigator.credentials?.[method]?.bind(navigator.credentials);
    if (!original) return;
    navigator.credentials[method] = (...args) => {
      window.postMessage({ __kyberion: 'webauthn', phase: 'start' }, '*');
      const pending = original(...args);
      Promise.resolve(pending)
        .then(() => window.postMessage({ __kyberion: 'webauthn', phase: 'end', ok: true }, '*'))
        .catch(() => window.postMessage({ __kyberion: 'webauthn', phase: 'end', ok: false }, '*'));
      return pending;
    };
  };
  wrap('get');
  wrap('create');
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
  const response = await callNativeHost({
    type: 'resolve_intent',
    intent: intent.trim(),
    origin: effectiveOrigin,
  });
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
  if (resolution.outcome === 'ambiguous')
    return `複数の候補が見つかりました。候補を選択してください。`;
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
    origins: response.origins || (response.origin ? [response.origin] : []),
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

  // The host knows the procedure's start origin (the recording's initial tab
  // origin) — authoritative over whatever tab happens to be connected. Auto-
  // connect to it so intent-driven runs need no manual Live-tab step.
  const info = await callNativeHost({ type: 'prepare_procedure', procedure_id: procedureId });
  if (!info?.ok) throw new Error(info?.error || '手順情報の取得に失敗しました。');
  const startOrigin = info.origin || info.origins?.[0] || origin;
  if (!startOrigin) throw new Error('手順の対象 origin を特定できませんでした。');
  const connected = await ensureConnectedToOrigin(startOrigin);

  const response = await callNativeHost({
    type: 'dispatch_procedure',
    procedure_id: procedureId,
    origin: startOrigin,
    tab_id: String(connected.tabId),
  });
  if (!response?.ok) throw new Error(response?.error || '手順の配信に失敗しました。');

  if (response.status === 'approval_required') {
    const state = await loadState();
    state.execution = {
      status: 'approval_required',
      requestId: response.request_id || null,
      procedureId,
    };
    state.notice = `手順の実行承認待ちです（${response.request_id || 'approval_required'}）。Kyberion で承認後にもう一度実行してください。`;
    await saveState(state);
    await broadcastState();
    return { state, status: 'approval_required' };
  }

  if (response.status === 'dispatched_segmented' && Array.isArray(response.segments)) {
    const out = await runSegmentedExecution(
      procedureId,
      response.segments,
      response.session,
      values
    );
    await verifyGoldenScenario(procedureId, response.golden_scenario, out);
    return out;
  }

  if (response.status !== 'dispatched' || !response.lease) {
    throw new Error('実行リースを取得できませんでした。');
  }

  const out = await runCompiledSteps(
    procedureId,
    response.compiled_steps || [],
    response.session,
    response.lease,
    values
  );
  await verifyGoldenScenario(procedureId, response.golden_scenario, out);
  return out;
}

async function promoteProcedure(procedureId, intentPhrases) {
  const state = await loadState();
  const draft = state.lastDraft;
  if (draft?.review?.status !== 'approved') {
    throw new Error('承認済みの下書きがありません。先に Review を確定してください。');
  }
  const response = await callNativeHost({
    type: 'promote_procedure',
    procedure_id: procedureId,
    intent_phrases: intentPhrases,
    recording: draft,
  });
  if (!response?.ok) throw new Error(response?.error || '個人用シナリオの登録に失敗しました。');
  state.procedureRegistration = {
    procedure_id: response.procedure_id,
    recording_ref: response.recording_ref,
    registered_at: new Date().toISOString(),
  };
  state.notice = `個人用シナリオ「${response.procedure_id}」を登録しました。`;
  await saveState(state);
  await broadcastState();
  return { state, registration: response };
}

// #3: after a completed run, collect the page evidence the golden scenario's
// success conditions need and let the host judge it (the extension never
// decides pass/fail). The host records the verdict on the procedure's
// knowledge-verification ledger.
async function verifyGoldenScenario(procedureId, golden, run) {
  if (
    !golden ||
    !Array.isArray(golden.success_conditions) ||
    golden.success_conditions.length === 0
  )
    return;
  if (run?.status !== 'completed' || !run.receipt?.receipt_id) return;
  const connectedTabId = (await loadState()).connected?.tabId;
  if (!connectedTabId) return;
  let verdict;
  try {
    const evidence = await chrome.tabs.sendMessage(connectedTabId, {
      type: 'bridge:golden-evidence',
      conditions: golden.success_conditions,
    });
    // No evidence is not "nothing matched": never send an empty list that the
    // host would read as a failed check.
    if (!evidence?.ok || !Array.isArray(evidence.elements)) {
      throw new Error('ページから成功条件の情報を取得できませんでした');
    }
    const response = await callNativeHost({
      type: 'submit_golden_evidence',
      procedure_id: procedureId,
      receipt_id: run.receipt.receipt_id,
      elements: evidence.elements,
    });
    verdict = response?.ok
      ? response.golden || null
      : { verdict: 'error', detail: response?.error || '判定できませんでした' };
  } catch (error) {
    verdict = {
      verdict: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!verdict) return; // the procedure has no golden scenario on the host
  const state = await loadState();
  if (state.execution) {
    state.execution.golden = {
      scenario_id: golden.scenario_id,
      verdict: verdict.verdict,
      conditions: verdict.conditions || [],
      ...(verdict.detail ? { detail: verdict.detail } : {}),
    };
    if (verdict.verdict === 'fail') state.execution.status = 'verification_failed';
  }
  state.notice =
    verdict.verdict === 'pass'
      ? `手順「${procedureId}」を実行し、成功条件を満たしました。`
      : verdict.verdict === 'fail'
        ? `手順「${procedureId}」は実行しましたが、成功条件を満たしていません。結果を確認してください。`
        : verdict.verdict === 'inconclusive'
          ? `手順「${procedureId}」を実行しました。成功条件はこの実行の情報では判定できませんでした。`
          : `手順「${procedureId}」を実行しましたが、成功条件の判定に失敗しました: ${verdict.detail}`;
  await saveState(state);
  await broadcastState();
}

// #2 (loop closure): apply the corrective recording (the just-finalized draft)
// to the failed procedure as a delta, then merge + persist for re-promotion.
async function applyRepair(procedureId) {
  const state = await loadState();
  const repair = state.repairPending;
  const draft = state.lastDraft;
  if (!repair || repair.procedure_id !== procedureId)
    throw new Error('対象の修復対象が見つかりません。');
  if (draft?.review?.status !== 'approved')
    throw new Error('承認済みの修正記録がありません。先に Review を確定してください。');

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
  if (!deltaResp?.ok || !deltaResp.delta_path)
    throw new Error(deltaResp?.error || 'デルタの保存に失敗しました。');

  // 3. Merge the delta into the base recording (re-promotion stays human-gated).
  const applied = await callNativeHost({
    type: 'apply_procedure_delta',
    procedure_id: procedureId,
    delta_path: deltaResp.delta_path,
  });
  if (!applied?.ok) throw new Error(applied?.error || 'デルタの適用に失敗しました。');

  state.repairPending = null;
  state.lastDraft = null;
  state.notice = `修正をマージしました（${applied.merged_recording_ref}）。レビュー後に promote_procedure で再昇格してください。`;
  await saveState(state);
  await broadcastState();
  return { state, merged_recording_ref: applied.merged_recording_ref };
}

// Wait until the tab reports status "complete" (page load finished) so step
// execution never races a still-loading DOM. Cheap no-op when already loaded.
async function waitForTabComplete(tabId, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// Poll until the connected tab's origin matches `expectedOrigin` (a cross-origin
// handoff completing), or time out. Returns the live origin reached.
async function waitForOrigin(tabId, expectedOrigin, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = null;
    }
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
      if (reached === segment.origin) await waitForTabComplete(connectedTabId);
      if (reached !== segment.origin) {
        const s = await loadState();
        s.execution = {
          status: 'failed',
          procedureId,
          total: segments.length,
          completed: segment.segment_index,
          session,
        };
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
    last = await runCompiledSteps(
      procedureId,
      segment.steps || [],
      segSession,
      segment.lease,
      values,
      {
        segmentIndex: segment.segment_index,
        segmentCount: segments.length,
      }
    );
    if (last.status !== 'completed') return last; // stop the chain on any segment failure
  }
  return last;
}

async function runCompiledSteps(procedureId, steps, session, lease, values, segmentInfo = null) {
  const connectedTabId = (await loadState()).connected?.tabId;
  if (!connectedTabId) throw new Error('実行対象のタブが接続されていません。');
  await waitForTabComplete(connectedTabId);
  await ensureContentScript(connectedTabId);

  // Arm the popup sentinel in the content script
  await chrome.tabs
    .sendMessage(connectedTabId, { type: 'bridge:set-execution-active' })
    .catch(() => undefined);

  const results = [];
  const extractions = [];
  let finalStatus = 'completed';

  try {
    for (const step of steps) {
      // Adapt compiled step shape to what content.js executeStep expects
      const contentStep = {
        op: step.op,
        target: step.ref
          ? {
              ref: step.ref,
              role: step.role || '',
              name: step.name || '',
              snapshot_hash: step.snapshot_hash || null,
              ...(step.dom_path ? { dom_path: step.dom_path } : {}),
            }
          : undefined,
        variable: step.variable,
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
        outcome = {
          status: 'error',
          detail: error instanceof Error ? error.message : String(error),
        };
      }

      results.push({
        step_index: step.step_index,
        op: step.op,
        status: outcome?.status || 'error',
        detail: outcome?.detail,
      });
      if (
        step.op === 'extract_text_ref' &&
        outcome?.status === 'done' &&
        typeof outcome.text === 'string'
      ) {
        extractions.push({
          name: extractionFieldName(step),
          text: outcome.text.slice(0, 20000),
          ...(step.dom_path ? { dom_path: step.dom_path } : {}),
        });
      }

      const progress = await loadState();
      progress.execution = {
        status: 'running',
        procedureId,
        lease,
        total: steps.length,
        completed: results.length,
        results,
        session,
        segment: segmentInfo,
      };
      await saveState(progress);
      await broadcastState();

      if (outcome?.status !== 'done' && outcome?.status !== 'skipped') {
        const errorMsg = outcome?.detail || 'ステップ実行に失敗しました';
        finalStatus =
          outcome?.status === 'ambiguous' || outcome?.status === 'not_found'
            ? 'cancelled'
            : 'failed';
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
          reason =
            classified?.ok && classified.reason
              ? classified.reason
              : classifyStepFailure(errorMsg, step.op);
        } catch (_) {
          reason = classifyStepFailure(errorMsg, step.op);
        }
        const repairState = await loadState();
        repairState.repairPending = {
          procedure_id: procedureId,
          anchor_step_index: step.step_index,
          reason,
          failed_at: new Date().toISOString(),
          ...(step.ref
            ? {
                target: {
                  ref: String(step.ref),
                  role: String(step.role || ''),
                  name: String(step.name || ''),
                  ...(typeof step.snapshot_hash === 'string'
                    ? { snapshot_hash: step.snapshot_hash }
                    : {}),
                  ...(typeof step.dom_path === 'string' && step.dom_path.length <= 600
                    ? { dom_path: step.dom_path }
                    : {}),
                },
              }
            : {}),
        };
        repairState.notice = `手順「${procedureId}」の step ${step.step_index + 1} で失敗しました: ${errorMsg}`;
        await saveState(repairState);
        await broadcastState();
        break;
      }
    }
  } finally {
    // Always disarm sentinel
    await chrome.tabs
      .sendMessage(connectedTabId, { type: 'bridge:set-execution-inactive' })
      .catch(() => undefined);
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
  } catch (_) {
    /* best-effort */
  }

  // Persist extracted data as a governed observation (host validates+redacts).
  const observation =
    finalStatus === 'completed' && extractions.length > 0
      ? await submitObservation(procedureId, session, lease, null, extractions)
      : null;

  const done = await loadState();
  done.execution = {
    status: finalStatus,
    procedureId,
    lease,
    total: steps.length,
    completed: results.length,
    results,
    receipt,
    session,
    ...(observation ? { observation } : {}),
  };
  if (finalStatus === 'completed') {
    done.notice = observation?.fieldCount
      ? `手順「${procedureId}」を完了し、抽出データ ${observation.fieldCount} 件を保存しました。レポートを生成できます。`
      : `手順「${procedureId}」を正常に完了しました。`;
  } else if (!done.repairPending) {
    done.notice = `手順「${procedureId}」が ${finalStatus} で終了しました。`;
  }
  await saveState(done);
  await broadcastState();
  return { state: done, status: finalStatus, receipt };
}

// Surface passkey (WebAuthn) progress while a run is active: the step executor
// keeps waiting during authentication; this just tells the user what's
// happening and why the run looks paused.
async function handleWebauthnPhase(phase, ok) {
  const state = await loadState();
  const active = state.execution && ['running', 'mfa_in_progress'].includes(state.execution.status);
  if (!active) return { ignored: true };
  if (phase === 'start') {
    state.execution.status = 'mfa_in_progress';
    state.notice =
      'パスキー認証が求められています。認証を完了すると実行を自動で続行します（自動入力はしません）。';
  } else {
    state.execution.status = 'running';
    state.notice =
      ok === false
        ? 'パスキー認証がキャンセルまたは失敗しました。ページの状態を確認してください。'
        : 'パスキー認証を確認しました。実行を続行します。';
  }
  await saveState(state);
  await broadcastState();
  return { state };
}

// Report-column name for an extraction step: prefer the label the user saw at
// record time (「LABEL」のテキストを抽出), else the accessible name.
function extractionFieldName(step) {
  const fromSummary = /^「(.+)」のテキストを抽出$/.exec(step.summary || '');
  return (fromSummary?.[1] || step.name || step.summary || 'field').slice(0, 200);
}

// Build + submit a browser-observation.v1 record from collected extract_text_ref
// outcomes. Best-effort: an observation failure never fails the run itself.
async function submitObservation(procedureId, session, lease, recording, extractions) {
  if (!extractions.length) return null;
  const observation = {
    schema_version: 'browser-observation.v1',
    observation_id: `OBS-${crypto.randomUUID()}`,
    procedure_id: procedureId,
    recording_id: session?.recording_id || '',
    lease_id: lease?.lease_id || '',
    origin: session?.origin || '',
    captured_at: new Date().toISOString(),
    source: 'chrome-extension',
    fields: extractions,
  };
  try {
    const ack = await callNativeHost(
      {
        type: 'submit_observation',
        observation,
        session,
        lease,
        ...(recording ? { recording } : {}),
      },
      30_000
    );
    if (!ack?.ok) return { observation_id: observation.observation_id, error: ack?.error };
    return {
      observation_id: observation.observation_id,
      procedure_id: procedureId,
      fieldCount: extractions.length,
      path: ack.path,
      preview: extractions.map((field) => ({
        name: String(field.name || '').slice(0, 120),
        text: String(field.text || '').slice(0, 240),
      })),
    };
  } catch (error) {
    return {
      observation_id: observation.observation_id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Ask the host to analyze stored observations for a procedure and produce a
// Markdown report (analysis happens host-side, on redacted data, injection-
// fenced — the extension only displays the result).
async function analyzeObservation(procedureId, question) {
  if (!procedureId) throw new Error('レポート対象の手順がありません。');
  const response = await callNativeHost(
    {
      type: 'analyze_observation',
      procedure_id: procedureId,
      ...(question ? { question } : {}),
    },
    120_000
  );
  if (!response?.ok) throw new Error(response?.error || 'レポート生成に失敗しました。');
  const state = await loadState();
  state.lastReport = {
    procedure_id: procedureId,
    report_ref: response.report_ref,
    report: String(response.report || '').slice(0, 20000),
    observation_count: response.observation_count,
    generated_at: new Date().toISOString(),
  };
  state.notice = `レポートを生成しました（観測 ${response.observation_count} 件 → ${response.report_ref}）。`;
  await saveState(state);
  await broadcastState();
  return { state, report_ref: response.report_ref };
}

function classifyStepFailure(errorDetail, op) {
  if (/mfa|otp|二段階|authenticat|ワンタイム|passkey|パスキー|webauthn|生体認証/i.test(errorDetail))
    return 'mfa';
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
  state.notice =
    reason === 'mfa'
      ? 'MFA チャレンジが検出されました。認証完了後に続行します。'
      : `実行中に予期しないダイアログが表示されました（${detail || ''}）。修正操作を記録してください。`;
  await saveState(state);
  await broadcastState();
  return { state };
}

async function handleMfaChallenge(lease, recording, session) {
  if (!lease || !recording || !session)
    throw new Error('mfa-challenge には lease / recording / session が必要です。');
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

// ---------------------------------------------------------------------------
// Kyberion → extension pull mailbox (受信) — B1 observe / B2 local infer / B4 notify
// ---------------------------------------------------------------------------
//
// Native Messaging stays the only transport: the extension polls the native
// host (`poll_requests`) and answers with `respond_request`. The poller runs
// every minute via chrome.alarms, and every 5 s only while a Side Panel holds
// a `sidepanel` port. Nothing here answers a request on its own: observe_tab
// needs an explicit click in the Side Panel, local_infer runs in the Side Panel
// (Built-in AI document APIs are unavailable in a service worker), and
// approval_pending notifications are display-only.

const Inbox = globalThis.KyberionBridgeInbox;
const INBOX_KEY = 'browserBridgeInbox';
const SEND_DRAFT_KEY = 'browserBridgeSendDraft';
const MAILBOX_ALARM = 'kyberion-bridge-mailbox';
const FAST_POLL_MS = 5_000;
const SEND_MENU_ID = 'kyberion-send-page';
const OBSERVE_PROCEDURE_ID = 'browser-bridge-observe';
// Leave headroom under the host's 64 KiB respond_request cap.
const RESPONSE_BUDGET_BYTES = 60_000;
const LOCAL_INFER_OUTPUT_BUDGET_BYTES = 48_000;
// WebMCP discovery is page-controlled: bound the in-page wait and the
// isolated-side wait so a hostile page can never hold the inbox lock.
const WEBMCP_PAGE_TIMEOUT_MS = 1_500;
const WEBMCP_PROBE_TIMEOUT_MS = 3_000;
// Overall bound on all page interaction for one observe_tab answer.
const OBSERVE_TIMEOUT_MS = 10_000;
const NOTIFICATION_PREFIX = 'kyberion-bbr-';
// 1x1 PNG: chrome.notifications 'basic' requires an iconUrl and the extension
// ships no icon assets.
const NOTIFICATION_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const INBOX_MESSAGE_TYPES = new Set([
  'bridge:get-inbox',
  'bridge:poll-inbox',
  'bridge:respond-request',
  'bridge:decline-request',
  'bridge:dismiss-request',
  'bridge:set-local-infer-auto',
]);
const REMOVE_ON_HOST_CODES = new Set(['expired', 'terminal', 'not_found']);

let inboxLock = Promise.resolve();
function withInboxLock(fn) {
  const next = inboxLock.then(fn, fn);
  inboxLock = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

const sidePanelPorts = new Set();
let fastPollTimer = null;

function scrubber() {
  const scrub = globalThis.__kyberionPiiScrub;
  if (typeof scrub !== 'function') {
    throw new Error('PII scrubber が読み込まれていないため、Kyberion への送信を停止しました。');
  }
  return scrub;
}

function scrubLine(value, max) {
  return String(scrubber()(String(value ?? '')))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function scrubDeep(value, depth = 0) {
  if (typeof value === 'string') return scrubber()(value);
  if (value === null || typeof value !== 'object') return value;
  // Past the depth limit nothing unscrubbed may survive: drop the subtree.
  if (depth > 6) return null;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => scrubDeep(entry, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 64)
      .map(([key, entry]) => [scrubber()(key).slice(0, 120), scrubDeep(entry, depth + 1)])
  );
}

function byteLength(value) {
  return new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).length;
}

function trimToBytes(text, maxBytes) {
  let out = String(text);
  while (out && byteLength(out) > maxBytes) out = out.slice(0, Math.floor(out.length * 0.85));
  return out;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function emptyInbox() {
  return {
    requests: [],
    approvals: [],
    requestsSignature: '',
    approvalsSignature: '',
    approvalsUnavailable: false,
    lastPolledAt: null,
    lastError: null,
    notified: [],
    dismissed: [],
    localInferAuto: false,
  };
}

async function loadInbox() {
  const stored = await chrome.storage.session.get(INBOX_KEY);
  return { ...emptyInbox(), ...(stored[INBOX_KEY] || {}) };
}

async function saveInbox(inbox) {
  await chrome.storage.session.set({ [INBOX_KEY]: inbox });
}

function publicInbox(inbox) {
  return {
    requests: inbox.requests,
    approvals: inbox.approvals,
    approvalsSignature: inbox.approvalsSignature,
    approvalsUnavailable: Boolean(inbox.approvalsUnavailable),
    lastPolledAt: inbox.lastPolledAt,
    lastError: inbox.lastError,
    localInferAuto: inbox.localInferAuto === true,
  };
}

async function updateBadge(inbox) {
  const count = Inbox.badgeCount(inbox.requests);
  try {
    await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
    if (count > 0) await chrome.action.setBadgeBackgroundColor({ color: '#174b3b' });
  } catch (_) {
    // badge is best-effort
  }
}

function postToSidePanels(message) {
  for (const port of sidePanelPorts) {
    try {
      port.postMessage(message);
    } catch (_) {
      sidePanelPorts.delete(port);
    }
  }
}

function notifyInboxChanged(inbox, newIds = [], approvalsChanged = false) {
  postToSidePanels({
    type: 'bridge:inbox-changed',
    inbox: publicInbox(inbox),
    newIds,
    approvalsChanged,
  });
}

function clearToast(requestId) {
  try {
    Promise.resolve(chrome.notifications.clear(`${NOTIFICATION_PREFIX}${requestId}`)).catch(
      () => undefined
    );
  } catch (_) {
    // best-effort
  }
}

function raiseToast(item) {
  let title;
  let message;
  if (item.request_kind === 'observe_tab') {
    title = 'Kyberion: ページ観測の依頼';
    message = `${scrubLine(item.payload?.purpose, 200)} — サイドパネルの「受信」で許可または拒否してください。`;
  } else if (item.request_kind === 'notify' && item.payload?.level === 'approval_pending') {
    title = 'Kyberion: 承認待ち';
    message = `${scrubLine(item.payload?.title, 120)} — 承認はターミナルで行います（サイドパネルの「受信」にコマンドがあります）。`;
  } else {
    return;
  }
  try {
    Promise.resolve(
      chrome.notifications.create(`${NOTIFICATION_PREFIX}${item.request_id}`, {
        type: 'basic',
        iconUrl: NOTIFICATION_ICON,
        title,
        message,
        priority: 1,
      })
    ).catch(() => undefined);
  } catch (_) {
    // notifications are best-effort
  }
}

async function purgeExpired(inbox, now = Date.now()) {
  const expired = inbox.requests.filter((item) => Inbox.isExpired(item, now));
  if (expired.length === 0) return false;
  // Expired items are dropped locally and never answered.
  inbox.requests = inbox.requests.filter((item) => !Inbox.isExpired(item, now));
  inbox.requestsSignature = Inbox.stableSignature(inbox.requests);
  expired.forEach((item) => clearToast(item.request_id));
  return true;
}

async function pollMailbox() {
  const inbox = await loadInbox();
  const now = Date.now();
  let response;
  try {
    response = await callNativeHost({ type: 'poll_requests' }, 15_000);
  } catch (error) {
    response = { ok: false, error: errorText(error) };
  }
  inbox.lastPolledAt = new Date(now).toISOString();

  if (!response?.ok) {
    const lastError = String(response?.error || '受信箱を確認できませんでした。').slice(0, 500);
    const errorChanged = lastError !== inbox.lastError;
    inbox.lastError = lastError;
    const purged = await purgeExpired(inbox, now);
    await saveInbox(inbox);
    await updateBadge(inbox);
    if (errorChanged || purged) notifyInboxChanged(inbox);
    return { inbox: publicInbox(inbox) };
  }

  const dismissed = new Set(inbox.dismissed);
  const requests = (Array.isArray(response.requests) ? response.requests : [])
    .filter(
      (item) =>
        Inbox.isValidRequestId(item?.request_id) &&
        ['observe_tab', 'local_infer', 'notify'].includes(item.request_kind) &&
        !Inbox.isExpired(item, now) &&
        !dismissed.has(item.request_id)
    )
    .slice(0, 50);
  const approvals = (Array.isArray(response.approvals) ? response.approvals : []).slice(0, 20);
  const requestsSignature = Inbox.stableSignature(requests);
  const approvalsSignature = Inbox.stableSignature(approvals);
  const requestsChanged = requestsSignature !== inbox.requestsSignature;
  const approvalsChanged = approvalsSignature !== inbox.approvalsSignature;
  const errorChanged = inbox.lastError !== null;

  const notified = new Set(inbox.notified);
  const fresh = requests.filter((item) => !notified.has(item.request_id));
  fresh.forEach((item) => {
    raiseToast(item);
    notified.add(item.request_id);
  });
  const liveIds = new Set(requests.map((item) => item.request_id));
  inbox.requests
    .filter((item) => !liveIds.has(item.request_id))
    .forEach((item) => clearToast(item.request_id));

  inbox.requests = requests;
  inbox.approvals = approvals;
  inbox.requestsSignature = requestsSignature;
  inbox.approvalsSignature = approvalsSignature;
  inbox.approvalsUnavailable = response.approvals_unavailable === true;
  inbox.lastError = null;
  inbox.notified = [...notified].slice(-200);
  inbox.dismissed = [...dismissed].filter((id) => notified.has(id)).slice(-200);
  await saveInbox(inbox);
  await updateBadge(inbox);
  if (requestsChanged || approvalsChanged || errorChanged) {
    notifyInboxChanged(
      inbox,
      fresh.map((item) => item.request_id),
      approvalsChanged
    );
  }
  return { inbox: publicInbox(inbox) };
}

function schedulePoll() {
  return withInboxLock(pollMailbox).catch(() => undefined);
}

function startFastPoll() {
  if (fastPollTimer) return;
  fastPollTimer = setInterval(() => {
    if (sidePanelPorts.size === 0) {
      stopFastPoll();
      return;
    }
    void schedulePoll();
  }, FAST_POLL_MS);
}

function stopFastPoll() {
  if (!fastPollTimer) return;
  clearInterval(fastPollTimer);
  fastPollTimer = null;
}

async function handleInboxMessage(message) {
  switch (message.type) {
    case 'bridge:get-inbox': {
      const inbox = await loadInbox();
      if (await purgeExpired(inbox)) {
        await saveInbox(inbox);
        await updateBadge(inbox);
      }
      return { inbox: publicInbox(inbox) };
    }
    case 'bridge:poll-inbox':
      return pollMailbox();
    case 'bridge:respond-request':
      return respondRequest(message);
    case 'bridge:decline-request':
      return declineRequest(message.requestId, message.reason);
    case 'bridge:dismiss-request':
      return dismissRequest(message.requestId);
    case 'bridge:set-local-infer-auto': {
      const inbox = await loadInbox();
      inbox.localInferAuto = message.enabled === true;
      await saveInbox(inbox);
      notifyInboxChanged(inbox);
      return { inbox: publicInbox(inbox) };
    }
    default:
      throw new Error('Unsupported Browser Bridge message.');
  }
}

async function takeInboxItem(requestId) {
  if (!Inbox.isValidRequestId(requestId)) throw new Error('依頼 ID が不正です。');
  const inbox = await loadInbox();
  const item = inbox.requests.find((candidate) => candidate.request_id === requestId);
  if (!item) {
    throw new Error('この依頼は受信箱にありません（応答済みか期限切れです）。');
  }
  if (Inbox.isExpired(item)) {
    await removeInboxItem(requestId);
    throw new Error('この依頼は期限切れです。応答は送りません。');
  }
  return item;
}

async function removeInboxItem(requestId) {
  const inbox = await loadInbox();
  inbox.requests = inbox.requests.filter((item) => item.request_id !== requestId);
  inbox.requestsSignature = Inbox.stableSignature(inbox.requests);
  await saveInbox(inbox);
  await updateBadge(inbox);
  clearToast(requestId);
  notifyInboxChanged(inbox);
  return inbox;
}

async function dismissRequest(requestId) {
  const item = await takeInboxItem(requestId);
  if (item.request_kind !== 'notify') {
    throw new Error('観測・推論の依頼は「拒否」で応答してください。');
  }
  // Local only: the request is never answered, it just stops being shown.
  const inbox = await loadInbox();
  inbox.dismissed = [...new Set([...inbox.dismissed, requestId])].slice(-200);
  await saveInbox(inbox);
  return { inbox: publicInbox(await removeInboxItem(requestId)) };
}

// respond-request in three steps for observe_tab: check the item under a short
// inbox lock, collect the observation with no lock held (bounded by one overall
// timeout), then re-take the lock to re-check the item and send the answer.
async function routeRespondRequest(message) {
  const item = await withInboxLock(() => takeInboxItem(message.requestId));
  if (item.request_kind !== 'observe_tab') {
    return withInboxLock(() => respondRequest(message));
  }
  // Reading the page needs a per-request click in the Side Panel.
  if (message.userAction !== true) {
    throw new Error('ページ観測の依頼には、受信タブでの明示的な許可が必要です。');
  }
  const wire = await withTimeout(
    buildObserveResponse(item),
    OBSERVE_TIMEOUT_MS,
    'ページの応答がないため観測を中止しました（ダイアログが開いているか、ページが応答していません）。ページを確認してから、もう一度許可してください。'
  );
  return withInboxLock(() => respondRequest(message, wire));
}

function withTimeout(promise, timeoutMs, errorMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function respondRequest(message, observeWire) {
  // Re-checked here (under the inbox lock): the item may have been answered,
  // declined or expired while an observation was being collected.
  const item = await takeInboxItem(message.requestId);
  let wire;
  if (item.request_kind === 'observe_tab') {
    if (message.userAction !== true || !observeWire) {
      throw new Error('ページ観測の依頼には、受信タブでの明示的な許可が必要です。');
    }
    const allowed = Array.isArray(item.payload?.allowed_origins)
      ? item.payload.allowed_origins
      : [];
    if (allowed.length > 0 && !allowed.includes(observeWire.origin)) {
      throw new Error('観測中に依頼の対象サイトが変わったため、応答を中止しました。');
    }
    wire = observeWire;
  } else if (item.request_kind === 'local_infer') {
    return respondLocalInfer(item, message);
  } else if (item.request_kind === 'notify') {
    if (item.payload?.level === 'approval_pending') {
      throw new Error(
        '承認待ちの通知には応答しません。承認は表示されたコマンドで、ターミナルから行ってください。'
      );
    }
    wire = { status: 'completed' };
  } else {
    throw new Error('未対応の依頼です。');
  }
  return sendRequestResponse(item, wire);
}

async function declineRequest(requestId, reason) {
  const item = await takeInboxItem(requestId);
  return sendRequestResponse(item, {
    status: 'declined',
    error: String(reason || 'ユーザーが拒否しました。'),
  });
}

async function sendRequestResponse(item, wire) {
  const payload = {
    type: 'respond_request',
    request_id: item.request_id,
    status: wire.status,
    ...(wire.result !== undefined ? { result: wire.result } : {}),
    ...(wire.error ? { error: scrubLine(wire.error, 1000) } : {}),
    ...(wire.origin ? { origin: wire.origin } : {}),
  };
  if (byteLength(payload) > 64 * 1024) {
    throw new ResponseTooLargeError('応答が 64 KiB を超えるため送信できません。');
  }
  const response = await callNativeHost(payload, 30_000);
  if (!response?.ok) {
    if (REMOVE_ON_HOST_CODES.has(response?.code)) await removeInboxItem(item.request_id);
    throw new Error(response?.error || '応答を Kyberion に送信できませんでした。');
  }
  const inbox = await removeInboxItem(item.request_id);
  return {
    inbox: publicInbox(inbox),
    responded: { request_id: item.request_id, status: response.status || wire.status },
  };
}

// A completed local_infer answer that cannot be sent (too large even after
// bounding) is answered as `failed` instead, so the requester is never left
// waiting on a request the panel silently gave up on.
async function respondLocalInfer(item, message) {
  try {
    return await sendRequestResponse(item, buildLocalInferResponse(item, message));
  } catch (error) {
    if (!error?.responseTooLarge) throw error;
    return sendRequestResponse(item, {
      status: 'failed',
      error: `ローカル推論の結果が大きすぎるため送信できませんでした: ${errorText(error)}`,
    });
  }
}

class ResponseTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.responseTooLarge = true;
  }
}

// Trim an object output (already scrubbed, plain JSON) until its serialized
// size fits: shorten the longest string first, then halve the longest array.
function boundObjectOutput(output, maxBytes) {
  if (byteLength(output) <= maxBytes) return { output, truncated: false };
  const bounded = structuredClone(output);
  for (let guard = 0; guard < 400 && byteLength(bounded) > maxBytes; guard += 1) {
    let longestString = null;
    let longestArray = null;
    const visit = (node) => {
      if (Array.isArray(node)) {
        if (!longestArray || node.length > longestArray.length) longestArray = node;
        node.forEach((entry, index) => {
          if (typeof entry === 'string') {
            if (!longestString || entry.length > longestString.length)
              longestString = { parent: node, key: index, length: entry.length };
          } else if (entry && typeof entry === 'object') visit(entry);
        });
        return;
      }
      for (const [key, entry] of Object.entries(node)) {
        if (typeof entry === 'string') {
          if (!longestString || entry.length > longestString.length)
            longestString = { parent: node, key, length: entry.length };
        } else if (entry && typeof entry === 'object') visit(entry);
      }
    };
    visit(bounded);
    if (longestString && longestString.length > 256) {
      const { parent, key } = longestString;
      parent[key] = parent[key].slice(0, Math.floor(parent[key].length * 0.7));
    } else if (longestArray && longestArray.length > 1) {
      longestArray.length = Math.floor(longestArray.length / 2);
    } else if (longestString && longestString.length > 0) {
      const { parent, key } = longestString;
      parent[key] = parent[key].slice(0, Math.floor(parent[key].length / 2));
    } else {
      break;
    }
  }
  if (byteLength(bounded) > maxBytes) {
    throw new ResponseTooLargeError('出力を上限内に収められません。');
  }
  return { output: bounded, truncated: true };
}

function buildLocalInferResponse(item, message) {
  const task = item.payload?.task;
  if (message.status === 'failed') {
    return {
      status: 'failed',
      error: String(message.error || 'Chrome 内蔵 AI でローカル推論を実行できませんでした。'),
    };
  }
  const result = message.result;
  if (!result || result.executable !== false) {
    throw new Error('ローカル推論の結果は executable:false である必要があります。');
  }
  if (result.task !== task) throw new Error('ローカル推論の結果のタスクが依頼と一致しません。');
  const provider = scrubLine(result.provider, 80);
  if (!provider) throw new Error('ローカル推論の結果に provider がありません。');
  let output = scrubDeep(result.output);
  let truncated = result.truncated === true;
  if (typeof output === 'string' && byteLength(output) > LOCAL_INFER_OUTPUT_BUDGET_BYTES) {
    output = trimToBytes(output, LOCAL_INFER_OUTPUT_BUDGET_BYTES);
    truncated = true;
  }
  if (typeof output !== 'string' && (output === null || typeof output !== 'object')) {
    throw new Error('ローカル推論の出力が不正です。');
  }
  if (typeof output !== 'string') {
    const bounded = boundObjectOutput(output, LOCAL_INFER_OUTPUT_BUDGET_BYTES);
    output = bounded.output;
    truncated = truncated || bounded.truncated;
  }
  return { status: 'completed', result: { provider, task, output, truncated, executable: false } };
}

// observe_tab: only the active tab that the user connected in the Live tab,
// only http(s), only an allowed origin; content comes from the same scrubbed
// extraction paths the AI summary and page inspection already use.
async function buildObserveResponse(item) {
  const tab = await activeTab();
  const origin = assertSupportedTab(tab);
  const state = await loadState();
  if (state.connected?.tabId !== tab.id || state.connected?.origin !== origin) {
    throw new Error(
      '観測できるのは Live タブで接続中の現在タブだけです。対象のタブを開いて接続してから許可してください。'
    );
  }
  const allowed = Array.isArray(item.payload?.allowed_origins) ? item.payload.allowed_origins : [];
  if (allowed.length > 0 && !allowed.includes(origin)) {
    throw new Error(
      `この依頼の対象は ${allowed.join(', ')} です（現在のタブ: ${origin}）。対象サイトのタブを接続するか、拒否してください。`
    );
  }
  await ensureContentScript(tab.id);
  const extracted =
    item.payload?.mode === 'structure'
      ? await observeStructureFields(tab.id)
      : await observeTextFields(tab.id);
  // The tab may have navigated between the origin check above and the
  // extraction: bind the content to the origin of the document it came from.
  if (extracted.origin !== origin || (allowed.length > 0 && !allowed.includes(extracted.origin))) {
    throw new Error(
      '観測中にページの接続先が変わったため、応答を中止しました。対象のタブを開き直してから許可してください。'
    );
  }
  const { fields } = extracted;
  const webmcp = await probeTabWebMcp(tab.id);
  const observation = {
    schema_version: 'browser-observation.v1',
    observation_id: `OBS-${crypto.randomUUID()}`,
    procedure_id: OBSERVE_PROCEDURE_ID,
    recording_id: item.request_id,
    lease_id: `LEASE-${item.request_id}`,
    origin,
    captured_at: new Date().toISOString(),
    source: 'chrome-extension',
    fields,
  };
  const result = {
    observation,
    ...(webmcp.tools.length > 0 ? { webmcp_tools: webmcp.tools } : {}),
  };
  fitObservationToBudget(result, RESPONSE_BUDGET_BYTES);
  return { status: 'completed', origin, result };
}

async function observeTextFields(tabId) {
  const source = await chrome.tabs.sendMessage(tabId, { type: 'bridge:get-ai-page-source' });
  if (!source?.ok) throw new Error(source?.error || 'ページ内容を取得できませんでした。');
  const fields = [
    { name: 'title', text: scrubLine(source.title, 500) },
    { name: 'path', text: scrubLine(source.url, 500) },
    { name: 'page_text', text: String(scrubber()(String(source.text || ''))).slice(0, 20_000) },
  ];
  if (source.truncated) fields.push({ name: 'note', text: '本文は上限で切り詰めています。' });
  return { fields, origin: originOf(String(source.origin || '')) };
}

function linkTarget(href) {
  try {
    const url = new URL(String(href || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    // Never forward query strings or fragments (tokens, identifiers, searches).
    return `${url.origin}${url.pathname}`;
  } catch {
    return '';
  }
}

async function observeStructureFields(tabId) {
  const result = await chrome.tabs.sendMessage(tabId, { type: 'bridge:inspect-page' });
  if (!result?.ok || !result.inspection) {
    throw new Error(result?.error || 'ページ構造を取得できませんでした。');
  }
  const inspection = result.inspection;
  const lines = (entries, format) =>
    (Array.isArray(entries) ? entries : [])
      .map((entry) => scrubLine(format(entry), 500))
      .filter(Boolean)
      .join('\n')
      .slice(0, 20_000);
  const fields = [
    { name: 'title', text: scrubLine(inspection.title, 500) },
    { name: 'headings', text: lines(inspection.headings, (h) => `${h.level}: ${h.text}`) },
    {
      name: 'inputs',
      text: lines(inspection.inputs, (input) =>
        [
          `${input.tag}${input.type ? `[${input.type}]` : ''}`,
          input.label || input.placeholder || input.name || input.id || '',
          input.required ? '(必須)' : '',
        ]
          .filter(Boolean)
          .join(' ')
      ),
    },
    { name: 'buttons', text: lines(inspection.buttons, (button) => button.text) },
    {
      name: 'links',
      text: lines(inspection.links, (link) => {
        const target = linkTarget(link.href);
        return target ? `${link.text} → ${target}` : link.text;
      }),
    },
    { name: 'excerpt', text: scrubLine(inspection.textExcerpt, 1000) },
  ];
  return {
    fields: fields.filter((field) => field.name === 'title' || field.text),
    origin: originOf(String(inspection.origin || '')),
  };
}

function fitObservationToBudget(result, budget) {
  const fields = result.observation.fields;
  let guard = 0;
  while (byteLength(result) > budget && guard < 200) {
    guard += 1;
    const longest = fields.reduce((a, b) => (b.text.length > a.text.length ? b : a), fields[0]);
    if (!longest || longest.text.length === 0) break;
    longest.text = longest.text.slice(0, Math.floor(longest.text.length * 0.8));
  }
  if (byteLength(result) > budget) throw new Error('観測結果が大きすぎるため送信できません。');
}

// ---------------------------------------------------------------------------
// B5 WebMCP discovery (read-only)
// ---------------------------------------------------------------------------

// Runs in the page's MAIN world (serialized by chrome.scripting, so it must be
// self-contained). Reads the tool list only — names, descriptions and the
// top-level keys of each input schema. Never calls a tool, never registers one,
// and never throws on pages without the API. Everything here is page-controlled
// (the API object, the returned list, every property), so listTools() is raced
// against a timeout, the walk stops at `max`, and only own data properties are
// read (a getter is never invoked).
async function probeWebMcpTools(limit, timeoutMs) {
  const max = Math.max(0, Math.min(Number(limit) || 50, 50));
  const waitMs = Math.max(0, Math.min(Number(timeoutMs) || 1500, 5000));
  const tools = [];
  let truncated = false;
  let supported = false;
  const own = (object, key) => {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch {
      return undefined;
    }
  };
  const text = (value, size) => (typeof value === 'string' ? value.slice(0, size) : '');
  const keysOf = (schema) => {
    let parsed = schema;
    if (typeof parsed === 'string') {
      if (parsed.length > 50_000) return [];
      try {
        parsed = JSON.parse(parsed);
      } catch {
        return [];
      }
    }
    if (!parsed || typeof parsed !== 'object') return [];
    const properties = own(parsed, 'properties');
    if (!properties || typeof properties !== 'object') return [];
    const keys = [];
    for (const key in properties) {
      if (keys.length >= 32) break;
      if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(properties, key)) {
        keys.push(key.slice(0, 80));
      }
    }
    return keys;
  };
  const collect = (list) => {
    if (!Array.isArray(list)) return;
    let length = 0;
    try {
      length = Math.max(0, Math.min(Number(list.length) || 0, 10_000));
    } catch {
      return;
    }
    // Bound the walk itself: skipped (invalid) entries count too.
    const scanLimit = Math.min(length, max * 4);
    for (let index = 0; index < scanLimit; index += 1) {
      if (tools.length >= max) {
        truncated = true;
        break;
      }
      try {
        const tool = own(list, index);
        if (!tool || typeof tool !== 'object') continue;
        const name = text(own(tool, 'name'), 120);
        if (!name) continue;
        tools.push({
          name,
          description: text(own(tool, 'description'), 500),
          input_keys: keysOf(own(tool, 'inputSchema') ?? own(tool, 'input_schema')),
        });
      } catch {
        // a hostile entry: skip it
      }
    }
    if (length > scanLimit) truncated = true;
  };
  const withTimeout = (promise) =>
    Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => setTimeout(() => resolve(undefined), waitMs)),
    ]);
  try {
    const testing = navigator.modelContextTesting;
    if (testing) supported = true;
    const listTools = testing ? testing.listTools : undefined;
    if (typeof listTools === 'function') {
      collect(await withTimeout(listTools.call(testing)));
    }
  } catch {
    // API absent, rejected, or timed out
  }
  if (tools.length === 0) {
    try {
      const context = navigator.modelContext;
      if (context) {
        supported = true;
        collect(context.tools);
      }
    } catch {
      // API absent
    }
  }
  return { supported, tools, truncated };
}

async function probeTabWebMcp(tabId) {
  let timer;
  try {
    const probe = chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: probeWebMcpTools,
      args: [Inbox.MAX_WEBMCP_TOOLS, WEBMCP_PAGE_TIMEOUT_MS],
    });
    // The page can wedge the MAIN-world call (e.g. a hostile setTimeout), so
    // the isolated side never waits longer than this either.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('WebMCP の確認がタイムアウトしました。')),
        WEBMCP_PROBE_TIMEOUT_MS
      );
    });
    const results = await Promise.race([probe, timeout]);
    const raw = results?.[0]?.result;
    // Scrub on the isolated side: page-provided strings are untrusted.
    const sanitized = Inbox.sanitizeWebMcpTools(raw?.tools, scrubber());
    return {
      supported: raw?.supported === true,
      tools: sanitized.tools,
      truncated: raw?.truncated === true || sanitized.truncated,
    };
  } catch (error) {
    return { supported: false, tools: [], truncated: false, error: errorText(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeConnectedTabWebMcp() {
  const state = await loadState();
  const tabId = state.connected?.tabId;
  if (tabId === undefined || tabId === null) {
    throw new Error('先に Live タブから現在のページを接続してください。');
  }
  return { webmcp: await probeTabWebMcp(tabId) };
}

// ---------------------------------------------------------------------------
// Page → Kyberion (送信) — B3
// ---------------------------------------------------------------------------

async function sendPage(form) {
  const scrub = scrubber();
  const built = Inbox.buildSendPagePayload({
    ...form,
    title: scrubLine(form.title, 300),
    text: String(scrub(String(form.text || ''))).slice(0, Inbox.SEND_MAX_TEXT + 1),
    note: String(scrub(String(form.note || ''))),
  });
  if (!built.ok) throw new Error(built.errors.join(' '));
  const response = await callNativeHost(built.payload, 180_000);
  if (!response?.ok) throw new Error(response?.error || 'Kyberion への送信に失敗しました。');
  if (response.mode === 'intent' && response.resolution) {
    // Store the resolution exactly like resolve_intent so the Intent tab's
    // Pattern B / Pattern A buttons work on it.
    await withStateLock(async () => {
      const state = await loadState();
      state.intentResolution = {
        intent: built.payload.note || built.payload.title,
        outcome: response.resolution.outcome,
        best: response.resolution.best || null,
        candidates: response.resolution.candidates || [],
        recommendedPattern: response.resolution.recommendedPattern,
        resolvedAt: new Date().toISOString(),
      };
      state.notice = formatResolutionNotice(response.resolution);
      await saveState(state);
      await broadcastState();
    });
  }
  await chrome.storage.session.set({ [SEND_DRAFT_KEY]: null });
  return {
    state: await loadState(),
    sendResult: {
      mode: response.mode,
      intent: built.payload.note || built.payload.title,
      ...(response.resolution ? { resolution: response.resolution } : {}),
      ...(response.staged_ref ? { staged_ref: response.staged_ref } : {}),
      ...(response.ingest ? { ingest: response.ingest } : {}),
      ...(response.page ? { page: response.page } : {}),
    },
  };
}

async function getSendDraft() {
  const stored = await chrome.storage.session.get(SEND_DRAFT_KEY);
  return { draft: stored[SEND_DRAFT_KEY] || null };
}

// Context menu: pre-fill the Side Panel's 送信 form. Never sends by itself.
async function prepareSendDraft(info, tab) {
  const origin = originOf(tab?.url || '');
  const preparedAt = new Date().toISOString();
  let draft;
  if (!origin) {
    draft = {
      error: 'このページは送信できません（http(s) の通常タブのみ）。',
      prepared_at: preparedAt,
    };
  } else if (typeof info?.selectionText === 'string' && info.selectionText.trim()) {
    const text = String(scrubber()(info.selectionText)).trim();
    draft = {
      url_origin: origin,
      title: scrubLine(tab?.title, 300),
      text: text.slice(0, Inbox.SEND_MAX_TEXT),
      truncated: text.length > Inbox.SEND_MAX_TEXT,
      selection_only: true,
      prepared_at: preparedAt,
    };
  } else {
    try {
      await ensureContentScript(tab.id);
      const source = await chrome.tabs.sendMessage(tab.id, { type: 'bridge:get-ai-page-source' });
      if (!source?.ok) throw new Error(source?.error || 'ページ内容を取得できませんでした。');
      draft = {
        url_origin: origin,
        title: scrubLine(source.title, 300),
        text: String(scrubber()(String(source.text || ''))).slice(0, Inbox.SEND_MAX_TEXT),
        truncated: Boolean(source.truncated),
        selection_only: false,
        prepared_at: preparedAt,
      };
    } catch (error) {
      draft = {
        url_origin: origin,
        title: scrubLine(tab?.title, 300),
        text: '',
        selection_only: false,
        error: errorText(error),
        prepared_at: preparedAt,
      };
    }
  }
  await chrome.storage.session.set({ [SEND_DRAFT_KEY]: draft });
  chrome.runtime.sendMessage({ type: 'bridge:send-draft-ready', draft }).catch(() => undefined);
  return draft;
}

function registerContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      { id: SEND_MENU_ID, title: 'Kyberion に送る', contexts: ['page', 'selection'] },
      () => void chrome.runtime.lastError
    );
  });
}

chrome.runtime.onInstalled.addListener(() => registerContextMenu());

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info?.menuItemId !== SEND_MENU_ID) return;
  // Open first, while the click's user gesture is still valid.
  if (tab?.windowId !== undefined) {
    Promise.resolve(chrome.sidePanel.open({ windowId: tab.windowId })).catch(() => undefined);
  }
  prepareSendDraft(info, tab).catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (!String(notificationId).startsWith(NOTIFICATION_PREFIX)) return;
  Promise.resolve(chrome.windows.getLastFocused())
    .then((window) =>
      window?.id !== undefined ? chrome.sidePanel.open({ windowId: window.id }) : undefined
    )
    .catch(() => undefined);
});

// Poller wiring: the alarm (1 min, Chrome's minimum period) always runs; the
// 5 s fast poll runs only while a Side Panel holds a `sidepanel` port.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === MAILBOX_ALARM) void schedulePoll();
});
Promise.resolve(chrome.alarms.get(MAILBOX_ALARM))
  .then((existing) =>
    existing ? undefined : chrome.alarms.create(MAILBOX_ALARM, { periodInMinutes: 1 })
  )
  .catch(() => undefined);

chrome.runtime.onConnect.addListener((port) => {
  if (port?.name !== 'sidepanel') return;
  if (!isSidePanelSender(port.sender)) {
    port.disconnect?.();
    return;
  }
  sidePanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    sidePanelPorts.delete(port);
    if (sidePanelPorts.size === 0) stopFastPoll();
  });
  // Keep-alive pings from the panel need no reply.
  port.onMessage.addListener(() => undefined);
  startFastPoll();
  void schedulePoll();
});
