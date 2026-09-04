'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import type { ConciergeMessageKey } from '../../lib/i18n';
import { parseSetupResponse, type Setup as SetupPayload } from '../../lib/setup-response';
import { parseConciergeMutationResponse } from '../../lib/mutation-response';

type NotificationChannelOption = { surface: string; display_name: string; status: string };
type NotificationTarget = { surface: string; target: string };
type PluginEntry = {
  id: string;
  trust: string;
  status: string;
  source: string;
  requested_by?: string;
  approval_status?: string;
};
type ConfigPresetInput = {
  key: string;
  type: 'string' | 'enum' | 'boolean' | 'secret';
  description: string;
  required: boolean;
  values?: string[];
  default?: string;
};
type ConfigPreset = {
  id: string;
  category: string;
  description: string;
  inputs: ConfigPresetInput[];
  write_target_count: number;
};
type ConfigMissionItem = {
  id: string;
  preset: string;
  tenant: string;
  status: string;
  created_at: string;
};
type Setup = SetupPayload;

type Notice = { text: string; error?: boolean } | null;

const DEFAULT_SERVICES = ['google-workspace', 'slack', 'browser'];

const DIAG_LABELS: Record<string, ConciergeMessageKey> = {
  profile: 'setup.diag.profile',
  avatar: 'setup.diag.avatar',
  voice: 'setup.diag.voice',
  services: 'setup.diag.services',
  notifications: 'setup.diag.notifications',
  reasoning: 'setup.diag.reasoning',
};

// Items with no in-app fix degrade to polite guidance (never a raw command
// printout as the primary copy — the command stays visually secondary).
const DIAG_GUIDANCE: Record<string, ConciergeMessageKey> = {
  reasoning: 'setup.reasoning_guidance',
};

const PLUGIN_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  activatable: 'setup.plugin_status_activatable',
  pending_approval: 'setup.plugin_status_pending',
  blocked_broken_manifest: 'setup.plugin_status_blocked',
  not_loadable: 'setup.plugin_status_not_loadable',
};

const PLUGIN_TRUST_KEYS: Record<string, ConciergeMessageKey> = {
  official: 'setup.plugin_trust_official',
  curated: 'setup.plugin_trust_curated',
  'third-party': 'setup.plugin_trust_third_party',
};

const CONFIG_STATUS_KEYS: Record<string, ConciergeMessageKey> = {
  draft: 'setup.governance_status_draft',
  applying: 'setup.governance_status_in_progress',
  applied: 'setup.governance_status_done',
  failed: 'setup.governance_status_failed',
};

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
  const [notifChannels, setNotifChannels] = React.useState<NotificationChannelOption[]>([]);
  const [notifCurrent, setNotifCurrent] = React.useState<NotificationTarget | null>(null);
  const [notif, setNotif] = React.useState({ surface: 'none', target: '' });
  const [plugins, setPlugins] = React.useState<PluginEntry[]>([]);
  const [pluginConfirm, setPluginConfirm] = React.useState<{
    id: string;
    decision: 'approve' | 'deny';
  } | null>(null);
  const [configPresets, setConfigPresets] = React.useState<ConfigPreset[]>([]);
  const [configTenants, setConfigTenants] = React.useState<string[]>([]);
  const [configRecent, setConfigRecent] = React.useState<ConfigMissionItem[]>([]);
  const [configPresetId, setConfigPresetId] = React.useState('');
  const [configTenant, setConfigTenant] = React.useState('');
  const [configInputs, setConfigInputs] = React.useState<Record<string, string>>({});
  const [configConfirm, setConfigConfirm] = React.useState(false);
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
      const next = parseSetupResponse(await response.json().catch(() => null));
      if (!response.ok || !next) throw new Error('Invalid setup response');
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

  const refreshNotifications = React.useCallback(async () => {
    try {
      const response = await fetch('/api/notification-preferences', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'notification failed');
      const channels = Array.isArray(payload.channels)
        ? (payload.channels as NotificationChannelOption[])
        : [];
      const current = (payload.preferences?.default_channel || null) as NotificationTarget | null;
      setNotifChannels(channels);
      setNotifCurrent(current);
      setNotif(
        current
          ? { surface: current.surface, target: current.target }
          : { surface: 'none', target: '' }
      );
    } catch {
      // The notification pane keeps its last known state; the diagnostics
      // checklist from /api/setup still reports the authoritative status.
    }
  }, []);

  const refreshPlugins = React.useCallback(async () => {
    try {
      const response = await fetch('/api/plugins', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'plugins failed');
      setPlugins(Array.isArray(payload.plugins) ? (payload.plugins as PluginEntry[]) : []);
    } catch {
      // The plugin pane keeps its last known state; approval decisions always
      // re-read the registry server-side, so stale display never grants more.
    }
  }, []);

  const refreshConfigMissions = React.useCallback(async () => {
    try {
      const response = await fetch('/api/config-missions', { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'config missions failed');
      const tenants = Array.isArray(payload.tenants) ? (payload.tenants as string[]) : [];
      setConfigPresets(Array.isArray(payload.presets) ? (payload.presets as ConfigPreset[]) : []);
      setConfigTenants(tenants);
      setConfigTenant((current) => current || tenants[0] || '');
      setConfigRecent(Array.isArray(payload.recent) ? (payload.recent as ConfigMissionItem[]) : []);
    } catch {
      // Same posture as the plugin pane: display-only degradation.
    }
  }, []);

  // CS-03: a plugin decision only fires from the inline confirm step — no
  // auto-approval, no default, no blocking browser dialog.
  const decidePlugin = React.useCallback(
    async (id: string, decision: 'approve' | 'deny') => {
      setBusy(true);
      try {
        const response = await fetch(`/api/plugins/${encodeURIComponent(id)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision }),
        });
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed?.message) throw new Error('Plugin action failed');
        setNotice({ text: parsed.message });
        setPluginConfirm(null);
        await refreshPlugins();
      } catch (err) {
        setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setBusy(false);
      }
    },
    [refreshPlugins]
  );

  // CS-03 ガバナンス設定: filing only fires from the inline confirm step. The
  // route stops at creation — the change takes effect after mission approval.
  const submitConfigMission = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/config-missions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          preset: configPresetId,
          tenant: configTenant,
          inputs: configInputs,
        }),
      });
      const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed?.message) throw new Error('Config mission failed');
      setNotice({ text: parsed.message });
      setConfigConfirm(false);
      setConfigPresetId('');
      setConfigInputs({});
      await refreshConfigMissions();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }, [configInputs, configPresetId, configTenant, refreshConfigMissions]);

  React.useEffect(() => {
    void refresh();
    void refreshNotifications();
    void refreshPlugins();
    void refreshConfigMissions();
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [refresh, refreshNotifications, refreshPlugins, refreshConfigMissions]);

  const jumpToSection = React.useCallback((target: string) => {
    if (!target.startsWith('#')) return;
    const element = document.getElementById(target.slice(1));
    if (!element) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, []);

  const saveNotification = React.useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/notification-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ surface: notif.surface, channel: notif.target.trim() }),
      });
      if (!response.ok) throw new Error('Notification save failed');
      setNotice({ text: t('setup.notification_saved') });
      await Promise.all([refreshNotifications(), refresh()]);
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setBusy(false);
    }
  }, [notif, refresh, refreshNotifications, t]);

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
        if (!response.ok) throw new Error('Onboarding failed');
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
      if (!response.ok) throw new Error('Management save failed');
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
        const parsed = parseConciergeMutationResponse(await response.json().catch(() => null));
        if (!response.ok || !parsed) throw new Error('Upload failed');
        if (action === 'voice_sample') {
          const sampleRef = parsed.sample?.sample_ref;
          if (!sampleRef) throw new Error('Invalid voice upload response');
          setVoiceSampleRefs((current) => [...current, sampleRef].slice(-3));
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
  const channelDisplayName = (surface: string) =>
    notifChannels.find((channel) => channel.surface === surface)?.display_name || surface;

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

      <section className="pane readiness-pane" aria-label={t('setup.readiness_title')}>
        <h2>{t('setup.readiness_title')}</h2>
        <p className="pane-subtitle">{t('setup.readiness_description')}</p>
        <ul className="readiness-list">
          {setup.diagnostics.map((item) => {
            const labelKey = DIAG_LABELS[item.id];
            const guidanceKey = DIAG_GUIDANCE[item.id];
            return (
              <li className="readiness-item" key={item.id}>
                <span className={`status-chip${item.status === 'ok' ? ' ok' : ' attention'}`}>
                  {item.status === 'ok'
                    ? `✓ ${t('setup.completed')}`
                    : item.status === 'error'
                      ? t('setup.diag_error')
                      : t('setup.incomplete')}
                </span>
                <span className="readiness-label">{labelKey ? t(labelKey) : item.id}</span>
                {item.status !== 'ok' && item.action?.type === 'navigate' ? (
                  <button
                    className="action-button secondary"
                    onClick={() => jumpToSection(item.action!.target)}
                  >
                    {t('setup.fix_here')}
                  </button>
                ) : null}
                {item.status !== 'ok' && !item.action && guidanceKey ? (
                  <span className="readiness-guidance">
                    {t(guidanceKey)}
                    {item.command ? (
                      <span className="readiness-command">
                        {t('setup.reasoning_command_hint', { value: item.command })}
                      </span>
                    ) : null}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>

      <div className="pane-grid">
        <section className="pane" id="setup-profile" aria-label={t('setup.profile_title')}>
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

        <section className="pane" id="setup-management" aria-label={t('setup.management_title')}>
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

        <section className="pane" id="setup-media" aria-label={t('setup.media_title')}>
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

        <section className="pane" id="setup-services" aria-label={t('setup.services_title')}>
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

        <section
          className="pane"
          id="setup-notifications"
          aria-label={t('setup.notifications_title')}
        >
          <h2>{t('setup.notifications_title')}</h2>
          <p className="pane-subtitle">{t('setup.notifications_description')}</p>
          <p className="item-meta">
            {notifCurrent
              ? t('setup.notification_current', {
                  value: `${channelDisplayName(notifCurrent.surface)} ${notifCurrent.target}`,
                })
              : t('setup.notification_none')}
          </p>
          <label className="field-label">
            {t('setup.notification_surface')}
            <select
              value={notif.surface}
              onChange={(event) => setNotif({ ...notif, surface: event.target.value })}
            >
              <option value="none">{t('setup.notification_off_option')}</option>
              {notifChannels.map((channel) => (
                <option key={channel.surface} value={channel.surface}>
                  {channel.display_name}
                </option>
              ))}
            </select>
          </label>
          {notif.surface !== 'none' ? (
            <label className="field-label">
              {t('setup.notification_target')}
              <input
                value={notif.target}
                onChange={(event) => setNotif({ ...notif, target: event.target.value })}
                placeholder={t('setup.notification_target_placeholder')}
              />
            </label>
          ) : null}
          <div className="button-row">
            <button
              className="action-button"
              disabled={busy || (notif.surface !== 'none' && !notif.target.trim())}
              onClick={() => void saveNotification()}
            >
              {t('setup.notification_save')}
            </button>
          </div>
        </section>

        <section className="pane" id="setup-plugins" aria-label={t('setup.plugins_title')}>
          <h2>{t('setup.plugins_title')}</h2>
          <p className="pane-subtitle">{t('setup.plugins_description')}</p>
          <p className="item-meta">{t('setup.plugins_caveat')}</p>
          {plugins.length === 0 ? (
            <p className="pane-empty">{t('setup.plugins_empty')}</p>
          ) : (
            plugins.map((plugin) => {
              const statusKey =
                plugin.approval_status === 'rejected'
                  ? 'setup.plugin_status_denied'
                  : PLUGIN_STATUS_KEYS[plugin.status];
              const trustKey = PLUGIN_TRUST_KEYS[plugin.trust];
              const decidable = plugin.status === 'pending_approval';
              return (
                <div className="item-card" key={`${plugin.source}-${plugin.id}`}>
                  <p className="item-title">
                    {plugin.id}
                    <span
                      className={`status-chip${plugin.status === 'activatable' ? ' ok' : ' attention'}`}
                    >
                      {statusKey ? t(statusKey) : plugin.status}
                    </span>
                  </p>
                  <p className="item-meta">
                    {trustKey ? t(trustKey) : plugin.trust}
                    {plugin.requested_by
                      ? ` · ${t('setup.plugin_requested_by', { value: plugin.requested_by })}`
                      : ''}
                  </p>
                  {decidable && pluginConfirm?.id === plugin.id ? (
                    <div className="plugin-confirm">
                      <p className="item-body">
                        {t(
                          pluginConfirm.decision === 'approve'
                            ? 'setup.plugin_confirm_approve'
                            : 'setup.plugin_confirm_deny'
                        )}
                      </p>
                      <div className="button-row">
                        <button
                          type="button"
                          className="action-button"
                          disabled={busy}
                          onClick={() => void decidePlugin(plugin.id, pluginConfirm.decision)}
                        >
                          {t('setup.confirm_yes')}
                        </button>
                        <button
                          type="button"
                          className="action-button secondary"
                          disabled={busy}
                          onClick={() => setPluginConfirm(null)}
                        >
                          {t('setup.confirm_back')}
                        </button>
                      </div>
                    </div>
                  ) : decidable ? (
                    <div className="button-row">
                      <button
                        type="button"
                        className="action-button"
                        disabled={busy}
                        onClick={() => setPluginConfirm({ id: plugin.id, decision: 'approve' })}
                      >
                        {t('setup.plugin_approve')}
                      </button>
                      <button
                        type="button"
                        className="action-button secondary"
                        disabled={busy}
                        onClick={() => setPluginConfirm({ id: plugin.id, decision: 'deny' })}
                      >
                        {t('setup.plugin_deny')}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </section>

        <section className="pane" id="setup-governance" aria-label={t('setup.governance_title')}>
          <h2>{t('setup.governance_title')}</h2>
          <p className="pane-subtitle">{t('setup.governance_description')}</p>
          <label className="field-label">
            {t('setup.governance_preset')}
            <select
              value={configPresetId}
              onChange={(event) => {
                setConfigPresetId(event.target.value);
                setConfigInputs({});
                setConfigConfirm(false);
              }}
            >
              <option value="">{t('setup.governance_preset_placeholder')}</option>
              {configPresets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.id}
                </option>
              ))}
            </select>
          </label>
          {(() => {
            const preset = configPresets.find((candidate) => candidate.id === configPresetId);
            if (!preset) return null;
            return (
              <>
                <p className="item-meta">{preset.description}</p>
                <p className="item-meta">
                  {t('setup.governance_targets', { count: preset.write_target_count })}
                </p>
                <label className="field-label">
                  {t('setup.governance_tenant')}
                  <select
                    value={configTenant}
                    onChange={(event) => setConfigTenant(event.target.value)}
                  >
                    {configTenants.map((tenant) => (
                      <option key={tenant} value={tenant}>
                        {tenant}
                      </option>
                    ))}
                  </select>
                </label>
                {preset.inputs.map((input) => (
                  <label className="field-label" key={input.key}>
                    {input.key}
                    {input.required ? ` (${t('setup.governance_required')})` : ''}
                    {input.type === 'enum' && input.values ? (
                      <select
                        value={configInputs[input.key] || input.default || ''}
                        onChange={(event) =>
                          setConfigInputs({ ...configInputs, [input.key]: event.target.value })
                        }
                      >
                        <option value="">{t('setup.governance_preset_placeholder')}</option>
                        {input.values.map((value) => (
                          <option key={value} value={value}>
                            {value}
                          </option>
                        ))}
                      </select>
                    ) : input.type === 'boolean' ? (
                      <select
                        value={configInputs[input.key] || input.default || 'false'}
                        onChange={(event) =>
                          setConfigInputs({ ...configInputs, [input.key]: event.target.value })
                        }
                      >
                        <option value="false">false</option>
                        <option value="true">true</option>
                      </select>
                    ) : (
                      <input
                        type={input.type === 'secret' ? 'password' : 'text'}
                        value={configInputs[input.key] || ''}
                        onChange={(event) =>
                          setConfigInputs({ ...configInputs, [input.key]: event.target.value })
                        }
                      />
                    )}
                    <span className="item-meta">{input.description}</span>
                  </label>
                ))}
                {configConfirm ? (
                  <div className="governance-confirm">
                    <p className="item-body">{t('setup.governance_confirm')}</p>
                    <div className="button-row">
                      <button
                        type="button"
                        className="action-button"
                        disabled={busy}
                        onClick={() => void submitConfigMission()}
                      >
                        {t('setup.confirm_yes')}
                      </button>
                      <button
                        type="button"
                        className="action-button secondary"
                        disabled={busy}
                        onClick={() => setConfigConfirm(false)}
                      >
                        {t('setup.confirm_back')}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="button-row">
                    <button
                      type="button"
                      className="action-button"
                      disabled={busy || !configTenant}
                      onClick={() => setConfigConfirm(true)}
                    >
                      {t('setup.governance_submit')}
                    </button>
                  </div>
                )}
              </>
            );
          })()}
          <h3 className="pane-subheading">{t('setup.governance_recent')}</h3>
          {configRecent.length === 0 ? (
            <p className="item-meta">{t('setup.governance_recent_empty')}</p>
          ) : (
            configRecent.map((mission) => {
              const statusKey = CONFIG_STATUS_KEYS[mission.status];
              return (
                <div className="item-card" key={mission.id}>
                  <p className="item-title">
                    {mission.preset}
                    <span
                      className={`status-chip${mission.status === 'applied' ? ' ok' : mission.status === 'failed' ? ' attention' : ''}`}
                    >
                      {statusKey ? t(statusKey) : mission.status}
                    </span>
                  </p>
                  <p className="item-meta">
                    {mission.id} · {mission.tenant}
                    {mission.created_at ? ` · ${mission.created_at.slice(0, 10)}` : ''}
                  </p>
                </div>
              );
            })
          )}
        </section>

        <section className="pane" id="setup-operations" aria-label={t('setup.operations_title')}>
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
                {capability.href?.startsWith('#') ? (
                  <button className="link-button" onClick={() => jumpToSection(capability.href!)}>
                    {t('setup.open_section')}
                  </button>
                ) : capability.href ? (
                  <a href={capability.href}>{t('setup.open_approval_queue')}</a>
                ) : (
                  t('setup.ask_via_conversation')
                )}
              </p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
