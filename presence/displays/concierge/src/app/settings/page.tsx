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

/**
 * FD-06 (設定): `/setup` and the companion `/onboarding` wizard fold into
 * this one page (plan §2.1/§FD-06). The 8 legacy `#setup-…` anchors are
 * preserved verbatim — the OAuth callback flow, the readiness checklist's
 * "ここで直す" jumps, and the command palette all still target them — but
 * they now live inside 7 human-labelled cards (`front_desk:settings_nav_*`)
 * behind a left sub-nav instead of 8 flat panes. `/setup` itself is now a
 * redirect (`src/app/setup/page.tsx`); the browser keeps the `#hash` across
 * a server redirect, so every existing deep link still lands on the right
 * card.
 */

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

type SettingsRole = 'owner' | 'approver' | 'viewer';
type SettingsTenantView = {
  tenant_slug: string;
  display_name: string;
  role: SettingsRole;
  status: 'active' | 'suspended' | 'archived';
};

// FD-07: 組織とメンバー member list + add form.
type SettingsMember = {
  member_id: string;
  display_name: string;
  status: 'active' | 'suspended';
  sign_in: 'local' | 'token';
  memberships: Array<{ tenant_slug: string; role: SettingsRole }>;
};

type VoiceSelection = {
  preferences: { tts_engine_id: string; stt_backend: string };
  tts: { candidates: Array<{ engine_id: string; display_name: string; selectable: boolean }> };
  stt: { candidates: Array<{ backend: string; display_name: string; selectable: boolean }> };
};
type VoiceDevice = { uid: string; name: string; isDefault: boolean };

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

const ROLE_LABEL_KEYS: Record<SettingsRole, FrontDeskMessageKey> = {
  owner: 'role_owner',
  approver: 'role_approver',
  viewer: 'role_viewer',
};

function isSettingsRole(value: unknown): value is SettingsRole {
  return value === 'owner' || value === 'approver' || value === 'viewer';
}

function isSettingsTenantView(value: unknown): value is SettingsTenantView {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.tenant_slug === 'string' &&
    typeof record.display_name === 'string' &&
    isSettingsRole(record.role) &&
    (record.status === 'active' || record.status === 'suspended' || record.status === 'archived')
  );
}

function parseSettingsMe(
  value: unknown
): { viewing: SettingsTenantView | null; tenants: SettingsTenantView[] } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.tenants)) return undefined;
  if (!record.tenants.every(isSettingsTenantView)) return undefined;
  if (record.viewing !== null && !isSettingsTenantView(record.viewing)) return undefined;
  return {
    viewing: (record.viewing as SettingsTenantView | null) ?? null,
    tenants: record.tenants,
  };
}

function isSettingsMember(value: unknown): value is SettingsMember {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.member_id === 'string' &&
    typeof record.display_name === 'string' &&
    (record.status === 'active' || record.status === 'suspended') &&
    (record.sign_in === 'local' || record.sign_in === 'token') &&
    Array.isArray(record.memberships) &&
    record.memberships.every(
      (m) =>
        m &&
        typeof m === 'object' &&
        typeof (m as Record<string, unknown>).tenant_slug === 'string' &&
        isSettingsRole((m as Record<string, unknown>).role)
    )
  );
}

function parseMembersResponse(value: unknown): SettingsMember[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !Array.isArray(record.members)) return undefined;
  if (!record.members.every(isSettingsMember)) return undefined;
  return record.members;
}

function parseAddMemberResponse(
  value: unknown
): { member: SettingsMember; token: string | null } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || !isSettingsMember(record.member)) return undefined;
  return { member: record.member, token: typeof record.token === 'string' ? record.token : null };
}

function parseChronosLink(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.ok !== true || typeof record.chronos_url !== 'string') return undefined;
  return record.chronos_url;
}

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
  const [oauthBusyId, setOauthBusyId] = React.useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = React.useState<string | null>(null);
  const [meTenants, setMeTenants] = React.useState<SettingsTenantView[]>([]);
  const [meViewing, setMeViewing] = React.useState<SettingsTenantView | null>(null);
  const [members, setMembers] = React.useState<SettingsMember[]>([]);
  const [memberForm, setMemberForm] = React.useState({
    display_name: '',
    member_id: '',
    tenant_slug: '',
    role: 'viewer' as SettingsRole,
    issue_token: false,
  });
  const [memberBusy, setMemberBusy] = React.useState(false);
  const [issuedToken, setIssuedToken] = React.useState<string | null>(null);
  const [chronosUrl, setChronosUrl] = React.useState<string | null>(null);
  const [voiceSelection, setVoiceSelection] = React.useState<VoiceSelection | null>(null);
  const [voiceDevices, setVoiceDevices] = React.useState<VoiceDevice[]>([]);
  const [voiceSelectionBusy, setVoiceSelectionBusy] = React.useState(false);
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

  const refreshVoiceSelection = React.useCallback(async () => {
    try {
      const [selectionResponse, statusResponse] = await Promise.all([
        fetch('/api/voice/selection', { cache: 'no-store' }),
        fetch('/api/voice/status', { cache: 'no-store' }),
      ]);
      const selection = await selectionResponse.json().catch(() => null);
      if (selectionResponse.ok && selection?.ok === true) setVoiceSelection(selection);
      const status = await statusResponse.json().catch(() => null);
      if (statusResponse.ok && Array.isArray(status?.inputDevices)) {
        setVoiceDevices(status.inputDevices);
      }
    } catch {
      // Voice is optional; the settings page remains usable when voice-hub is down.
    }
  }, []);

  const saveVoiceSelection = React.useCallback(
    async (field: 'tts_engine_id' | 'stt_backend', value: string) => {
      if (!voiceSelection) return;
      setVoiceSelectionBusy(true);
      try {
        const response = await fetch('/api/voice/selection', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...voiceSelection.preferences,
            [field]: value,
          }),
        });
        const next = await response.json().catch(() => null);
        if (!response.ok || next?.ok !== true)
          throw new Error('Voice selection could not be saved');
        setVoiceSelection(next);
      } catch (error) {
        setNotice({ text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        setVoiceSelectionBusy(false);
      }
    },
    [voiceSelection]
  );

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
          <section
            key="profile"
            className="pane"
            id="setup-profile"
            ref={setSectionRef('profile')}
            aria-label={frontDeskText('settings_nav_profile', locale)}
          >
            <h2>{frontDeskText('settings_nav_profile', locale)}</h2>
            <h3 className="pane-subheading">{t('setup.profile_title')}</h3>
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
        );

      case 'members':
        return (
          <section
            key="members"
            className="pane"
            id="settings-members"
            ref={setSectionRef('members')}
            aria-label={frontDeskText('settings_nav_members', locale)}
          >
            <h2>{frontDeskText('settings_nav_members', locale)}</h2>
            <h3 className="pane-subheading">{frontDeskText('settings_tenants_title', locale)}</h3>
            <p className="pane-subtitle">{frontDeskText('settings_tenants_lead', locale)}</p>
            {meTenants.length === 0 ? (
              <p className="pane-empty">{t('setup.loading')}</p>
            ) : (
              <ul className="settings-tenant-list">
                {meTenants.map((tenant) => (
                  <li className="item-card settings-tenant-item" key={tenant.tenant_slug}>
                    <p className="item-title">
                      {tenant.display_name} ({tenant.tenant_slug})
                      {meViewing?.tenant_slug === tenant.tenant_slug ? (
                        <span className="status-chip ok">
                          {frontDeskText('settings_tenant_current', locale)}
                        </span>
                      ) : null}
                    </p>
                    <p className="item-meta">
                      {frontDeskText(ROLE_LABEL_KEYS[tenant.role], locale)} · {tenant.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            <h3 className="pane-subheading">{frontDeskText('settings_members_title', locale)}</h3>
            {members.length === 0 ? (
              <p className="pane-empty">{t('setup.loading')}</p>
            ) : (
              <ul className="settings-tenant-list">
                {members.map((member) => {
                  const membership = member.memberships.find(
                    (m) => m.tenant_slug === (meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug)
                  );
                  return (
                    <li className="item-card settings-tenant-item" key={member.member_id}>
                      <p className="item-title">
                        {member.display_name} ({member.member_id})
                        <span className="status-chip">
                          {frontDeskText(
                            member.sign_in === 'token'
                              ? 'settings_member_signin_token'
                              : 'settings_member_signin_local',
                            locale
                          )}
                        </span>
                        {membership ? (
                          <span className="status-chip ok">
                            {frontDeskText(ROLE_LABEL_KEYS[membership.role], locale)}
                          </span>
                        ) : null}
                        <span className="status-chip">
                          {frontDeskText(
                            member.status === 'suspended'
                              ? 'settings_member_status_suspended'
                              : 'settings_member_status_active',
                            locale
                          )}
                        </span>
                      </p>
                      <div className="button-row">
                        <select
                          aria-label={frontDeskText('settings_member_role_change', locale)}
                          defaultValue={membership?.role ?? 'viewer'}
                          disabled={memberBusy}
                          onChange={(event) => {
                            const tenantSlug = meViewing?.tenant_slug ?? meTenants[0]?.tenant_slug;
                            if (!tenantSlug) return;
                            void patchMember(member.member_id, {
                              tenant_slug: tenantSlug,
                              role: event.target.value as SettingsRole,
                            });
                          }}
                        >
                          {(['owner', 'approver', 'viewer'] as SettingsRole[]).map((role) => (
                            <option key={role} value={role}>
                              {frontDeskText(ROLE_LABEL_KEYS[role], locale)}
                            </option>
                          ))}
                        </select>
                        <button
                          className="action-button"
                          disabled={memberBusy}
                          onClick={() =>
                            void patchMember(member.member_id, {
                              status: member.status === 'suspended' ? 'active' : 'suspended',
                            })
                          }
                        >
                          {frontDeskText(
                            member.status === 'suspended'
                              ? 'settings_member_reactivate'
                              : 'settings_member_suspend',
                            locale
                          )}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <h3 className="pane-subheading">{t('setup.agent_display_name')}</h3>
            <p className="pane-subtitle">
              {t('setup.agent_registry_count', {
                count: setup.agent_management.durable_identities.length,
              })}
            </p>
            {setup.agent_management.durable_identities.length > 0 ? (
              <ul className="settings-tenant-list">
                {setup.agent_management.durable_identities.map((agent) => {
                  const ownerId = agent.accountable_human_id?.replace(/^user:/, '');
                  const owner = members.find((member) => member.member_id === ownerId);
                  return (
                    <li className="item-card settings-tenant-item" key={agent.nhi_id}>
                      <p className="item-title">{agent.display_name}</p>
                      <p className="item-meta">
                        {owner?.display_name || frontDeskText('settings_members_title', locale)}
                      </p>
                    </li>
                  );
                })}
              </ul>
            ) : null}

            <h3 className="pane-subheading">{frontDeskText('settings_member_add', locale)}</h3>
            <div className="item-card settings-member-form">
              <div className="field-row">
                <label className="field-label">
                  {frontDeskText('settings_member_add_display_name', locale)}
                  <input
                    type="text"
                    value={memberForm.display_name}
                    onChange={(event) =>
                      setMemberForm({ ...memberForm, display_name: event.target.value })
                    }
                  />
                </label>
                <label className="field-label">
                  {frontDeskText('settings_member_add_id', locale)}
                  <input
                    type="text"
                    value={memberForm.member_id}
                    onChange={(event) =>
                      setMemberForm({ ...memberForm, member_id: event.target.value })
                    }
                  />
                </label>
              </div>
              <div className="field-row">
                <label className="field-label">
                  {frontDeskText('settings_member_add_tenant', locale)}
                  <select
                    value={memberForm.tenant_slug}
                    onChange={(event) =>
                      setMemberForm({ ...memberForm, tenant_slug: event.target.value })
                    }
                  >
                    {meTenants.map((tenant) => (
                      <option key={tenant.tenant_slug} value={tenant.tenant_slug}>
                        {tenant.display_name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  {frontDeskText('settings_member_add_role', locale)}
                  <select
                    value={memberForm.role}
                    onChange={(event) =>
                      setMemberForm({ ...memberForm, role: event.target.value as SettingsRole })
                    }
                  >
                    {(['owner', 'approver', 'viewer'] as SettingsRole[]).map((role) => (
                      <option key={role} value={role}>
                        {frontDeskText(ROLE_LABEL_KEYS[role], locale)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={memberForm.issue_token}
                  onChange={(event) =>
                    setMemberForm({ ...memberForm, issue_token: event.target.checked })
                  }
                />
                {frontDeskText('settings_member_add_issue_token', locale)}
              </label>
              <div className="button-row">
                <button
                  className="action-button"
                  disabled={
                    memberBusy ||
                    !memberForm.display_name.trim() ||
                    !memberForm.member_id.trim() ||
                    !memberForm.tenant_slug
                  }
                  onClick={() => void addMember()}
                >
                  {frontDeskText('settings_member_add_submit', locale)}
                </button>
              </div>
              {issuedToken ? (
                <div className="notice" role="alert">
                  <p>{frontDeskText('settings_token_once', locale)}</p>
                  <code>{issuedToken}</code>
                  <div className="button-row">
                    <button className="action-button" onClick={() => setIssuedToken(null)}>
                      {frontDeskText('settings_token_once_dismiss', locale)}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        );

      case 'services':
        return (
          <section
            key="services"
            className="pane"
            id="setup-services"
            ref={setSectionRef('services')}
            aria-label={frontDeskText('settings_nav_services', locale)}
          >
            <h2>{frontDeskText('settings_nav_services', locale)}</h2>
            <p className="settings-card-lead">{frontDeskText('settings_services_lead', locale)}</p>
            <h3 className="pane-subheading">{t('setup.services_title')}</h3>
            <p className="pane-subtitle">{t('setup.services_description')}</p>
            <p className="item-meta">{t('setup.connect_oauth_hint')}</p>
            <div className="service-icon-grid">
              {setup.service_catalog.map((service) => {
                const oauthCapable = /oauth/i.test(service.auth);
                const initial = service.label.slice(0, 1).toUpperCase();
                return (
                  <div className="service-tile" key={service.id} data-service={service.id}>
                    <div className="service-tile-icon" aria-hidden="true">
                      {initial}
                    </div>
                    <div className="service-tile-body">
                      <label className="service-tile-label">
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
                        />
                        <span>{service.label}</span>
                      </label>
                      <span className={`status-chip${service.configured ? '' : ' attention'}`}>
                        {service.configured ? t('setup.connected') : service.auth}
                      </span>
                      {oauthCapable ? (
                        <button
                          type="button"
                          className="action-button secondary service-connect-btn"
                          disabled={busy || oauthBusyId === service.id}
                          onClick={() => void connectOAuth(service.id, service.label)}
                        >
                          {oauthBusyId === service.id ? '…' : t('setup.connect_oauth')}
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
            {oauthMessage ? <p className="item-meta">{oauthMessage}</p> : null}
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
        );

      case 'voice':
        return (
          <section
            key="voice"
            className="pane"
            id="setup-media"
            ref={setSectionRef('voice')}
            aria-label={frontDeskText('settings_nav_voice', locale)}
          >
            <h2>{frontDeskText('settings_nav_voice', locale)}</h2>
            <h3 className="pane-subheading">{t('setup.media_title')}</h3>
            <p className="pane-subtitle">{t('setup.media_description')}</p>
            <div className="item-card">
              <p className="item-title">
                {t('setup.photo_avatar')}{' '}
                <span
                  className={`status-chip${setup.profile.avatar_registered ? '' : ' attention'}`}
                >
                  {setup.profile.avatar_registered
                    ? t('setup.registered')
                    : t('setup.unregistered')}
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
                    <button
                      className="action-button secondary"
                      disabled={busy}
                      onClick={stopCamera}
                    >
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
                    void prepareAvatarFile(file).then((avatar) =>
                      upload('avatar', avatar, 'upload')
                    );
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
            <div className="item-card" id="voice-runtime-settings">
              <p className="item-title">{t('setup.agent_display_name')}</p>
              <p className="item-meta">{t('setup.media_description')}</p>
              {voiceSelection ? (
                <div className="field-column">
                  <label>
                    {t('dock.voice.backend')}
                    <select
                      value={voiceSelection.preferences.stt_backend}
                      disabled={voiceSelectionBusy}
                      onChange={(event) =>
                        void saveVoiceSelection('stt_backend', event.target.value)
                      }
                    >
                      <option value="auto">{t('dock.voice.auto')}</option>
                      {voiceSelection.stt.candidates.map((candidate) => (
                        <option
                          key={candidate.backend}
                          value={candidate.backend}
                          disabled={!candidate.selectable}
                        >
                          {candidate.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {t('setup.voice_profile')}
                    <select
                      value={voiceSelection.preferences.tts_engine_id}
                      disabled={voiceSelectionBusy}
                      onChange={(event) =>
                        void saveVoiceSelection('tts_engine_id', event.target.value)
                      }
                    >
                      {voiceSelection.tts.candidates.map((candidate) => (
                        <option
                          key={candidate.engine_id}
                          value={candidate.engine_id}
                          disabled={!candidate.selectable}
                        >
                          {candidate.display_name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {voiceDevices.length > 0 ? (
                    <p className="item-meta">{voiceDevices[0].name}</p>
                  ) : null}
                </div>
              ) : (
                <p className="item-meta">{t('setup.loading')}</p>
              )}
            </div>
          </section>
        );

      case 'notifications':
        return (
          <section
            key="notifications"
            className="pane"
            id="setup-notifications"
            ref={setSectionRef('notifications')}
            aria-label={frontDeskText('settings_nav_notifications', locale)}
          >
            <h2>{frontDeskText('settings_nav_notifications', locale)}</h2>
            <h3 className="pane-subheading">{t('setup.notifications_title')}</h3>
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
        );

      case 'plugins':
        return (
          <section
            key="plugins"
            className="pane"
            id="setup-plugins"
            ref={setSectionRef('plugins')}
            aria-label={frontDeskText('settings_nav_plugins', locale)}
          >
            <h2>{frontDeskText('settings_nav_plugins', locale)}</h2>
            <h3 className="pane-subheading">{t('setup.plugins_title')}</h3>
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
        );

      case 'advanced':
      default:
        return (
          <section
            key="advanced"
            className="pane"
            id="settings-advanced"
            ref={setSectionRef('advanced')}
            aria-label={frontDeskText('settings_nav_advanced', locale)}
          >
            <h2>{frontDeskText('settings_nav_advanced', locale)}</h2>
            <p className="settings-card-lead">{frontDeskText('settings_advanced_lead', locale)}</p>
            {chronosUrl ? (
              <p className="item-meta">
                <a href={chronosUrl}>{frontDeskText('settings_open_chronos', locale)}</a>
              </p>
            ) : null}

            <details className="settings-details">
              <summary>{t('setup.management_title')}</summary>
              <div id="setup-management">
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
                    onChange={(event) =>
                      setManagement({ ...management, agent_id: event.target.value })
                    }
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
                  <button
                    className="action-button"
                    disabled={busy}
                    onClick={() => void saveManagement()}
                  >
                    {t('setup.save_management')}
                  </button>
                </div>
              </div>
            </details>

            <details className="settings-details">
              <summary>{t('setup.governance_title')}</summary>
              <div id="setup-governance">
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
                                setConfigInputs({
                                  ...configInputs,
                                  [input.key]: event.target.value,
                                })
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
                                setConfigInputs({
                                  ...configInputs,
                                  [input.key]: event.target.value,
                                })
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
                                setConfigInputs({
                                  ...configInputs,
                                  [input.key]: event.target.value,
                                })
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
              </div>
            </details>

            <details className="settings-details">
              <summary>{t('setup.operations_title')}</summary>
              <div id="setup-operations">
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
                        <button
                          className="link-button"
                          onClick={() => jumpToSection(capability.href!)}
                        >
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
              </div>
            </details>
          </section>
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
