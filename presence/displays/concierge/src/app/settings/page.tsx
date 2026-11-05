'use client';
import type { OAuthOperationHandle } from './sections/OAuthOperationCard';

import { frontDeskFetch as fetch } from '../../lib/front-desk-fetch';

import * as React from 'react';
import {
  Button,
  Callout,
  Disclosure,
  PageHeader,
  SaveBar,
  SettingsNav,
  Skeleton,
} from '@agent/shared-ui';
import { useConciergeI18n } from '../../lib/use-concierge-i18n';
import { frontDeskText } from '../../lib/i18n';
import { parseSetupResponse, type Setup as SetupPayload } from '../../lib/setup-response';
import { parseConciergeMutationResponse } from '../../lib/mutation-response';
import {
  parseConfigMissionsResponse,
  parseNotificationPreferencesResponse,
  parsePluginListResponse,
} from '../../lib/setup-auxiliary-response';
import {
  DIAGNOSTIC_SECTION,
  SETTINGS_CARDS,
  SETTINGS_CATEGORIES,
  SETTINGS_SECTION_ELEMENT_ID,
  SETTINGS_SECTION_ORDER,
  filterSettingsCards,
  resolveSelectedServices,
  type SettingsSectionId,
} from '../../lib/settings-view';
import { useSetupChecklist } from '../../lib/setup-checklist-client';
import { companySetupHref } from '../setup/company/company-setup-model';
import { ReasoningSection } from './sections/ReasoningSection';
import { SetupChecklistCard } from './sections/SetupChecklistCard';
import { SettingMeta } from './sections/settings-ia-parts';
import {
  BudgetCard,
  CliOperationsCard,
  CompanySetupCard,
  EngineConfigCard,
  ProjectsCard,
  SecretsCard,
  SsoCard,
  TenantCliCard,
  TrialMissionCard,
} from './sections/IaCards';
import { CARD_META } from './settings-card-meta';
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
  type SettingsMemberPatch,
  type SettingsRole,
  type SettingsTenantView,
} from '../../lib/settings-types';
import {
  useSettingsDraft,
  useSettingsDraftSession,
  isOnboardingSaveReceipt,
  notificationSaveReceipt,
} from '../../lib/use-settings-draft';
import { useSettingsExitRegistration } from '../../lib/settings-exit-guard';
import { useVoiceSelection } from '../../lib/use-voice-selection';
import { useTrainingAssignments } from '../../lib/use-training-assignments';
import { useRecordingConsent } from '../../lib/use-recording-consent';
import { openServiceConsentWindow } from '../../lib/oauth-popup';
import { ProfileSection } from './sections/ProfileSection';
import type { SettingsSaveFeedbackState } from './sections/SettingsSaveFeedback';
import { installationAccessCodeOf } from '../../lib/installation-access-client';
import { MembersSection, type MemberFormState } from './sections/MembersSection';
import { ServicesSection } from './sections/ServicesSection';
import { VoiceSection } from './sections/VoiceSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { RecordingConsentSection } from './sections/RecordingConsentSection';
import { PluginsSection, type PluginConfirmState } from './sections/PluginsSection';
import { AdvancedSection, type ManagementState } from './sections/AdvancedSection';
import { AuthoritySection } from './sections/AuthoritySection';
import { DisplaySection } from './sections/DisplaySection';
import { PasskeyPane } from './sections/PasskeyPane';
import { FormScope } from './sections/form-scope';
import { buildSettingsPatch, type ProfileDraft } from '../../lib/settings-save-patch';
import { postSetupUpload, toUploadFile } from './settings-api';
import {
  SYSTEM_SELECTION,
  withSelectedTenant,
  readSelectedTenant,
  readTenantSelection,
} from '../../lib/tenant-context';
import { createSettingsNavigation, resolveSettingsTarget } from './settings-navigation';
import './settings.css';
import { SettingsReadiness } from './settings-readiness';
import { createSettingsMenu } from './settings-menu';

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

type SaveBarState = 'clean' | 'dirty' | 'saving' | 'saved' | 'error';

/** The server's own refusal text, when it sent one. */
const failureMessage = (body: unknown): string | undefined =>
  body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
    ? (body as { error: string }).error
    : undefined;

const sameServices = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
const sameProfile = (a: ProfileDraft, b: ProfileDraft) =>
  a.name === b.name &&
  a.primary_domain === b.primary_domain &&
  a.vision === b.vision &&
  a.agent_id === b.agent_id;

export default function SettingsPage() {
  const { locale, setLocale, t } = useConciergeI18n();
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [error, setError] = React.useState<'unavailable' | 'context-changed' | null>(null);
  const [retrying, setRetrying] = React.useState(false);
  const retryPending = React.useRef(false);
  const [notice, setNotice] = React.useState<Notice>(null);
  const [busy, setBusy] = React.useState(false);
  const [saveFeedback, setSaveFeedback] = React.useState<SettingsSaveFeedbackState | null>(null);
  const profileDraft = useSettingsDraft(
    {
      name: '',
      primary_domain: '',
      vision: '',
      agent_id: 'sovereign-agent',
    },
    sameProfile
  );
  const {
    draft: profile,
    set: setProfile,
    saved: savedProfile,
    load: loadProfile,
    acknowledge: ackProfile,
  } = profileDraft;
  const servicesDraft = useSettingsDraft<string[]>(DEFAULT_SERVICES, sameServices);
  const {
    draft: services,
    set: setServices,
    saved: savedServices,
    load: loadServices,
    acknowledge: ackServices,
  } = servicesDraft;
  // UI-06 save bar: the last loaded (= saved) values, so grouped unsaved
  // changes across プロフィール / サービス連携 / 通知 can be saved or discarded.
  const [saveBarPhase, setSaveBarPhase] = React.useState<'idle' | 'saving' | 'saved' | 'error'>(
    'idle'
  );
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
  const notifDraft = useSettingsDraft(
    { surface: 'none', target: '' },
    (a, b) => a.surface === b.surface && a.target.trim() === b.target.trim()
  );
  const {
    draft: notif,
    set: setNotif,
    saved: savedNotif,
    load: loadNotif,
    acknowledge: ackNotif,
  } = notifDraft;
  const [plugins, setPlugins] = React.useState<PluginEntry[]>([]);
  const [pluginConfirm, setPluginConfirm] = React.useState<PluginConfirmState>(null);
  const [configPresets, setConfigPresets] = React.useState<ConfigPreset[]>([]);
  const [configTenants, setConfigTenants] = React.useState<string[]>([]);
  const [configRecent, setConfigRecent] = React.useState<ConfigMissionItem[]>([]);
  const [configPresetId, setConfigPresetId] = React.useState('');
  const [configTenant, setConfigTenant] = React.useState('');
  const [configInputs, setConfigInputs] = React.useState<Record<string, string>>({});
  const [configConfirm, setConfigConfirm] = React.useState(false);
  const [voiceRecording, setVoiceRecording] = React.useState(false);
  const [oauthOperation, setOauthOperation] = React.useState<OAuthOperationHandle | null>(null);
  const [oauthBusyId, setOauthBusyId] = React.useState<string | null>(null);
  const [oauthMessage, setOauthMessage] = React.useState<string | null>(null);
  const [oauthError, setOauthError] = React.useState(false);
  const [meTenants, setMeTenants] = React.useState<SettingsTenantView[]>([]);
  const [meViewing, setMeViewing] = React.useState<SettingsTenantView | null>(null);
  const [members, setMembers] = React.useState<SettingsMember[]>([]);
  const [memberContextId, setMemberContextId] = React.useState<string | undefined>();
  const memberPending = React.useRef(false);
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
  const recordingConsent = useRecordingConsent(locale, setNotice);
  const { refreshRecordingConsent, refreshRecordingObservations } = recordingConsent;
  const [activeSection, setActiveSection] = React.useState<SettingsSectionId>('start');
  const [searchQuery, setSearchQuery] = React.useState('');
  const checklist = useSetupChecklist();
  const [studioUrl, setStudioUrl] = React.useState<string | null>(null);
  const voiceStreamRef = React.useRef<MediaStream | null>(null);
  const voiceRecorderRef = React.useRef<MediaRecorder | null>(null);
  const voiceChunksRef = React.useRef<Blob[]>([]);
  const sectionRefs = React.useRef<Partial<Record<SettingsSectionId, HTMLElement | null>>>({});
  const settingsNavigation = React.useRef<ReturnType<typeof createSettingsNavigation> | null>(null);
  const compactNavigation = React.useRef<HTMLDivElement | null>(null);

  const setupRef = React.useRef(setup);
  setupRef.current = setup;
  const textRef = React.useRef(t);
  textRef.current = t;
  const savePending = React.useRef(false);
  const invalidateExit = React.useRef<() => void>(() => {});
  const draftSession = useSettingsDraftSession(() => {
    invalidateExit.current();
    profileDraft.clear();
    servicesDraft.clear();
    notifDraft.clear();
    setSetup(null);
    setNotice(null);
    setBusy(false);
    setSaveFeedback(null);
    setMembers([]);
    setMemberContextId(undefined);
    setIssuedToken(null);
    setMemberBusy(false);
    setMeTenants([]);
    setMeViewing(null);
    setMemberForm({
      display_name: '',
      member_id: '',
      tenant_slug: '',
      role: 'viewer',
      issue_token: false,
    });
    setError('context-changed');
  });

  const refresh = React.useCallback(async () => {
    const current = draftSession.startRead('setup');
    try {
      if (!(await draftSession.check()) || !current()) return;
      const response = await fetch('/api/setup', { cache: 'no-store' });
      if (!draftSession.inspect(response)) return;
      const next = parseSetupResponse(await response.json().catch(() => null));
      if (!current()) return;
      if (!response.ok || !next) throw new Error('Invalid setup response');
      if (!(await draftSession.check()) || !current()) return;
      setSetup(next);
      const loadedProfile = {
        name: next.profile.name,
        primary_domain: next.profile.primary_domain,
        vision: next.profile.vision,
        agent_id: next.profile.agent_id || 'sovereign-agent',
      };
      loadProfile(loadedProfile);
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
      const loadedServices = resolveSelectedServices(
        next.service_catalog,
        next.selected_services,
        DEFAULT_SERVICES
      );
      loadServices(loadedServices);
      setError(null);
    } catch {
      if (!current()) return;
      if (setupRef.current)
        setNotice({ text: textRef.current('setup.draft_refresh_failed'), error: true });
      else setError('unavailable');
    }
  }, [draftSession, loadProfile, loadServices]);

  const refreshNotifications = React.useCallback(async () => {
    const current = draftSession.startRead('notifications');
    try {
      if (!(await draftSession.check()) || !current()) return;
      const response = await fetch('/api/notification-preferences', { cache: 'no-store' });
      if (!draftSession.inspect(response)) return;
      const parsed = parseNotificationPreferencesResponse(await response.json().catch(() => null));
      if (!current()) return;
      if (!response.ok || !parsed) throw new Error('Invalid notification preferences response');
      if (!(await draftSession.check()) || !current()) return;
      setNotifChannels(parsed.channels);
      setNotifCurrent(parsed.preferences.default_channel);
      const loadedNotif = parsed.preferences.default_channel
        ? {
            surface: parsed.preferences.default_channel.surface,
            target: parsed.preferences.default_channel.target,
          }
        : { surface: 'none', target: '' };
      loadNotif(loadedNotif);
    } catch {
      if (current())
        setNotice({ text: textRef.current('setup.draft_refresh_failed'), error: true });
    }
  }, [draftSession, loadNotif]);

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
    const current = draftSession.startRead('me');
    try {
      if (!current()) return;
      const response = await fetch('/api/me', { cache: 'no-store' });
      if (!current() || !draftSession.inspect(response)) return;
      const parsed = parseSettingsMe(await response.json().catch(() => null));
      if (!response.ok || !parsed) throw new Error('Invalid me response');
      if (!current()) return;
      setMeTenants(parsed.tenants);
      setMeViewing(parsed.viewing);
    } catch {
      // 組織とメンバー shows an empty list rather than blocking the page.
    }
  }, [draftSession]);

  // Retry only initial reads in the same valid draft session. A terminal
  // authorization/context invalidation still requires a fresh page.
  const retryLoad = React.useCallback(async () => {
    const epoch = draftSession.epoch();
    if (retryPending.current || setupRef.current || !draftSession.current(epoch)) return;
    retryPending.current = true;
    setRetrying(true);
    setNotice(null);
    try {
      await Promise.all([refresh(), refreshNotifications(), refreshMe()]);
    } finally {
      retryPending.current = false;
      if (draftSession.current(epoch)) setRetrying(false);
    }
  }, [draftSession, refresh, refreshNotifications, refreshMe]);

  // FD-07: the member list itself. Degrades to an empty list — a non-owner
  // viewer simply sees nothing here (the section stays visible, matching
  // every other degrade-gracefully pane on this page).
  const refreshMembers = React.useCallback(async () => {
    const current = draftSession.startRead('members');
    try {
      if (!(await draftSession.check()) || !current()) return false;
      const response = await fetch('/api/members', { cache: 'no-store' });
      if (!current() || !draftSession.inspect(response)) return false;
      const payload = await response.json().catch(() => null);
      const parsed = parseMembersResponse(payload);
      if (!response.ok || !parsed) throw new Error('Invalid members response');
      if (!(await draftSession.check()) || !current()) return false;
      setMembers(parsed);
      setMemberContextId(typeof payload.context_id === 'string' ? payload.context_id : undefined);
      return true;
    } catch {
      if (current()) {
        setMembers([]);
        setMemberContextId(undefined);
      }
      return false;
    }
  }, [draftSession]);

  // FD-07 「メンバーを追加」: fires only from the explicit form submit — no
  // auto-creation, no default role. The new access token (when requested)
  // is shown exactly once via `issuedToken` and never re-fetchable.
  const addMember = React.useCallback(async () => {
    const epoch = draftSession.epoch();
    if (memberPending.current || !draftSession.current(epoch)) return;
    memberPending.current = true;
    setMemberBusy(true);
    try {
      if (!memberContextId) throw new Error(t('management.changed'));
      if (!(await draftSession.check(epoch))) return;
      draftSession.advance('members');
      const response = await fetch('/api/members', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...memberForm, expected_context_id: memberContextId }),
      });
      if (!draftSession.current(epoch) || !draftSession.inspect(response)) return;
      const parsed = parseAddMemberResponse(await response.json().catch(() => null));
      if (!draftSession.current(epoch)) return;
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
      if (!(await draftSession.check(epoch))) return;
      setIssuedToken(parsed.token);
      setMemberForm((current) => ({ ...current, display_name: '', member_id: '' }));
      if (!(await refreshMembers()) || !draftSession.current(epoch)) {
        if (draftSession.current(epoch))
          setNotice({ text: t('management.uncertain'), error: true });
        return;
      }
      setNotice({ text: frontDeskText('settings_member_added', locale) });
    } catch (err) {
      if (draftSession.current(epoch))
        setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
    } finally {
      memberPending.current = false;
      if (draftSession.current(epoch)) setMemberBusy(false);
    }
  }, [memberForm, locale, refreshMembers, memberContextId, draftSession, t]);

  // FD-07 role change / suspend / reactivate — owner-only PATCH, no delete.
  const patchMember = React.useCallback(
    async (memberId: string, patch: SettingsMemberPatch) => {
      const epoch = draftSession.epoch();
      if (memberPending.current || !draftSession.current(epoch)) return;
      memberPending.current = true;
      setMemberBusy(true);
      try {
        const expectedVersion =
          patch.expected_version ??
          members.find((member) => member.member_id === memberId)?.version;
        const contextId = patch.expected_context_id ?? memberContextId;
        if (!contextId || contextId !== memberContextId || !expectedVersion)
          throw new Error(t('management.changed'));
        if (!(await draftSession.check(epoch))) return;
        draftSession.advance('members');
        const response = await fetch(`/api/members/${encodeURIComponent(memberId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...patch,
            expected_version: expectedVersion,
            expected_context_id: contextId,
          }),
        });
        if (!draftSession.current(epoch) || !draftSession.inspect(response)) return;
        const parsed = await response.json().catch(() => null);
        if (!draftSession.current(epoch)) return;
        if (!response.ok || !parsed?.ok) {
          throw new Error(
            (parsed && typeof parsed.error === 'string' && parsed.error) || 'Member update failed'
          );
        }
        if (!(await draftSession.check(epoch))) return;
        if (!(await refreshMembers()) || !draftSession.current(epoch)) {
          if (draftSession.current(epoch))
            setNotice({ text: t('management.uncertain'), error: true });
          return;
        }
        setNotice({ text: frontDeskText('settings_member_updated', locale) });
      } catch (err) {
        if (draftSession.current(epoch))
          setNotice({ text: err instanceof Error ? err.message : String(err), error: true });
      } finally {
        memberPending.current = false;
        if (draftSession.current(epoch)) setMemberBusy(false);
      }
    },
    [locale, refreshMembers, memberContextId, members, draftSession, t]
  );

  // FD-06 詳細設定: the 管制塔 (chronos-mirror-v2) link's port is resolved
  // server-side (plan §2.6) — this component only ever holds the string URL.
  const refreshChronosLink = React.useCallback(async () => {
    try {
      const response = await fetch('/api/front-desk/links', { cache: 'no-store' });
      const links = await response.json().catch(() => null);
      const chronos = parseChronosLink(links);
      if (!response.ok || !chronos) throw new Error('Invalid links response');
      setChronosUrl(chronos);
      const studio = (links as { studio_engine_config_url?: unknown }).studio_engine_config_url;
      if (typeof studio === 'string' && /^https?:\/\//.test(studio)) setStudioUrl(studio);
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
          body: JSON.stringify({
            decision,
            presentedDigest: plugins.find((plugin) => plugin.id === id)?.approval?.presented_digest,
          }),
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
    [plugins, refreshPlugins]
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
    void refreshRecordingConsent();
    void refreshRecordingObservations();
    return () => {
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
    refreshRecordingConsent,
    refreshRecordingObservations,
  ]);

  React.useEffect(() => {
    if (memberForm.tenant_slug || meTenants.length === 0) return;
    setMemberForm((current) => ({ ...current, tenant_slug: meTenants[0].tenant_slug }));
  }, [meTenants, memberForm.tenant_slug]);

  const jumpToSection = React.useCallback((target: string) => {
    // Close the mobile chooser before measuring the destination's position.
    const disclosure = compactNavigation.current?.querySelector('details');
    if (disclosure) disclosure.open = false;
    // Jumping to a card leaves search mode so its category is the visible one.
    setSearchQuery('');
    settingsNavigation.current?.navigate(target);
  }, []);
  const settingsReady = setup !== null;
  React.useEffect(() => {
    if (!settingsReady) return;
    const navigation = createSettingsNavigation(
      window,
      document,
      sectionRefs.current,
      setActiveSection
    );
    settingsNavigation.current = navigation;
    return () => {
      navigation.dispose();
      settingsNavigation.current = null;
    };
  }, [settingsReady]);
  // The section becomes visible only after `activeSection` commits, so
  // scrollIntoView inside the navigation helper hits a display:none element.
  // Reveal the hash target (or the content top) once it is laid out.
  React.useLayoutEffect(() => {
    if (!settingsReady) return;
    const target = resolveSettingsTarget(window.location?.hash ?? '');
    const element = target ? document.getElementById(target.id) : null;
    if (element) element.scrollIntoView({ block: 'start', behavior: 'auto' });
    else window.scrollTo?.({ top: 0, behavior: 'auto' });
  }, [activeSection, settingsReady]);

  const saveNotification = React.useCallback(
    async (grouped = false): Promise<boolean> => {
      if (savePending.current && !grouped) return false;
      if (!grouped) {
        savePending.current = true;
        setSaveFeedback({ section: 'notifications', phase: 'saving' });
        setNotice(null);
      }
      const epoch = draftSession.epoch();
      const submitted = { ...notif };
      setBusy(true);
      let submittedRequest = false;
      try {
        if (!(await draftSession.check(epoch))) return false;
        draftSession.advance('notifications');
        submittedRequest = true;
        const response = await fetch('/api/notification-preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ surface: submitted.surface, channel: submitted.target.trim() }),
        });
        if (!draftSession.current(epoch) || !draftSession.inspect(response)) return false;
        const receipt = notificationSaveReceipt(await response.json().catch(() => null));
        if (!draftSession.current(epoch)) return false;
        const saved = receipt === null ? { surface: 'none', target: '' } : receipt;
        if (
          !response.ok ||
          !saved ||
          saved.surface !== submitted.surface ||
          (submitted.surface !== 'none' && saved.target !== submitted.target.trim())
        )
          throw new Error('Unconfirmed notification save');
        if (!(await draftSession.check(epoch))) return false;
        draftSession.advance('notifications');
        ackNotif(submitted, saved);
        setNotifCurrent(receipt ?? null);
        if (!grouped) setSaveFeedback({ section: 'notifications', phase: 'saved' });
        if (grouped) setNotice({ text: t('setup.notification_saved') });
        await Promise.all([refreshNotifications(), refresh()]);
        return draftSession.current(epoch);
      } catch {
        if (!grouped && draftSession.current(epoch))
          setSaveFeedback({
            section: 'notifications',
            phase: submittedRequest ? 'unconfirmed' : 'unavailable',
          });
        if (grouped && draftSession.current(epoch))
          setNotice({
            text: t(
              submittedRequest ? 'setup.draft_save_unconfirmed' : 'setup.draft_context_unavailable'
            ),
            error: true,
          });
        return false;
      } finally {
        if (!grouped) {
          savePending.current = false;
          setBusy(false);
        }
      }
    },
    [notif, draftSession, ackNotif, refresh, refreshNotifications, t]
  );

  const connectOAuth = React.useCallback(
    async (serviceId: string, serviceLabel: string) => {
      setOauthBusyId(serviceId);
      setOauthMessage(null);
      setOauthError(false);
      const oauthWindow = openServiceConsentWindow();
      try {
        const response = await globalThis.fetch('/api/oauth/begin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ service_id: serviceId }),
        });
        const body = (await response.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          authorization_url?: string;
          service_id?: string;
          operation_id?: string;
          expires_at?: string;
        } | null;
        if (!response.ok || !body?.ok || !body.authorization_url) {
          throw new Error(body?.error || `HTTP ${response.status}`);
        }
        const authorizationUrl = new URL(body.authorization_url);
        if (
          authorizationUrl.protocol !== 'https:' ||
          authorizationUrl.username ||
          authorizationUrl.password
        )
          throw new Error(t('authority.oauth_invalid'));
        if (oauthWindow) oauthWindow.location.href = body.authorization_url;
        else window.location.assign(body.authorization_url);
        if (body.operation_id && body.service_id && body.expires_at)
          setOauthOperation({
            operationId: body.operation_id,
            serviceId: body.service_id,
            label: serviceLabel || serviceId,
            expiresAt: body.expires_at,
          });
        setOauthMessage(t('setup.connect_oauth_started', { service: serviceLabel || serviceId }));
      } catch (err) {
        oauthWindow?.close();
        setOauthError(true);
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

  // Settings saves send only the edited fields (`save_settings`); the server
  // merges them onto the stored profile. The profile button also carries
  // service edits (its label covers both), the services button only those.
  const saveSettings = React.useCallback(
    async (grouped = false, section?: 'profile' | 'services'): Promise<boolean> => {
      if (!setup || (savePending.current && !grouped)) return false;
      const submitted = { ...profile };
      const submittedServices = [...services];
      const servicesChanged =
        savedServices === null ||
        !sameServices(submittedServices, savedServices) ||
        // First save: persist the selection the page shows, not an empty one.
        setup.selected_services === undefined;
      const built = buildSettingsPatch({
        savedProfile,
        ...(section !== 'services' ? { profile: submitted } : {}),
        ...(servicesChanged ? { services: submittedServices } : {}),
      });
      if (!grouped) {
        savePending.current = true;
        setSaveFeedback(section ? { section, phase: built ? 'saving' : 'saved' } : null);
        if (section) setNotice(null);
      }
      if (!built) {
        if (!grouped) savePending.current = false;
        return true;
      }
      const epoch = draftSession.epoch();
      setBusy(true);
      let submittedRequest = false;
      try {
        if (!(await draftSession.check(epoch))) return false;
        draftSession.advance('setup');
        submittedRequest = true;
        const response = await fetch('/api/setup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'save_settings', patch: built.patch }),
        });
        if (!draftSession.current(epoch) || !draftSession.inspect(response)) return false;
        const receipt = await response.json().catch(() => null);
        if (!draftSession.current(epoch)) return false;
        const denied = response.ok ? null : installationAccessCodeOf(receipt);
        if (denied && section) {
          // Installation scope: another member, or the owner on another
          // device before a passkey confirmation — not a failed save.
          setSaveFeedback({ section, phase: 'rejected', access: denied });
          return false;
        }
        if (!response.ok || !isOnboardingSaveReceipt(receipt))
          throw new Error('Unconfirmed settings save');
        if (!(await draftSession.check(epoch))) return false;
        draftSession.advance('setup');
        if (built.patch.identity && built.savedProfile) ackProfile(submitted, built.savedProfile);
        if (built.patch.services) ackServices(submittedServices);
        if (section) setSaveFeedback({ section, phase: 'saved' });
        if (!section) setNotice({ text: t('setup.onboarding_saved') });
        await refresh();
        return draftSession.current(epoch);
      } catch {
        if (section && draftSession.current(epoch))
          setSaveFeedback({ section, phase: submittedRequest ? 'unconfirmed' : 'unavailable' });
        if (!section && draftSession.current(epoch))
          setNotice({
            text: t(
              submittedRequest ? 'setup.draft_save_unconfirmed' : 'setup.draft_context_unavailable'
            ),
            error: true,
          });
        return false;
      } finally {
        if (!grouped) {
          savePending.current = false;
          setBusy(false);
        }
      }
    },
    [
      profile,
      refresh,
      services,
      savedProfile,
      savedServices,
      setup,
      t,
      draftSession,
      ackProfile,
      ackServices,
    ]
  );

  // Voice registration saves immediately and only the voice profile: the
  // stored engine and languages of an existing profile are kept server-side.
  const registerVoice = React.useCallback(async () => {
    if (savePending.current) return;
    savePending.current = true;
    setBusy(true);
    setSaveFeedback({ section: 'voice', phase: 'saving' });
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_settings',
          patch: {
            voice: {
              profile_id: voice.profile_id,
              display_name: voice.display_name,
              sample_refs: voiceSampleRefs.slice(0, 3),
            },
          },
        }),
      });
      const receipt = await response.json().catch(() => null);
      if (!response.ok || !isOnboardingSaveReceipt(receipt)) {
        setSaveFeedback({ section: 'voice', phase: 'rejected', message: failureMessage(receipt) });
        return;
      }
      setSaveFeedback({ section: 'voice', phase: 'saved' });
      await refresh();
    } catch {
      setSaveFeedback({ section: 'voice', phase: 'unconfirmed' });
    } finally {
      savePending.current = false;
      setBusy(false);
    }
  }, [refresh, voice, voiceSampleRefs]);

  // 詳細設定 (management) saves immediately, for an explicitly selected
  // registered tenant only (the server refuses anything else). Profile
  // drafts are not sent: unsaved Profile edits stay in the Profile section.
  const saveManagement = React.useCallback(async () => {
    if (!setup || savePending.current) return;
    if (!setup.tenant.catalog.some((tenant) => tenant.tenant_slug === management.tenant_slug)) {
      setSaveFeedback({
        section: 'advanced',
        phase: 'rejected',
        message: t('api.config.tenant_invalid'),
      });
      return;
    }
    savePending.current = true;
    setBusy(true);
    setSaveFeedback({ section: 'advanced', phase: 'saving' });
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'save_management',
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
      const body = await response.json().catch(() => null);
      if (!response.ok || body?.ok !== true) {
        setSaveFeedback({ section: 'advanced', phase: 'rejected', message: failureMessage(body) });
        return;
      }
      setSaveFeedback({ section: 'advanced', phase: 'saved' });
      await refresh();
    } catch {
      setSaveFeedback({ section: 'advanced', phase: 'unconfirmed' });
    } finally {
      savePending.current = false;
      setBusy(false);
    }
  }, [management, refresh, setup, t]);

  const upload = React.useCallback(
    async (action: 'avatar' | 'voice_sample', file: File, source = 'upload') => {
      setBusy(true);
      try {
        const response = await postSetupUpload({
          action,
          profileId: voice.profile_id,
          source,
          file,
        });
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

  // UI-06: AvatarPicker hands over a square-cropped Blob (from a file or its
  // own camera panel, which it starts only on the person's click and stops on
  // confirm / cancel / unmount); it goes through the same 512px PNG
  // normalization and `POST /api/setup` action=avatar upload as before.
  const changeAvatar = React.useCallback(
    async (blob: Blob, source: 'upload' | 'camera') => {
      const avatar = await prepareAvatarFile(toUploadFile(blob, 'avatar.png'));
      await upload('avatar', avatar, source);
    },
    [prepareAvatarFile, upload]
  );

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

  const profileDirty = savedProfile !== null && !sameProfile(profile, savedProfile);
  const servicesDirty = savedServices !== null && !sameServices(services, savedServices);
  const notifDirty =
    savedNotif === null
      ? notifDraft.edited
      : notif.surface !== savedNotif.surface || notif.target.trim() !== savedNotif.target;
  const anyDirty = profileDirty || servicesDirty || notifDirty;
  const discardAll = () => {
    if (savePending.current) return false;
    setSaveFeedback(null);
    profileDraft.discard();
    servicesDraft.discard();
    notifDraft.discard();
    setSaveBarPhase('idle');
    return true;
  };
  const exitRegistration = useSettingsExitRegistration({
    dirty: anyDirty,
    saving: savePending.current,
    isSaving: () => savePending.current,
    valid: setup !== null && draftSession.current(draftSession.epoch()),
    discard: discardAll,
  });
  invalidateExit.current = exitRegistration.invalidate;

  // The concierge shell supplies the shared-ui locale bundle (KbI18nProvider).
  if (error)
    return (
      <FormScope actions={{ 'settings.retry-load': () => void retryLoad() }}>
        <Callout
          tone="danger"
          title={t('setup.load_retry_title')}
          body={t(
            error === 'context-changed' ? 'setup.draft_context_changed' : 'setup.load_retry_help'
          )}
        >
          {error === 'unavailable' ? (
            <div aria-busy={retrying}>
              {retrying ? <p role="status">{t('setup.load_retry_pending')}</p> : null}
              <Button
                label={t('setup.load_retry_action')}
                action={{ id: 'settings.retry-load' }}
                disabled={retrying}
              />
            </div>
          ) : null}
        </Callout>
      </FormScope>
    );
  if (!setup) return <Skeleton shape="card" lines={4} label={t('setup.loading')} />;

  const saveBarState: SaveBarState =
    savePending.current || saveBarPhase === 'saving'
      ? 'saving'
      : saveBarPhase === 'error' && anyDirty
        ? 'error'
        : anyDirty
          ? 'dirty'
          : saveBarPhase === 'saved'
            ? 'saved'
            : 'clean';

  // One save for every grouped unsaved change: プロフィール + サービス連携
  // share one edited-fields patch (`save_settings`), 通知 its own route.
  // Voice, avatar, 詳細設定 and plugins save immediately from their own
  // buttons and report the result next to that button.
  const saveAll = async () => {
    if (savePending.current) return;
    setSaveFeedback(null);
    if (notifDirty && notif.surface !== 'none' && !notif.target.trim()) {
      setNotice({ text: t('api.notification_target'), error: true });
      setSaveBarPhase('error');
      return;
    }
    savePending.current = true;
    const epoch = draftSession.epoch();
    setSaveBarPhase('saving');
    setBusy(true);
    try {
      let ok = true;
      if (profileDirty || servicesDirty) ok = (await saveSettings(true)) && ok;
      if (notifDirty && draftSession.current(epoch)) ok = (await saveNotification(true)) && ok;
      if (!draftSession.current(epoch)) return;
      setSaveBarPhase(ok ? 'saved' : 'error');
      if (!ok) setNotice({ text: t('setup.draft_batch_incomplete'), error: true });
    } finally {
      savePending.current = false;
      setBusy(false);
    }
  };

  const channelDisplayName = (surface: string) =>
    notifChannels.find((channel) => channel.surface === surface)?.display_name || surface;
  const selectedTenant = readSelectedTenant() || meViewing?.tenant_slug || management.tenant_slug;
  const settingsMenu = createSettingsMenu(locale, {
    workspace: profileDirty,
    connections: servicesDirty,
    notifications: notifDirty,
  });
  const currentSettingsLabel = frontDeskText(SETTINGS_CATEGORIES[activeSection].label, locale);
  const settingsNav = (
    <SettingsNav
      label={frontDeskText('nav_settings', locale)}
      groups={settingsMenu}
      active={activeSection}
      onNavigate={jumpToSection}
    />
  );

  const setSectionRef = (id: SettingsSectionId) => (element: HTMLElement | null) => {
    sectionRefs.current[id] = element;
  };
  // Section components keep their own anchors; the category container is the
  // navigation target, so their former section refs are unused.
  const noRef = () => {};
  const searching = searchQuery.trim().length > 0;
  const visibleCards = new Set(
    filterSettingsCards(searchQuery, (key) => frontDeskText(key, locale)).map((card) => card.id)
  );
  // "Nice to have" readiness: the /api/setup items the checklist does not cover.
  const extraDiagnostics = setup.diagnostics.filter(
    (item) => item.id !== 'reasoning' && item.id !== 'notifications' && DIAGNOSTIC_SECTION[item.id]
  );

  // Declared as a `const` (not a hoisted `function`) so TypeScript narrows
  // `setup` to non-null inside it — the early `if (!setup) return` above
  // already guarantees that for every call site below.
  const renderCard = (id: string): React.ReactNode => {
    switch (id) {
      case 'settings-checklist':
        return (
          <SetupChecklistCard
            locale={locale}
            state={checklist}
            diagnostics={extraDiagnostics}
            onNavigate={jumpToSection}
          >
            {extraDiagnostics.length > 0 ? (
              <SettingsReadiness
                diagnostics={extraDiagnostics}
                t={t}
                title={frontDeskText('ia_settings_other_readiness', locale)}
                onNavigate={jumpToSection}
              />
            ) : null}
          </SetupChecklistCard>
        );
      case 'settings-trial-mission':
        return <TrialMissionCard locale={locale} />;
      case 'setup-profile':
        return (
          <ProfileSection
            locale={locale}
            t={t}
            profile={profile}
            setProfile={setProfile}
            busy={busy}
            saveFeedback={saveFeedback?.section === 'profile' ? saveFeedback : null}
            hasUnsavedChanges={profileDirty || servicesDirty}
            onSaveProfile={() => void saveSettings(false, 'profile')}
            sectionRef={noRef}
          >
            <PasskeyPane locale={locale} t={t} />
          </ProfileSection>
        );
      case 'settings-members':
        return (
          <MembersSection
            locale={locale}
            t={t}
            setup={setup}
            meTenants={meTenants}
            meViewing={meViewing}
            members={members}
            memberContextId={memberContextId}
            onRefreshMembers={() => void refreshMembers()}
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
            sectionRef={noRef}
          />
        );
      case 'settings-company':
        return (
          <CompanySetupCard
            locale={locale}
            href={selectedTenant ? companySetupHref(selectedTenant) : '/setup/company'}
          />
        );
      case 'settings-projects':
        return (
          <ProjectsCard
            locale={locale}
            state={checklist}
            href={withSelectedTenant('/management', selectedTenant, 'snake')}
          />
        );
      case 'settings-tenant-cli':
        return <TenantCliCard locale={locale} />;
      case 'settings-reasoning':
        return <ReasoningSection locale={locale} />;
      case 'settings-authority':
        return (
          <AuthoritySection
            locale={locale}
            t={t}
            authorityTenants={meTenants.filter((tenant) => tenant.status === 'active')}
            selectedTenant={meViewing?.tenant_slug || readSelectedTenant() || undefined}
            sectionRef={noRef}
          />
        );
      case 'setup-media':
        return (
          <VoiceSection
            locale={locale}
            t={t}
            setup={setup}
            busy={busy}
            onAvatarChange={(file, source) => void changeAvatar(file, source)}
            voice={voice}
            setVoice={setVoice}
            voiceSampleRefs={voiceSampleRefs}
            voiceRecording={voiceRecording}
            onStartVoiceRecording={() => void startVoiceRecording()}
            onStopVoiceRecording={stopVoiceRecording}
            onVoiceSampleFileChange={(file) => void upload('voice_sample', file, 'upload')}
            onSaveVoice={() => void registerVoice()}
            saveFeedback={saveFeedback?.section === 'voice' ? saveFeedback : null}
            voiceSelection={voiceSelection}
            voiceDevices={voiceDevices}
            voiceSelectionBusy={voiceSelectionBusy}
            onSaveVoiceSelection={(field, value) => void saveVoiceSelection(field, value)}
            sectionRef={noRef}
          />
        );
      case 'settings-engine':
        return <EngineConfigCard locale={locale} studioUrl={studioUrl} />;
      case 'setup-notifications':
        return (
          <NotificationsSection
            locale={locale}
            t={t}
            notifCurrent={notifCurrent}
            notif={notif}
            setNotif={setNotif}
            notifChannels={notifChannels}
            channelDisplayName={channelDisplayName}
            busy={busy}
            saveFeedback={saveFeedback?.section === 'notifications' ? saveFeedback : null}
            hasUnsavedChanges={notifDirty}
            onSaveNotification={() => void saveNotification()}
            sectionRef={noRef}
          />
        );
      case 'setup-services':
        return (
          <ServicesSection
            locale={locale}
            t={t}
            setup={setup}
            services={services}
            setServices={setServices}
            busy={busy}
            oauthOperation={oauthOperation}
            onDismissOAuthOperation={() => setOauthOperation(null)}
            oauthBusyId={oauthBusyId}
            oauthMessage={oauthMessage}
            oauthError={oauthError}
            onConnectOAuth={(serviceId, serviceLabel) => void connectOAuth(serviceId, serviceLabel)}
            saveFeedback={saveFeedback?.section === 'services' ? saveFeedback : null}
            hasUnsavedChanges={servicesDirty}
            onSaveConnections={() => void saveSettings(false, 'services')}
            sectionRef={noRef}
          />
        );
      case 'settings-sso':
        return <SsoCard locale={locale} />;
      case 'setup-plugins':
        return (
          <PluginsSection
            locale={locale}
            t={t}
            plugins={plugins}
            pluginConfirm={pluginConfirm}
            setPluginConfirm={setPluginConfirm}
            busy={busy}
            onDecidePlugin={(pluginId, decision) => void decidePlugin(pluginId, decision)}
            sectionRef={noRef}
          />
        );
      case 'settings-recording':
        return (
          <RecordingConsentSection
            locale={locale}
            sectionRef={noRef}
            // WI-18: attach still needs an owner/approver viewer; grant,
            // revoke, confirm, and discard are self-service for everyone.
            canAttachToWorkItem={meViewing?.role !== 'viewer'}
            {...recordingConsent}
          />
        );
      case 'settings-secrets':
        return <SecretsCard locale={locale} />;
      case 'settings-budget':
        return <BudgetCard locale={locale} state={checklist} />;
      case 'settings-display':
        return <DisplaySection locale={locale} t={t} onLocaleChange={setLocale} />;
      case 'settings-advanced':
        return (
          <AdvancedSection
            locale={locale}
            t={t}
            setup={setup}
            busy={busy}
            chronosUrl={chronosUrl}
            sectionRef={noRef}
            management={management}
            setManagement={setManagement}
            onSaveManagement={() => void saveManagement()}
            saveFeedback={saveFeedback?.section === 'advanced' ? saveFeedback : null}
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
      case 'settings-cli':
        return <CliOperationsCard locale={locale} />;
      default:
        return null;
    }
  };

  const renderCardWithMeta = (id: string) => {
    const meta = CARD_META[id];
    return (
      <div className="settings-card" key={id} data-card={id} hidden={!visibleCards.has(id)}>
        {renderCard(id)}
        {meta ? (
          <SettingMeta
            locale={locale}
            defaultValue={meta.default ? frontDeskText(meta.default, locale) : undefined}
            effect={frontDeskText(meta.effect, locale)}
          />
        ) : null}
      </div>
    );
  };

  return (
    <div className="settings-page kb-settings kb-page" data-width="default">
      <PageHeader
        title={frontDeskText('nav_settings', locale)}
        subtitle={frontDeskText('ia_settings_lead', locale)}
      />
      <div className="settings-search" role="search">
        <label className="kb-field__label" htmlFor="settings-search">
          {frontDeskText('ia_settings_search_label', locale)}
        </label>
        <input
          id="settings-search"
          className="kb-input"
          type="search"
          autoComplete="off"
          value={searchQuery}
          placeholder={frontDeskText('ia_settings_search_placeholder', locale)}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        {searching ? (
          <p className="kb-text kb-text--caption" role="status">
            {visibleCards.size > 0
              ? frontDeskText('ia_settings_search_results', locale, { count: visibleCards.size })
              : frontDeskText('ia_settings_search_empty', locale, { query: searchQuery.trim() })}
          </p>
        ) : null}
      </div>

      {notice ? (
        <div role="status" aria-live="polite">
          <Callout tone={notice.error ? 'danger' : 'success'} title={notice.text} />
        </div>
      ) : null}
      {/* Personal view: company-scoped panes read nothing until a company is chosen. */}
      {!meViewing && meTenants.length > 1 && readTenantSelection() !== SYSTEM_SELECTION ? (
        <Callout tone="info" title={frontDeskText('personal_scope_hint', locale)} />
      ) : null}

      <div className="settings-layout">
        <aside className="settings-navigation settings-navigation--desktop">{settingsNav}</aside>
        <div className="settings-navigation--compact" ref={compactNavigation}>
          <Disclosure
            summary={`${frontDeskText('nav_settings', locale)} · ${currentSettingsLabel}`}
          >
            {settingsNav}
          </Disclosure>
        </div>
        <div className="settings-content">
          {/* Every card stays mounted so in-progress panel state survives a
              switch; one category is visible, or every match while searching. */}
          {SETTINGS_SECTION_ORDER.map((category) => {
            const cards = SETTINGS_CARDS.filter((card) => card.category === category);
            const shown = searching
              ? cards.some((card) => visibleCards.has(card.id))
              : category === activeSection;
            return (
              <section
                key={category}
                id={SETTINGS_SECTION_ELEMENT_ID[category]}
                ref={setSectionRef(category)}
                className="settings-category"
                hidden={!shown}
                aria-labelledby={`${SETTINGS_SECTION_ELEMENT_ID[category]}-title`}
              >
                <header className="settings-category__header">
                  <h2 id={`${SETTINGS_SECTION_ELEMENT_ID[category]}-title`}>
                    {frontDeskText(SETTINGS_CATEGORIES[category].label, locale)}
                  </h2>
                  <p>{frontDeskText(SETTINGS_CATEGORIES[category].description, locale)}</p>
                </header>
                {cards.map((card) => renderCardWithMeta(card.id))}
              </section>
            );
          })}
        </div>
      </div>
      {saveBarState !== 'clean' ? (
        <FormScope
          actions={{
            'settings.save': () => void saveAll(),
            'settings.discard': discardAll,
          }}
        >
          <SaveBar
            id="settings-save"
            state={saveBarState}
            message={
              saveBarState === 'error'
                ? notice?.error
                  ? notice.text
                  : t('setup.draft_batch_incomplete')
                : undefined
            }
            save_action={{ id: 'settings.save' }}
            discard_action={{ id: 'settings.discard' }}
          />
        </FormScope>
      ) : null}
    </div>
  );
}
