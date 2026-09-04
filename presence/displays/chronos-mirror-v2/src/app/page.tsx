'use client';

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
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useSearchParams } from 'next/navigation';
import { createChronosWebDesignSystem } from '@agent/core/web-design-system';
import { AgentOpsBoards } from '../components/AgentOpsBoards';
import {
  A2UIRenderer,
  KbArtifactTile,
  KbInterventionPanel,
} from '../components/A2UIComponentLibrary';
import { FocusedOperatorView } from '../components/FocusedOperatorView';
import { SovereignChat } from '../components/SovereignChat';
import { AgentPanel } from '../components/AgentPanel';
import { FirstRunBanner } from '../components/FirstRunBanner';
import { IdentityBadge } from '../components/IdentityBadge';
import { MissionIntelligence } from '../components/MissionIntelligence';
import { MissionJourneySummary } from '../components/MissionJourneySummary';
import { ChronosOffice } from '../components/ChronosOffice';
import { WorkItemsWorkspace } from '../components/WorkItemsWorkspace';
import { SurfaceControlWorkspace } from '../components/SurfaceControlWorkspace';
import { OrganizationOperatingModel } from '../components/OrganizationOperatingModel';
import { CloudflareOsPanel } from '../components/CloudflareOsPanel';
import { HeadlessA2UIWorkspace } from '../components/HeadlessA2UIWorkspace';
import { ApprovalsWorkspace } from '../components/ApprovalsWorkspace';
import { DeliverablesWorkspace } from '../components/DeliverablesWorkspace';
import { KnowledgeWorkspace } from '../components/KnowledgeWorkspace';
import { DiagnosticsAttentionSummary } from '../components/DiagnosticsAttentionSummary';
import { ChronosTenantScope, useChronosTenant } from '../components/ChronosTenantScope';
import {
  MISSION_CYCLE,
  OPERATOR_SCENARIO_PRESETS,
  OPERATOR_VIEW_LINKS,
  SURFACE_ROLES,
} from '../lib/operator-console';
import {
  chronosSpeechLocale,
  nextChronosLocale,
  setChronosLocalePreference,
  uxMessage,
  uxText,
  type SupportedLocale,
} from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import {
  CONSOLE_SECTIONS,
  buildPlanPreviewSignature,
  buildQuickActionGroups,
  buildStatusCards,
  isPlanPreviewStale,
  loadChronosThemeMode,
  loadOperatorLayoutPrefs,
  saveChronosThemeMode,
  saveOperatorLayoutPrefs,
  type ConsoleContentSection,
  type ConsoleSectionId,
} from './chronos-page-config';
import { ChronosMirrorShell } from './ChronosMirrorShell';
import {
  nextChronosThemeMode,
  resolveChronosThemeMode,
  type ChronosThemeMode,
} from '../lib/chronos-theme';
import { parseTenantDesignResponse } from '../lib/tenant-design-response';
import { parseDeliverablesResponse, type ClientDeliverable } from '../lib/deliverables-response';
import {
  parseMissionHistoryResponse,
  type ClientMissionHistoryEntry,
} from '../lib/mission-history-response';
import { parseCostSummaryResponse } from '../lib/cost-summary-response';
import type { CostSummary } from '../lib/su-surface-data';
import {
  parseConnectionsResponse,
  type ClientConnectionReviewItem,
} from '../lib/connections-response';
import {
  parseOperatorHomeResponse,
  type ClientOperatorHomeSummary,
} from '../lib/operator-home-response';
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
  const [systemPrefersDark, setSystemPrefersDark] = useState(true);
  const [planRequestText, setPlanRequestText] = useState('');
  const [planMissionType, setPlanMissionType] = useState('proposal-brief');
  const [planPersona, setPlanPersona] = useState('operator');
  const [planTier, setPlanTier] = useState<'personal' | 'confidential' | 'public'>('confidential');
  const [planPreview, setPlanPreview] = useState<any | null>(null);
  const [planPreviewError, setPlanPreviewError] = useState<string | null>(null);
  const [planPreviewBusy, setPlanPreviewBusy] = useState(false);
  const [planPreviewSignature, setPlanPreviewSignature] = useState<string | null>(null);
  const [deliverables, setDeliverables] = useState<ClientDeliverable[]>([]);
  const [deliverablesError, setDeliverablesError] = useState<string | null>(null);
  const [deliverablesQuery, setDeliverablesQuery] = useState('');
  const [deliverablesRefreshTick, setDeliverablesRefreshTick] = useState(0);
  const [selectedDeliverableId, setSelectedDeliverableId] = useState<string | null>(null);
  const [deliverableReviewComment, setDeliverableReviewComment] = useState('');
  const [deliverableReviewBusy, setDeliverableReviewBusy] = useState(false);
  const [deliverableReviewError, setDeliverableReviewError] = useState<string | null>(null);
  // LC-10 ask-why: when a reject / request-changes lands without any reason,
  // ask exactly one skippable question so the redo/learning loops get a
  // deterministic category instead of nothing.
  const [deliverableAskWhyVerdict, setDeliverableAskWhyVerdict] = useState<
    'reject' | 'request-changes' | null
  >(null);
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
    assignedPersona: planPersona,
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

  useEffect(() => {
    const prefs = loadChronosThemeMode();
    if (prefs) setThemeModePreference(prefs);
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

  useEffect(() => {
    saveChronosThemeMode(themeModePreference);
  }, [themeModePreference]);

  const themeMode = resolveChronosThemeMode(themeModePreference, systemPrefersDark);
  const webDesignSystem = useMemo(() => createChronosWebDesignSystem(themeMode), [themeMode]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  useEffect(() => {
    let cancelled = false;
    void fetch(
      `/api/deliverables?limit=24${deliverablesQuery ? `&query=${encodeURIComponent(deliverablesQuery)}` : ''}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}${organizationId ? `&organization_id=${encodeURIComponent(organizationId)}` : ''}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`,
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
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('limit', '24');
    if (missionHistoryQuery) params.set('query', missionHistoryQuery);
    if (missionHistoryStatus) params.set('status', missionHistoryStatus);
    if (missionHistoryTier) params.set('tier', missionHistoryTier);
    if (tenant) params.set('tenant', tenant);
    void fetch(`/api/missions/search?${params.toString()}`, {
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
  }, [missionHistoryQuery, missionHistoryStatus, missionHistoryTier, tenant]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (selectedMissionId) params.set('missionId', selectedMissionId);
    if (tenant) params.set('tenant', tenant);
    params.set('since', new Date().toISOString().slice(0, 10));
    void fetch(`/api/cost?${params.toString()}`, {
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
    void fetch(`/api/connections${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`, {
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
    let cancelled = false;
    void fetch(
      `/api/operator-home?limit=8${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}${organizationId ? `&organization_id=${encodeURIComponent(organizationId)}` : ''}${projectId ? `&project_id=${encodeURIComponent(projectId)}` : ''}`,
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
  const initialSection: ConsoleSectionId =
    sectionFromUrl &&
    [
      'home',
      'organization',
      'missions',
      'work-items',
      'surface-control',
      'deliverables',
      'approvals',
      'knowledge',
      'operations',
      'governance',
      'diagnostics',
      'surface',
    ].includes(sectionFromUrl)
      ? (sectionFromUrl as ConsoleSectionId)
      : 'home';
  const [consoleSection, setConsoleSection] = useState<ConsoleSectionId>(initialSection);
  const [surfaceOrigin, setSurfaceOrigin] = useState<ConsoleContentSection>('home');

  useEffect(() => {
    if (!sectionFromUrl) return;
    if (
      [
        'home',
        'organization',
        'missions',
        'work-items',
        'surface-control',
        'deliverables',
        'approvals',
        'knowledge',
        'operations',
        'governance',
        'diagnostics',
        'surface',
      ].includes(sectionFromUrl)
    ) {
      setConsoleSection(sectionFromUrl as ConsoleSectionId);
    }
  }, [sectionFromUrl]);

  const openConsoleSection = useCallback((section: ConsoleSectionId) => {
    if (section === 'surface') {
      setSurfaceOrigin('home');
    }
    setConsoleSection(section);
    setSurface(null);
    setFocusedOperatorView(null);
    setFocusedOperatorMissionId(null);
    setMissionIntelligenceFocus(null);
    setMissionIntelligenceFocusedMissionId(null);
  }, []);

  // SU-02: operator clicks on actionable A2UI components move things forward.
  const handleA2UIComponentAction = useCallback(async (action: any) => {
    try {
      if (action.componentType === 'kb-intervention-panel' && action.action === 'select-option') {
        const props = action.props || {};
        const option = action.option || {};
        const optionValue = String(option.value ?? option.label ?? '').trim();
        const approvalId = String(props.approval_id || props.approvalId || '').trim();
        const missionId = String(props.mission_id || props.missionId || '').trim();
        if (approvalId && (optionValue === 'approved' || optionValue === 'rejected')) {
          const response = await fetch('/api/intelligence', {
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
            `承認リクエスト ${approvalId} を ${optionValue === 'approved' ? '承認' : '差し戻し'}しました。`
          );
          return;
        }
        if (missionId) {
          const response = await fetch('/api/intelligence', {
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
            `ミッション ${missionId} へ介入回答「${option.label}」を送信しました。`
          );
          return;
        }
        setA2uiActionNotice(
          'この介入パネルには対象（mission_id / approval_id）が指定されていません。'
        );
        return;
      }
      if (action.componentType === 'kb-artifact-tile') {
        const path = String(action.props?.path || '').trim();
        if (path) {
          window.open(`/api/mission-asset?path=${encodeURIComponent(path)}`, '_blank');
          return;
        }
        setA2uiActionNotice('この成果物タイルにはパスがありません。');
      }
    } catch (error) {
      setA2uiActionNotice(error instanceof Error ? error.message : String(error));
    }
  }, []);

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
          window.open(`/api/deliverable-preview?${params.toString()}`, '_blank', 'noreferrer');
        }
        return;
      }
      // repo-relative artifact mode covers exports/tmp/missions uniformly;
      // mission mode remains for mission-relative records.
      const params = new URLSearchParams({ path: item.path });
      if (item.artifactId) params.set('artifactId', item.artifactId);
      if (item.tenantSlug || tenant) params.set('tenant', item.tenantSlug || tenant);
      const url = item.path.startsWith('active/')
        ? `/api/mission-asset?${params.toString()}`
        : item.missionId
          ? `/api/mission-asset?missionId=${encodeURIComponent(item.missionId)}&${params.toString()}`
          : `/api/mission-asset?${params.toString()}`;
      window.open(url, '_blank', 'noreferrer');
    },
    []
  );

  const runPlanPreview = useCallback(async () => {
    if (!planRequestText.trim()) {
      setPlanPreviewError('依頼文を入力してください');
      return;
    }
    setPlanPreviewBusy(true);
    setPlanPreviewError(null);
    try {
      const response = await fetch('/api/plan-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestText: planRequestText,
          missionType: planMissionType,
          assignedPersona: planPersona,
          tier: planTier,
          locale: locale,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'plan preview failed');
      setPlanPreview(payload.preview);
      setPlanPreviewSignature(currentPlanPreviewSignature);
      setPlanApprovalSessionId(payload.preview?.missionId || null);
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
      setPlanApprovalMessage('先に plan preview を作成してください');
      return;
    }
    if (planPreviewIsStale) {
      setPlanApprovalMessage('入力を変更したので plan preview を再実行してください');
      return;
    }
    const sessionId = planApprovalSessionId || planPreview.missionId;
    setPlanApprovalBusy(true);
    setPlanApprovalMessage(null);
    try {
      const proposalResponse = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: planRequestText,
          sessionId,
          locale,
          requesterId: 'chronos-ui',
        }),
      });
      const proposalPayload = await proposalResponse.json();
      if (!proposalResponse.ok) throw new Error(proposalPayload.error || 'mission proposal failed');

      const confirmResponse = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approve_mission',
          sessionId,
          locale,
          requesterId: 'chronos-ui',
        }),
      });
      const confirmPayload = await confirmResponse.json();
      if (!confirmResponse.ok) throw new Error(confirmPayload.error || 'mission approval failed');

      setPlanApprovalMessage(
        confirmPayload.mission?.missionId
          ? `Started ${confirmPayload.mission.missionId}`
          : 'Mission started'
      );
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

  const submitDeliverableReview = useCallback(
    async (
      verdict: 'accept' | 'reject' | 'request-changes',
      options?: { reasonCategory?: string; skipAskWhy?: boolean }
    ) => {
      const item = deliverables.find((entry) => entry.artifactId === selectedDeliverableId);
      if (!item) {
        setDeliverableReviewError('成果物を選択してください');
        return;
      }
      // LC-10 ask-why: a rejection with no comment and no category teaches
      // nothing — ask one skippable question before submitting.
      if (
        verdict !== 'accept' &&
        !deliverableReviewComment.trim() &&
        !options?.reasonCategory &&
        !options?.skipAskWhy
      ) {
        setDeliverableAskWhyVerdict(verdict);
        return;
      }
      setDeliverableAskWhyVerdict(null);
      setDeliverableReviewBusy(true);
      setDeliverableReviewError(null);
      try {
        const response = await fetch('/api/deliverable-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            artifactId: item.artifactId,
            verdict,
            comment: deliverableReviewComment,
            reasonCategory: options?.reasonCategory,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'deliverable review failed');
        setDeliverableReviewComment('');
        refreshDeliverables();
        setOperatorHomeRefreshTick((value) => value + 1);
        if (payload.state?.current_artifact_id) {
          setSelectedDeliverableId(payload.state.current_artifact_id);
        }
      } catch (error) {
        setDeliverableReviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setDeliverableReviewBusy(false);
      }
    },
    [deliverableReviewComment, deliverables, refreshDeliverables, selectedDeliverableId]
  );

  const submitConnectionReview = useCallback(
    async (bindingId: string, action: 'approve' | 'hold' | 'delete' | 'modify') => {
      setConnectionReviewBusyId(bindingId);
      try {
        const response = await fetch('/api/connections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            bindingId,
            action,
            note: connectionReviewNote,
            tenant,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'connection review failed');
        setConnections((current) =>
          current.map((entry) =>
            entry.binding_id === bindingId
              ? {
                  ...entry,
                  reviewAction: payload.review?.action,
                  reviewNote: payload.review?.note,
                  reviewedAt: payload.review?.reviewed_at,
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
        setConsoleSection('missions');
        setFocusedOperatorView(null);
        setFocusedOperatorMissionId(null);
        setMissionIntelligenceFocus('mission-control-plane');
        setMissionIntelligenceFocusedMissionId(missionId);
        return;
      }
      setSurfaceOrigin(consoleSection === 'surface' ? 'home' : consoleSection);
      setConsoleSection('surface');
      setFocusedOperatorView(targetId);
      setMissionIntelligenceFocus(null);
      setMissionIntelligenceFocusedMissionId(null);
      setFocusedOperatorMissionId(targetId === 'mission-control-plane' ? missionId : null);
      setSurface(null);
    },
    [consoleSection]
  );

  const handleScenarioOpen = useCallback(
    (targetId: string, surfaceMode: 'mission-intelligence' | 'focused-operator') => {
      setSurfaceOrigin(consoleSection === 'surface' ? 'home' : consoleSection);
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

  const homeCopy = useMemo(() => {
    const counts = operatorHomeSummary?.counts || {};
    const blocked = Number(counts.blockedMissions || 0);
    const approvals = Number(counts.pendingApprovals || 0);
    const planned = operatorHomeSummary?.plannedMissions?.length || 0;
    const inbox = Number(counts.unreadInbox || 0);
    const status = operatorHomeSummary?.status;
    const statusMessage =
      status === 'blocked'
        ? uxMessage(
            'chronos_home_status_blocked',
            { count: blocked },
            'Paused or failed missions need review.',
            locale
          )
        : status === 'attention'
          ? uxText('chronos_home_status_attention', locale)
          : operatorHomeSummary
            ? uxText('chronos_home_status_clear', locale)
            : uxText('chronos_cb_reading_state', locale);
    const actionTitle =
      blocked > 0
        ? uxText('chronos_home_action_blocked', locale)
        : approvals > 0
          ? uxText('chronos_home_action_approvals', locale)
          : planned > 0
            ? uxText('chronos_home_action_planned', locale)
            : inbox > 0
              ? uxText('chronos_home_action_inbox', locale)
              : uxText('chronos_home_action_clear', locale);
    const actionReason =
      blocked > 0
        ? uxMessage(
            'chronos_home_reason_blocked',
            { count: blocked },
            'Review the cause and next step for the paused or failed missions.',
            locale
          )
        : approvals > 0
          ? uxMessage(
              'chronos_home_reason_approvals',
              { count: approvals },
              'Review the requested changes waiting for approval.',
              locale
            )
          : planned > 0
            ? uxMessage(
                'chronos_home_reason_planned',
                { count: planned },
                'Review what the planned missions cover.',
                locale
              )
            : inbox > 0
              ? uxMessage(
                  'chronos_home_reason_inbox',
                  { count: inbox },
                  'Review the items waiting for your check.',
                  locale
                )
              : uxText('chronos_cb_all_clear_detail', locale);
    const statusLabel =
      status === 'blocked' || status === 'attention'
        ? uxText('chronos_status_needs_action', locale)
        : operatorHomeSummary
          ? uxText('chronos_status_clear', locale)
          : uxText('chronos_working', locale);
    return { statusMessage, actionTitle, actionReason, statusLabel };
  }, [locale, operatorHomeSummary]);

  const homePrimaryAction = useMemo(() => {
    if (!operatorHomeSummary) return null;
    const counts = operatorHomeSummary.counts || {};
    const target: { targetId: string; surface: 'mission-intelligence' | 'focused-operator' } =
      counts.blockedMissions > 0
        ? { targetId: 'needs-attention', surface: 'mission-intelligence' }
        : counts.pendingApprovals > 0
          ? { targetId: 'approvals', surface: 'mission-intelligence' }
          : (operatorHomeSummary.plannedMissions?.length ?? 0) > 0
            ? { targetId: 'mission-control-plane', surface: 'mission-intelligence' }
            : counts.unreadInbox > 0
              ? { targetId: 'recent-surface-outbox', surface: 'mission-intelligence' }
              : { targetId: 'mission-control-plane', surface: 'mission-intelligence' };
    return {
      title: homeCopy.actionTitle,
      reason: homeCopy.actionReason,
      ...target,
    };
  }, [homeCopy, operatorHomeSummary]);

  /**
   * The counters double as navigation: each one is the shortest path to the
   * work it counts. `null` targets stay readable but non-interactive.
   */
  const homeCounters = useMemo(() => {
    if (!operatorHomeSummary) return [];
    const counts = operatorHomeSummary.counts || {};
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
  const legacyWorkspaceEnabled = process.env.NEXT_PUBLIC_CHRONOS_LEGACY_WORKSPACE === '1';
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
    selectedDeliverableId,
    setSelectedDeliverableId,
    deliverableReviewComment,
    setDeliverableReviewComment,
    deliverableReviewBusy,
    setDeliverableReviewBusy,
    deliverableReviewError,
    setDeliverableReviewError,
    deliverableAskWhyVerdict,
    setDeliverableAskWhyVerdict,
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
    submitDeliverableReview,
    submitConnectionReview,
    handleOperatorViewOpen,
    handleScenarioOpen,
    activeSurfaceTitle,
    activeScenario,
    cleanedDeliverableCount,
    visibleDeliverables,
    homeCopy,
    homePrimaryAction,
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
    SovereignChat,
    AgentPanel,
    FirstRunBanner,
    IdentityBadge,
    MissionIntelligence,
    MissionJourneySummary,
    ChronosOffice,
    WorkItemsWorkspace,
    SurfaceControlWorkspace,
    OrganizationOperatingModel,
    CloudflareOsPanel,
    HeadlessA2UIWorkspace,
    ApprovalsWorkspace,
    DeliverablesWorkspace,
    KnowledgeWorkspace,
    DiagnosticsAttentionSummary,
    ChronosTenantScope,
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
    loadChronosThemeMode,
    saveChronosThemeMode,
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
    void fetch(`/api/tenant-design?${params.toString()}`, { signal: controller.signal })
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
