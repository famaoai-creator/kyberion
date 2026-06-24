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
  copyDraftButton: document.querySelector('#copy-draft-button'),
  requestExecutionButton: document.querySelector('#request-execution-button'),
  notice: document.querySelector('#notice'),
};

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => selectTab(tab.dataset.tab));
});

elements.connectButton.addEventListener('click', () => invoke('bridge:connect-active-tab'));
elements.disconnectButton.addEventListener('click', () => invoke('bridge:disconnect'));
elements.startRecordingButton.addEventListener('click', () => invoke('bridge:start-recording'));
elements.resumeRecordingButton.addEventListener('click', () => invoke('bridge:resume-recording'));
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
elements.requestExecutionButton.addEventListener('click', () => invoke('bridge:request-execution'));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'bridge:state-changed') render(message.state);
});

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
  showNotice(recording?.pausedReason || state.current.notice || '');
}

function renderHandoff(draft) {
  elements.handoffSteps.replaceChildren();
  const approved = draft?.review?.status === 'approved';
  const approvedCount = approved
    ? draft.review.decisions.filter((decision) => decision.status === 'approved').length
    : 0;
  elements.copyDraftButton.disabled = !approved;

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

  elements.handoffStatus.textContent = `${approvedCount} 件の操作を承認済みです。下書きをコピーして Kyberion Bridge に渡すと、schema / policy / capability preflight の対象になります。`;
  appendHandoffStep('1. Review 確定', 'completed');
  appendHandoffStep(`2. Kyberion preflight (${approvedCount} 操作)`, 'ready');
  appendHandoffStep('3. Native Messaging lease 発行', 'blocked');
  appendHandoffStep('4. Chrome 実行', 'blocked');
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
