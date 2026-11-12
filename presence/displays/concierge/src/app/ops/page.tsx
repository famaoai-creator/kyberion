'use client';

import { opsApiPath } from '../../lib/ops/ops-api-path';
import { localeToBcp47 } from '@agent/core/foundation/locale-normalize';
import {
  Shield,
  Building2,
  Cpu,
  Radar,
  Bot,
  ActivitySquare,
  Wrench,
  PanelsTopLeft,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  CalendarClock,
  LayoutGrid,
  Palette,
  Type,
  Ruler,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createChronosWebDesignSystem } from '@agent/core/web-design-system';
import { AgentOpsBoards } from '../../components/ops/AgentOpsBoards';
import {
  A2UIRenderer,
  KbArtifactTile,
  KbInterventionPanel,
} from '../../components/ops/A2UIComponentLibrary';
import { FocusedOperatorView } from '../../components/ops/FocusedOperatorView';
import { AgentPanel } from '../../components/ops/AgentPanel';
import { IdentityBadge } from '../../components/ops/IdentityBadge';
import { MissionIntelligence } from '../../components/ops/MissionIntelligence';
import { ChronosOffice } from '../../components/ops/ChronosOffice';
import { SurfaceControlWorkspace } from '../../components/ops/SurfaceControlWorkspace';
import { HeadlessA2UIWorkspace } from '../../components/ops/HeadlessA2UIWorkspace';
import { DiagnosticsAttentionSummary } from '../../components/ops/DiagnosticsAttentionSummary';
import { useChronosTenant } from '../../components/ops/ChronosTenantScope';
import {
  MISSION_CYCLE,
  OPERATOR_SCENARIO_PRESETS,
  OPERATOR_VIEW_LINKS,
  SURFACE_ROLES,
} from '../../lib/ops/operator-console';
import {
  chronosSpeechLocale,
  nextChronosLocale,
  setChronosLocalePreference,
  uxMessage,
  uxText,
} from '../../lib/ops/ux-vocabulary';
import { useChronosLocale } from '../../lib/ops/hooks';
import {
  CONSOLE_SECTIONS,
  buildPlanPreviewSignature,
  resolveConsoleSectionParam,
  OPS_DEFAULT_SECTION,
  buildQuickActionGroups,
  buildStatusCards,
  isPlanPreviewStale,
  loadOperatorLayoutPrefs,
  saveOperatorLayoutPrefs,
  type ConsoleContentSection,
  type ConsoleSectionId,
} from './chronos-page-config';
import { ChronosMirrorShell } from './ChronosMirrorShell';
import { resolveIaRedirect } from '../../lib/ia-routes';
import { withSelectedTenant } from '../../lib/tenant-context';
import { entityHref } from '../../lib/workspace-view';
import {
  nextChronosThemeMode,
  resolveChronosThemeMode,
  type ChronosThemeMode,
} from '../../lib/ops/chronos-theme';
import { parseTenantDesignResponse } from '../../lib/ops/tenant-design-response';
import {
  parseDeliverablesResponse,
  type ClientDeliverable,
} from '../../lib/ops/deliverables-response';
import {
  parseMissionHistoryResponse,
  type ClientMissionHistoryEntry,
} from '../../lib/ops/mission-history-response';
import { parseCostSummaryResponse } from '../../lib/ops/cost-summary-response';
import type { CostSummary } from '../../lib/ops/su-surface-data';
import {
  parseConnectionsResponse,
  type ClientConnectionReviewItem,
} from '../../lib/ops/connections-response';
import {
  parseOperatorHomeResponse,
  type ClientOperatorHomeSummary,
} from '../../lib/ops/operator-home-response';
import {
  parsePlanPreviewResponse,
  type ClientPlanPreview,
} from '../../lib/ops/plan-preview-response';
import { parseConnectionReviewResponse } from '../../lib/ops/connection-review-response';
import {
  parseMissionApprovalResponse,
  parseMissionProposalResponse,
} from '../../lib/ops/agent-mutation-response';
/** The flagged legacy grid (`NEXT_PUBLIC_CHRONOS_LEGACY_WORKSPACE=1`) is the only reader of the moved sections' data. */
const OPS_LEGACY_WORKSPACE = process.env.NEXT_PUBLIC_CHRONOS_LEGACY_WORKSPACE === '1';

export default function ChronosMirrorV2() {
  return (
    <Suspense fallback={null}>
      <ChronosMirrorV2Content />
    </Suspense>
  );
}

function ChronosMirrorV2Content() {
  const locale = useChronosLocale();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tenant = useChronosTenant();
  const organizationId = searchParams.get('organization_id') || '';
  const projectId = searchParams.get('project_id') || '';
  const quickActionGroups = useMemo(() => buildQuickActionGroups(locale), [locale]);
  const statusCards = useMemo(() => buildStatusCards(locale), [locale]);
  const [surface, setSurface] = useState<any>(null);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [focusedOperatorView, setFocusedOperatorView] = useState<string | null>(null);
  const [missionIntelligenceFocus, setMissionIntelligenceFocus] = useState<string | null>(null);
  const [missionIntelligenceFocusedMissionId, setMissionIntelligenceFocusedMissionId] = useState<
    string | null
  >(null);
  const [focusedOperatorMissionId, setFocusedOperatorMissionId] = useState<string | null>(null);
  const [tenantCssVars, setTenantCssVars] = useState<Record<string, string>>({});
  const [tenantLabel, setTenantLabel] = useState<string | null>(null);
  const [themeModePreference, setThemeModePreference] = useState<ChronosThemeMode>('system');
  // The stored choice is read after mount (SSR renders 'system'); until then
  // the head bootstrap script's data-theme must not be cleared or overwritten.
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);
  const [planRequestText, setPlanRequestText] = useState('');
  const [planMissionType, setPlanMissionType] = useState('proposal-brief');
  const [planPersona, setPlanPersona] = useState('operator');
  const [planTier, setPlanTier] = useState<'personal' | 'confidential' | 'public'>('confidential');
  const [planPreview, setPlanPreview] = useState<ClientPlanPreview | null>(null);
  const [planPreviewError, setPlanPreviewError] = useState<string | null>(null);
  const [planPreviewBusy, setPlanPreviewBusy] = useState(false);
  const [planPreviewSignature, setPlanPreviewSignature] = useState<string | null>(null);
  const [deliverables, setDeliverables] = useState<ClientDeliverable[]>([]);
  const [deliverablesError, setDeliverablesError] = useState<string | null>(null);
  const [deliverablesQuery, setDeliverablesQuery] = useState('');
  const [deliverablesRefreshTick, setDeliverablesRefreshTick] = useState(0);
  const [operatorHomeSummary, setOperatorHomeSummary] = useState<ClientOperatorHomeSummary | null>(
    null
  );
  const [operatorHomeError, setOperatorHomeError] = useState<string | null>(null);
  const [operatorHomeRefreshTick, setOperatorHomeRefreshTick] = useState(0);
  const [missionHistory, setMissionHistory] = useState<ClientMissionHistoryEntry[]>([]);
  const [missionHistoryError, setMissionHistoryError] = useState<string | null>(null);
  const [missionHistoryQuery, setMissionHistoryQuery] = useState('');
  // Defaulting to 'completed' made this panel read "No missions match the
  // current filter" on a workspace with active missions and no finished ones —
  // an empty history next to a live mission count. Start unfiltered.
  const [missionHistoryStatus, setMissionHistoryStatus] = useState('');
  const [missionHistoryTier, setMissionHistoryTier] = useState('');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [costSummary, setCostSummary] = useState<CostSummary | null>(null);
  const [costSummaryError, setCostSummaryError] = useState<string | null>(null);
  const [planApprovalBusy, setPlanApprovalBusy] = useState(false);
  const [planApprovalMessage, setPlanApprovalMessage] = useState<string | null>(null);
  const [planApprovalSessionId, setPlanApprovalSessionId] = useState<string | null>(null);
  const [connections, setConnections] = useState<ClientConnectionReviewItem[]>([]);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [connectionsQuery, setConnectionsQuery] = useState('');
  const [connectionReviewBusyId, setConnectionReviewBusyId] = useState<string | null>(null);
  const [connectionReviewNote, setConnectionReviewNote] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  // The console used to open with four competing full-size navigation panels
  // (quick actions, scenarios, surface cards, operator views) all expanded.
  // Scenarios is now the one primary entry; everything else starts closed so
  // the first screen answers "what needs me" instead of "which menu is this".
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    taxonomy: false,
    cycle: false,
    views: false,
    checks: false,
    designSystem: false,
  });
  const [showCleanedDeliverables, setShowCleanedDeliverables] = useState(false);
  const sendQueryRef = useRef<((q: string) => void) | null>(null);
  const mainSurfaceRef = useRef<HTMLElement | null>(null);
  const currentPlanPreviewSignature = buildPlanPreviewSignature({
    requestText: planRequestText,
    missionType: planMissionType,
    orgRole: planPersona,
    tier: planTier,
  });
  const planPreviewIsStale = isPlanPreviewStale(planPreviewSignature, currentPlanPreviewSignature);

  useEffect(() => {
    const prefs = loadOperatorLayoutPrefs();
    if (!prefs) return;
    setFocusedOperatorView(prefs.focusedOperatorView);
    setMissionIntelligenceFocus(prefs.missionIntelligenceFocus);
  }, []);

  useEffect(() => {
    saveOperatorLayoutPrefs(focusedOperatorView, missionIntelligenceFocus);
  }, [focusedOperatorView, missionIntelligenceFocus]);

  // Inside Concierge the shell owns the theme (設定 › 表示 → `data-theme` on
  // <html>). The console follows it instead of pinning its own, so opening
  // /ops never changes the theme of the rest of Concierge.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    const read = () => {
      const pinned = root.getAttribute('data-theme');
      setThemeModePreference(pinned === 'light' || pinned === 'dark' ? pinned : 'system');
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setSystemPrefersDark(media.matches);
    update();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', update);
      return () => media.removeEventListener('change', update);
    }
    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  const themeMode = resolveChronosThemeMode(themeModePreference, systemPrefersDark);
  const webDesignSystem = useMemo(() => createChronosWebDesignSystem(themeMode), [themeMode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.lang = localeToBcp47(locale);
  }, [locale]);

  useEffect(() => {
    // MSN-SHELL-IA: only the legacy grid still shows this; /ops sections don't.
    if (!OPS_LEGACY_WORKSPACE) return undefined;
    let cancelled = false;
    void fetch(
      opsApiPath(
        `/deliverables?limit=24${deliverablesQuery ? `&query=${encodeURIComponent(deliverablesQuery)}` : ''}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}${organizationId ? `&organization_id=${encodeURIComponent(organizationId)}` : ''}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`
      ),
      {
        headers: { 'Cache-Control': 'no-cache' },
      }
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`deliverables ${response.status}`);
        }
        const parsed = parseDeliverablesResponse(await response.json().catch(() => null));
        if (!parsed) throw new Error('Invalid deliverables response');
        return parsed;
      })
      .then((payload) => {
        if (cancelled) return;
        setDeliverables(payload.deliverables);
        setDeliverablesError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setDeliverables([]);
        setDeliverablesError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [deliverablesQuery, deliverablesRefreshTick, tenant, organizationId, projectId]);

  useEffect(() => {
    // MSN-SHELL-IA: only the legacy grid still shows this; /ops sections don't.
    if (!OPS_LEGACY_WORKSPACE) return undefined;
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('limit', '24');
    if (missionHistoryQuery) params.set('query', missionHistoryQuery);
    if (missionHistoryStatus) params.set('status', missionHistoryStatus);
    if (missionHistoryTier) params.set('tier', missionHistoryTier);
    if (tenant) params.set('tenant', tenant);
    if (organizationId) params.set('organization_id', organizationId);
    if (projectId) params.set('project_id', projectId);
    void fetch(opsApiPath(`/missions/search?${params.toString()}`), {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`missions ${response.status}`);
        const parsed = parseMissionHistoryResponse(await response.json().catch(() => null));
        if (!parsed) throw new Error('Invalid mission history response');
        return parsed;
      })
      .then((payload) => {
        if (cancelled) return;
        setMissionHistory(payload.missions);
        setMissionHistoryError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setMissionHistory([]);
        setMissionHistoryError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    missionHistoryQuery,
    missionHistoryStatus,
    missionHistoryTier,
    tenant,
    organizationId,
    projectId,
  ]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (selectedMissionId) params.set('missionId', selectedMissionId);
    if (tenant) params.set('tenant', tenant);
    params.set('since', new Date().toISOString().slice(0, 10));
    void fetch(opsApiPath(`/cost?${params.toString()}`), {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`cost ${response.status}`);
        const parsed = parseCostSummaryResponse(await response.json().catch(() => null));
        if (!parsed) throw new Error('Invalid cost summary response');
        return parsed;
      })
      .then((payload) => {
        if (cancelled) return;
        setCostSummary(payload.summary);
        setCostSummaryError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setCostSummary(null);
        setCostSummaryError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMissionId, tenant]);

  useEffect(() => {
    let cancelled = false;
    void fetch(opsApiPath(`/connections${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`), {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`connections ${response.status}`);
        const parsed = parseConnectionsResponse(await response.json().catch(() => null));
        if (!parsed) throw new Error('Invalid connections response');
        return parsed;
      })
      .then((payload) => {
        if (cancelled) return;
        setConnections(payload.connections);
        setConnectionsError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setConnections([]);
        setConnectionsError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [tenant]);

  useEffect(() => {
    // MSN-SHELL-IA: only the legacy grid still shows this; /ops sections don't.
    if (!OPS_LEGACY_WORKSPACE) return undefined;
    let cancelled = false;
    void fetch(
      opsApiPath(
        `/operator-home?limit=8${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}${organizationId ? `&organization_id=${encodeURIComponent(organizationId)}` : ''}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`
      ),
      {
        headers: { 'Cache-Control': 'no-cache' },
      }
    )
      .then(async (response) => {
        if (!response.ok) throw new Error(`operator-home ${response.status}`);
        const parsed = parseOperatorHomeResponse(await response.json().catch(() => null));
        if (!parsed) throw new Error('Invalid operator home response');
        return parsed;
      })
      .then((payload) => {
        if (cancelled) return;
        setOperatorHomeSummary(payload.summary);
        setOperatorHomeError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setOperatorHomeSummary(null);
        setOperatorHomeError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [operatorHomeRefreshTick, tenant, organizationId, projectId]);

  useEffect(() => {
    if (!focusedOperatorView) return;
    window.requestAnimationFrame(() => {
      mainSurfaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [focusedOperatorView]);

  const toggleSection = (key: string) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleReady = useCallback((fn: (q: string) => void) => {
    sendQueryRef.current = fn;
  }, []);

  const handleA2UIMessage = useCallback((message: any) => {
    if (message.createSurface) {
      setConsoleSection('surface');
      setSurface({
        surfaceId: message.createSurface.surfaceId,
        title: message.createSurface.title,
        titleKey: message.createSurface.titleKey,
        components: [],
      });
    }
    if (message.updateComponents) {
      setConsoleSection('surface');
      setSurface((prev: any) => ({
        surfaceId: message.updateComponents.surfaceId,
        title: prev?.title || message.updateComponents.surfaceId,
        titleKey: prev?.titleKey,
        components: message.updateComponents.components,
      }));
    }
    if (message.deleteSurface) {
      setSurface(null);
    }
    if (message.type && message.type.startsWith('display:')) {
      const id = message.id || `auto-${Date.now()}`;
      setConsoleSection('surface');
      setSurface({
        surfaceId: 'auto-surface',
        title: 'Dashboard',
        components: [{ id, type: message.type, props: message.props || message }],
      });
    }
  }, []);

  const handleQuickAction = useCallback((query: string) => {
    const operatorViewMatch = query.match(/^chronos:\/\/operator-view\/(.+)$/);
    if (operatorViewMatch) {
      setConsoleSection('surface');
      setFocusedOperatorView(operatorViewMatch[1]);
      setSurface(null);
      return;
    }
    sendQueryRef.current?.(query);
  }, []);

  const handleSectionJump = useCallback((targetId: string) => {
    const element = document.getElementById(targetId);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const [a2uiActionNotice, setA2uiActionNotice] = useState<string | null>(null);
  const sectionFromUrl = searchParams.get('section');
  // MSN-SHELL-IA §1: `?section=` addresses one of the four operations
  // sections; sections that moved to a top-level destination are redirected
  // by proxy.ts and never render here.
  const initialSection: ConsoleSectionId =
    resolveConsoleSectionParam(sectionFromUrl) ?? OPS_DEFAULT_SECTION;
  const [consoleSection, setConsoleSection] = useState<ConsoleSectionId>(initialSection);
  const [surfaceOrigin, setSurfaceOrigin] = useState<ConsoleContentSection>(OPS_DEFAULT_SECTION);

  useEffect(() => {
    const resolved = resolveConsoleSectionParam(sectionFromUrl);
    if (resolved) setConsoleSection(resolved);
  }, [sectionFromUrl]);

  const openConsoleSection = useCallback(
    (requested: ConsoleSectionId) => {
      // A section that moved out of the console opens its new destination.
      const moved = resolveIaRedirect(
        pathname,
        `?${new URLSearchParams({ ...Object.fromEntries(searchParams.entries()), section: requested })}`
      );
      if (moved) {
        router.push(moved);
        return;
      }
      const section = resolveConsoleSectionParam(requested) ?? OPS_DEFAULT_SECTION;
      if (section === 'surface') {
        setSurfaceOrigin(OPS_DEFAULT_SECTION);
      }
      setConsoleSection(section);
      setSurface(null);
      setFocusedOperatorView(null);
      setFocusedOperatorMissionId(null);
      setMissionIntelligenceFocus(null);
      setMissionIntelligenceFocusedMissionId(null);
      // Keep the address bar a deep link to the open section (tenant /
      // organization / project params are preserved).
      if (section !== 'surface') {
        const params = new URLSearchParams(searchParams.toString());
        if (section === OPS_DEFAULT_SECTION) params.delete('section');
        else params.set('section', section);
        const query = params.toString();
        router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
      }
    },
    [pathname, router, searchParams]
  );

  // SU-02: operator clicks on actionable A2UI components move things forward.
  const handleA2UIComponentAction = useCallback(
    async (action: any) => {
      try {
        if (action.componentType === 'kb-intervention-panel' && action.action === 'select-option') {
          const props = action.props || {};
          const option = action.option || {};
          const optionValue = String(option.value ?? option.label ?? '').trim();
          const approvalId = String(props.approval_id || props.approvalId || '').trim();
          const missionId = String(props.mission_id || props.missionId || '').trim();
          if (approvalId && (optionValue === 'approved' || optionValue === 'rejected')) {
            const response = await fetch(opsApiPath('/intelligence'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'approval_decision',
                requestId: approvalId,
                channel: props.channel || 'chronos',
                storageChannel:
                  props.storage_channel || props.storageChannel || props.channel || 'chronos',
                decision: optionValue,
              }),
            });
            if (!response.ok) throw new Error('approval decision failed');
            setA2uiActionNotice(
              uxMessage(
                optionValue === 'approved'
                  ? 'chronos_a2ui_approval_approved'
                  : 'chronos_a2ui_approval_rejected',
                { id: approvalId },
                `Approval request ${approvalId} was ${optionValue === 'approved' ? 'approved' : 'sent back'}.`,
                locale
              )
            );
            return;
          }
          if (missionId) {
            const response = await fetch(opsApiPath('/intelligence'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'intervention_respond',
                missionId,
                question: props.reason || '',
                response: optionValue || option.label,
              }),
            });
            if (!response.ok) throw new Error('intervention response failed');
            setA2uiActionNotice(
              uxMessage(
                'chronos_a2ui_intervention_sent',
                { missionId, label: option.label },
                `Sent the intervention response "${option.label}" to mission ${missionId}.`,
                locale
              )
            );
            return;
          }
          setA2uiActionNotice(uxText('chronos_a2ui_intervention_no_target', locale));
          return;
        }
        if (action.componentType === 'kb-artifact-tile') {
          const path = String(action.props?.path || '').trim();
          if (path) {
            window.open(opsApiPath(`/mission-asset?path=${encodeURIComponent(path)}`), '_blank');
            return;
          }
          setA2uiActionNotice(uxText('chronos_a2ui_artifact_no_path', locale));
        }
      } catch (error) {
        setA2uiActionNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [locale]
  );

  const openDeliverableAsset = useCallback(
    (item: {
      artifactId?: string;
      missionId?: string;
      tenantSlug?: string;
      path?: string;
      externalRef?: string;
      previewText?: string;
    }) => {
      if (item.externalRef && /^https?:/.test(item.externalRef)) {
        window.open(item.externalRef, '_blank', 'noreferrer');
        return;
      }
      if (!item.path) {
        if (item.artifactId && item.previewText) {
          const params = new URLSearchParams({ artifactId: item.artifactId });
          if (item.tenantSlug || tenant) params.set('tenant', item.tenantSlug || tenant);
          window.open(
            opsApiPath(`/deliverable-preview?${params.toString()}`),
            '_blank',
            'noreferrer'
          );
        }
        return;
      }
      // repo-relative artifact mode covers exports/tmp/missions uniformly;
      // mission mode remains for mission-relative records.
      const params = new URLSearchParams({ path: item.path });
      if (item.artifactId) params.set('artifactId', item.artifactId);
      if (item.tenantSlug || tenant) params.set('tenant', item.tenantSlug || tenant);
      const url = item.path.startsWith('active/')
        ? opsApiPath(`/mission-asset?${params.toString()}`)
        : item.missionId
          ? opsApiPath(
              `/mission-asset?missionId=${encodeURIComponent(item.missionId)}&${params.toString()}`
            )
          : opsApiPath(`/mission-asset?${params.toString()}`);
      window.open(url, '_blank', 'noreferrer');
    },
    []
  );

  const runPlanPreview = useCallback(async () => {
    if (!planRequestText.trim()) {
      setPlanPreviewError(uxText('chronos_plan_request_required', locale));
      return;
    }
    setPlanPreviewBusy(true);
    setPlanPreviewError(null);
    try {
      const response = await fetch(opsApiPath('/plan-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestText: planRequestText,
          missionType: planMissionType,
          orgRole: planPersona,
          tier: planTier,
          locale: locale,
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error('plan preview failed');
      const parsed = parsePlanPreviewResponse(payload);
      if (!parsed) throw new Error('Invalid plan preview response');
      setPlanPreview(parsed.preview);
      setPlanPreviewSignature(currentPlanPreviewSignature);
      setPlanApprovalSessionId(parsed.preview.missionId);
      setPlanApprovalMessage(null);
    } catch (error) {
      setPlanPreview(null);
      setPlanApprovalSessionId(null);
      setPlanPreviewSignature(null);
      setPlanPreviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setPlanPreviewBusy(false);
    }
  }, [
    currentPlanPreviewSignature,
    locale,
    planMissionType,
    planPersona,
    planRequestText,
    planTier,
  ]);

  const approvePlanAndStart = useCallback(async () => {
    if (!planPreview) {
      setPlanApprovalMessage(uxText('chronos_plan_preview_required', locale));
      return;
    }
    if (planPreviewIsStale) {
      setPlanApprovalMessage(uxText('chronos_plan_preview_stale', locale));
      return;
    }
    const sessionId = planApprovalSessionId || planPreview.missionId;
    setPlanApprovalBusy(true);
    setPlanApprovalMessage(null);
    try {
      const proposalResponse = await fetch(opsApiPath('/agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: planRequestText,
          sessionId,
          locale,
          requesterId: 'chronos-ui',
        }),
      });
      const proposalPayload = await proposalResponse.json().catch(() => null);
      if (!proposalResponse.ok) throw new Error('mission proposal failed');
      const proposal = parseMissionProposalResponse(proposalPayload);
      if (!proposal) throw new Error('Invalid mission proposal response');

      const confirmResponse = await fetch(opsApiPath('/agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve_mission',
          sessionId,
          locale,
          requesterId: 'chronos-ui',
        }),
      });
      const confirmPayload = await confirmResponse.json().catch(() => null);
      if (!confirmResponse.ok) throw new Error('mission approval failed');
      const approval = parseMissionApprovalResponse(confirmPayload);

      if (!approval) throw new Error('Invalid mission approval response');
      setPlanApprovalMessage(`Started ${approval.mission.missionId}`);
      setOperatorHomeRefreshTick((value) => value + 1);
    } catch (error) {
      setPlanApprovalMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPlanApprovalBusy(false);
    }
  }, [locale, planApprovalSessionId, planPreview, planPreviewIsStale, planRequestText]);

  const refreshDeliverables = useCallback(() => {
    setDeliverablesRefreshTick((value) => value + 1);
  }, []);

  const submitConnectionReview = useCallback(
    async (bindingId: string, action: 'approve' | 'hold' | 'delete' | 'modify') => {
      setConnectionReviewBusyId(bindingId);
      try {
        const response = await fetch(opsApiPath('/connections'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bindingId,
            action,
            note: connectionReviewNote,
            tenant,
          }),
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) throw new Error('connection review failed');
        const parsed = parseConnectionReviewResponse(payload);
        if (!parsed) throw new Error('Invalid connection review response');
        setConnections((current) =>
          current.map((entry) =>
            entry.binding_id === bindingId
              ? {
                  ...entry,
                  reviewAction: parsed.review.action,
                  reviewNote: parsed.review.note,
                  reviewedAt: parsed.review.reviewed_at,
                }
              : entry
          )
        );
        setConnectionReviewNote('');
        setOperatorHomeRefreshTick((value) => value + 1);
      } catch (error) {
        setConnectionsError(error instanceof Error ? error.message : String(error));
      } finally {
        setConnectionReviewBusyId(null);
      }
    },
    [connectionReviewNote]
  );

  const handleOperatorViewOpen = useCallback(
    (targetId: string, missionId: string | null = null) => {
      if (targetId === 'mission-control-plane' && missionId) {
        // Missions live under 仕事 now: open the mission's own page.
        router.push(withSelectedTenant(entityHref('mission', missionId), tenant || null));
        return;
      }
      setSurfaceOrigin(consoleSection === 'surface' ? OPS_DEFAULT_SECTION : consoleSection);
      setConsoleSection('surface');
      setFocusedOperatorView(targetId);
      setMissionIntelligenceFocus(null);
      setMissionIntelligenceFocusedMissionId(null);
      setFocusedOperatorMissionId(targetId === 'mission-control-plane' ? missionId : null);
      setSurface(null);
    },
    [consoleSection, router, tenant]
  );

  const handleScenarioOpen = useCallback(
    (targetId: string, surfaceMode: 'mission-intelligence' | 'focused-operator') => {
      setSurfaceOrigin(consoleSection === 'surface' ? OPS_DEFAULT_SECTION : consoleSection);
      setConsoleSection('surface');
      if (surfaceMode === 'mission-intelligence') {
        setMissionIntelligenceFocus(targetId);
        setFocusedOperatorView(null);
        setMissionIntelligenceFocusedMissionId(null);
        setFocusedOperatorMissionId(null);
      } else {
        setFocusedOperatorView(targetId);
        setMissionIntelligenceFocus(null);
        setMissionIntelligenceFocusedMissionId(null);
        setFocusedOperatorMissionId(null);
      }
      setSurface(null);
    },
    [consoleSection]
  );

  const activeSurfaceTitle = useMemo(
    () =>
      surface?.titleKey
        ? uxText(surface.titleKey, locale)
        : surface?.title || uxText('chronos_nav_active_surface', locale),
    [surface?.title, surface?.titleKey, locale]
  );
  const activeScenario = useMemo(
    () =>
      OPERATOR_SCENARIO_PRESETS.find((scenario) =>
        scenario.surface === 'mission-intelligence'
          ? missionIntelligenceFocus === scenario.targetId
          : focusedOperatorView === scenario.targetId
      ) || null,
    [focusedOperatorView, missionIntelligenceFocus]
  );

  useEffect(() => {
    const handleScenarioHotkey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const index = Number.parseInt(event.key, 10);
      if (!Number.isInteger(index) || index < 1 || index > OPERATOR_SCENARIO_PRESETS.length) return;
      const scenario = OPERATOR_SCENARIO_PRESETS[index - 1];
      if (!scenario) return;
      event.preventDefault();
      handleScenarioOpen(scenario.targetId, scenario.surface);
    };

    window.addEventListener('keydown', handleScenarioHotkey);
    return () => window.removeEventListener('keydown', handleScenarioHotkey);
  }, [handleScenarioOpen]);

  /**
   * The one thing to press. `operatorHomeSummary.nextAction` already says WHAT
   * to do in prose; this maps the same control-plane state onto WHERE that
   * happens, so the headline action is a real destination and not advice.
   */
  /**
   * The inbox is dominated by records whose file was swept away by a tmp clean
   * or mission archival. They are honest history, not work — so they collapse
   * behind a counted toggle and the live deliverables get the panel.
   */
  const cleanedDeliverableCount = useMemo(
    () => deliverables.filter((item) => item.missing).length,
    [deliverables]
  );
  const visibleDeliverables = useMemo(
    () => (showCleanedDeliverables ? deliverables : deliverables.filter((item) => !item.missing)),
    [deliverables, showCleanedDeliverables]
  );

  /**
   * Human titles for mission ids (goal summaries from the control plane and
   * mission history); rows fall back to a humanized id with the id in mono.
   */
  const missionTitles = useMemo(() => {
    const titles: Record<string, string> = {};
    for (const mission of missionHistory) {
      const title = mission.goalSummary || mission.intentText;
      if (title) titles[mission.missionId] = title;
    }
    for (const mission of operatorHomeSummary?.activeMissions ?? []) {
      if (mission.goalSummary) titles[mission.missionId] = mission.goalSummary;
    }
    return titles;
  }, [missionHistory, operatorHomeSummary]);

  /**
   * The counters double as navigation: each one is the shortest path to the
   * work it counts. `null` targets stay readable but non-interactive.
   */
  const homeCounters = useMemo(() => {
    if (!operatorHomeSummary) return [];
    const counts = operatorHomeSummary.counts;
    return [
      {
        key: 'approvals',
        value: counts.pendingApprovals ?? 0,
        label: uxText('chronos_cb_count_approvals', locale),
        targetId: 'approvals',
        tone: 'info' as const,
      },
      {
        key: 'inbox',
        value: counts.unreadInbox ?? 0,
        label: uxText('chronos_cb_count_inbox', locale),
        targetId: 'recent-surface-outbox',
        tone: 'info' as const,
      },
      {
        key: 'active',
        value: counts.activeMissions ?? 0,
        label: uxText('chronos_cb_count_active', locale),
        targetId: 'mission-control-plane',
        tone: 'neutral' as const,
      },
      {
        key: 'planned',
        value: operatorHomeSummary.plannedMissions?.length ?? 0,
        label: uxText('chronos_cb_count_planned', locale),
        targetId: 'mission-control-plane',
        tone: 'alert' as const,
      },
      {
        key: 'blocked',
        value: counts.blockedMissions ?? 0,
        label: uxText('chronos_cb_count_blocked', locale),
        targetId: 'needs-attention',
        tone: 'alert' as const,
      },
    ];
  }, [operatorHomeSummary, locale]);

  const webTheme = webDesignSystem.theme.theme;
  const webLayout = webDesignSystem.layout;
  // Keep the former sidebar + embedded pane available for an explicit rollback
  // while the simplified screen model is the only default operator path.
  const legacyWorkspaceEnabled = OPS_LEGACY_WORKSPACE;
  const isLightTheme = themeMode === 'light';
  const shellTextClass = isLightTheme ? 'text-[var(--kb-text-primary)]' : 'kb-text-primary';
  const shellMutedClass = isLightTheme ? 'text-[var(--kb-text-secondary)]' : 'kb-text-muted';
  const shellSubtleClass = isLightTheme ? 'text-[var(--kb-text-secondary)]' : 'kb-text-secondary';
  const shellTitleClass = isLightTheme ? 'text-[var(--kb-text-primary)]' : 'kb-text-primary';
  // Tone-colored chips were authored for the dark console only: a 100-level
  // text on a 400/10 wash measures ~1.7:1 once the panel underneath is light.
  // Light mode needs the ink darkened, not just the panel lightened.
  const toneChipClass = (tone: 'approve' | 'reject' | 'info' | 'alert' | 'neutral'): string => {
    if (isLightTheme) {
      return {
        approve:
          'kb-status-positive-border kb-status-positive-surface kb-status-positive hover:kb-status-positive-surface',
        reject:
          'kb-status-negative-border kb-status-negative-surface kb-status-negative hover:kb-status-negative-surface',
        info: 'kb-status-info-border kb-status-info-surface kb-status-info hover:kb-status-info-surface',
        alert:
          'kb-status-warning-border kb-status-warning-surface kb-status-warning hover:kb-status-warning-surface',
        neutral:
          'border-[color:var(--kb-border)] kb-surface-well text-[var(--kb-text-primary)] hover:kb-surface-well',
      }[tone];
    }
    return {
      approve:
        'kb-status-positive-border kb-status-positive-surface kb-status-positive hover:kb-status-positive-surface',
      reject:
        'kb-status-negative-border kb-status-negative-surface kb-status-negative hover:kb-status-negative-surface',
      info: 'kb-border-accent kb-surface-accent kb-text-accent hover:kb-surface-accent',
      alert:
        'kb-status-warning-border kb-status-warning-surface kb-status-warning hover:kb-status-warning-surface',
      neutral: 'kb-border-subtle kb-surface-sunken kb-text-secondary hover:kb-surface-raised',
    }[tone];
  };

  const viewModel = {
    locale,
    searchParams,
    tenant,
    organizationId,
    projectId,
    quickActionGroups,
    statusCards,
    surface,
    setSurface,
    agentPanelOpen,
    setAgentPanelOpen,
    focusedOperatorView,
    setFocusedOperatorView,
    missionIntelligenceFocus,
    setMissionIntelligenceFocus,
    missionIntelligenceFocusedMissionId,
    setMissionIntelligenceFocusedMissionId,
    focusedOperatorMissionId,
    setFocusedOperatorMissionId,
    tenantCssVars,
    setTenantCssVars,
    tenantLabel,
    setTenantLabel,
    themeModePreference,
    setThemeModePreference,
    systemPrefersDark,
    setSystemPrefersDark,
    planRequestText,
    setPlanRequestText,
    planMissionType,
    setPlanMissionType,
    planPersona,
    setPlanPersona,
    planTier,
    setPlanTier,
    planPreview,
    setPlanPreview,
    planPreviewError,
    setPlanPreviewError,
    planPreviewBusy,
    setPlanPreviewBusy,
    planPreviewSignature,
    setPlanPreviewSignature,
    deliverables,
    setDeliverables,
    deliverablesError,
    setDeliverablesError,
    deliverablesQuery,
    setDeliverablesQuery,
    deliverablesRefreshTick,
    setDeliverablesRefreshTick,
    operatorHomeSummary,
    setOperatorHomeSummary,
    operatorHomeError,
    setOperatorHomeError,
    operatorHomeRefreshTick,
    setOperatorHomeRefreshTick,
    missionHistory,
    setMissionHistory,
    missionHistoryError,
    setMissionHistoryError,
    missionHistoryQuery,
    setMissionHistoryQuery,
    missionHistoryStatus,
    setMissionHistoryStatus,
    missionHistoryTier,
    setMissionHistoryTier,
    selectedMissionId,
    setSelectedMissionId,
    costSummary,
    setCostSummary,
    costSummaryError,
    setCostSummaryError,
    planApprovalBusy,
    setPlanApprovalBusy,
    planApprovalMessage,
    setPlanApprovalMessage,
    planApprovalSessionId,
    setPlanApprovalSessionId,
    connections,
    setConnections,
    connectionsError,
    setConnectionsError,
    connectionsQuery,
    setConnectionsQuery,
    connectionReviewBusyId,
    setConnectionReviewBusyId,
    connectionReviewNote,
    setConnectionReviewNote,
    selectedConnectionId,
    setSelectedConnectionId,
    expandedSections,
    setExpandedSections,
    showCleanedDeliverables,
    setShowCleanedDeliverables,
    sendQueryRef,
    mainSurfaceRef,
    currentPlanPreviewSignature,
    planPreviewIsStale,
    themeMode,
    webDesignSystem,
    toggleSection,
    handleReady,
    handleA2UIMessage,
    handleQuickAction,
    handleSectionJump,
    a2uiActionNotice,
    setA2uiActionNotice,
    sectionFromUrl,
    initialSection,
    consoleSection,
    setConsoleSection,
    surfaceOrigin,
    setSurfaceOrigin,
    openConsoleSection,
    handleA2UIComponentAction,
    openDeliverableAsset,
    runPlanPreview,
    approvePlanAndStart,
    refreshDeliverables,
    submitConnectionReview,
    handleOperatorViewOpen,
    handleScenarioOpen,
    activeSurfaceTitle,
    activeScenario,
    cleanedDeliverableCount,
    visibleDeliverables,
    missionTitles,
    homeCounters,
    webTheme,
    webLayout,
    legacyWorkspaceEnabled,
    isLightTheme,
    shellTextClass,
    shellMutedClass,
    shellSubtleClass,
    shellTitleClass,
    toneChipClass,
    Shield,
    Building2,
    Cpu,
    Radar,
    Bot,
    ActivitySquare,
    Wrench,
    PanelsTopLeft,
    ChevronDown,
    ChevronRight,
    ClipboardCheck,
    CalendarClock,
    LayoutGrid,
    Palette,
    Type,
    Ruler,
    AgentOpsBoards,
    A2UIRenderer,
    KbArtifactTile,
    KbInterventionPanel,
    FocusedOperatorView,
    AgentPanel,
    IdentityBadge,
    MissionIntelligence,
    ChronosOffice,
    SurfaceControlWorkspace,
    HeadlessA2UIWorkspace,
    DiagnosticsAttentionSummary,
    MISSION_CYCLE,
    OPERATOR_SCENARIO_PRESETS,
    OPERATOR_VIEW_LINKS,
    SURFACE_ROLES,
    chronosSpeechLocale,
    nextChronosLocale,
    setChronosLocalePreference,
    uxMessage,
    uxText,
    nextChronosThemeMode,
    TenantDesignBridge,
    CONSOLE_SECTIONS,
    buildPlanPreviewSignature,
    isPlanPreviewStale,
    loadOperatorLayoutPrefs,
    saveOperatorLayoutPrefs,
    buildQuickActionGroups,
    buildStatusCards,
  };
  return <ChronosMirrorShell model={viewModel} />;
}

function TenantDesignBridge({
  onResolve,
}: {
  onResolve: (cssVars: Record<string, string>, label: string | null) => void;
}) {
  const searchParams = useSearchParams();
  // The parent passes a fresh inline onResolve on every render; keeping it in
  // the effect deps made resolve → setState → re-render → new onResolve →
  // resolve an infinite loop. Track the latest callback in a ref and re-run
  // only when the actual inputs (query params) change.
  const onResolveRef = useRef(onResolve);
  onResolveRef.current = onResolve;

  useEffect(() => {
    const customerId = searchParams.get('customerId') || searchParams.get('customer') || '';
    const brandName = searchParams.get('brandName') || '';
    const designSystemId = searchParams.get('designSystemId') || '';
    if (!customerId && !brandName && !designSystemId) {
      onResolveRef.current({}, null);
      return;
    }
    const params = new URLSearchParams();
    if (customerId) params.set('customerId', customerId);
    if (brandName) params.set('brandName', brandName);
    if (designSystemId) params.set('designSystemId', designSystemId);
    const controller = new AbortController();
    void fetch(opsApiPath(`/tenant-design?${params.toString()}`), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return parseTenantDesignResponse(await response.json().catch(() => null));
      })
      .then((payload) => {
        if (!payload) return;
        onResolveRef.current(payload.css_vars, payload.brand_name || payload.source || null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [searchParams]);

  return null;
}
