const state = { current: null };

const elements = {
  connectionStatus: document.querySelector('#connection-status'),
  connectionTitle: document.querySelector('#connection-title'),
  connectionOrigin: document.querySelector('#connection-origin'),
  connectButton: document.querySelector('#connect-button'),
  disconnectButton: document.querySelector('#disconnect-button'),
  startRecordingButton: document.querySelector('#start-recording-button'),
  resumeRecordingButton: document.querySelector('#resume-recording-button'),
  stopRecordingButton: document.querySelector('#stop-recording-button'),
  discardLastButton: document.querySelector('#discard-last-button'),
  recordingCount: document.querySelector('#recording-count'),
  omittedCount: document.querySelector('#omitted-count'),
  recordingActions: document.querySelector('#recording-actions'),
  reviewSummary: document.querySelector('#review-summary'),
  reviewActions: document.querySelector('#review-actions'),
  finalizeReviewButton: document.querySelector('#finalize-review-button'),
  rejectDraftButton: document.querySelector('#reject-draft-button'),
  draftPreview: document.querySelector('#draft-preview'),
  handoffStatus: document.querySelector('#handoff-status'),
  handoffSteps: document.querySelector('#handoff-steps'),
  executionInputs: document.querySelector('#execution-inputs'),
  executionInputsFields: document.querySelector('#execution-inputs-fields'),
  executionResults: document.querySelector('#execution-results'),
  preflightButton: document.querySelector('#preflight-button'),
  copyDraftButton: document.querySelector('#copy-draft-button'),
  requestExecutionButton: document.querySelector('#request-execution-button'),
  notice: document.querySelector('#notice'),
  // Intent tab
  intentInput: document.querySelector('#intent-input'),
  intentResolveButton: document.querySelector('#intent-resolve-button'),
  intentResult: document.querySelector('#intent-result'),
  intentOutcomeLabel: document.querySelector('#intent-outcome-label'),
  intentMatchedInfo: document.querySelector('#intent-matched-info'),
  intentProcedureId: document.querySelector('#intent-procedure-id'),
  intentConfidence: document.querySelector('#intent-confidence'),
  intentCandidates: document.querySelector('#intent-candidates'),
  intentExecuteButton: document.querySelector('#intent-execute-button'),
  intentRecordButton: document.querySelector('#intent-record-button'),
  intentRepairStatus: document.querySelector('#intent-repair-status'),
  intentRepairReason: document.querySelector('#intent-repair-reason'),
  intentRepairRecordButton: document.querySelector('#intent-repair-record-button'),
  intentRepairApplyButton: document.querySelector('#intent-repair-apply-button'),
  intentInputs: document.querySelector('#intent-inputs'),
  intentInputsFields: document.querySelector('#intent-inputs-fields'),
  intentRunButton: document.querySelector('#intent-run-button'),
};

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

// Intent tab wiring
elements.intentResolveButton.addEventListener('click', resolveIntent);
elements.intentInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') resolveIntent(); });
elements.intentExecuteButton.addEventListener('click', () => startProcedure(state.current?.intentResolution?.best?.procedure_id));
elements.intentRunButton.addEventListener('click', async () => {
  const procedureId = elements.intentInputs.dataset.procedureId;
  if (!procedureId) return showNotice('実行する手順が選択されていません。');
  selectTab('run');
  await invoke('bridge:execute-procedure', {
    procedureId,
    origin: state.current?.connected?.origin,
    values: collectIntentInputValues(),
  });
});
elements.intentRecordButton.addEventListener('click', () => {
  selectTab('record');
  showNotice('Pattern A: 新しい操作を記録してください。');
});
elements.intentRepairRecordButton.addEventListener('click', () => {
  selectTab('record');
  showNotice('修正操作を記録してください。記録停止後、Review で承認すると「修正を手順に反映」が押せます。');
});
elements.intentRepairApplyButton.addEventListener('click', async () => {
  const procedureId = state.current?.repairPending?.procedure_id;
  if (!procedureId) return showNotice('反映対象の修復がありません。');
  await invoke('bridge:apply-repair', { procedureId });
});

// #1: Pattern B start — ask the host what inputs are needed; if any, render
// fields and wait for the user before dispatching; otherwise execute directly.
async function startProcedure(procedureId) {
  if (!procedureId) return showNotice('実行する手順が選択されていません。');
  const prepared = await invoke('bridge:prepare-procedure', { procedureId, origin: state.current?.connected?.origin });
  if (!prepared) return;
  if (prepared.hasInputs) {
    renderIntentInputs(procedureId, prepared.inputs || []);
    showNotice('入力値を指定して「入力して実行」を押してください。');
    return;
  }
  selectTab('run');
  await invoke('bridge:execute-procedure', { procedureId, origin: state.current?.connected?.origin, values: {} });
}

function renderIntentInputs(procedureId, inputs) {
  elements.intentInputs.dataset.procedureId = procedureId;
  elements.intentInputs.hidden = inputs.length === 0;
  elements.intentInputsFields.replaceChildren();
  inputs.forEach((input) => {
    const label = document.createElement('label');
    label.className = 'execution-input';
    const span = document.createElement('span');
    span.textContent = `${input.label}${input.optional ? '（任意）' : ''}`;
    const field = document.createElement('input');
    field.type = input.type === 'number' ? 'number' : input.type === 'date' ? 'date' : 'text';
    field.dataset.variable = input.name;
    field.autocomplete = 'off';
    label.append(span, field);
    elements.intentInputsFields.append(label);
  });
}

function collectIntentInputValues() {
  const values = {};
  elements.intentInputsFields.querySelectorAll('input[data-variable]').forEach((input) => {
    if (input.value) values[input.dataset.variable] = input.value;
  });
  return values;
}

elements.connectButton.addEventListener('click', () => withHostPermission('bridge:connect-active-tab'));
elements.disconnectButton.addEventListener('click', () => invoke('bridge:disconnect'));
elements.startRecordingButton.addEventListener('click', () => withHostPermission('bridge:start-recording'));
elements.resumeRecordingButton.addEventListener('click', () => withHostPermission('bridge:resume-recording'));

// Request site access from the side panel (a valid user gesture) before any
// action that needs to inject the content script. Once granted, injection keeps
// working across navigations and reconnects — without it, activeTab only grants
// a single page and the connection breaks on the next navigation/tab switch.
async function ensureHostPermission() {
  const origins = ['http://*/*', 'https://*/*'];
  try {
    if (await chrome.permissions.contains({ origins })) return true;
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

async function withHostPermission(type) {
  const granted = await ensureHostPermission();
  if (!granted) {
    showNotice('サイトへのアクセスが許可されませんでした。記録・実行にはアクセス許可が必要です。');
    return null;
  }
  return invoke(type);
}
elements.stopRecordingButton.addEventListener('click', async () => {
  const result = await invoke('bridge:stop-recording');
  if (result?.draft) selectTab('review');
});
elements.discardLastButton.addEventListener('click', () => invoke('bridge:discard-last-action'));
elements.finalizeReviewButton.addEventListener('click', async () => {
  const result = await invoke('bridge:finalize-review');
  if (result?.state?.lastDraft?.review?.status === 'approved') selectTab('run');
});
elements.rejectDraftButton.addEventListener('click', () => invoke('bridge:reject-draft'));
elements.copyDraftButton.addEventListener('click', copyApprovedDraft);
elements.preflightButton.addEventListener('click', () => invoke('bridge:preflight-draft'));
elements.requestExecutionButton.addEventListener('click', () => invoke('bridge:request-execution', { values: collectInputValues() }));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'bridge:state-changed') render(message.state);
});

async function resolveIntent() {
  const intent = elements.intentInput.value.trim();
  if (!intent) return showNotice('やりたいことを入力してください。');
  // Resolution may call the LLM (seconds of latency) — show an explicit busy
  // state so the panel never looks hung.
  elements.intentResolveButton.disabled = true;
  elements.intentResolveButton.classList.add('is-busy');
  const originalLabel = elements.intentResolveButton.textContent;
  elements.intentResolveButton.textContent = '照合中';
  showNotice('登録済みの手順と照合しています…');
  try {
    const response = await invoke('bridge:resolve-intent', { intent });
    if (response?.resolution) renderIntentResolution(intent, response.resolution);
  } finally {
    elements.intentResolveButton.disabled = false;
    elements.intentResolveButton.classList.remove('is-busy');
    elements.intentResolveButton.textContent = originalLabel;
  }
}

function renderIntentResolution(intent, resolution) {
  elements.intentResult.hidden = false;
  elements.intentCandidates.hidden = true;
  elements.intentMatchedInfo.hidden = true;
  elements.intentExecuteButton.hidden = true;
  elements.intentRecordButton.hidden = true;
  elements.intentCandidates.replaceChildren();

  if (resolution.outcome === 'matched' && resolution.best) {
    elements.intentOutcomeLabel.textContent = '✓ 手順が見つかりました（Pattern B 実行可能）';
    elements.intentOutcomeLabel.className = 'intent-outcome is-matched';
    elements.intentMatchedInfo.hidden = false;
    elements.intentProcedureId.textContent = resolution.best.procedure_id;
    elements.intentConfidence.textContent = `信頼度 ${Math.round(resolution.best.confidence * 100)}%`;
    elements.intentExecuteButton.hidden = false;
  } else if (resolution.outcome === 'ambiguous') {
    elements.intentOutcomeLabel.textContent = '△ 複数の候補があります。選択してください。';
    elements.intentOutcomeLabel.className = 'intent-outcome is-ambiguous';
    elements.intentCandidates.hidden = false;
    (resolution.candidates || []).forEach((c) => {
      const li = document.createElement('li');
      const title = document.createElement('strong');
      title.textContent = c.procedure_id;
      const detail = document.createElement('small');
      detail.textContent = `信頼度 ${Math.round(c.confidence * 100)}% — ${c.reason || ''}`;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'decision-button';
      btn.textContent = 'この手順で実行';
      btn.addEventListener('click', () => startProcedure(c.procedure_id));
      li.append(title, detail, btn);
      elements.intentCandidates.append(li);
    });
    elements.intentRecordButton.hidden = false;
  } else {
    elements.intentOutcomeLabel.textContent = '✗ 一致する手順がありません（Pattern A: 新規記録）';
    elements.intentOutcomeLabel.className = 'intent-outcome is-unmatched';
    elements.intentRecordButton.hidden = false;
  }
}

function renderRepairStatus(state) {
  const repair = state.repairPending;
  if (!repair) {
    elements.intentRepairStatus.hidden = true;
    return;
  }
  elements.intentRepairStatus.hidden = false;
  const reasonLabel = {
    mfa: 'MFA チャレンジ',
    new_popup: '新しいポップアップ',
    handoff: 'タブ遷移',
    ambiguity: 'UI 変更',
  }[repair.reason] || repair.reason;
  // The "apply repair" button appears once a corrective recording is finalized
  // (an approved draft) — it merges the correction into the failed procedure.
  const correctiveReady = state.lastDraft?.review?.status === 'approved';
  elements.intentRepairApplyButton.hidden = !correctiveReady;
  elements.intentRepairReason.textContent = correctiveReady
    ? `「${repair.procedure_id}」の step ${repair.anchor_step_index + 1}（${reasonLabel}）の修正記録が承認されました。「修正を手順に反映」で手順へマージできます。`
    : `「${repair.procedure_id}」の step ${repair.anchor_step_index + 1} で ${reasonLabel} が発生しました。修正操作を記録してください。`;
}

refresh();

async function refresh() {
  const response = await chrome.runtime.sendMessage({ type: 'bridge:get-state' });
  if (!response?.ok) return showNotice(response?.error || 'Browser Bridge の状態を取得できません。');
  render(response.state);
}

async function invoke(type, payload = {}) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...payload });
    if (!response?.ok) throw new Error(response?.error || '操作を完了できませんでした。');
    render(response.state || state.current);
    return response;
  } catch (error) {
    showNotice(error instanceof Error ? error.message : String(error));
    return null;
  }
}

function render(nextState) {
  state.current = nextState || { connected: null, recording: null, lastDraft: null, notice: null };
  const connected = state.current.connected;
  const recording = state.current.recording;
  const draft = state.current.lastDraft;
  const paused = Boolean(recording?.pausedReason);

  elements.connectionStatus.textContent = paused ? '一時停止中' : connected ? '接続済み' : '未接続';
  elements.connectionStatus.classList.toggle('is-connected', Boolean(connected) && !paused);
  elements.connectionTitle.textContent = connected ? connected.title || '名称のないタブ' : 'タブを接続してください';
  elements.connectionOrigin.textContent = connected ? connected.origin : 'http(s) の通常タブだけを接続できます。';
  elements.connectButton.textContent = paused ? 'このタブへ再接続' : connected ? '接続を更新' : 'このタブを接続';
  elements.disconnectButton.disabled = !connected || Boolean(recording);
  elements.startRecordingButton.disabled = !connected || Boolean(recording);
  elements.resumeRecordingButton.disabled = !paused;
  elements.stopRecordingButton.disabled = !recording;
  elements.discardLastButton.disabled = !recording?.actions?.length;

  const actions = recording?.actions || [];
  elements.recordingCount.textContent = `${actions.length} 操作`;
  elements.omittedCount.textContent = `秘密入力の除外: ${recording?.sensitiveInputOmitted || 0}`;
  renderRecordingActions(actions);
  renderReview(draft);
  renderHandoff(draft);
  renderRepairStatus(state.current);
  showNotice(recording?.pausedReason || state.current.notice || '');
}

function renderHandoff(draft) {
  elements.handoffSteps.replaceChildren();
  const execution = state.current?.execution || null;
  const approved = draft?.review?.status === 'approved';
  const approvedActions = approved ? approvedActionableActions(draft) : [];
  elements.copyDraftButton.disabled = !approved;
  elements.preflightButton.disabled = !approved;
  elements.requestExecutionButton.disabled = !approved || execution?.status === 'running';

  renderInputFields(approvedActions);
  renderExecutionResults(execution);

  if (!draft) {
    elements.handoffStatus.textContent = 'Review を確定すると、承認済み操作だけを含む handoff 下書きが準備されます。';
    appendHandoffStep('1. 操作を記録', 'pending');
    appendHandoffStep('2. Review で承認または除外', 'pending');
    appendHandoffStep('3. Kyberion preflight', 'blocked');
    return;
  }
  if (!approved) {
    elements.handoffStatus.textContent = draft.review?.status === 'rejected'
      ? 'この下書きは拒否済みです。実行・preflight には進みません。'
      : 'Review が未確定です。承認済み操作をまだ Kyberion へ渡しません。';
    appendHandoffStep('1. Review を確定', draft.review?.status === 'rejected' ? 'rejected' : 'pending');
    appendHandoffStep('2. Kyberion preflight', 'blocked');
    return;
  }

  const highRisk = approvedActions.filter((action) => action.risk === 'high').length;
  elements.handoffStatus.textContent = `${approvedActions.length} 件の操作を承認済み（高リスク ${highRisk} 件）。Native Bridge 経由で preflight → 承認 → lease → Chrome 実行へ進みます。`;
  appendHandoffStep('1. Review 確定', 'completed');
  appendHandoffStep(`2. Kyberion preflight (${approvedActions.length} 操作)`, execution?.preflight ? 'completed' : 'ready');
  appendHandoffStep('3. 承認 + lease 発行', executionLeaseStatus(execution));
  appendHandoffStep('4. Chrome 実行', executionRunStatus(execution));
}

function executionLeaseStatus(execution) {
  if (!execution) return 'ready';
  if (execution.status === 'approval_required') return 'pending';
  if (execution.lease) return 'completed';
  return 'ready';
}

function executionRunStatus(execution) {
  if (!execution) return 'blocked';
  if (execution.status === 'running') return 'ready';
  if (execution.status === 'completed') return 'completed';
  if (['failed', 'cancelled', 'blocked', 'verification_failed'].includes(execution.status)) return 'rejected';
  return 'blocked';
}

function approvedActionableActions(draft) {
  const decisions = new Map((draft.review?.decisions || []).map((entry) => [entry.action_id, entry.status]));
  return draft.actions.filter((action) => action.op !== 'sensitive_input_omitted' && decisions.get(action.action_id) === 'approved');
}

function renderInputFields(approvedActions) {
  const fillActions = approvedActions.filter((action) => action.op === 'fill_ref' && action.variable);
  elements.executionInputsFields.replaceChildren();
  if (fillActions.length === 0) {
    elements.executionInputs.hidden = true;
    return;
  }
  elements.executionInputs.hidden = false;
  const seen = new Set();
  fillActions.forEach((action) => {
    const name = action.variable.name;
    if (seen.has(name)) return;
    seen.add(name);
    const label = document.createElement('label');
    label.className = 'execution-input';
    const span = document.createElement('span');
    span.textContent = action.summary || name;
    const input = document.createElement('input');
    input.type = 'text';
    input.dataset.variable = name;
    input.autocomplete = 'off';
    label.append(span, input);
    elements.executionInputsFields.append(label);
  });
}

function collectInputValues() {
  const values = {};
  elements.executionInputsFields.querySelectorAll('input[data-variable]').forEach((input) => {
    if (input.value) values[input.dataset.variable] = input.value;
  });
  return values;
}

function renderExecutionResults(execution) {
  elements.executionResults.replaceChildren();
  if (!execution) return;

  // #4: segmented (multi-origin) progress — show which origin segment is running.
  if (execution.segment && execution.segment.segmentCount > 1) {
    const seg = document.createElement('li');
    seg.className = 'is-done';
    const t = document.createElement('strong');
    t.textContent = `セグメント ${execution.segment.segmentIndex + 1} / ${execution.segment.segmentCount}`;
    const d = document.createElement('small');
    d.textContent = execution.session?.origin ? `実行中: ${execution.session.origin.replace(/^https?:\/\//, '')}` : 'クロスサイト手順';
    seg.append(t, d);
    elements.executionResults.append(seg);
  }

  // #3: golden-scenario verification verdict.
  if (execution.golden) {
    const g = document.createElement('li');
    g.className = execution.golden.passed ? 'is-done' : 'is-high';
    const t = document.createElement('strong');
    t.textContent = execution.golden.passed ? '✓ 成功条件を満たしました' : '✗ 成功条件の検証に失敗';
    const d = document.createElement('small');
    const failed = (execution.golden.results || []).filter((r) => !r.pass);
    d.textContent = execution.golden.passed
      ? `${(execution.golden.results || []).length} 条件 OK`
      : failed.map((r) => `${r.kind}: ${r.detail || 'NG'}`).join(' / ');
    g.append(t, d);
    elements.executionResults.append(g);
  }

  if (!execution.results?.length) return;
  execution.results.forEach((result, index) => {
    const item = document.createElement('li');
    item.className = result.status === 'done' ? 'is-done' : result.status === 'skipped' ? '' : 'is-high';
    const title = document.createElement('strong');
    title.textContent = `${index + 1}. ${result.op || ''}`;
    const detail = document.createElement('small');
    detail.textContent = `${result.status}${result.detail ? ` — ${result.detail}` : ''}`;
    item.append(title, detail);
    elements.executionResults.append(item);
  });
}

function appendHandoffStep(label, status) {
  const item = document.createElement('li');
  const title = document.createElement('strong');
  title.textContent = label;
  const detail = document.createElement('small');
  detail.textContent = status === 'completed' ? '完了' : status === 'ready' ? '準備完了' : status === 'rejected' ? '拒否済み' : status === 'blocked' ? 'Native Bridge 待ち' : '未完了';
  item.append(title, detail);
  elements.handoffSteps.append(item);
}

async function copyApprovedDraft() {
  const draft = state.current?.lastDraft;
  if (draft?.review?.status !== 'approved') return showNotice('承認済みの下書きがありません。');
  try {
    await navigator.clipboard.writeText(JSON.stringify(draft, null, 2));
    showNotice('承認済み下書きをクリップボードへコピーしました。Kyberion Bridge の preflight 入力として渡せます。');
  } catch {
    showNotice('クリップボードへコピーできませんでした。Review の JSON 表示から確認してください。');
  }
}

function renderRecordingActions(actions) {
  elements.recordingActions.replaceChildren();
  actions.forEach((action, index) => {
    elements.recordingActions.append(actionItem(action, `${index + 1}. ${action.summary}`));
  });
}

function renderReview(draft) {
  elements.reviewActions.replaceChildren();
  if (!draft?.review) {
    elements.reviewSummary.textContent = '記録を停止すると、ここに redaction 済みの下書きが表示されます。';
    elements.draftPreview.textContent = '';
    elements.finalizeReviewButton.disabled = true;
    elements.rejectDraftButton.disabled = true;
    return;
  }

  const decisions = new Map(draft.review.decisions.map((entry) => [entry.action_id, entry]));
  const actionable = draft.actions.filter((action) => action.op !== 'sensitive_input_omitted');
  const hasPending = actionable.some((action) => decisions.get(action.action_id)?.status === 'pending');
  const hasApproved = actionable.some((action) => decisions.get(action.action_id)?.status === 'approved');
  const final = ['approved', 'rejected'].includes(draft.review.status);
  elements.reviewSummary.textContent = reviewMessage(draft.review.status, hasPending, hasApproved);
  elements.finalizeReviewButton.disabled = final || hasPending || !hasApproved;
  elements.rejectDraftButton.disabled = final;
  elements.draftPreview.textContent = JSON.stringify(draft, null, 2);

  draft.actions.forEach((action, index) => {
    const decision = decisions.get(action.action_id) || { status: 'pending' };
    const item = actionItem(action, `${index + 1}. ${action.summary}`);
    const reviewState = document.createElement('small');
    reviewState.textContent = `Review: ${decision.status}`;
    item.append(reviewState);
    if (!final && action.op !== 'sensitive_input_omitted') {
      const controls = document.createElement('div');
      controls.className = 'review-controls';
      controls.append(
        decisionButton('承認', 'approved', action.action_id, decision.status === 'approved'),
        decisionButton('除外', 'rejected', action.action_id, decision.status === 'rejected'),
      );
      item.append(controls);
    }
    elements.reviewActions.append(item);
  });
}

function actionItem(action, label) {
  const item = document.createElement('li');
  item.className = action.risk === 'sensitive' ? 'is-sensitive' : action.risk === 'high' ? 'is-high' : '';
  const title = document.createElement('strong');
  title.textContent = label;
  const detail = document.createElement('small');
  detail.textContent = `${action.op} / ${action.risk}`;
  item.append(title, detail);
  return item;
}

function decisionButton(label, decision, actionId, selected) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = selected ? 'decision-button is-selected' : 'decision-button';
  button.textContent = label;
  button.addEventListener('click', () => invoke('bridge:review-action', { actionId, decision }));
  return button;
}

function reviewMessage(status, hasPending, hasApproved) {
  if (status === 'approved') return '下書きを確定しました。承認済み操作だけが pipeline candidate に含まれます。';
  if (status === 'rejected') return '下書きを拒否しました。実行対象にはなりません。';
  if (hasPending) return '各操作を承認または除外してください。値や秘密情報は記録されません。';
  return hasApproved ? '確定すると、承認済み操作だけが candidate に残ります。' : '操作をすべて除外する場合は、下書きを拒否してください。';
}

function selectTab(tabName) {
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.tab === tabName));
  document.querySelectorAll('.panel').forEach((panel) => panel.classList.toggle('is-active', panel.dataset.panel === tabName));
}

function showNotice(message) {
  elements.notice.textContent = message;
}
