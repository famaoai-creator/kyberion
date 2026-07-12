/* global document, MediaRecorder */

const steps = [
  ['welcome', 'Welcome'],
  ['identity', 'Identity'],
  ['readiness', 'Readiness'],
  ['voice', 'Voice'],
  ['services', 'Services'],
  ['models', 'Models'],
  ['tools', 'Tools'],
  ['review', 'Review'],
];
let stepIndex = 0;
let serverState = {};
let providerPriority = ['claude', 'codex', 'gemini'];
let samples = [];
let recorder = null;
let recordingChunks = [];
const $ = (id) => document.getElementById(id);
const notice = (message, error = false) => {
  const el = $('notice');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.remove('hidden');
};
const clearNotice = () => $('notice').classList.add('hidden');
function renderNav() {
  const nav = $('step-nav');
  nav.innerHTML = steps
    .map(
      ([id, label], i) =>
        `<button type="button" data-index="${i}" class="${i === stepIndex ? 'active' : ''}"><span>${String(i + 1).padStart(2, '0')}</span>${label}</button>`
    )
    .join('');
  nav
    .querySelectorAll('button')
    .forEach((button) => (button.onclick = () => goTo(Number(button.dataset.index))));
}
function goTo(index) {
  clearNotice();
  stepIndex = Math.max(0, Math.min(steps.length - 1, index));
  document
    .querySelectorAll('.step')
    .forEach((el, i) => el.classList.toggle('active', i === stepIndex));
  $('step-count').textContent =
    `${String(stepIndex + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`;
  $('progress-bar').style.width = `${((stepIndex + 1) / steps.length) * 100}%`;
  $('back-button').disabled = stepIndex === 0;
  $('next-button').classList.toggle('hidden', stepIndex === steps.length - 1);
  renderNav();
  if (steps[stepIndex][0] === 'review') void preview();
}
function renderReadiness() {
  const mic = serverState.readiness?.microphone;
  const cards = [
    [
      'Identity',
      serverState.identity ? 'ready' : 'blocked',
      serverState.identity ? 'Profile detected' : 'Identity is not configured',
    ],
    [
      'Reasoning',
      providerPriority.length ? 'ready' : 'blocked',
      `${providerPriority.length} providers in fallback chain`,
    ],
    [
      'Microphone',
      mic?.available ? 'ready' : 'blocked',
      mic?.available ? 'Capture device available' : mic?.reason || 'Not detected',
    ],
    [
      'Voice',
      serverState.voice_profiles?.length ? 'ready' : 'optional',
      `${serverState.voice_profiles?.length || 0} profiles available`,
    ],
    [
      'Services',
      serverState.service_bindings?.length ? 'ready' : 'optional',
      `${serverState.service_bindings?.length || 0} active bindings`,
    ],
    ['Browser', 'ready', 'Presence Studio is connected'],
  ];
  $('readiness-grid').innerHTML = cards
    .map(
      ([name, status, detail]) =>
        `<article class="readiness-card"><span class="badge ${status === 'blocked' ? 'blocked' : ''}">${status.toUpperCase()}</span><strong>${name}</strong><small>${detail}</small></article>`
    )
    .join('');
}
const serviceMeta = {
  github: ['GitHub', 'Repository, issue and PR workflows', 'oauth'],
  'google-workspace': ['Google Workspace', 'Calendar, Gmail and Drive', 'oauth'],
  'microsoft-365': ['Microsoft 365', 'Teams, Outlook and OneDrive', 'oauth'],
  slack: ['Slack', 'Mission notifications and approvals', 'oauth'],
  comfyui: ['ComfyUI', 'Local image and video generation', 'none'],
  'voice-hub': ['Voice Hub', 'Speech input and output runtime', 'none'],
  browser: ['Browser', 'Authenticated browser automation', 'session'],
};
function renderServices() {
  const selected = new Map((serverState.onboarding?.services || []).map((x) => [x.service_id, x]));
  $('service-grid').innerHTML = Object.entries(serviceMeta)
    .map(
      ([id, [name, detail, auth]]) =>
        `<label class="service-card ${selected.has(id) ? 'selected' : ''}"><input type="checkbox" data-service="${id}" data-auth="${auth}" ${selected.has(id) ? 'checked' : ''}/><em>${auth.toUpperCase()}</em><strong>${name}</strong><small>${detail}</small></label>`
    )
    .join('');
  $('service-grid')
    .querySelectorAll('input')
    .forEach(
      (el) => (el.onchange = () => el.closest('label').classList.toggle('selected', el.checked))
    );
}
function renderProviders() {
  const models = serverState.providers?.default_models || {};
  $('provider-list').innerHTML = providerPriority
    .map(
      (provider, i) =>
        `<div class="priority-item"><span class="priority-rank">${String(i + 1).padStart(2, '0')}</span><strong>${provider}</strong><input data-model="${provider}" value="${models[provider] || ''}" placeholder="default model"/><div class="priority-actions"><button type="button" data-move="up" data-index="${i}">↑</button><button type="button" data-move="down" data-index="${i}">↓</button></div></div>`
    )
    .join('');
  $('provider-list')
    .querySelectorAll('[data-move]')
    .forEach(
      (btn) =>
        (btn.onclick = () => {
          const i = Number(btn.dataset.index),
            j = btn.dataset.move === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= providerPriority.length) return;
          [providerPriority[i], providerPriority[j]] = [providerPriority[j], providerPriority[i]];
          renderProviders();
        })
    );
}
function collectDraft() {
  const defaultModels = {};
  document.querySelectorAll('[data-model]').forEach((input) => {
    if (input.value.trim()) defaultModels[input.dataset.model] = input.value.trim();
  });
  const services = [...document.querySelectorAll('[data-service]:checked')].map((input) => ({
    service_id: input.dataset.service,
    auth_mode: input.dataset.auth,
    required: false,
  }));
  return {
    version: '1.0.0',
    identity: {
      name: $('identity-name').value.trim(),
      language: $('language').value,
      interaction_style: $('interaction-style').value,
      primary_domain: $('primary-domain').value.trim(),
      vision: $('vision').value.trim(),
      agent_id: $('agent-id').value.trim(),
    },
    voice: {
      enabled: $('voice-enabled').checked,
      profile_id: $('voice-profile-id').value.trim() || undefined,
      display_name: $('voice-display-name').value.trim() || undefined,
      language: $('language').value,
      engine_id: $('voice-engine').value,
      sample_refs: samples.map((x) => x.sample_ref),
    },
    services,
    providers: { priority: providerPriority, default_models: defaultModels },
    tools: {
      mode_preference: {
        python: $('tool-python').value,
        node: $('tool-node').value,
        system: $('tool-system').value,
      },
      install_requires_approval: $('install-approval').checked,
      pin_requires_approval: $('pin-approval').checked,
    },
    tutorial: {
      mode: 'simulate',
      summary: `First ${document.querySelector('[name=purpose]:checked')?.value || 'operations'} tutorial`,
    },
  };
}
async function preview() {
  try {
    const response = await fetch('/api/onboarding/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectDraft()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Preview failed');
    const grouped = {
      Identity: payload.effects.filter((x) => ['identity', 'vision', 'agent'].includes(x.kind)),
      Runtime: payload.effects.filter((x) => ['providers', 'tools', 'state'].includes(x.kind)),
      Connections: payload.effects.filter((x) => ['service', 'voice'].includes(x.kind)),
    };
    $('review-summary').innerHTML =
      Object.entries(grouped)
        .map(
          ([title, items]) =>
            `<section class="review-block"><h3>${title}</h3><ul>${items.map((x) => `<li>${x.description}</li>`).join('') || '<li>No changes</li>'}</ul></section>`
        )
        .join('') +
      (payload.warnings.length
        ? `<section class="review-block warning"><h3>Warnings</h3><ul>${payload.warnings.map((x) => `<li>${x}</li>`).join('')}</ul></section>`
        : '');
    return payload;
  } catch (error) {
    $('review-summary').innerHTML =
      `<section class="review-block warning"><h3>Preview blocked</h3><p>${error.message}</p></section>`;
    notice(error.message, true);
    throw error;
  }
}
async function apply() {
  try {
    $('apply-button').disabled = true;
    $('apply-button').textContent = '適用しています…';
    const response = await fetch('/api/onboarding/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectDraft()),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Apply failed');
    $('review-summary').innerHTML =
      `<div class="success-card"><p class="eyebrow">ACTIVATED</p><h3>Kyberionの設定を適用しました。</h3><p>${payload.artifacts.length} artifacts updated · ${new Date(payload.applied_at).toLocaleString()}</p><a href="/">Presence Studioへ戻る →</a></div>`;
    $('save-state').textContent = 'APPLIED';
    $('apply-consent').closest('label').classList.add('hidden');
    $('apply-button').classList.add('hidden');
  } catch (error) {
    notice(error.message, true);
    $('apply-button').disabled = false;
    $('apply-button').textContent = '設定を適用してKyberionを起動';
  }
}
async function toggleRecording() {
  if (recorder?.state === 'recording') {
    recorder.stop();
    return;
  }
  const profile = $('voice-profile-id').value.trim();
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(profile)) {
    notice('録音前に有効なProfile IDを入力してください', true);
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingChunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size) recordingChunks.push(e.data);
    };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      $('record-button').classList.remove('recording');
      $('record-label').textContent = 'アップロード中…';
      try {
        const blob = new Blob(recordingChunks, { type: recorder.mimeType || 'audio/webm' });
        const response = await fetch(
          `/api/onboarding/voice-sample?profile_id=${encodeURIComponent(profile)}`,
          { method: 'POST', headers: { 'Content-Type': blob.type.split(';')[0] }, body: blob }
        );
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error);
        samples.push(payload);
        renderSamples();
        $('voice-enabled').checked = true;
        $('record-label').textContent = 'もう一つ録音する';
      } catch (error) {
        notice(error.message, true);
        $('record-label').textContent = '録音を開始';
      }
    };
    recorder.start();
    $('record-button').classList.add('recording');
    $('record-label').textContent = '録音中 — クリックして停止';
  } catch (error) {
    notice(`マイクを開始できません: ${error.message}`, true);
  }
}
function renderSamples() {
  $('sample-list').innerHTML = samples
    .map(
      (sample, i) =>
        `<div class="sample-item"><span>SAMPLE ${i + 1}</span><span>${Math.round(sample.bytes / 1024)} KB</span></div>`
    )
    .join('');
}
async function load() {
  try {
    const response = await fetch('/api/onboarding/browser-state');
    serverState = await response.json();
    if (!response.ok) throw new Error(serverState.error);
    providerPriority = serverState.providers?.priority || providerPriority;
    const identity = serverState.identity || {};
    $('identity-name').value = identity.name || '';
    const language = String(identity.language || 'ja').toLowerCase();
    $('language').value = language === 'english' || language.startsWith('en') ? 'en' : 'ja';
    $('interaction-style').value = identity.interaction_style || 'Senior Partner';
    $('primary-domain').value = identity.primary_domain || '';
    $('agent-id').value = serverState.agent_identity?.agent_id || 'KYBERION-PRIME';
    $('profile-status').textContent = serverState.onboarding ? 'ONBOARDED' : 'DRAFT PROFILE';
    $('readiness-dot').classList.toggle('ready', Boolean(serverState.identity));
    renderReadiness();
    renderServices();
    renderProviders();
  } catch (error) {
    notice(`状態を読み込めません: ${error.message}`, true);
    renderServices();
    renderProviders();
  }
}
document
  .querySelectorAll('[name=purpose]')
  .forEach(
    (input) =>
      (input.onchange = () =>
        document
          .querySelectorAll('.choice')
          .forEach((x) => x.classList.toggle('selected', x.querySelector('input').checked)))
  );
document.querySelectorAll('[data-preset]').forEach(
  (btn) =>
    (btn.onclick = () => {
      document
        .querySelectorAll('[data-preset]')
        .forEach((x) => x.classList.toggle('active', x === btn));
      providerPriority =
        btn.dataset.preset === 'quality'
          ? ['claude', 'codex', 'gemini']
          : btn.dataset.preset === 'fast'
            ? ['gemini', 'codex', 'claude']
            : ['codex', 'claude', 'gemini'];
      renderProviders();
    })
);
$('record-button').onclick = toggleRecording;
$('back-button').onclick = () => goTo(stepIndex - 1);
$('next-button').onclick = () => goTo(stepIndex + 1);
$('apply-consent').onchange = () => {
  $('apply-button').disabled = !$('apply-consent').checked;
};
$('apply-button').onclick = apply;
renderNav();
void load();
