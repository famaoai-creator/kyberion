'use client';

import * as React from 'react';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText, type ConciergeMessageKey, type FrontDeskMessageKey } from '../../lib/i18n';
import { parseSetupResponse, type Setup as SetupPayload } from '../../lib/setup-response';
import { parseConciergeMutationResponse } from '../../lib/mutation-response';
import {
  parseConfigMissionsResponse,
  parseNotificationPreferencesResponse,
  parsePluginListResponse,
} from '../../lib/setup-auxiliary-response';
import {
  orderSectionsForFirstRun,
  SETTINGS_SECTION_ORDER,
  type SettingsSectionId,
} from '../../lib/settings-view';
import {
  parseAddMemberResponse,
  parseChronosLink,
  parseMembersResponse,
  parseSettingsMe,
  type ConfigMissionItem,
  type ConfigPreset,
  type NotificationChannelOption,
  type NotificationTarget,
  type Notice,
  type PluginEntry,
  type SettingsMember,
  type SettingsRole,
  type SettingsTenantView,
} from '../../lib/settings-types';
import { useVoiceSelection } from '../../lib/use-voice-selection';
import { useTrainingAssignments } from '../../lib/use-training-assignments';
import { ProfileSection } from './sections/ProfileSection';
import { MembersSection, type MemberFormState } from './sections/MembersSection';
import { ServicesSection } from './sections/ServicesSection';
import { VoiceSection } from './sections/VoiceSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { PluginsSection, type PluginConfirmState } from './sections/PluginsSection';
import { AdvancedSection, type ManagementState } from './sections/AdvancedSection';

/**
 * FD-06 (設定): `/setup` and the companion `/onboarding` wizard fold into
 * this one page (plan §2.1/§FD-06). The 8 legacy `#setup-…` anchors are
 * preserved verbatim — the OAuth callback flow, the readiness checklist's
 * "ここで直す" jumps, and the command palette all still target them — but
 * they now live inside 7 human-labelled cards (`front_desk:settings_nav_*`)
 * behind a left sub-nav instead of 8 flat panes. `/setup` itself is now a
 * redirect (`src/app/setup/page.tsx`); the browser keeps the `#hash` across
 * a server redirect, so every existing deep link still lands on the right
 * card. Each card's JSX lives in `./sections/*Section.tsx` (KP gate:
 * max-file-lines) — this file owns all state, data loading, and handlers,
 * and passes them down as props; the sections themselves are render-only.
 */

type Setup = SetupPayload;

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

/** Section heading label (front_desk:settings_nav_*), in the fixed sub-nav order. */
const SETTINGS_NAV_LABEL_KEYS: Record<SettingsSectionId, FrontDeskMessageKey> = {
  profile: 'settings_nav_profile',
  members: 'settings_nav_members',
  services: 'settings_nav_services',
  voice: 'settings_nav_voice',
  notifications: 'settings_nav_notifications',
  plugins: 'settings_nav_plugins',
  advanced: 'settings_nav_advanced',
};

/** The DOM id each section scrolls to — the 6 that carry a legacy `#setup-…`
 * anchor keep it; `members` and `advanced` are new wrapper ids (their 3
 * sub-panes under 詳細設定 keep their own legacy ids inside). */
const SETTINGS_SECTION_ELEMENT_ID: Record<SettingsSectionId, string> = {
  profile: 'setup-profile',
  members: 'settings-members',
  services: 'setup-services',
  voice: 'setup-media',
  notifications: 'setup-notifications',
  plugins: 'setup-plugins',
  advanced: 'settings-advanced',
};

export default function SettingsPage() {
  const { locale, t } = useConciergeI18n();
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
  const [management, setManagement] = React.useState<ManagementState>({
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
  const [pluginConfirm, setPluginConfirm] = React.useState<PluginConfirmState>(null);
  const [configPresets, setConfigPresets] = React.useState<ConfigPreset[]>([]);
  const [configTenants, setConfigTenants] = React.useState<string[]>([]);
  const [configRecent, setConfigRecent] = React.useState<ConfigMissionItem[]>([]);
  const [configPresetId, setConfigPresetId] = React.useState('');
  const [configTenant, setConfigTenant] = React.useState('');
  const [configInputs, setConfigInputs] = React.useState<Record<string, string>>({});
  const [configConfirm, setConfigConfirm] = React.useState(false);
  const [cameraState, setCameraState] = React.useState<'idle' | 'starting' | 'ready'>('idle');
  const [voiceRecording, setVoiceRecording] = React.useState(false);
  const [oauthBusyId, setOauthBusyId] = React.useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = React.useState<string | null>(null);
  const [meTenants, setMeTenants] = React.useState<SettingsTenantView[]>([]);
  const [meViewing, setMeViewing] = React.useState<SettingsTenantView | null>(null);
  const [members, setMembers] = React.useState<SettingsMember[]>([]);
  const [memberForm, setMemberForm] = React.useState<MemberFormState>({
    display_name: '',
    member_id: '',
    tenant_slug: '',
    role: 'viewer' as SettingsRole,
    issue_token: false,
  });
  const [memberBusy, setMemberBusy] = React.useState(false);
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const [chronosUrl, setChronosUrl] = React.useState<string | null>(null);
  const {
    voiceSelection,
    voiceDevices,
    voiceSelectionBusy,
    refreshVoiceSelection,
    saveVoiceSelection,
  } = useVoiceSelection(setNotice);
  const {
    trainingTracks,
    trainingAssignments,
    trainingProgress,
    trainingTrackId,
    setTrainingTrackId,
    refreshTrainingCatalog,
    refreshTrainingAssignments,
    refreshTrainingProgress,
    assignTraining,
  } = useTrainingAssignments(locale, setNotice);
  const [activeSection, setActiveSection] = React.useState<SettingsSectionId>('profile');
  const cameraStreamRef = React.useRef<MediaStream | null>(null);
  const cameraVideoRef = React.useRef<HTMLVideoElement | null>(null);
  const cameraCanvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const voiceStreamRef = React.useRef<MediaStream | null>(null);
  const voiceRecorderRef = React.useRef<MediaRecorder | null>(null);
  const voiceChunksRef = React.useRef<Blob[]>([]);
  const sectionRefs = React.useRef<Partial<Record<SettingsSectionId, HTMLElement | null>>>({});

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
      const parsed = parseNotificationPreferencesResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid notification preferences response');
      setNotifChannels(parsed.channels);
      setNotifCurrent(parsed.preferences.default_channel);
      setNotif(
        parsed.preferences.default_channel
          ? {
              surface: parsed.preferences.default_channel.surface,
              target: parsed.preferences.default_channel.target,
            }
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
      const parsed = parsePluginListResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid plugin list response');
      setPlugins(parsed);
    } catch {
      // The plugin pane keeps its last known state; approval decisions always
      // re-read the registry server-side, so stale display never grants more.
    }
  }, []);

  const refreshConfigMissions = React.useCallback(async () => {
    try {
      const response = await fetch('/api/config-missions', { cache: 'no-store' });
      const parsed = parseConfigMissionsResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid config missions response');
      setConfigPresets(parsed.presets);
      setConfigTenants(parsed.tenants);
      setConfigTenant((current) => current || parsed.tenants[0] || '');
      setConfigRecent(parsed.recent);
    } catch {
      // Same posture as the plugin pane: display-only degradation.
    }
  }, []);

  // FD-06 組織とメンバー: the shared front-desk identity contract, same
  // shape front-desk-rail.tsx fetches. Degrades to an empty tenant list —
  // every other section still works without it.
  const refreshMe = React.useCallback(async () => {
    try {
      const response = await fetch('/api/me', { cache: 'no-store' });
      const parsed = parseSettingsMe(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid me response');
      setMeTenants(parsed.tenants);
      setMeViewing(parsed.viewing);
    } catch {
      // 組織とメンバー shows an empty list rather than blocking the page.
    }
  }, []);

  // FD-07: the member list itself. Degrades to an empty list — a non-owner
  // viewer simply sees nothing here (the section stays visible, matching
  // every other degrade-gracefully pane on this page).
  const refreshMembers = React.useCallback(async () => {
    try {
      const response = await fetch('/api/members', { cache: 'no-store' });
      const parsed = parseMembersResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid members response');
      setMembers(parsed);
    } catch {
      // Members pane shows an empty list rather than blocking the page.
    }
  }, []);

  // FD-07 「メンバーを追加」: fires only from the explicit form submit — no
  // auto-creation, no default role. The new access token (when requested)
  // is shown exactly once via `issuedToken` and never re-fetchable.
  const addMember = React.useCallback(async () => {
    setMemberBusy(true);
    try {
      const response = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memberForm),
      });
      const parsed = parseAddMemberResponse(await response.json().catch(() => null));
      if (!response.ok || !parsed) {
        const failure = await response
          .clone()
          .json()
          .catch(() => null);
        throw new Error(
          (failure && typeof failure.error === 'string' && failure.error) ||
            'Member creation failed'
        );
      }
      setNotice({ text: frontDeskText('settings_member_added', locale) });
      setIssuedToken(parsed.token);
      setMemberForm((current) => ({ ...current, display_name: '', member_id: '' }));
      await refreshMembers();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      setMemberBusy(false);
    }
  }, [memberForm, locale, refreshMembers]);

  // FD-07 role change / suspend / reactivate — owner-only PATCH, no delete.
  const patchMember = React.useCallback(
    async (
      memberId: string,
      patch: { tenant_slug: string; role: SettingsRole } | { status: 'active' | 'suspended' }
    ) => {
      setMemberBusy(true);
      try {
        const response = await fetch(`/api/members/${encodeURIComponent(memberId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        const parsed = await response.json().catch(() => null);
        if (!response.ok || !parsed?.ok) {
          throw new Error(
            (parsed && typeof parsed.error === 'string' && parsed.error) || 'Member update failed'
          );
        }
        setNotice({ text: frontDeskText('settings_member_updated', locale) });
        await refreshMembers();
      } catch (err) {
        setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        setMemberBusy(false);
      }
    },
    [locale, refreshMembers]
  );

  // FD-06 詳細設定: the 管制塔 (chronos-mirror-v2) link's port is resolved
  // server-side (plan §2.6) — this component only ever holds the string URL.
  const refreshChronosLink = React.useCallback(async () => {
    try {
      const response = await fetch('/api/front-desk/links', { cache: 'no-store' });
      const chronos = parseChronosLink(await response.json().catch(() => null));
      if (!response.ok || !chronos) throw new Error('Invalid links response');
      setChronosUrl(chronos);
    } catch {
      // 詳細設定 keeps the rest of its content usable without the link.
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
    void refreshMe();
    void refreshMembers();
    void refreshChronosLink();
    void refreshVoiceSelection();
    void refreshTrainingCatalog();
    void refreshTrainingAssignments();
    void refreshTrainingProgress();
    return () => {
      cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
      voiceStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [
    refresh,
    refreshNotifications,
    refreshPlugins,
    refreshConfigMissions,
    refreshMe,
    refreshMembers,
    refreshChronosLink,
    refreshVoiceSelection,
    refreshTrainingCatalog,
    refreshTrainingAssignments,
    refreshTrainingProgress,
  ]);

  React.useEffect(() => {
    if (memberForm.tenant_slug || meTenants.length === 0) return;
    setMemberForm((current) => ({ ...current, tenant_slug: meTenants[0].tenant_slug }));
  }, [meTenants, memberForm.tenant_slug]);

  const jumpToSection = React.useCallback((target: string) => {
    if (!target.startsWith('#')) return;
    const element = document.getElementById(target.slice(1));
    if (!element) return;
    // 詳細設定 keeps its 3 sub-panes collapsed by default; a deep link (the
    // readiness checklist's "ここで直す" button, or the command palette)
    // must still reveal them rather than scrolling to hidden content.
    let details = element.closest('details');
    while (details) {
      details.open = true;
      details = details.parentElement?.closest('details') ?? null;
    }
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }, []);

  const jumpToNavSection = React.useCallback(
    (id: SettingsSectionId) => jumpToSection(`#${SETTINGS_SECTION_ELEMENT_ID[id]}`),
    [jumpToSection]
  );

  // FD-06: the left sub-nav highlights whichever card is currently in view.
  React.useEffect(() => {
    if (!setup) return;
    const observed = (
      Object.entries(sectionRefs.current) as Array<[SettingsSectionId, HTMLElement | null]>
    ).filter((entry): entry is [SettingsSectionId, HTMLElement] => entry[1] !== null);
    if (!observed.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const mostVisible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!mostVisible) return;
        const match = observed.find(([, element]) => element === mostVisible.target);
        if (match) setActiveSection(match[0]);
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    observed.forEach(([, element]) => observer.observe(element));
    return () => observer.disconnect();
  }, [setup]);

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

  const connectOAuth = React.useCallback(
    async (serviceId: string, serviceLabel: string) => {
      setOauthBusyId(serviceId);
      setOauthMessage(null);
      const oauthWindow = window.open('', '_blank', 'noopener');
      try {
        const response = await fetch('/api/oauth/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service_id: serviceId }),
        });
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          authorization_url?: string;
        } | null;
        if (!response.ok || !body?.ok || !body.authorization_url) {
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        if (oauthWindow) oauthWindow.location.href = body.authorization_url;
        else window.location.assign(body.authorization_url);
        setOauthMessage(t('setup.connect_oauth_started', { service: serviceLabel || serviceId }));
      } catch (err) {
        oauthWindow?.close();
        setOauthMessage(
          t('setup.connect_oauth_failed', {
            service: serviceLabel || serviceId,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      } finally {
        setOauthBusyId(null);
      }
    },
    [t]
  );

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

  const channelDisplayName = (surface: string) =>
    notifChannels.find((channel) => channel.surface === surface)?.display_name || surface;
  const firstRun = !setup.diagnostics.every((item) => item.status === 'ok');
  const sectionOrder = orderSectionsForFirstRun(setup.diagnostics);

  const setSectionRef = (id: SettingsSectionId) => (element: HTMLElement | null) => {
    sectionRefs.current[id] = element;
  };

  // Declared as a `const` (not a hoisted `function`) so TypeScript narrows
  // `setup` to non-null inside it — the early `if (!setup) return` above
  // already guarantees that for every call site below.
  const renderSection = (id: SettingsSectionId): React.ReactNode => {
    switch (id) {
      case 'profile':
        return (
          <ProfileSection
            key="profile"
            locale={locale}
            t={t}
            profile={profile}
            setProfile={setProfile}
            busy={busy}
            onSaveProfile={() => void applyOnboarding(false)}
            sectionRef={setSectionRef('profile')}
          />
        );

      case 'members':
        return (
          <MembersSection
            key="members"
            locale={locale}
            t={t}
            setup={setup}
            meTenants={meTenants}
            meViewing={meViewing}
            members={members}
            memberForm={memberForm}
            setMemberForm={setMemberForm}
            memberBusy={memberBusy}
            issuedToken={issuedToken}
            setIssuedToken={setIssuedToken}
            onAddMember={() => void addMember()}
            onPatchMember={(memberId, patch) => void patchMember(memberId, patch)}
            trainingTracks={trainingTracks}
            trainingAssignments={trainingAssignments}
            trainingProgress={trainingProgress}
            trainingTrackId={trainingTrackId}
            setTrainingTrackId={setTrainingTrackId}
            onAssignTraining={(memberId) =>
              void assignTraining(memberId, meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug)
            }
            sectionRef={setSectionRef('members')}
          />
        );

      case 'services':
        return (
          <ServicesSection
            key="services"
            locale={locale}
            t={t}
            setup={setup}
            services={services}
            setServices={setServices}
            busy={busy}
            oauthBusyId={oauthBusyId}
            oauthMessage={oauthMessage}
            onConnectOAuth={(serviceId, serviceLabel) => void connectOAuth(serviceId, serviceLabel)}
            onSaveConnections={() => void applyOnboarding(false)}
            sectionRef={setSectionRef('services')}
          />
        );

      case 'voice':
        return (
          <VoiceSection
            key="voice"
            locale={locale}
            t={t}
            setup={setup}
            busy={busy}
            cameraState={cameraState}
            cameraVideoRef={cameraVideoRef}
            cameraCanvasRef={cameraCanvasRef}
            onStartCamera={() => void startCamera()}
            onStopCamera={stopCamera}
            onCaptureAvatar={() => void captureAvatar()}
            onAvatarFileChange={(file) =>
              void prepareAvatarFile(file).then((avatar) => upload('avatar', avatar, 'upload'))
            }
            voice={voice}
            setVoice={setVoice}
            voiceSampleRefs={voiceSampleRefs}
            voiceRecording={voiceRecording}
            onStartVoiceRecording={() => void startVoiceRecording()}
            onStopVoiceRecording={stopVoiceRecording}
            onVoiceSampleFileChange={(file) => void upload('voice_sample', file, 'upload')}
            onSaveVoice={() => void applyOnboarding(true)}
            voiceSelection={voiceSelection}
            voiceDevices={voiceDevices}
            voiceSelectionBusy={voiceSelectionBusy}
            onSaveVoiceSelection={(field, value) => void saveVoiceSelection(field, value)}
            sectionRef={setSectionRef('voice')}
          />
        );

      case 'notifications':
        return (
          <NotificationsSection
            key="notifications"
            locale={locale}
            t={t}
            notifCurrent={notifCurrent}
            notif={notif}
            setNotif={setNotif}
            notifChannels={notifChannels}
            channelDisplayName={channelDisplayName}
            busy={busy}
            onSaveNotification={() => void saveNotification()}
            sectionRef={setSectionRef('notifications')}
          />
        );

      case 'plugins':
        return (
          <PluginsSection
            key="plugins"
            locale={locale}
            t={t}
            plugins={plugins}
            pluginConfirm={pluginConfirm}
            setPluginConfirm={setPluginConfirm}
            busy={busy}
            onDecidePlugin={(id, decision) => void decidePlugin(id, decision)}
            sectionRef={setSectionRef('plugins')}
          />
        );

      case 'advanced':
      default:
        return (
          <AdvancedSection
            key="advanced"
            locale={locale}
            t={t}
            setup={setup}
            busy={busy}
            chronosUrl={chronosUrl}
            sectionRef={setSectionRef('advanced')}
            management={management}
            setManagement={setManagement}
            onSaveManagement={() => void saveManagement()}
            configPresets={configPresets}
            configTenants={configTenants}
            configTenant={configTenant}
            setConfigTenant={setConfigTenant}
            configPresetId={configPresetId}
            setConfigPresetId={setConfigPresetId}
            configInputs={configInputs}
            setConfigInputs={setConfigInputs}
            configConfirm={configConfirm}
            setConfigConfirm={setConfigConfirm}
            configRecent={configRecent}
            onSubmitConfigMission={() => void submitConfigMission()}
            onJumpToSection={jumpToSection}
          />
        );
    }
  };

  return (
    <div className="settings-page">
      {firstRun ? (
        <p className="settings-first-run-lead">
          {frontDeskText('settings_first_run_lead', locale)}
        </p>
      ) : null}

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

      {notice ? <div className={`notice${notice.error ? ' error' : ''}`}>{notice.text}</div> : null}

      <div className="settings-layout">
        <nav className="settings-subnav" aria-label="Settings sections">
          <ul>
            {SETTINGS_SECTION_ORDER.map((id) => (
              <li key={id}>
                <button
                  type="button"
                  className={`settings-subnav-item${activeSection === id ? ' active' : ''}`}
                  aria-current={activeSection === id ? 'true' : undefined}
                  onClick={() => jumpToNavSection(id)}
                >
                  {frontDeskText(SETTINGS_NAV_LABEL_KEYS[id], locale)}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="settings-content">{sectionOrder.map((id) => renderSection(id))}</div>
      </div>
    </div>
  );
}
