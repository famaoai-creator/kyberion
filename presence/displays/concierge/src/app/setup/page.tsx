'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';

type Service = { id: string; label: string; auth: string; configured: boolean };
type Setup = {
  surface_roles: Array<{
    id: string;
    role_ja: string;
    tagline_ja: string;
    port: number;
    enabled: boolean;
  }>;
  active_surfaces: Array<{ id: string; port?: number; enabled: boolean }>;
  reasoning_mode: string;
  model_tiers: Record<string, string>;
  commands: Record<string, string>;
  providers?: { priority?: string[]; default_models?: Record<string, string> };
  profile: {
    name: string;
    language: string;
    interaction_style: string;
    primary_domain: string;
    vision: string;
    agent_id: string;
    tenant_slug: string;
    onboarding_complete: boolean;
    avatar_registered: boolean;
    avatar_source?: string;
    voice_profiles: Array<{
      profile_id: string;
      display_name: string;
      sample_count: number;
      sample_refs?: string[];
    }>;
  };
  service_catalog: Service[];
  capabilities: Array<{
    id: string;
    label: string;
    status: string;
    href?: string;
    pipeline?: string;
    command?: string;
  }>;
  tenant: {
    active_slug: string;
    runtime_bound: boolean;
    catalog: Array<{
      tenant_slug: string;
      tenant_id: string;
      display_name: string;
      status: string;
      assigned_role: string;
    }>;
  };
  agent_management: {
    configured: {
      agent_id?: string;
      display_name?: string;
      provider?: string;
      model_id?: string;
    } | null;
    durable_identities: Array<{
      nhi_id: string;
      kind: string;
      display_name: string;
      lifecycle_status: string;
      organization_id: string;
      provider_hint: string;
      model_hint: string;
    }>;
  };
};

type Notice = { text: string; error?: boolean } | null;

const DEFAULT_SERVICES = ['google-workspace', 'slack', 'browser'];

export default function SetupPage() {
  const { locale, setLocale, t } = useConciergeI18n();
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [busy, setBusy] = React.useState(false);
  const [profile, setProfile] = React.useState({
    name: '',
    primary_domain: '',
    vision: '',
    agent_id: 'sovereign-agent',
  });
  const [services, setServices] = React.useState<string[]>(DEFAULT_SERVICES);
  const [voice, setVoice] = React.useState({ profile_id: 'my-voice', display_name: 'My voice' });
  const [voiceSampleRefs, setVoiceSampleRefs] = React.useState<string[]>([]);
  const [management, setManagement] = React.useState({
    tenant_slug: 'default',
    tenant_display_name: 'Default Tenant',
    tenant_role: 'owner',
    agent_id: 'sovereign-agent',
    agent_display_name: 'Kyberion Concierge',
    agent_provider: '',
    agent_model_id: '',
  });
  const [cameraState, setCameraState] = React.useState<'idle' | 'starting' | 'ready'>('idle');
  const [voiceRecording, setVoiceRecording] = React.useState(false);
  const cameraStreamRef = React.useRef<MediaStream | null>(null);
  const cameraVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const cameraCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const voiceStreamRef = React.useRef<MediaStream | null>(null);
  const voiceRecorderRef = React.useRef<MediaRecorder | null>(null);
  const voiceChunksRef = React.useRef<Blob[]>([]);

  const refresh = React.useCallback(async () => {
    try {
      const response = await fetch('/api/setup', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'setup failed');
      const next = payload.setup as Setup;
      setSetup(next);
      setProfile({
        name: next.profile.name,
        primary_domain: next.profile.primary_domain,
        vision: next.profile.vision,
        agent_id: next.profile.agent_id || 'sovereign-agent',
      });
      const tenantProfile = next.tenant.catalog.find(
        (tenant) => tenant.tenant_slug === next.tenant.active_slug
      );
      const configuredAgent = next.agent_management.configured || {};
      setManagement((current) => ({
        tenant_slug: next.tenant.active_slug || current.tenant_slug,
        tenant_display_name: tenantProfile?.display_name || current.tenant_display_name,
        tenant_role: tenantProfile?.assigned_role || current.tenant_role,
        agent_id: String(configuredAgent.agent_id || next.profile.agent_id || current.agent_id),
        agent_display_name: String(configuredAgent.display_name || current.agent_display_name),
        agent_provider: String(configuredAgent.provider || current.agent_provider),
        agent_model_id: String(configuredAgent.model_id || current.agent_model_id),
      }));
      const existingVoice = next.profile.voice_profiles[0];
      if (existingVoice) {
        setVoice({
          profile_id: existingVoice.profile_id || 'my-voice',
          display_name: existingVoice.display_name || 'My voice',
        });
        setVoiceSampleRefs((current) =>
          current.length ? current : existingVoice.sample_refs || []
        );
      }
      setServices(
        next.service_catalog
          .filter((service) => service.configured || DEFAULT_SERVICES.includes(service.id))
          .map((service) => service.id)
      );
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [refresh]);

  const applyOnboarding = React.useCallback(
    async (includeVoice: boolean) => {
      if (!setup) return;
      setBusy(true);
      try {
        const providerPriority = setup.providers?.priority?.length
          ? setup.providers.priority
          : ['codex-cli'];
        const response = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'apply_onboarding',
            draft: {
              version: '1.0.0',
              identity: {
                name: profile.name.trim() || 'user',
                language: 'ja',
                interaction_style: 'Concierge',
                primary_domain: profile.primary_domain.trim() || 'personal operations',
                vision: profile.vision.trim() || t('setup.default_vision'),
                agent_id: profile.agent_id.trim() || 'sovereign-agent',
              },
              voice: {
                enabled: includeVoice,
                profile_id: voice.profile_id,
                display_name: voice.display_name,
                language: 'ja',
                engine_id: 'mlx_audio_qwen3',
                sample_refs: voiceSampleRefs.slice(0, 3),
              },
              services: services.map((service_id) => ({
                service_id,
                auth_mode:
                  service_id === 'browser' || service_id === 'voice-hub' ? 'session' : 'oauth',
                required: service_id === 'google-workspace',
              })),
              providers: {
                priority: providerPriority,
                default_models: setup.providers?.default_models || {},
              },
              tools: {
                mode_preference: {
                  python: 'installed_first',
                  node: 'installed_first',
                  system: 'installed_first',
                },
                install_requires_approval: true,
                pin_requires_approval: true,
              },
              tutorial: { mode: 'simulate', summary: t('setup.tutorial_summary') },
            },
          }),
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'onboarding failed');
        setNotice({
          text: includeVoice ? t('setup.voice_registered') : t('setup.onboarding_saved'),
        });
        await refresh();
      } catch (err) {
        setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setBusy(false);
      }
    },
    [profile, refresh, services, setup, t, voice, voiceSampleRefs]
  );

  const saveManagement = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_management',
          name: profile.name,
          primary_domain: profile.primary_domain,
          vision: profile.vision,
          tenant: {
            slug: management.tenant_slug,
            display_name: management.tenant_display_name,
            assigned_role: management.tenant_role,
          },
          agent: {
            agent_id: management.agent_id,
            display_name: management.agent_display_name,
            provider: management.agent_provider,
            model_id: management.agent_model_id,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'management save failed');
      setNotice({ text: t('setup.management_saved') });
      await refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }, [management, profile, refresh, t]);

  const upload = React.useCallback(
    async (action: 'avatar' | 'voice_sample', file: File, source = 'upload') => {
      setBusy(true);
      try {
        const form = new FormData();
        form.set('action', action);
        form.set('profile_id', voice.profile_id);
        form.set('source', source);
        form.set('file', file);
        const response = await fetch('/api/setup', { method: 'POST', body: form });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || 'upload failed');
        if (action === 'voice_sample') {
          setVoiceSampleRefs((current) => [...current, payload.sample.sample_ref].slice(-3));
        }
        setNotice({ text: action === 'avatar' ? t('setup.avatar_saved') : t('setup.voice_saved') });
        await refresh();
      } catch (err) {
        setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setBusy(false);
      }
    },
    [refresh, t, voice.profile_id]
  );

  const prepareAvatarFile = React.useCallback(async (file: File): Promise<File> => {
    try {
      const bitmap = await createImageBitmap(file);
      const size = Math.min(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.drawImage(
        bitmap,
        (bitmap.width - size) / 2,
        (bitmap.height - size) / 2,
        size,
        size,
        0,
        0,
        512,
        512
      );
      bitmap.close();
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob ? new File([blob], 'avatar.png', { type: 'image/png' }) : file;
    } catch {
      return file;
    }
  }, []);

  const startCamera = React.useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice({ text: t('setup.camera_unavailable'), error: true });
      return;
    }
    setCameraState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user' },
        audio: false,
      });
      cameraStreamRef.current = stream;
      if (cameraVideoRef.current) {
        cameraVideoRef.current.srcObject = stream;
        await cameraVideoRef.current.play();
      }
      setCameraState('ready');
    } catch {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      cameraStreamRef.current = null;
      setCameraState('idle');
      setNotice({ text: t('setup.camera_permission'), error: true });
    }
  }, [t]);

  const stopCamera = React.useCallback(() => {
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    cameraStreamRef.current = null;
    if (cameraVideoRef.current) cameraVideoRef.current.srcObject = null;
    setCameraState('idle');
  }, []);

  const captureAvatar = React.useCallback(async () => {
    const video = cameraVideoRef.current;
    const canvas = cameraCanvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;
    const size = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(
      video,
      (video.videoWidth - size) / 2,
      (video.videoHeight - size) / 2,
      size,
      size,
      0,
      0,
      512,
      512
    );
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    await upload('avatar', new File([blob], 'avatar.png', { type: 'image/png' }), 'camera');
    stopCamera();
  }, [stopCamera, upload]);

  const startVoiceRecording = React.useCallback(async () => {
    if (voiceSampleRefs.length >= 3) {
      setNotice({ text: t('setup.voice_sample_limit'), error: true });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setNotice({ text: t('setup.voice_recording_unavailable'), error: true });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg'].find((candidate) =>
        MediaRecorder.isTypeSupported(candidate)
      );
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      voiceStreamRef.current = stream;
      voiceRecorderRef.current = recorder;
      voiceChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) voiceChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || 'audio/webm';
        const extension = type.includes('ogg') ? 'ogg' : 'webm';
        const file = new File(voiceChunksRef.current, `voice-sample.${extension}`, { type });
        voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
        voiceRecorderRef.current = null;
        setVoiceRecording(false);
        void upload('voice_sample', file, 'microphone');
      };
      recorder.start();
      setVoiceRecording(true);
    } catch {
      setNotice({ text: t('setup.voice_permission'), error: true });
    }
  }, [t, upload, voiceSampleRefs.length]);

  const stopVoiceRecording = React.useCallback(() => {
    voiceRecorderRef.current?.stop();
  }, []);

  if (error) return <div className="notice error">{t('setup.load_error', { error })}</div>;
  if (!setup) return <div className="pane-empty">{t('setup.loading')}</div>;

  const reasoningReady =
    setup.reasoning_mode !== 'not-installed' && setup.reasoning_mode !== 'stub';

  return (
    <div>
      <section className="briefing-card" aria-label={t('setup.onboarding')}>
        <div className="locale-switcher">
          <label>
            {t('locale.label')}
            <select
              value={locale}
              onChange={(event) => setLocale(event.target.value as 'en' | 'ja')}
            >
              <option value="ja">{t('locale.japanese')}</option>
              <option value="en">{t('locale.english')}</option>
            </select>
          </label>
        </div>
        <p className="briefing-sentence">
          {t('setup.briefing', { name: profile.name || t('setup.you') })}
        </p>
        <div className="briefing-counts">
          <span>
            <strong>
              {setup.profile.onboarding_complete ? t('setup.completed') : t('setup.incomplete')}
            </strong>
            {t('setup.onboarding')}
          </span>
          <span>
            <strong>
              {setup.profile.avatar_registered ? t('setup.registered') : t('setup.unregistered')}
            </strong>
            {t('setup.avatar')}
          </span>
          <span>
            <strong>{setup.profile.voice_profiles.length}</strong>
            {t('setup.voice_profiles')}
          </span>
          <span>
            <strong>{reasoningReady ? t('setup.running') : t('setup.needs_setup')}</strong>
            {t('setup.reasoning_backend')}
          </span>
        </div>
      </section>

      {notice ? <div className={`notice${notice.error ? ' error' : ''}`}>{notice.text}</div> : null}

      <div className="pane-grid">
        <section className="pane" aria-label={t('setup.profile_title')}>
          <h2>{t('setup.profile_title')}</h2>
          <p className="pane-subtitle">{t('setup.profile_description')}</p>
          <label className="field-label">
            {t('setup.display_name')}
            <input
              value={profile.name}
              onChange={(event) => setProfile({ ...profile, name: event.target.value })}
              placeholder="e.g. Alex Morgan"
            />
          </label>
          <label className="field-label">
            {t('setup.primary_domain')}
            <input
              value={profile.primary_domain}
              onChange={(event) => setProfile({ ...profile, primary_domain: event.target.value })}
              placeholder="e.g. business development"
            />
          </label>
          <label className="field-label">
            {t('setup.secretary_policy')}
            <textarea
              value={profile.vision}
              onChange={(event) => setProfile({ ...profile, vision: event.target.value })}
              rows={3}
              placeholder={t('setup.priority_placeholder')}
            />
          </label>
          <div className="button-row">
            <button
              className="action-button"
              disabled={busy}
              onClick={() => void applyOnboarding(false)}
            >
              {t('setup.save_profile')}
            </button>
          </div>
        </section>

        <section className="pane" aria-label={t('setup.management_title')}>
          <h2>{t('setup.management_title')}</h2>
          <p className="pane-subtitle">{t('setup.management_description')}</p>
          <label className="field-label">
            {t('setup.tenant')}
            <select
              value={management.tenant_slug}
              onChange={(event) => {
                const selected = setup.tenant.catalog.find(
                  (tenant) => tenant.tenant_slug === event.target.value
                );
                setManagement({
                  ...management,
                  tenant_slug: event.target.value,
                  tenant_display_name: selected?.display_name || event.target.value,
                  tenant_role: selected?.assigned_role || management.tenant_role,
                });
              }}
            >
              {setup.tenant.catalog.map((tenant) => (
                <option key={tenant.tenant_slug} value={tenant.tenant_slug}>
                  {tenant.display_name} ({tenant.tenant_slug})
                </option>
              ))}
            </select>
          </label>
          <label className="field-label">
            {t('setup.tenant_display_name')}
            <input
              value={management.tenant_display_name}
              onChange={(event) =>
                setManagement({ ...management, tenant_display_name: event.target.value })
              }
            />
          </label>
          <label className="field-label">
            {t('setup.tenant_role')}
            <input
              value={management.tenant_role}
              onChange={(event) =>
                setManagement({ ...management, tenant_role: event.target.value })
              }
            />
          </label>
          <p className="item-meta">
            {setup.tenant.runtime_bound
              ? t('setup.tenant_runtime_bound')
              : t('setup.tenant_runtime_unbound')}
          </p>
          <label className="field-label">
            {t('setup.agent_id')}
            <input
              value={management.agent_id}
              onChange={(event) => setManagement({ ...management, agent_id: event.target.value })}
            />
          </label>
          <label className="field-label">
            {t('setup.agent_display_name')}
            <input
              value={management.agent_display_name}
              onChange={(event) =>
                setManagement({ ...management, agent_display_name: event.target.value })
              }
            />
          </label>
          <div className="field-row">
            <input
              aria-label={t('setup.agent_provider')}
              value={management.agent_provider}
              onChange={(event) =>
                setManagement({ ...management, agent_provider: event.target.value })
              }
              placeholder="codex-cli"
            />
            <input
              aria-label={t('setup.agent_model')}
              value={management.agent_model_id}
              onChange={(event) =>
                setManagement({ ...management, agent_model_id: event.target.value })
              }
              placeholder="gpt-5.6-luna"
            />
          </div>
          <p className="item-meta">
            {t('setup.agent_registry_count', {
              count: setup.agent_management.durable_identities.length,
            })}
          </p>
          <div className="button-row">
            <button className="action-button" disabled={busy} onClick={() => void saveManagement()}>
              {t('setup.save_management')}
            </button>
          </div>
        </section>

        <section className="pane" aria-label={t('setup.media_title')}>
          <h2>{t('setup.media_title')}</h2>
          <p className="pane-subtitle">{t('setup.media_description')}</p>
          <div className="item-card">
            <p className="item-title">
              {t('setup.photo_avatar')}{' '}
              <span className={`status-chip${setup.profile.avatar_registered ? '' : ' attention'}`}>
                {setup.profile.avatar_registered ? t('setup.registered') : t('setup.unregistered')}
              </span>
            </p>
            <p className="item-meta">{t('setup.avatar_flow')}</p>
            {cameraState !== 'idle' ? (
              <video
                ref={cameraVideoRef}
                className="media-preview"
                muted
                playsInline
                aria-label={t('setup.camera_preview')}
              />
            ) : null}
            <canvas ref={cameraCanvasRef} hidden />
            <div className="button-row">
              {cameraState === 'idle' ? (
                <button
                  className="action-button secondary"
                  disabled={busy}
                  onClick={() => void startCamera()}
                >
                  {t('setup.open_camera')}
                </button>
              ) : null}
              {cameraState === 'starting' ? (
                <button className="action-button secondary" disabled>
                  {t('setup.camera_starting')}
                </button>
              ) : null}
              {cameraState === 'ready' ? (
                <>
                  <button
                    className="action-button"
                    disabled={busy}
                    onClick={() => void captureAvatar()}
                  >
                    {t('setup.capture_avatar')}
                  </button>
                  <button className="action-button secondary" disabled={busy} onClick={stopCamera}>
                    {t('setup.close_camera')}
                  </button>
                </>
              ) : null}
            </div>
            <p className="item-meta">{t('setup.camera_fallback')}</p>
            <input
              aria-label={t('setup.image_label')}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file)
                  void prepareAvatarFile(file).then((avatar) => upload('avatar', avatar, 'upload'));
              }}
            />
          </div>
          <div className="item-card">
            <p className="item-title">
              {t('setup.voice_profile')} <span className="status-chip">{t('setup.consent')}</span>
            </p>
            <div className="field-row">
              <input
                aria-label={t('setup.voice_id_label')}
                value={voice.profile_id}
                onChange={(event) => setVoice({ ...voice, profile_id: event.target.value })}
                placeholder="my-voice"
              />
              <input
                aria-label={t('setup.voice_name_label')}
                value={voice.display_name}
                onChange={(event) => setVoice({ ...voice, display_name: event.target.value })}
                placeholder="My voice"
              />
            </div>
            <p className="item-meta">
              {t('setup.voice_sample_count', { count: voiceSampleRefs.length })}
            </p>
            <div className="button-row">
              {voiceRecording ? (
                <button className="action-button" disabled={busy} onClick={stopVoiceRecording}>
                  {t('setup.stop_recording')}
                </button>
              ) : (
                <button
                  className="action-button secondary"
                  disabled={busy || voiceSampleRefs.length >= 3}
                  onClick={() => void startVoiceRecording()}
                >
                  {t('setup.record_voice')}
                </button>
              )}
            </div>
            <input
              aria-label={t('setup.voice_sample_label')}
              type="file"
              accept="audio/webm,audio/wav,audio/ogg,audio/mp4"
              disabled={busy || voiceSampleRefs.length >= 3}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload('voice_sample', file, 'upload');
              }}
            />
            <div className="button-row">
              <button
                className="action-button secondary"
                disabled={busy || !voiceSampleRefs.length}
                onClick={() => void applyOnboarding(true)}
              >
                {t('setup.save_voice')}
              </button>
            </div>
          </div>
        </section>

        <section className="pane" aria-label={t('setup.services_title')}>
          <h2>{t('setup.services_title')}</h2>
          <p className="pane-subtitle">{t('setup.services_description')}</p>
          {setup.service_catalog.map((service) => (
            <label className="item-card service-row" key={service.id}>
              <span>
                <input
                  type="checkbox"
                  checked={services.includes(service.id)}
                  onChange={(event) =>
                    setServices((current) =>
                      event.target.checked
                        ? [...current, service.id]
                        : current.filter((id) => id !== service.id)
                    )
                  }
                />{' '}
                {service.label}
              </span>
              <span className={`status-chip${service.configured ? '' : ' attention'}`}>
                {service.configured ? t('setup.connected') : service.auth}
              </span>
            </label>
          ))}
          <div className="button-row">
            <button
              className="action-button"
              disabled={busy}
              onClick={() => void applyOnboarding(false)}
            >
              {t('setup.save_connections')}
            </button>
          </div>
        </section>

        <section className="pane" aria-label={t('setup.operations_title')}>
          <h2>{t('setup.operations_title')}</h2>
          <p className="pane-subtitle">{t('setup.operations_description')}</p>
          {setup.capabilities.map((capability) => (
            <div className="item-card" key={capability.id}>
              <p className="item-title">
                {capability.label}
                <span
                  className={`status-chip${capability.status === 'guided' ? ' attention' : ''}`}
                >
                  {capability.status === 'ready' ? t('setup.available') : t('setup.guided')}
                </span>
              </p>
              <p className="item-meta">
                {capability.href ? (
                  <a href={capability.href}>{t('setup.open_approval_queue')}</a>
                ) : capability.pipeline ? (
                  t('setup.pipeline', { value: capability.pipeline })
                ) : (
                  t('setup.device_command', { value: capability.command || '' })
                )}
              </p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
