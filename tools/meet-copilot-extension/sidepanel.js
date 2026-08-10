/**
 * Kyberion Meeting Copilot — side panel (on-device AI surface).
 *
 * The panel is the ONLY place a model runs: it pulls the redacted caption
 * buffer from the service worker, calls Chrome Built-in AI (Gemini Nano) via
 * meeting-ai.js, and hands the result back to the worker, which relays it to
 * the meeting driver. Nothing generated here is spoken or posted without an
 * explicit click on a suggestion.
 */

const elements = {
  notice: document.querySelector('#notice'),
  statusWs: document.querySelector('#status-ws'),
  statusPhase: document.querySelector('#status-phase'),
  statusCaptions: document.querySelector('#status-captions'),
  aiAvailability: document.querySelector('#ai-availability'),
  aiPrepareButton: document.querySelector('#ai-prepare-button'),
  aiPrepareStatus: document.querySelector('#ai-prepare-status'),
  summaryButton: document.querySelector('#summary-button'),
  summaryStatus: document.querySelector('#summary-status'),
  summaryOutput: document.querySelector('#summary-output'),
  rollingToggle: document.querySelector('#rolling-toggle'),
  rollingInterval: document.querySelector('#rolling-interval'),
  insightsButton: document.querySelector('#insights-button'),
  insightsStatus: document.querySelector('#insights-status'),
  insightsOutput: document.querySelector('#insights-output'),
  suggestRole: document.querySelector('#suggest-role'),
  suggestGoal: document.querySelector('#suggest-goal'),
  suggestButton: document.querySelector('#suggest-button'),
  suggestStatus: document.querySelector('#suggest-status'),
  suggestOutput: document.querySelector('#suggest-output'),
  transcriptOutput: document.querySelector('#transcript-output'),
};

const state = {
  transcript: [],
  summary: '',
  summarizedLines: 0,
  busy: false,
};
const aiReady = new Set();

function send(type, extra) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(extra || {}) }, (response) => {
      // A dead worker surfaces as lastError; treat it as a failed call.
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(response || {});
    });
  });
}

function showNotice(message, kind) {
  elements.notice.textContent = message || '';
  elements.notice.classList.toggle('is-error', kind === 'error');
}

function aiAdapter() {
  const adapter = globalThis.KyberionMeetingAI;
  if (!adapter) throw new Error('Chrome Built-in AI adapter が読み込まれていません。');
  return adapter;
}

function aiAvailabilityLabel(value) {
  if (typeof value === 'string') {
    return (
      {
        available: '利用可能',
        downloadable: 'モデル取得可能',
        downloading: 'モデル取得中',
        unavailable: '利用不可',
        unsupported: 'APIなし',
      }[value] || value
    );
  }
  return value?.status === 'error' ? '確認エラー' : '不明';
}

function updateAiProgress(element, loaded) {
  if (!Number.isFinite(loaded)) return;
  element.textContent = `Chrome 内蔵 AI のモデルを準備中… ${Math.round(loaded * 100)}%`;
}

async function ensureAiReady(preferred, statusElement) {
  const key = preferred === 'prompt' ? 'chrome-prompt' : 'any';
  if (
    aiReady.has(key) ||
    (key === 'any' && (aiReady.has('chrome-prompt') || aiReady.has('chrome-summarizer')))
  ) {
    return;
  }
  statusElement.textContent = 'Chrome 内蔵 AI のモデルを準備しています…';
  const result = await aiAdapter().prepare({
    preferred,
    onProgress: (loaded) => updateAiProgress(statusElement, loaded),
  });
  aiReady.add(result.provider);
}

async function refreshAvailability() {
  try {
    const result = await aiAdapter().availability();
    elements.aiAvailability.textContent =
      `Prompt API: ${aiAvailabilityLabel(result.prompt)} / ` +
      `Summarizer API: ${aiAvailabilityLabel(result.summarizer)}`;
  } catch (error) {
    elements.aiAvailability.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Hand a generated artifact to the worker, which forwards it to the driver. */
async function relay(kind, provider, payload) {
  const response = await send('panel:ai-result', { kind, provider, payload });
  return response?.ok ? 'driver へ送信済み' : `driver 未送信 (${response?.error || 'unknown'})`;
}

function transcriptText() {
  return state.transcript.map((entry) => entry.text);
}

function renderTranscript() {
  const lines = state.transcript.slice(-60).map((entry) => entry.text);
  elements.transcriptOutput.textContent = lines.length
    ? lines.join('\n')
    : 'まだ字幕を受信していません。';
}

function renderStatus(status) {
  elements.statusWs.textContent = status.wsConnected ? 'connected' : 'disconnected';
  elements.statusPhase.textContent = status.phase || 'idle';
  elements.statusCaptions.textContent = String(state.transcript.length);
}

async function pullState() {
  const status = await send('panel:get-state');
  if (Array.isArray(status.transcript)) {
    state.transcript = status.transcript;
    renderTranscript();
  }
  renderStatus(status);
}

async function prepareAi() {
  elements.aiPrepareStatus.textContent = 'モデルの状態を確認しています…';
  const result = await aiAdapter().prepare({
    onProgress: (loaded) => updateAiProgress(elements.aiPrepareStatus, loaded),
  });
  aiReady.add(result.provider);
  elements.aiPrepareStatus.textContent = `準備完了: ${result.provider}`;
  await refreshAvailability();
}

async function runSummary({ rolling = false } = {}) {
  const transcript = transcriptText();
  if (transcript.length === 0) throw new Error('要約する字幕がまだありません。');
  // Rolling updates merge into the existing summary; a manual run rebuilds it.
  const previousSummary = rolling ? state.summary : '';
  await ensureAiReady(previousSummary ? 'prompt' : 'any', elements.summaryStatus);
  elements.summaryStatus.textContent = rolling ? '要約を更新しています…' : '要約を生成しています…';
  const result = await aiAdapter().summarizeMeeting({
    transcript,
    previousSummary,
    onProgress: (loaded) => updateAiProgress(elements.summaryStatus, loaded),
  });
  state.summary = result.text;
  state.summarizedLines = transcript.length;
  elements.summaryOutput.hidden = false;
  elements.summaryOutput.textContent = result.text;
  const relayStatus = await relay('summary', result.provider, {
    text: result.text,
    mode: result.mode,
  });
  elements.summaryStatus.textContent =
    `ローカル生成: ${result.provider} (${result.mode}) — ${relayStatus}` +
    (result.truncated ? ' / 古い発言は入力上限で切り捨てました' : '');
}

function listBlock(title, items) {
  if (!items || items.length === 0) return `<h3>${title}</h3><p class="empty">なし</p>`;
  const rows = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<h3>${title}</h3><ul>${rows}</ul>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]
  );
}

async function runInsights() {
  const transcript = transcriptText();
  if (transcript.length === 0) throw new Error('抽出する字幕がまだありません。');
  await ensureAiReady('prompt', elements.insightsStatus);
  elements.insightsStatus.textContent = '決定事項と ToDo を抽出しています…';
  const result = await aiAdapter().extractInsights({
    transcript,
    title: document.title,
    onProgress: (loaded) => updateAiProgress(elements.insightsStatus, loaded),
  });
  const insights = result.insights;
  const actionRows = insights.action_items.map(
    (item) => `${item.owner} / ${item.task} / 期限: ${item.due} (確度: ${item.confidence})`
  );
  elements.insightsOutput.hidden = false;
  elements.insightsOutput.innerHTML = [
    listBlock('決定事項', insights.decisions),
    listBlock('アクションアイテム', actionRows),
    listBlock('未解決の論点', insights.open_questions),
    listBlock('リスク', insights.risks),
  ].join('');
  const relayStatus = await relay('insights', result.provider, { insights });
  elements.insightsStatus.textContent =
    `ローカル生成: ${result.provider} — ${relayStatus} / 発言に基づく候補です。確定前に確認してください。` +
    (result.truncated ? ' 古い発言は入力上限で切り捨てました。' : '');
}

function renderSuggestions(suggestions) {
  elements.suggestOutput.textContent = '';
  elements.suggestOutput.hidden = suggestions.length === 0;
  const kindLabel = {
    question: '質問',
    answer: '返答',
    clarify: '確認',
    summarize: '要点整理',
  };
  for (const suggestion of suggestions) {
    const item = document.createElement('li');
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = kindLabel[suggestion.kind] || suggestion.kind;
    const text = document.createElement('p');
    text.className = 'text';
    text.textContent = suggestion.text;
    const why = document.createElement('p');
    why.className = 'why';
    why.textContent = suggestion.why;
    const actions = document.createElement('div');
    actions.className = 'actions';

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'text-button';
    copyButton.textContent = 'コピー';
    copyButton.addEventListener('click', async () => {
      await navigator.clipboard.writeText(suggestion.text);
      showNotice('候補をコピーしました。');
    });

    const sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'secondary';
    sendButton.textContent = 'チャットに送信';
    sendButton.addEventListener('click', async () => {
      sendButton.disabled = true;
      const response = await send('panel:send-chat', { text: suggestion.text });
      sendButton.disabled = false;
      showNotice(
        response?.ok
          ? 'チャットに送信しました。'
          : `送信できませんでした: ${response?.error || ''}`,
        response?.ok ? undefined : 'error'
      );
    });

    actions.append(copyButton, sendButton);
    item.append(kind, text, why, actions);
    elements.suggestOutput.append(item);
  }
}

async function runSuggestions() {
  const transcript = transcriptText();
  if (transcript.length === 0) throw new Error('サジェストの材料になる字幕がまだありません。');
  await ensureAiReady('prompt', elements.suggestStatus);
  elements.suggestStatus.textContent = '発言候補を生成しています…';
  const result = await aiAdapter().suggestUtterances({
    transcript,
    role: elements.suggestRole.value,
    goal: elements.suggestGoal.value,
    onProgress: (loaded) => updateAiProgress(elements.suggestStatus, loaded),
  });
  renderSuggestions(result.suggestions);
  const relayStatus = await relay('suggestions', result.provider, {
    suggestions: result.suggestions,
  });
  elements.suggestStatus.textContent =
    result.suggestions.length === 0
      ? '候補を生成できませんでした。'
      : `ローカル生成: ${result.provider} — ${relayStatus} / 送信は手動です。`;
}

// Serializes AI work: Gemini Nano sessions are expensive and a rolling update
// firing on top of a manual run would interleave two summaries of the same text.
function bindAction(button, handler, statusElement) {
  button.addEventListener('click', async () => {
    if (state.busy) {
      showNotice('別の AI 処理を実行中です。', 'error');
      return;
    }
    state.busy = true;
    button.disabled = true;
    showNotice('');
    try {
      await handler();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (statusElement) statusElement.textContent = message;
      showNotice(message, 'error');
    } finally {
      state.busy = false;
      button.disabled = false;
    }
  });
}

bindAction(elements.aiPrepareButton, prepareAi, elements.aiPrepareStatus);
bindAction(elements.summaryButton, () => runSummary({ rolling: false }), elements.summaryStatus);
bindAction(elements.insightsButton, runInsights, elements.insightsStatus);
bindAction(elements.suggestButton, runSuggestions, elements.suggestStatus);

function rollingInterval() {
  const value = Number(elements.rollingInterval.value);
  return Number.isFinite(value) && value >= 5 ? Math.floor(value) : 20;
}

async function maybeRollingSummary() {
  if (!elements.rollingToggle.checked || state.busy) return;
  if (state.transcript.length - state.summarizedLines < rollingInterval()) return;
  state.busy = true;
  try {
    await runSummary({ rolling: true });
  } catch (error) {
    elements.summaryStatus.textContent = error instanceof Error ? error.message : String(error);
    // A failed rolling run must not retry on every single caption.
    state.summarizedLines = state.transcript.length;
  } finally {
    state.busy = false;
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === 'panel:caption' && message.entry) {
    state.transcript.push(message.entry);
    elements.statusCaptions.textContent = String(state.transcript.length);
    renderTranscript();
    maybeRollingSummary();
  }
});

async function init() {
  await pullState();
  await refreshAvailability();
  setInterval(pullState, 5000);
}

init();
