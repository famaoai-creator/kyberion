'use client';

import {
  Shield,
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
import {
  MISSION_CYCLE,
  OPERATOR_SCENARIO_PRESETS,
  OPERATOR_VIEW_LINKS,
  SURFACE_ROLES,
} from '../lib/operator-console';
import {
  chronosSpeechLocale,
  setChronosLocalePreference,
  uxMessage,
  uxText,
  type SupportedLocale,
} from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';
import {
  nextChronosThemeMode,
  resolveChronosThemeMode,
  type ChronosThemeMode,
} from '../lib/chronos-theme';

type QuickAction = {
  label: string;
  query: string;
  icon: string;
  tone: 'observe' | 'verify' | 'operate';
};

type QuickActionGroup = {
  title: string;
  hint: string;
  icon: typeof Radar;
  accent: string;
  accentText: string;
  actions: QuickAction[];
};

type StatusCard = {
  label: string;
  value: string;
  detail: string;
  icon: typeof Shield;
  accent: string;
  targetId: string;
};

const OPERATOR_LAYOUT_PREFS_KEY = 'chronos.operator-layout.prefs';
const CHRONOS_THEME_PREFS_KEY = 'chronos.theme-mode';

function buildPlanPreviewSignature(input: {
  requestText: string;
  missionType: string;
  assignedPersona: string;
  tier: 'personal' | 'confidential' | 'public';
}): string {
  return JSON.stringify({
    requestText: input.requestText.trim(),
    missionType: input.missionType.trim(),
    assignedPersona: input.assignedPersona.trim(),
    tier: input.tier,
  });
}

function isPlanPreviewStale(previewSignature: string | null, currentSignature: string): boolean {
  if (!previewSignature) return true;
  return previewSignature !== currentSignature;
}

function loadOperatorLayoutPrefs(): {
  focusedOperatorView: string | null;
  missionIntelligenceFocus: string | null;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OPERATOR_LAYOUT_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      focusedOperatorView: string | null;
      missionIntelligenceFocus: string | null;
    }>;
    return {
      focusedOperatorView:
        typeof parsed.focusedOperatorView === 'string' ? parsed.focusedOperatorView : null,
      missionIntelligenceFocus:
        typeof parsed.missionIntelligenceFocus === 'string'
          ? parsed.missionIntelligenceFocus
          : null,
    };
  } catch {
    return null;
  }
}

function saveOperatorLayoutPrefs(
  focusedOperatorView: string | null,
  missionIntelligenceFocus: string | null
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      OPERATOR_LAYOUT_PREFS_KEY,
      JSON.stringify({ focusedOperatorView, missionIntelligenceFocus })
    );
  } catch {
    // localStorage may be denied; ignore.
  }
}

function loadChronosThemeMode(): ChronosThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CHRONOS_THEME_PREFS_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : null;
  } catch {
    return null;
  }
}

function saveChronosThemeMode(mode: ChronosThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHRONOS_THEME_PREFS_KEY, mode);
  } catch {
    // localStorage may be denied; ignore.
  }
}

const buildQuickActionGroups = (locale: SupportedLocale): QuickActionGroup[] => [
  {
    title: uxText('chronos_qa_prepare_title', locale),
    hint: uxText('chronos_qa_prepare_hint', locale),
    icon: ClipboardCheck,
    accent: 'from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent',
    accentText: 'kb-status-positive',
    actions: [
      {
        label: uxText('chronos_qa_action_prereq_check', locale),
        query: 'chronos://quick-action/prereq-check',
        icon: '🧰',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_setup_report', locale),
        query: 'chronos://quick-action/setup-report',
        icon: '📑',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_doctor', locale),
        query: 'chronos://quick-action/doctor',
        icon: '🩺',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_surface_setup', locale),
        query: 'chronos://quick-action/surfaces-setup',
        icon: '🛰',
        tone: 'verify',
      },
    ],
  },
  {
    title: uxText('chronos_qa_schedule_title', locale),
    hint: uxText('chronos_qa_schedule_hint', locale),
    icon: CalendarClock,
    accent: 'from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent',
    accentText: 'kb-status-info',
    actions: [
      {
        label: uxText('chronos_qa_action_schedule_tick', locale),
        query: 'chronos://quick-action/schedule-tick',
        icon: '⏱',
        tone: 'operate',
      },
      {
        label: uxText('chronos_qa_action_schedule_list', locale),
        query: 'chronos://quick-action/schedule-list',
        icon: '🗂',
        tone: 'observe',
      },
    ],
  },
  {
    title: uxText('chronos_qa_observe_title', locale),
    hint: uxText('chronos_qa_observe_hint', locale),
    icon: Radar,
    accent: 'from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent',
    accentText: 'kb-text-accent',
    actions: [
      {
        label: uxText('chronos_qa_action_dashboard', locale),
        query: 'chronos://quick-action/dashboard',
        icon: '📊',
        tone: 'observe',
      },
      {
        label: uxText('chronos_qa_action_missions', locale),
        query: 'chronos://quick-action/missions',
        icon: '🎯',
        tone: 'observe',
      },
      {
        label: uxText('chronos_qa_action_agents', locale),
        query: 'chronos://quick-action/agents',
        icon: '🤖',
        tone: 'observe',
      },
      {
        label: uxText('chronos_qa_action_audit_log', locale),
        query: 'chronos://quick-action/audit-log',
        icon: '📋',
        tone: 'observe',
      },
      {
        label: uxText('chronos_qa_action_traces', locale),
        query: 'chronos://operator-view/trace-viewer',
        icon: '🔭',
        tone: 'observe',
      },
    ],
  },
  {
    title: uxText('chronos_qa_verify_title', locale),
    hint: uxText('chronos_qa_verify_hint', locale),
    icon: ActivitySquare,
    accent: 'from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent',
    accentText: 'kb-status-warning',
    actions: [
      {
        label: uxText('chronos_qa_action_vital_check', locale),
        query: 'chronos://quick-action/vital-check',
        icon: '💓',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_diagnostics', locale),
        query: 'chronos://quick-action/diagnostics',
        icon: '🔍',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_capability_audit', locale),
        query: 'chronos://quick-action/capability-audit',
        icon: '🧩',
        tone: 'verify',
      },
      {
        label: uxText('chronos_qa_action_provider_check', locale),
        query: 'chronos://quick-action/provider-check',
        icon: '🔌',
        tone: 'verify',
      },
    ],
  },
  {
    title: uxText('chronos_qa_operate_title', locale),
    hint: uxText('chronos_qa_operate_hint', locale),
    icon: Wrench,
    accent: 'from-[var(--kb-surface-accent)] via-[var(--kb-surface-raised)] to-transparent',
    accentText: 'kb-status-warning',
    actions: [
      {
        label: uxText('chronos_qa_action_build_test', locale),
        query: 'chronos://quick-action/build-test',
        icon: '🔨',
        tone: 'operate',
      },
      {
        label: uxText('chronos_qa_action_policies', locale),
        query: 'chronos://quick-action/policies',
        icon: '🛡',
        tone: 'operate',
      },
      {
        label: uxText('chronos_qa_action_upgrade_check', locale),
        query:
          'node dist/scripts/run_pipeline.js --input pipelines/system-upgrade-check.json を実行して、アップデートの有無を表示して',
        icon: '⬆',
        tone: 'operate',
      },
      {
        label: uxText('chronos_qa_action_knowledge', locale),
        query: 'chronos://quick-action/knowledge',
        icon: '🧠',
        tone: 'operate',
      },
    ],
  },
];

const buildStatusCards = (locale: SupportedLocale): StatusCard[] => [
  {
    label: uxText('chronos_sc_needs_attention_label', locale),
    value: uxText('chronos_sc_needs_attention_value', locale),
    detail: uxText('chronos_sc_needs_attention_detail', locale),
    icon: Shield,
    accent: 'kb-status-warning-border kb-status-warning-surface kb-status-warning',
    targetId: 'mission-control-plane',
  },
  {
    label: uxText('chronos_sc_toolchain_label', locale),
    value: uxText('chronos_sc_toolchain_value', locale),
    detail: uxText('chronos_sc_toolchain_detail', locale),
    icon: ClipboardCheck,
    accent: 'kb-status-positive-border kb-status-positive-surface kb-status-positive',
    targetId: 'operator-quick-actions',
  },
  {
    label: uxText('chronos_sc_schedules_label', locale),
    value: uxText('chronos_sc_schedules_value', locale),
    detail: uxText('chronos_sc_schedules_detail', locale),
    icon: CalendarClock,
    accent: 'kb-status-info-border kb-status-info-surface kb-status-info',
    targetId: 'operator-quick-actions',
  },
  {
    label: uxText('chronos_sc_runtime_governance_label', locale),
    value: uxText('chronos_sc_runtime_governance_value', locale),
    detail: uxText('chronos_sc_runtime_governance_detail', locale),
    icon: Bot,
    accent: 'kb-border-accent kb-surface-accent kb-text-accent',
    targetId: 'runtime-lease-doctor',
  },
  {
    label: uxText('chronos_sc_delivery_label', locale),
    value: uxText('chronos_sc_delivery_value', locale),
    detail: uxText('chronos_sc_delivery_detail', locale),
    icon: Radar,
    accent: 'kb-status-negative-border kb-status-negative-surface kb-status-negative',
    targetId: 'recent-surface-outbox',
  },
];

export default function ChronosMirrorV2() {
  const locale = useChronosLocale();
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
  const [deliverables, setDeliverables] = useState<any[]>([]);
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
  const [approvalAskWhyId, setApprovalAskWhyId] = useState<string | null>(null);
  const [operatorHomeSummary, setOperatorHomeSummary] = useState<any | null>(null);
  const [operatorHomeError, setOperatorHomeError] = useState<string | null>(null);
  const [operatorHomeRefreshTick, setOperatorHomeRefreshTick] = useState(0);
  const [missionHistory, setMissionHistory] = useState<any[]>([]);
  const [missionHistoryError, setMissionHistoryError] = useState<string | null>(null);
  const [missionHistoryQuery, setMissionHistoryQuery] = useState('');
  // Defaulting to 'completed' made this panel read "No missions match the
  // current filter" on a workspace with active missions and no finished ones —
  // an empty history next to a live mission count. Start unfiltered.
  const [missionHistoryStatus, setMissionHistoryStatus] = useState('');
  const [missionHistoryTier, setMissionHistoryTier] = useState('');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [costSummary, setCostSummary] = useState<any | null>(null);
  const [costSummaryError, setCostSummaryError] = useState<string | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<any[]>([]);
  const [approvalQueueError, setApprovalQueueError] = useState<string | null>(null);
  const [approvalQueueQuery, setApprovalQueueQuery] = useState('');
  const [approvalDecisionBusyId, setApprovalDecisionBusyId] = useState<string | null>(null);
  const [planApprovalBusy, setPlanApprovalBusy] = useState(false);
  const [planApprovalMessage, setPlanApprovalMessage] = useState<string | null>(null);
  const [planApprovalSessionId, setPlanApprovalSessionId] = useState<string | null>(null);
  const [connections, setConnections] = useState<any[]>([]);
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
      `/api/deliverables?limit=24${deliverablesQuery ? `&query=${encodeURIComponent(deliverablesQuery)}` : ''}`,
      {
        headers: { 'Cache-Control': 'no-cache' },
      }
    )
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`deliverables ${response.status}`);
        }
        return (await response.json()) as { deliverables?: any[] };
      })
      .then((payload) => {
        if (cancelled) return;
        setDeliverables(Array.isArray(payload.deliverables) ? payload.deliverables : []);
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
  }, [deliverablesQuery, deliverablesRefreshTick]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('limit', '24');
    if (missionHistoryQuery) params.set('query', missionHistoryQuery);
    if (missionHistoryStatus) params.set('status', missionHistoryStatus);
    if (missionHistoryTier) params.set('tier', missionHistoryTier);
    void fetch(`/api/missions/search?${params.toString()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`missions ${response.status}`);
        return (await response.json()) as { missions?: any[] };
      })
      .then((payload) => {
        if (cancelled) return;
        setMissionHistory(Array.isArray(payload.missions) ? payload.missions : []);
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
  }, [missionHistoryQuery, missionHistoryStatus, missionHistoryTier]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (selectedMissionId) params.set('missionId', selectedMissionId);
    params.set('since', new Date().toISOString().slice(0, 10));
    void fetch(`/api/cost?${params.toString()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`cost ${response.status}`);
        return (await response.json()) as { summary?: any };
      })
      .then((payload) => {
        if (cancelled) return;
        setCostSummary(payload.summary || null);
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
  }, [selectedMissionId]);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    params.set('status', 'pending');
    params.set('limit', '24');
    if (approvalQueueQuery) params.set('query', approvalQueueQuery);
    void fetch(`/api/approvals?${params.toString()}`, {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`approvals ${response.status}`);
        return (await response.json()) as { approvals?: any[] };
      })
      .then((payload) => {
        if (cancelled) return;
        setApprovalQueue(Array.isArray(payload.approvals) ? payload.approvals : []);
        setApprovalQueueError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setApprovalQueue([]);
        setApprovalQueueError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [approvalQueueQuery]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/connections', {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`connections ${response.status}`);
        return (await response.json()) as { connections?: any[] };
      })
      .then((payload) => {
        if (cancelled) return;
        setConnections(Array.isArray(payload.connections) ? payload.connections : []);
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/operator-home?limit=8', {
      headers: { 'Cache-Control': 'no-cache' },
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`operator-home ${response.status}`);
        return (await response.json()) as { summary?: any };
      })
      .then((payload) => {
        if (cancelled) return;
        setOperatorHomeSummary(payload.summary || null);
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
  }, [operatorHomeRefreshTick]);

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
      setSurface({
        surfaceId: message.createSurface.surfaceId,
        title: message.createSurface.title,
        components: [],
      });
    }
    if (message.updateComponents) {
      setSurface((prev: any) => ({
        surfaceId: message.updateComponents.surfaceId,
        title: prev?.title || message.updateComponents.surfaceId,
        components: message.updateComponents.components,
      }));
    }
    if (message.deleteSurface) {
      setSurface(null);
    }
    if (message.type && message.type.startsWith('display:')) {
      const id = message.id || `auto-${Date.now()}`;
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
  const [showOpsBoards, setShowOpsBoards] = useState(false);

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
    (item: { missionId?: string; path?: string; externalRef?: string }) => {
      if (item.externalRef && /^https?:/.test(item.externalRef)) {
        window.open(item.externalRef, '_blank', 'noreferrer');
        return;
      }
      if (!item.path) return;
      // repo-relative artifact mode covers exports/tmp/missions uniformly;
      // mission mode remains for mission-relative records.
      const url = item.path.startsWith('active/')
        ? `/api/mission-asset?path=${encodeURIComponent(item.path)}`
        : item.missionId
          ? `/api/mission-asset?missionId=${encodeURIComponent(item.missionId)}&path=${encodeURIComponent(item.path)}`
          : `/api/mission-asset?path=${encodeURIComponent(item.path)}`;
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
          query: 'はい',
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

  const submitApprovalDecision = useCallback(
    async (
      item: any,
      decision: 'approved' | 'rejected',
      options?: { reasonCategory?: string; skipAskWhy?: boolean }
    ) => {
      // LC-10 ask-why: a rejection with no reason teaches nothing — ask one
      // skippable question before submitting.
      if (decision === 'rejected' && !options?.reasonCategory && !options?.skipAskWhy) {
        setApprovalAskWhyId(item.id);
        return;
      }
      setApprovalAskWhyId(null);
      setApprovalDecisionBusyId(item.id);
      try {
        const response = await fetch('/api/intelligence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'approval_decision',
            requestId: item.id,
            storageChannel: item.storageChannel,
            channel: item.channel,
            decision,
            reasonCategory: options?.reasonCategory,
          }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'approval decision failed');
        setApprovalQueue((current) => current.filter((entry) => entry.id !== item.id));
        setOperatorHomeRefreshTick((value) => value + 1);
      } catch (error) {
        setApprovalQueueError(error instanceof Error ? error.message : String(error));
      } finally {
        setApprovalDecisionBusyId(null);
      }
    },
    []
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
        setFocusedOperatorView(null);
        setFocusedOperatorMissionId(null);
        setMissionIntelligenceFocus('mission-control-plane');
        setMissionIntelligenceFocusedMissionId(missionId);
        return;
      }
      setFocusedOperatorView(targetId);
      setMissionIntelligenceFocus(null);
      setMissionIntelligenceFocusedMissionId(null);
      setFocusedOperatorMissionId(targetId === 'mission-control-plane' ? missionId : null);
      if (surface) {
        setSurface(null);
      }
    },
    [surface]
  );

  const handleScenarioOpen = useCallback(
    (targetId: string, surfaceMode: 'mission-intelligence' | 'focused-operator') => {
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
    []
  );

  const activeSurfaceTitle = useMemo(
    () => surface?.title || uxText('chronos_mission_intelligence', locale),
    [surface?.title, locale]
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

  const homePrimaryAction = useMemo(() => {
    if (!operatorHomeSummary) return null;
    const counts = operatorHomeSummary.counts || {};
    const target: { targetId: string; surface: 'mission-intelligence' | 'focused-operator' } =
      counts.blockedMissions > 0
        ? { targetId: 'needs-attention', surface: 'mission-intelligence' }
        : counts.pendingApprovals > 0
          ? { targetId: 'approvals', surface: 'mission-intelligence' }
          : counts.unreadInbox > 0
            ? { targetId: 'recent-surface-outbox', surface: 'mission-intelligence' }
            : { targetId: 'mission-control-plane', surface: 'mission-intelligence' };
    return {
      title: operatorHomeSummary.nextAction?.title as string | undefined,
      reason: operatorHomeSummary.nextAction?.reason as string | undefined,
      ...target,
    };
  }, [operatorHomeSummary]);

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

  return (
    <Suspense fallback={null}>
      <TenantDesignBridge
        onResolve={(cssVars, label) => {
          setTenantCssVars(cssVars);
          setTenantLabel(label);
        }}
      />
      <main
        className={`min-h-screen w-screen overflow-x-hidden bg-[var(--kb-bg-main)] ${shellTextClass}`}
        data-theme={themeMode}
        style={{ ...(webDesignSystem.css_vars as CSSProperties), ...tenantCssVars }}
      >
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute left-[-8%] top-[-6%] h-[32rem] w-[32rem] rounded-full kb-surface-accent blur-[160px]" />
          <div className="absolute top-[18%] right-[12%] h-[20rem] w-[20rem] rounded-full kb-surface-accent blur-[150px]" />
          <div className="absolute bottom-[-12%] left-[32%] h-[26rem] w-[26rem] rounded-full kb-surface-sunken blur-[160px]" />
        </div>
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:88px_88px] opacity-[0.06]" />
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(180deg,rgba(255,248,225,0.05)_0%,transparent_18%,transparent_82%,rgba(148,163,184,0.04)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col gap-6 p-4 md:p-6">
          <header className="px-1 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border kb-border-accent kb-surface-accent">
                  <Shield className="h-5 w-5 kb-text-accent" />
                </div>
                <div>
                  <div
                    className={`text-[10px] uppercase tracking-[0.3em] font-bold ${shellMutedClass}`}
                  >
                    Chronos Mirror
                  </div>
                  <h1 className={`text-lg font-bold tracking-tight ${shellTitleClass}`}>
                    Control Plane
                  </h1>
                </div>
                <div
                  className={`ml-2 rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[11px] ${isLightTheme ? 'text-[var(--kb-text-secondary)]' : 'kb-text-accent'}`}
                  title={locale === 'ja' ? 'このサーフェスの役割' : 'What this surface is for'}
                >
                  {locale === 'ja'
                    ? '管制塔 — 実行状態の監視と介入'
                    : 'Control tower — monitor execution, intervene when needed'}
                </div>
                <button
                  type="button"
                  onClick={() => setShowOpsBoards((current) => !current)}
                  className={`ml-2 rounded-full border px-3 py-1 text-[11px] transition ${showOpsBoards ? 'kb-border-accent kb-surface-accent kb-text-accent' : isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised'}`}
                >
                  {locale === 'ja' ? 'エージェント/看板' : 'Agents / Boards'}
                </button>
              </div>
              {tenantLabel ? (
                <div className="rounded-full border kb-border-accent kb-surface-accent px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] kb-text-accent">
                  {tenantLabel}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setThemeModePreference(nextChronosThemeMode)}
                  aria-label={`Chronos theme: ${themeModePreference}`}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <Palette size={12} />
                  <span>{themeModePreference}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setChronosLocalePreference(locale === 'ja' ? 'en' : 'ja')}
                  aria-label={
                    locale === 'ja' ? 'Switch language to English' : '言語を日本語に切り替え'
                  }
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <span>{locale === 'ja' ? 'JA' : 'EN'}</span>
                </button>
                <IdentityBadge />
                <button
                  type="button"
                  onClick={() => setAgentPanelOpen(true)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70 ${isLightTheme ? 'border-[color:var(--kb-border)] kb-surface-raised text-[var(--kb-text-primary)] hover:kb-surface-raised' : 'kb-border-subtle kb-surface-raised/5 kb-text-secondary hover:kb-surface-raised hover:kb-text-accent'}`}
                >
                  <Cpu size={12} />
                  <span>{uxText('chronos_agent_runtimes', locale)}</span>
                </button>
              </div>
            </div>
          </header>

          {/* The command band: role, current state, the one action to take,
              and counters that double as navigation. This is deliberately the
              first thing on the page — the design-system panel that used to own
              this slot moved into the sidebar's reference drawer. */}
          <section className="kyberion-glass rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="max-w-3xl">
                <div
                  className={`flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.28em] ${shellMutedClass}`}
                >
                  <span>{uxText('chronos_cb_role', locale)}</span>
                  <span aria-hidden="true">·</span>
                  <span>{uxText('chronos_mission_intelligence', locale)}</span>
                </div>
                <h2
                  className={`mt-3 text-xl font-semibold leading-snug tracking-tight ${shellTitleClass} md:text-2xl`}
                >
                  {operatorHomeSummary
                    ? operatorHomeSummary.statusDetail
                    : uxText('chronos_cb_reading_state', locale)}
                </h2>
                <p className={`mt-2 text-sm leading-6 ${shellSubtleClass}`}>
                  {uxText('chronos_cb_purpose', locale)}
                </p>
              </div>
              <div
                className={`rounded-full border px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] ${toneChipClass(
                  operatorHomeSummary?.status === 'blocked'
                    ? 'reject'
                    : operatorHomeSummary?.status === 'attention'
                      ? 'alert'
                      : operatorHomeSummary
                        ? 'approve'
                        : 'neutral'
                )}`}
              >
                {operatorHomeSummary?.statusLabel || uxText('chronos_working', locale)}
              </div>
            </div>

            {operatorHomeError ? (
              <div className="mt-4 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                {operatorHomeError}
              </div>
            ) : null}

            {homePrimaryAction ? (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border kb-border-accent kb-surface-accent px-4 py-4">
                <div className="min-w-0">
                  <div
                    className={`text-[10px] font-bold uppercase tracking-[0.22em] ${shellMutedClass}`}
                  >
                    {uxText('chronos_cb_do_this_next', locale)}
                  </div>
                  <div className={`mt-1 text-base font-semibold ${shellTitleClass}`}>
                    {homePrimaryAction.title || uxText('chronos_cb_all_clear', locale)}
                  </div>
                  <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                    {homePrimaryAction.reason || uxText('chronos_cb_all_clear_detail', locale)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    handleScenarioOpen(homePrimaryAction.targetId, homePrimaryAction.surface)
                  }
                  className={`rounded-xl border px-5 py-3 text-[11px] font-bold uppercase tracking-[0.2em] transition ${toneChipClass('info')}`}
                >
                  {uxText('chronos_cb_open', locale)} →
                </button>
              </div>
            ) : null}

            {homeCounters.length > 0 ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                  {homeCounters.map((counter) => (
                    <button
                      key={counter.key}
                      type="button"
                      onClick={() => handleScenarioOpen(counter.targetId, 'mission-intelligence')}
                      className={`rounded-2xl border px-4 py-3 text-left transition ${toneChipClass(
                        counter.value > 0 ? counter.tone : 'neutral'
                      )}`}
                    >
                      <div className="text-2xl font-semibold leading-none">{counter.value}</div>
                      <div className="mt-2 text-[10px] font-bold uppercase tracking-[0.18em]">
                        {counter.label}
                      </div>
                    </button>
                  ))}
                </div>
                <div className={`mt-3 text-[10px] uppercase tracking-[0.16em] ${shellMutedClass}`}>
                  {uxText('chronos_cb_counts_hint', locale)}
                </div>
              </>
            ) : null}

            {operatorHomeSummary?.activeMissions?.length ? (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {operatorHomeSummary.activeMissions.slice(0, 4).map((mission: any) => (
                  <button
                    key={mission.missionId}
                    type="button"
                    onClick={() => setSelectedMissionId(mission.missionId)}
                    className={`rounded-full border px-3 py-1 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
                  >
                    {mission.missionId}
                  </button>
                ))}
              </div>
            ) : null}
          </section>

          <FirstRunBanner />

          <section className="grid gap-4 xl:grid-cols-[1.05fr,0.95fr]">
            <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                    SU history
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                    Mission history
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={missionHistoryQuery}
                    onChange={(event) => setMissionHistoryQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                  />
                  <select
                    value={missionHistoryStatus}
                    onChange={(event) => setMissionHistoryStatus(event.target.value)}
                    className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none focus:kb-border-accent"
                  >
                    <option value="">{uxText('chronos_mh_all_statuses', locale)}</option>
                    <option value="completed">completed</option>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="failed">failed</option>
                  </select>
                  <select
                    value={missionHistoryTier}
                    onChange={(event) => setMissionHistoryTier(event.target.value)}
                    className="rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none focus:kb-border-accent"
                  >
                    <option value="">all tiers</option>
                    <option value="public">public</option>
                    <option value="confidential">confidential</option>
                    <option value="personal">personal</option>
                  </select>
                </div>
              </div>
              {missionHistoryError ? (
                <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                  {missionHistoryError}
                </div>
              ) : null}
              <div className="mt-4 max-h-[420px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                {missionHistory.length === 0 ? (
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
                    {uxText('chronos_mh_no_match', locale)}
                  </div>
                ) : (
                  missionHistory.map((mission) => (
                    <button
                      key={mission.missionId}
                      type="button"
                      onClick={() => setSelectedMissionId(mission.missionId)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        selectedMissionId === mission.missionId
                          ? 'kb-border-accent kb-surface-accent'
                          : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            {mission.missionId}
                          </div>
                          <div className="mt-1 text-sm font-semibold kb-text-primary">
                            {mission.goalSummary ||
                              mission.intentText ||
                              mission.missionType ||
                              'Mission'}
                          </div>
                        </div>
                        <div className="text-right text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                          {mission.status}
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 text-[10px] kb-text-muted sm:grid-cols-2">
                        <div>tier {mission.tier}</div>
                        <div>artifacts {mission.artifactCount}</div>
                        <div>updated {mission.updatedAt || mission.startedAt || '-'}</div>
                        <div className="truncate">
                          tenant {mission.tenantSlug || mission.tenantId || '-'}
                        </div>
                      </div>
                      {mission.successCondition ? (
                        <div className="mt-2 text-[11px] leading-6 kb-text-secondary">
                          {mission.successCondition}
                        </div>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="grid gap-4">
              <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                      SU cost
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                      Cost visibility
                    </h2>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                    {selectedMissionId ? selectedMissionId : 'today'}
                  </div>
                </div>
                {costSummaryError ? (
                  <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                    {costSummaryError}
                  </div>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">usd</div>
                    <div className="mt-2 text-2xl font-semibold kb-text-primary">
                      {typeof costSummary?.totalUsd === 'number'
                        ? `$${costSummary.totalUsd.toFixed(3)}`
                        : '-'}
                    </div>
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {costSummary?.entryCount || 0} entries
                    </div>
                  </div>
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      tokens
                    </div>
                    <div className="mt-2 text-2xl font-semibold kb-text-primary">
                      {typeof costSummary?.totalTokens === 'number'
                        ? costSummary.totalTokens.toLocaleString(chronosSpeechLocale())
                        : '-'}
                    </div>
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {costSummary?.missionCount || 0} missions
                    </div>
                  </div>
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      budget
                    </div>
                    <div className="mt-2 text-2xl font-semibold kb-text-primary">
                      {typeof costSummary?.budgetUsd === 'number'
                        ? `$${costSummary.budgetUsd.toFixed(3)}`
                        : 'n/a'}
                    </div>
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {typeof costSummary?.remainingUsd === 'number'
                        ? `remaining $${costSummary.remainingUsd.toFixed(3)}`
                        : 'no spend guard configured'}
                    </div>
                  </div>
                </div>
                {Array.isArray(costSummary?.missionBreakdown) &&
                costSummary.missionBreakdown.length > 0 ? (
                  <div className="mt-4 space-y-2">
                    {costSummary.missionBreakdown.slice(0, 4).map((item: any) => (
                      <div
                        key={item.missionId}
                        className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] kb-text-muted"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedMissionId(
                                item.missionId === 'UNASSIGNED' ? null : item.missionId
                              )
                            }
                            className="font-mono text-[10px] uppercase tracking-[0.16em] kb-text-accent"
                          >
                            {item.missionId}
                          </button>
                          <div className="kb-text-primary">${item.usd.toFixed(3)}</div>
                        </div>
                        <div className="mt-1 kb-text-muted">
                          {item.tokens.toLocaleString(chronosSpeechLocale())} tokens ·{' '}
                          {item.entryCount} entries
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                      SU approvals
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                      Approval queue
                    </h2>
                  </div>
                  <input
                    value={approvalQueueQuery}
                    onChange={(event) => setApprovalQueueQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                  />
                </div>
                {approvalQueueError ? (
                  <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                    {approvalQueueError}
                  </div>
                ) : null}
                <div className="mt-4 max-h-[310px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                  {approvalQueue.length === 0 ? (
                    <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
                      No pending approvals.
                    </div>
                  ) : (
                    approvalQueue.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                              {item.kind} · {item.channel}
                            </div>
                            <div className="mt-1 text-sm font-semibold kb-text-primary">
                              {item.title}
                            </div>
                          </div>
                          <div className="text-right text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                            {item.status}
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] leading-6 kb-text-secondary">
                          {item.summary}
                        </div>
                        <div className="mt-2 grid gap-2 text-[10px] kb-text-muted sm:grid-cols-2">
                          <div>mission {item.missionId || '-'}</div>
                          <div>service {item.serviceId || '-'}</div>
                          <div>risk {item.riskLevel || '-'}</div>
                          <div>requested {item.requestedAt}</div>
                        </div>
                        <div className="mt-3 flex gap-2">
                          <button
                            type="button"
                            disabled={approvalDecisionBusyId === item.id}
                            onClick={() => submitApprovalDecision(item, 'approved')}
                            className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                          >
                            approve
                          </button>
                          <button
                            type="button"
                            disabled={approvalDecisionBusyId === item.id}
                            onClick={() => submitApprovalDecision(item, 'rejected')}
                            className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                          >
                            reject
                          </button>
                        </div>
                        {approvalAskWhyId === item.id ? (
                          <div className="mt-3 rounded-xl border kb-status-warning-border kb-status-warning-surface px-4 py-3">
                            <div className="text-[11px] kb-status-warning">
                              どこが期待と違いましたか？（1問だけ・スキップ可）
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(
                                [
                                  ['incorrect_content', '内容が誤り'],
                                  ['wrong_direction', '方向が違う'],
                                  ['quality', '品質不足'],
                                  ['scope', 'スコープ過不足'],
                                  ['other', 'その他'],
                                ] as const
                              ).map(([category, label]) => (
                                <button
                                  key={category}
                                  type="button"
                                  disabled={approvalDecisionBusyId === item.id}
                                  onClick={() =>
                                    submitApprovalDecision(item, 'rejected', {
                                      reasonCategory: category,
                                    })
                                  }
                                  className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                                >
                                  {label}
                                </button>
                              ))}
                              <button
                                type="button"
                                disabled={approvalDecisionBusyId === item.id}
                                onClick={() =>
                                  submitApprovalDecision(item, 'rejected', { skipAskWhy: true })
                                }
                                className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('neutral')}`}
                              >
                                スキップ
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                      SU connections
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                      Connection review
                    </h2>
                  </div>
                  <input
                    value={connectionsQuery}
                    onChange={(event) => setConnectionsQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                  />
                </div>
                {connectionsError ? (
                  <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                    {connectionsError}
                  </div>
                ) : null}
                <div className="mt-4 max-h-[240px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                  {connections
                    .filter((item) => {
                      if (!connectionsQuery.trim()) return true;
                      const haystack = [
                        item.binding_id,
                        item.service_id,
                        item.service_type,
                        item.scope,
                        item.target,
                        item.reviewAction,
                        item.reviewNote,
                      ]
                        .filter(Boolean)
                        .join(' ')
                        .toLowerCase();
                      return haystack.includes(connectionsQuery.trim().toLowerCase());
                    })
                    .map((item) => (
                      <button
                        key={item.binding_id}
                        type="button"
                        onClick={() => {
                          setSelectedConnectionId(item.binding_id);
                          setConnectionsError(null);
                        }}
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          selectedConnectionId === item.binding_id
                            ? 'kb-border-accent kb-surface-accent'
                            : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                              {item.service_type || 'service'} · {item.binding_id}
                            </div>
                            <div className="mt-1 text-sm font-semibold kb-text-primary">
                              {item.service_id || item.target}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                            {item.reviewAction || 'pending'}
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 text-[10px] kb-text-muted sm:grid-cols-2">
                          <div>scope {item.scope}</div>
                          <div>target {item.target}</div>
                          <div>policy {Object.keys(item.approval_policy || {}).length}</div>
                          <div>reviewed {item.reviewedAt || '-'}</div>
                        </div>
                      </button>
                    ))}
                </div>
                {selectedConnectionId ? (
                  <div className="mt-4 rounded-2xl border kb-border-accent kb-surface-accent p-4">
                    {(() => {
                      const selected = connections.find(
                        (item) => item.binding_id === selectedConnectionId
                      );
                      if (!selected)
                        return (
                          <div className="text-[11px] kb-text-muted">
                            Selected connection not found.
                          </div>
                        );
                      return (
                        <>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                                review
                              </div>
                              <div className="mt-1 text-sm font-semibold kb-text-primary">
                                {selected.service_id || selected.binding_id}
                              </div>
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                              {selected.reviewAction || 'pending'}
                            </div>
                          </div>
                          <textarea
                            value={connectionReviewNote}
                            onChange={(event) => setConnectionReviewNote(event.target.value)}
                            placeholder="review note"
                            className="mt-3 min-h-[80px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                          />
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'approve')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                            >
                              approve
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'modify')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('info')}`}
                            >
                              modify
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'hold')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                            >
                              hold
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'delete')}
                              className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                            >
                              delete
                            </button>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </div>
            </div>
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.1fr,0.9fr]">
            <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                    SU workbench
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                    Plan preview and approval
                  </h2>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={runPlanPreview}
                    disabled={planPreviewBusy}
                    className="rounded-lg border kb-border-accent kb-surface-accent px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {planPreviewBusy ? 'previewing' : 'preview'}
                  </button>
                  <button
                    type="button"
                    onClick={approvePlanAndStart}
                    disabled={planApprovalBusy || !planPreview || planPreviewIsStale}
                    className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {planApprovalBusy ? 'starting' : 'approve & start'}
                  </button>
                </div>
              </div>
              {planPreview && planPreviewIsStale ? (
                <div className="mt-3 rounded-xl border kb-status-warning-border kb-status-warning-surface px-4 py-3 text-[11px] kb-status-warning">
                  Preview is stale. Re-run preview before approving.
                </div>
              ) : null}
              <textarea
                value={planRequestText}
                onChange={(event) => setPlanRequestText(event.target.value)}
                placeholder="例: 来週までに顧客向け提案資料を作って、承認前にレビューしたい"
                className="mt-4 min-h-[120px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                  mission type
                  <input
                    value={planMissionType}
                    onChange={(event) => setPlanMissionType(event.target.value)}
                    className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                  />
                </label>
                <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                  persona
                  <input
                    value={planPersona}
                    onChange={(event) => setPlanPersona(event.target.value)}
                    className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                  />
                </label>
                <label className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                  tier
                  <select
                    value={planTier}
                    onChange={(event) =>
                      setPlanTier(event.target.value as 'personal' | 'confidential' | 'public')
                    }
                    className="mt-2 w-full rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] tracking-normal kb-text-primary outline-none focus:kb-border-accent"
                  >
                    <option value="personal">personal</option>
                    <option value="confidential">confidential</option>
                    <option value="public">public</option>
                  </select>
                </label>
              </div>
              {planPreviewError ? (
                <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                  {planPreviewError}
                </div>
              ) : null}
              {planApprovalMessage ? (
                <div className="mt-3 rounded-xl border kb-status-positive-border kb-status-positive-surface px-4 py-3 text-[11px] kb-status-positive">
                  {planApprovalMessage}
                </div>
              ) : null}
              {planPreview ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-[1fr,0.85fr]">
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      goal
                    </div>
                    <div className="mt-2 text-sm font-semibold kb-text-primary">
                      {planPreview.goal?.summary}
                    </div>
                    <div className="mt-2 text-[11px] leading-6 kb-text-muted">
                      {planPreview.goal?.successCondition}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-[10px] kb-text-muted">
                      <div>
                        delivery mode{' '}
                        <span className="font-mono kb-text-primary">
                          {planPreview.delivery?.mode}
                        </span>
                      </div>
                      <div>
                        clarification{' '}
                        <span className="font-mono kb-text-primary">
                          {planPreview.delivery?.clarificationNeeded ? 'needed' : 'clear'}
                        </span>
                      </div>
                      <div>
                        execution{' '}
                        <span className="font-mono kb-text-primary">
                          {planPreview.execution?.shape}
                        </span>
                      </div>
                      <div>
                        confidence{' '}
                        <span className="font-mono kb-text-primary">
                          {Math.round((Number(planPreview.confidence) || 0) * 100)}%
                        </span>
                      </div>
                    </div>
                    {Array.isArray(planPreview.execution?.clarificationQuestions) &&
                    planPreview.execution.clarificationQuestions.length > 0 ? (
                      <div className="mt-4">
                        <KbInterventionPanel
                          reason="Clarification is required before approval. 質問をクリックすると依頼文に回答欄が追加されます。"
                          isBlocking
                          options={planPreview.execution.clarificationQuestions.map(
                            (question: any) => ({
                              label: question.question,
                              variant: 'neutral' as const,
                              value: question.id,
                            })
                          )}
                          onSelectOption={(option) => {
                            setPlanRequestText(
                              (current) =>
                                `${current.trimEnd()}\n\n【確認事項への回答】${option.label}\n→ `
                            );
                            setPlanApprovalMessage(
                              '確認事項を依頼文に追記しました。回答を書いてから再プレビューしてください。'
                            );
                          }}
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      team + workflow
                    </div>
                    <div className="mt-2 text-[11px] kb-text-muted">
                      {planPreview.team?.assignments?.length || 0} assignments ·{' '}
                      {planPreview.team?.team_governance?.composition?.required_roles?.length || 0}{' '}
                      required roles
                    </div>
                    <div className="mt-3 space-y-2">
                      {(planPreview.team?.assignments || []).slice(0, 5).map((assignment: any) => (
                        <div
                          key={`${assignment.team_role}-${assignment.agent_id || 'unfilled'}`}
                          className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                              {assignment.team_role}
                            </div>
                            <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                              {assignment.status}
                            </div>
                          </div>
                          <div className="mt-1 font-mono text-[10px] kb-text-secondary">
                            {assignment.agent_id || 'unfilled'}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                      workflow steps
                    </div>
                    <div className="mt-2 space-y-2">
                      {(planPreview.workflow || []).slice(0, 5).map((step: any) => (
                        <div
                          key={step.id}
                          className="rounded-xl border kb-border-subtle kb-surface-raised px-3 py-2"
                        >
                          <div className="text-[10px] kb-text-primary">{step.label}</div>
                          <div className="mt-1 text-[9px] leading-5 kb-text-muted">
                            {step.description}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                    SU inbox
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                    Deliverables
                  </h2>
                </div>
                <input
                  value={deliverablesQuery}
                  onChange={(event) => setDeliverablesQuery(event.target.value)}
                  placeholder="search"
                  className="w-36 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.16em] kb-text-secondary outline-none placeholder:kb-text-muted focus:kb-border-accent"
                />
              </div>
              {deliverablesError ? (
                <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                  {deliverablesError}
                </div>
              ) : null}
              {cleanedDeliverableCount > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowCleanedDeliverables((current) => !current)}
                  className={`mt-3 rounded-xl border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
                >
                  {uxMessage(
                    showCleanedDeliverables ? 'chronos_dl_hide_cleaned' : 'chronos_dl_show_cleaned',
                    { count: cleanedDeliverableCount },
                    '{count} cleaned-up record(s)',
                    locale
                  )}
                </button>
              ) : null}
              <div className="mt-4 max-h-[540px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                {visibleDeliverables.length === 0 ? (
                  <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] kb-text-muted">
                    {deliverables.length === 0
                      ? 'No deliverables found yet.'
                      : uxText('chronos_dl_none_live', locale)}
                  </div>
                ) : (
                  visibleDeliverables.map((item) => (
                    <KbArtifactTile
                      key={item.artifactId}
                      type={item.kind}
                      path={item.path || item.externalRef || item.artifactId}
                      missionId={item.missionId}
                      updatedAt={item.updatedAt}
                      missing={item.missing}
                      previewContent={[
                        item.previewText || item.kind,
                        item.reviewVerdict ? `review: ${item.reviewVerdict}` : '',
                        item.reviewVersion ? `v${item.reviewVersion}` : '',
                        item.supersededCount
                          ? uxMessage(
                              'chronos_dl_superseded',
                              { count: item.supersededCount },
                              '+{count} older record(s) for the same file',
                              locale
                            )
                          : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      onSelect={() => {
                        setSelectedDeliverableId(item.artifactId);
                        setDeliverableReviewError(null);
                      }}
                      onOpen={() => openDeliverableAsset(item)}
                      onPreview={() => openDeliverableAsset(item)}
                    />
                  ))
                )}
              </div>
              {selectedDeliverableId ? (
                <div className="mt-4 rounded-2xl border kb-border-accent kb-surface-accent p-4">
                  {(() => {
                    const selected = deliverables.find(
                      (item) => item.artifactId === selectedDeliverableId
                    );
                    if (!selected) {
                      return (
                        <div className="text-[11px] kb-text-muted">
                          Selected deliverable not found.
                        </div>
                      );
                    }
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                              review
                            </div>
                            <div className="mt-1 text-sm font-semibold kb-text-primary">
                              {selected.artifactId}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            {selected.reviewVerdict
                              ? `latest ${selected.reviewVerdict}`
                              : 'not reviewed'}
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] leading-6 kb-text-secondary">
                          {selected.previewText || selected.kind}
                        </div>
                        <textarea
                          value={deliverableReviewComment}
                          onChange={(event) => setDeliverableReviewComment(event.target.value)}
                          placeholder="review comment"
                          className="mt-3 min-h-[88px] w-full rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[12px] leading-6 kb-text-primary placeholder:kb-text-muted outline-none ring-0 focus:kb-border-accent"
                        />
                        {deliverableReviewError ? (
                          <div className="mt-3 rounded-xl border kb-status-negative-border kb-status-negative-surface px-4 py-3 text-[11px] kb-status-negative">
                            {deliverableReviewError}
                          </div>
                        ) : null}
                        {deliverableAskWhyVerdict ? (
                          <div className="mt-3 rounded-xl border kb-status-warning-border kb-status-warning-surface px-4 py-3">
                            <div className="text-[11px] kb-status-warning">
                              どこが期待と違いましたか？（1問だけ・スキップ可）
                            </div>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(
                                [
                                  ['incorrect_content', '内容が誤り'],
                                  ['wrong_direction', '方向が違う'],
                                  ['quality', '品質不足'],
                                  ['scope', 'スコープ過不足'],
                                  ['other', 'その他'],
                                ] as const
                              ).map(([category, label]) => (
                                <button
                                  key={category}
                                  type="button"
                                  disabled={deliverableReviewBusy}
                                  onClick={() =>
                                    submitDeliverableReview(deliverableAskWhyVerdict, {
                                      reasonCategory: category,
                                    })
                                  }
                                  className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('alert')}`}
                                >
                                  {label}
                                </button>
                              ))}
                              <button
                                type="button"
                                disabled={deliverableReviewBusy}
                                onClick={() =>
                                  submitDeliverableReview(deliverableAskWhyVerdict, {
                                    skipAskWhy: true,
                                  })
                                }
                                className={`rounded-lg border px-3 py-1.5 text-[11px] transition disabled:opacity-50 ${toneChipClass('neutral')}`}
                              >
                                スキップ
                              </button>
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('accept')}
                            className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('approve')}`}
                          >
                            accept
                          </button>
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('request-changes')}
                            className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('info')}`}
                          >
                            request-changes
                          </button>
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('reject')}
                            className={`rounded-lg border px-3 py-2 text-[10px] uppercase tracking-[0.16em] transition disabled:opacity-50 ${toneChipClass('reject')}`}
                          >
                            reject
                          </button>
                        </div>
                        <div className="mt-3 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                          version {selected.reviewVersion || 1}
                          {selected.reviewCurrentArtifactId &&
                          selected.reviewCurrentArtifactId !== selected.artifactId
                            ? ` · current ${selected.reviewCurrentArtifactId}`
                            : ''}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          </section>

          <div className="grid flex-1 gap-6 min-h-0 xl:grid-cols-[280px,1fr]">
            <aside className="min-h-0 xl:max-h-[calc(100vh-8rem)] xl:overflow-y-auto xl:pr-2 chronos-scroll">
              <div className="flex flex-col gap-6">
                {/* The single primary entry point. Everything else in this
                    sidebar is a drawer below it. */}
                <section className="grid gap-3 xl:grid-cols-[1.35fr,0.85fr]">
                  <div className="kyberion-glass rounded-[24px] border kb-border-accent bg-[linear-gradient(180deg,rgba(247,240,223,0.055),rgba(255,255,255,0.02))] p-4">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-[0.28em] kb-text-accent">
                          {uxText('chronos_nav_start_here', locale)}
                        </div>
                        <div className="mt-1 text-sm kb-text-secondary">
                          {uxText('chronos_nav_start_here_hint', locale)}
                        </div>
                      </div>
                      <div className="text-[10px] uppercase tracking-[0.22em] kb-text-accent">
                        1-7
                      </div>
                    </div>
                    <div className="mt-4 grid gap-2">
                      {OPERATOR_SCENARIO_PRESETS.map((scenario, index) => {
                        const active =
                          (scenario.surface === 'mission-intelligence' &&
                            missionIntelligenceFocus === scenario.targetId) ||
                          (scenario.surface === 'focused-operator' &&
                            focusedOperatorView === scenario.targetId);
                        return (
                          <button
                            key={scenario.label}
                            type="button"
                            onClick={() => handleScenarioOpen(scenario.targetId, scenario.surface)}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${
                              active
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            {/* Stacked, not side-by-side: this list lives in a
                                280px column, where a right-aligned action label
                                collided with the scenario name. */}
                            <div className="flex items-center gap-2">
                              <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border kb-border-subtle kb-surface-sunken text-[9px] uppercase tracking-[0.16em] kb-text-secondary">
                                {index + 1}
                              </div>
                              <div className="text-[11px] font-semibold uppercase tracking-[0.14em] kb-text-secondary">
                                {scenario.label}
                              </div>
                            </div>
                            <div className="mt-1.5 text-[11px] leading-5 kb-text-secondary">
                              {scenario.detail}
                            </div>
                            <div className="mt-2 text-[10px] uppercase tracking-[0.16em] kb-text-accent">
                              {scenario.actionLabel} →
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-4 grid gap-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Scenarios · 1-7
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Thread · T / C
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Sessions · 1-9 / J K
                      </div>
                      <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2">
                        Traces · 1-9 / J K / R
                      </div>
                    </div>
                    {/* The five surface cards used to be their own full-size card
                        grid — a fourth navigation system saying "jump to
                        section". Same destinations, one line each, inside the
                        one place an operator is meant to start. */}
                    <div className="mt-4 border-t kb-border-subtle pt-3">
                      <div className={`text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}>
                        {uxText('chronos_jump_to_section', locale)}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {statusCards.map((card) => {
                          const Icon = card.icon;
                          return (
                            <button
                              key={card.label}
                              type="button"
                              onClick={() => handleSectionJump(card.targetId)}
                              title={card.detail}
                              className={`flex items-center gap-2 rounded-xl border px-3 py-1.5 text-[10px] uppercase tracking-[0.16em] transition ${toneChipClass('neutral')}`}
                            >
                              <Icon size={11} />
                              <span>{card.label}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {activeScenario ? (
                    <section className="kyberion-glass rounded-[24px] border kb-border-accent kb-surface-accent p-4">
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                        Current
                      </div>
                      <div className="mt-1 text-sm font-semibold kb-text-primary">
                        {activeScenario.label}
                      </div>
                      <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                          Next
                        </div>
                        <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
                          {activeScenario.nextStep}
                        </div>
                        <div className="mt-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted">
                          Hotkey{' '}
                          {OPERATOR_SCENARIO_PRESETS.findIndex(
                            (scenario) => scenario.label === activeScenario.label
                          ) + 1}
                        </div>
                      </div>
                      {activeScenario.surface === 'mission-intelligence' ? (
                        <button
                          type="button"
                          onClick={() => setMissionIntelligenceFocus(null)}
                          className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                        >
                          Clear
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4">
                  <button
                    onClick={() => toggleSection('views')}
                    aria-expanded={expandedSections.views}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_nav_focus_views', locale)}</span>
                    {expandedSections.views ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.views && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        {uxText('chronos_nav_focus_views_hint', locale)}
                      </div>
                      <div className="mt-4 grid gap-2">
                        <button
                          type="button"
                          onClick={() => setFocusedOperatorView(null)}
                          className={`rounded-2xl border px-3 py-3 text-left transition ${
                            focusedOperatorView === null
                              ? 'kb-border-accent kb-surface-accent'
                              : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            {uxText('chronos_nav_full_console', locale)}
                          </div>
                          <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                            {uxText('chronos_nav_full_console_hint', locale)}
                          </div>
                        </button>
                        {OPERATOR_VIEW_LINKS.map((view) => (
                          <button
                            key={view.targetId}
                            type="button"
                            onClick={() => handleOperatorViewOpen(view.targetId)}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${
                              focusedOperatorView === view.targetId
                                ? 'kb-border-accent kb-surface-accent'
                                : 'kb-border-subtle kb-surface-sunken hover:kb-border-subtle hover:kb-surface-raised'
                            }`}
                          >
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                              {view.label}
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {view.detail}
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* Diagnostics, not a starting point: 17 buttons competing with
                    the scenario list is what made the console read as a menu of
                    menus. Collapsed until something looks wrong. */}
                <section
                  id="operator-quick-actions"
                  className="kyberion-glass rounded-[28px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4 md:p-5"
                >
                  <button
                    type="button"
                    onClick={() => toggleSection('checks')}
                    aria-expanded={expandedSections.checks}
                    className={`flex w-full items-center justify-between gap-3 text-left transition ${shellTitleClass}`}
                  >
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] kb-text-muted">
                        {uxText('chronos_nav_checks', locale)}
                      </div>
                      <div className="mt-1 text-sm kb-text-secondary">
                        {uxText('chronos_nav_checks_hint', locale)}
                      </div>
                    </div>
                    {expandedSections.checks ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>

                  <div className={expandedSections.checks ? 'mt-4 space-y-5' : 'hidden'}>
                    {quickActionGroups.map((group) => {
                      const Icon = group.icon;
                      return (
                        <div
                          key={group.title}
                          className="overflow-hidden rounded-2xl border kb-border-subtle kb-surface-sunken"
                        >
                          <div className={`bg-gradient-to-r ${group.accent} px-3 py-3`}>
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border kb-border-subtle kb-surface-raised/6">
                                <Icon size={14} className={group.accentText} />
                              </div>
                              <div>
                                <div
                                  className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${group.accentText}`}
                                >
                                  {group.title}
                                </div>
                                <div className="mt-1 text-[11px] leading-5 kb-text-secondary">
                                  {group.hint}
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="grid gap-2 p-3">
                            {group.actions.map((action) => (
                              <button
                                key={action.label}
                                onClick={() => handleQuickAction(action.query)}
                                className="flex items-center justify-between rounded-xl border kb-border-subtle kb-surface-well px-3 py-2 text-left transition hover:kb-border-subtle hover:kb-surface-well"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="text-sm">{action.icon}</div>
                                  <div>
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] kb-text-primary">
                                      {action.label}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-[0.14em] kb-text-secondary">
                                      {action.tone}
                                    </div>
                                  </div>
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                                  Run
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('taxonomy')}
                    aria-expanded={expandedSections.taxonomy}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>Surface Taxonomy</span>
                    {expandedSections.taxonomy ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.taxonomy && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        Every surface connects people and agent execution in a different mode.
                        Chronos is the control surface, while A2UI provides drill-down work
                        surfaces.
                      </div>
                      <div className="mt-4 space-y-3">
                        {SURFACE_ROLES.map((role) => (
                          <div
                            key={role.label}
                            className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {role.label}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                                {role.value}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {role.detail}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('cycle')}
                    aria-expanded={expandedSections.cycle}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>Mission Cycle</span>
                    {expandedSections.cycle ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.cycle && (
                    <>
                      <div className="mt-2 text-sm kb-text-secondary">
                        Kyberion should always make this loop legible: a request becomes a mission,
                        execution stays explainable, and the result remains inspectable and
                        reusable.
                      </div>
                      <div className="mt-4 grid gap-2">
                        {MISSION_CYCLE.map((step, index) => (
                          <div
                            key={step.label}
                            className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full border kb-border-accent kb-surface-accent text-[10px] font-semibold kb-text-accent">
                                {index + 1}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {step.label}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                              {step.detail}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                {/* Relocated from the top of the page. It describes how the
                    surface is themed — reference material for whoever is
                    styling it, never the operator's first question. */}
                <section className="kyberion-glass rounded-[24px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('designSystem')}
                    aria-expanded={expandedSections.designSystem}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] kb-text-muted hover:kb-text-primary transition"
                  >
                    <span>{uxText('chronos_nav_design_system', locale)}</span>
                    {expandedSections.designSystem ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.designSystem && (
                    <>
                      <div
                        className={`mt-3 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.24em] ${shellMutedClass}`}
                      >
                        <span>{webTheme.name}</span>
                        <span aria-hidden="true">·</span>
                        <span>{webDesignSystem.design_system.pack_id}</span>
                        <span aria-hidden="true">·</span>
                        <span>{webTheme.colors.accent}</span>
                      </div>
                      <div className="mt-3 grid gap-2">
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Palette size={11} />
                            Theme
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webDesignSystem.theme.web.snapshot_summary}
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <LayoutGrid size={11} />
                            Layout
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webLayout.grid_columns}-column grid · container{' '}
                            {webLayout.container_max_width} · {webLayout.section_gap} section gap
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Type size={11} />
                            Typography
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webTheme.fonts.heading}
                          </div>
                        </div>
                        <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                          <div
                            className={`flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] ${shellMutedClass}`}
                          >
                            <Ruler size={11} />
                            Surface
                          </div>
                          <div className={`mt-1 text-[11px] leading-5 ${shellSubtleClass}`}>
                            {webLayout.panel_radius} / {webLayout.surface_radius}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {webDesignSystem.section_order.map((sectionId) => (
                          <span
                            key={sectionId}
                            className={`rounded-full border px-2.5 py-1 text-[9px] uppercase tracking-[0.16em] ${toneChipClass('neutral')}`}
                          >
                            {sectionId}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </aside>

            <section
              ref={mainSurfaceRef}
              className="kyberion-glass flex min-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[30px] border kb-border-subtle bg-[linear-gradient(180deg,rgba(247,240,223,0.035),rgba(255,255,255,0.02))] xl:max-h-[calc(100vh-11rem)]"
            >
              <div className="flex items-center justify-between border-b kb-border-subtle px-5 py-4 md:px-6">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.34em] kb-text-muted">
                    Active Surface
                  </div>
                  <div className="mt-1 text-lg font-semibold tracking-tight kb-text-primary">
                    {activeSurfaceTitle}
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-full border kb-border-subtle kb-surface-sunken px-3 py-1 text-[10px] uppercase tracking-[0.22em] kb-text-secondary">
                  <PanelsTopLeft size={12} />
                  <span>
                    {surface
                      ? 'a2ui drill-down'
                      : focusedOperatorView
                        ? 'focused operator view'
                        : missionIntelligenceFocus
                          ? 'focused mission console'
                          : 'default operator view'}
                  </span>
                </div>
              </div>

              <div className="chronos-scroll min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
                {!surface ? (
                  focusedOperatorView ? (
                    <FocusedOperatorView
                      viewId={
                        focusedOperatorView as
                          | 'needs-attention'
                          | 'mission-control-plane'
                          | 'runtime-topology-map'
                          | 'runtime-lease-doctor'
                          | 'recent-surface-outbox'
                          | 'secret-approval-queue'
                          | 'owner-summaries'
                          | 'trace-viewer'
                      }
                      onBack={() => {
                        setFocusedOperatorView(null);
                        setFocusedOperatorMissionId(null);
                      }}
                      onOpenView={(targetId, missionId) =>
                        handleOperatorViewOpen(targetId, missionId || null)
                      }
                      focusedMissionId={focusedOperatorMissionId}
                      onOpenMissionThread={(missionId) =>
                        handleOperatorViewOpen('mission-control-plane', missionId)
                      }
                    />
                  ) : (
                    <MissionIntelligence
                      focusedView={missionIntelligenceFocus}
                      onClearFocus={() => {
                        setMissionIntelligenceFocus(null);
                        setMissionIntelligenceFocusedMissionId(null);
                      }}
                      focusedMissionId={missionIntelligenceFocusedMissionId}
                    />
                  )
                ) : showOpsBoards ? (
                  <AgentOpsBoards
                    onOpenMission={(missionId) =>
                      handleOperatorViewOpen('mission-control-plane', missionId)
                    }
                    onOpenView={(viewId) => handleOperatorViewOpen(viewId)}
                  />
                ) : (
                  <div className="flex flex-col gap-6">
                    {a2uiActionNotice ? (
                      <div className="rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[11px] kb-text-accent">
                        {a2uiActionNotice}
                      </div>
                    ) : null}
                    {surface.components?.map((component: any, index: number) => (
                      <A2UIRenderer
                        key={component.id || index}
                        type={component.type}
                        props={component.props || {}}
                        onAction={handleA2UIComponentAction}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>

          <SovereignChat onA2UIMessage={handleA2UIMessage} onReady={handleReady} />
          <AgentPanel isOpen={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />
        </div>
      </main>
    </Suspense>
  );
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
        return (await response.json()) as {
          source?: string;
          brand_name?: string | null;
          css_vars?: Record<string, string>;
        };
      })
      .then((payload) => {
        if (!payload) return;
        onResolveRef.current(payload.css_vars || {}, payload.brand_name || payload.source || null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [searchParams]);

  return null;
}
