/** Profile defaults editor. Authority and profile selection remain server-side. */
const FIELDS = Object.freeze([
  'ffmpeg_bin',
  'ffprobe_bin',
  'python_bin',
  'audio_record_command',
  'audio_playback_backend',
  'fluid_audio_stt_command',
  'streaming_stt_bridge',
  'streaming_tts_bridge',
  'agent_runtime_backend',
  'agent_pane_runtime_provider',
]);
const ENDPOINT = '/api/voice/engine-config';

export function mountEngineConfig(root, fetchImpl) {
  const form = root.querySelector('#engine-form');
  const fieldset = root.querySelector('#engine-fields');
  const saveButton = root.querySelector('#engine-save');
  const reloadButton = root.querySelector('#engine-reload');
  const status = root.querySelector('#engine-status');
  const profile = root.querySelector('#engine-profile');
  const controls = new Map(FIELDS.map((key) => [key, form.querySelector('[name="' + key + '"]')]));
  let baseline = {};
  let revision;
  let loaded = false;
  let busy = false;
  let conflicted = false;
  const text = (key) => root.querySelector('[data-message="' + key + '"]').textContent;
  const mutation = () => {
    const patch = {};
    const unset = [];
    for (const [key, control] of controls) {
      const value = control.value.trim();
      if (value === (baseline[key] ?? '')) continue;
      if (value) patch[key] = value;
      else unset.push(key);
    }
    return { patch, unset };
  };
  const dirty = () => {
    const changes = mutation();
    return Object.keys(changes.patch).length > 0 || changes.unset.length > 0;
  };
  const sync = () => {
    fieldset.disabled = busy || !loaded;
    saveButton.disabled = busy || !loaded || conflicted || !dirty();
    reloadButton.disabled = busy;
    form.setAttribute('aria-busy', String(busy));
  };
  const show = (key, error = false) => {
    status.textContent = text(key);
    status.dataset.state = error ? 'error' : 'ready';
    if (error) status.focus();
  };
  const apply = (data) => {
    if (
      !data ||
      data.ok !== true ||
      !data.preferences ||
      typeof data.preferences !== 'object' ||
      !/^[a-f0-9]{64}$/.test(data.revision) ||
      !['personal', 'customer'].includes(data.profile?.kind) ||
      typeof data.profile.id !== 'string'
    )
      throw new Error('invalid_response');
    for (const key of FIELDS) {
      const value = data.preferences[key];
      if (value !== undefined && typeof value !== 'string') throw new Error('invalid_response');
      if (
        key === 'agent_runtime_backend' &&
        value !== undefined &&
        !['pipe', 'pane'].includes(value)
      )
        throw new Error('invalid_response');
    }
    baseline = Object.fromEntries(FIELDS.map((key) => [key, data.preferences[key] ?? '']));
    for (const [key, control] of controls) control.value = baseline[key];
    profile.textContent = text('profile_' + data.profile.kind) + ' · ' + data.profile.id;
    revision = data.revision;
    loaded = true;
    conflicted = false;
  };
  const request = async (options) => {
    const response = await fetchImpl(ENDPOINT, {
      cache: 'no-store',
      credentials: 'same-origin',
      ...options,
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw Object.assign(new Error('request_failed'), { status: response.status });
    }
    if (!response.ok || data?.ok !== true)
      throw Object.assign(new Error('request_failed'), { status: response.status });
    return data;
  };
  const failure = (error, fallback) => {
    if (error?.status === 409) {
      conflicted = true;
      show('conflict', true);
    } else if ([401, 403].includes(error?.status)) show('denied', true);
    else if (error?.status === 400) show('invalid', true);
    else show(fallback, true);
  };
  const load = async () => {
    if (busy) return false;
    busy = true;
    loaded = false;
    sync();
    show('loading');
    try {
      apply(await request());
      show('ready');
      return true;
    } catch (error) {
      failure(error, 'load_failed');
      return false;
    } finally {
      busy = false;
      sync();
    }
  };
  const save = async () => {
    if (busy || !loaded || conflicted) return false;
    const changes = mutation();
    if (!Object.keys(changes.patch).length && !changes.unset.length) {
      show('unchanged');
      return false;
    }
    busy = true;
    sync();
    show('saving');
    try {
      apply(
        await request({
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...changes, expected_revision: revision }),
        })
      );
      show('saved');
      return true;
    } catch (error) {
      failure(error, 'save_failed');
      return false;
    } finally {
      busy = false;
      sync();
    }
  };
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void save();
  });
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  reloadButton.addEventListener('click', () => {
    void load();
  });
  return { load, save, ready: load() };
}

if (typeof globalThis.document !== 'undefined') {
  const root = globalThis.document.getElementById('engine-config');
  if (root) mountEngineConfig(root, globalThis.fetch.bind(globalThis));
}
