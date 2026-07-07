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
import { uxText } from '../lib/ux-vocabulary';
import { useChronosLocale } from '../lib/hooks';

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

type ChronosThemeMode = 'system' | 'light' | 'dark';

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

function resolveChronosThemeMode(
  mode: ChronosThemeMode,
  systemPrefersDark: boolean
): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  return systemPrefersDark ? 'dark' : 'light';
}

const QUICK_ACTION_GROUPS: QuickActionGroup[] = [
  {
    title: 'Prepare',
    hint: 'Check the local toolchain and readiness manifests before you start the operator flow.',
    icon: ClipboardCheck,
    accent: 'from-emerald-400/16 via-emerald-300/8 to-transparent',
    accentText: 'text-emerald-200/85',
    actions: [
      {
        label: 'Prereq Check',
        query: 'chronos://quick-action/prereq-check',
        icon: '🧰',
        tone: 'verify',
      },
      {
        label: 'Setup Report',
        query: 'chronos://quick-action/setup-report',
        icon: '📑',
        tone: 'verify',
      },
      { label: 'Doctor', query: 'chronos://quick-action/doctor', icon: '🩺', tone: 'verify' },
      {
        label: 'Surface Setup',
        query: 'chronos://quick-action/surfaces-setup',
        icon: '🛰',
        tone: 'verify',
      },
    ],
  },
  {
    title: 'Schedule',
    hint: 'Run scheduled generation jobs or inspect the current schedule registry.',
    icon: CalendarClock,
    accent: 'from-violet-400/16 via-violet-300/8 to-transparent',
    accentText: 'text-violet-200/85',
    actions: [
      {
        label: 'Schedule Tick',
        query: 'chronos://quick-action/schedule-tick',
        icon: '⏱',
        tone: 'operate',
      },
      {
        label: 'Schedule List',
        query: 'chronos://quick-action/schedule-list',
        icon: '🗂',
        tone: 'observe',
      },
    ],
  },
  {
    title: 'Observe',
    hint: 'Open governed readouts before you intervene.',
    icon: Radar,
    accent: 'from-cyan-400/16 via-cyan-300/8 to-transparent',
    accentText: 'text-cyan-200/85',
    actions: [
      {
        label: 'Dashboard',
        query: 'chronos://quick-action/dashboard',
        icon: '📊',
        tone: 'observe',
      },
      { label: 'Missions', query: 'chronos://quick-action/missions', icon: '🎯', tone: 'observe' },
      { label: 'Agents', query: 'chronos://quick-action/agents', icon: '🤖', tone: 'observe' },
      {
        label: 'Audit Log',
        query: 'chronos://quick-action/audit-log',
        icon: '📋',
        tone: 'observe',
      },
      {
        label: 'Traces',
        query: 'chronos://operator-view/trace-viewer',
        icon: '🔭',
        tone: 'observe',
      },
    ],
  },
  {
    title: 'Verify',
    hint: 'Run deterministic checks when the control plane needs proof.',
    icon: ActivitySquare,
    accent: 'from-amber-300/18 via-amber-200/8 to-transparent',
    accentText: 'text-amber-200/85',
    actions: [
      {
        label: 'Vital Check',
        query: 'chronos://quick-action/vital-check',
        icon: '💓',
        tone: 'verify',
      },
      {
        label: 'Diagnostics',
        query: 'chronos://quick-action/diagnostics',
        icon: '🔍',
        tone: 'verify',
      },
      {
        label: 'Capability Audit',
        query: 'chronos://quick-action/capability-audit',
        icon: '🧩',
        tone: 'verify',
      },
      {
        label: 'Provider Check',
        query: 'chronos://quick-action/provider-check',
        icon: '🔌',
        tone: 'verify',
      },
    ],
  },
  {
    title: 'Operate',
    hint: 'Escalate only when mission flow, runtime health, or delivery is blocked.',
    icon: Wrench,
    accent: 'from-rose-400/16 via-orange-300/8 to-transparent',
    accentText: 'text-orange-200/85',
    actions: [
      {
        label: 'Build & Test',
        query: 'chronos://quick-action/build-test',
        icon: '🔨',
        tone: 'operate',
      },
      { label: 'Policies', query: 'chronos://quick-action/policies', icon: '🛡', tone: 'operate' },
      {
        label: 'Upgrade Check',
        query:
          'node dist/scripts/run_pipeline.js --input pipelines/system-upgrade-check.json を実行して、アップデートの有無を表示して',
        icon: '⬆',
        tone: 'operate',
      },
      {
        label: 'Knowledge',
        query: 'chronos://quick-action/knowledge',
        icon: '🧠',
        tone: 'operate',
      },
    ],
  },
];

const STATUS_CARDS: StatusCard[] = [
  {
    label: 'Needs Attention',
    value: 'Exceptions',
    detail: 'Start with mission blockers, runtime incidents, and delivery exceptions.',
    icon: Shield,
    accent: 'border-amber-200/16 bg-amber-300/8 text-amber-100',
    targetId: 'mission-control-plane',
  },
  {
    label: 'Toolchain',
    value: 'Preflight',
    detail: 'Confirm local prerequisites and setup reports before you work from source.',
    icon: ClipboardCheck,
    accent: 'border-emerald-200/16 bg-emerald-300/8 text-emerald-100',
    targetId: 'operator-quick-actions',
  },
  {
    label: 'Schedules',
    value: 'Registry',
    detail: 'Inspect and tick scheduled generation jobs from the operator console.',
    icon: CalendarClock,
    accent: 'border-violet-200/16 bg-violet-300/8 text-violet-100',
    targetId: 'operator-quick-actions',
  },
  {
    label: 'Runtime Governance',
    value: 'Supervisor',
    detail: 'Managed runtimes, lease ownership, and remediation live here.',
    icon: Bot,
    accent: 'border-cyan-200/16 bg-cyan-300/8 text-cyan-100',
    targetId: 'runtime-lease-doctor',
  },
  {
    label: 'Delivery',
    value: 'Outbox',
    detail: 'Slack and Chronos share one operator-visible delivery queue.',
    icon: Radar,
    accent: 'border-rose-200/16 bg-rose-300/8 text-rose-100',
    targetId: 'recent-surface-outbox',
  },
];

export default function ChronosMirrorV2() {
  const locale = useChronosLocale();
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
  const [operatorHomeSummary, setOperatorHomeSummary] = useState<any | null>(null);
  const [operatorHomeError, setOperatorHomeError] = useState<string | null>(null);
  const [operatorHomeRefreshTick, setOperatorHomeRefreshTick] = useState(0);
  const [missionHistory, setMissionHistory] = useState<any[]>([]);
  const [missionHistoryError, setMissionHistoryError] = useState<string | null>(null);
  const [missionHistoryQuery, setMissionHistoryQuery] = useState('');
  const [missionHistoryStatus, setMissionHistoryStatus] = useState('completed');
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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    taxonomy: false,
    cycle: false,
    views: true,
  });
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
    async (verdict: 'accept' | 'reject' | 'request-changes') => {
      const item = deliverables.find((entry) => entry.artifactId === selectedDeliverableId);
      if (!item) {
        setDeliverableReviewError('成果物を選択してください');
        return;
      }
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
    async (item: any, decision: 'approved' | 'rejected') => {
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
    () => surface?.title || uxText('chronos_mission_intelligence', 'Mission Intelligence', locale),
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

  const webTheme = webDesignSystem.theme.theme;
  const webLayout = webDesignSystem.layout;

  return (
    <Suspense fallback={null}>
      <TenantDesignBridge
        onResolve={(cssVars, label) => {
          setTenantCssVars(cssVars);
          setTenantLabel(label);
        }}
      />
      <main
        className="min-h-screen w-screen overflow-hidden bg-[var(--kb-bg-main)] text-white"
        data-theme={themeMode}
        style={{ ...(webDesignSystem.css_vars as CSSProperties), ...tenantCssVars }}
      >
        <div className="absolute inset-0 pointer-events-none opacity-60">
          <div className="absolute left-[-8%] top-[-6%] h-[32rem] w-[32rem] rounded-full bg-cyan-500/10 blur-[160px]" />
          <div className="absolute top-[18%] right-[12%] h-[20rem] w-[20rem] rounded-full bg-cyan-400/5 blur-[150px]" />
          <div className="absolute bottom-[-12%] left-[32%] h-[26rem] w-[26rem] rounded-full bg-slate-500/5 blur-[160px]" />
        </div>
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_right,rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.025)_1px,transparent_1px)] bg-[size:88px_88px] opacity-[0.06]" />
        <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(180deg,rgba(255,248,225,0.05)_0%,transparent_18%,transparent_82%,rgba(148,163,184,0.04)_100%)]" />

        <div className="relative z-10 flex min-h-screen flex-col gap-6 p-4 md:p-6 xl:h-screen xl:overflow-hidden">
          <header className="px-1 py-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/10">
                  <Shield className="h-5 w-5 text-cyan-400" />
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-[0.3em] text-white/40 font-bold">
                    Chronos Mirror
                  </div>
                  <h1 className="text-lg font-bold tracking-tight text-white/90">Control Plane</h1>
                </div>
                <div
                  className="ml-2 rounded-full border border-cyan-400/20 bg-cyan-400/5 px-3 py-1 text-[11px] text-cyan-100/70"
                  title="このサーフェスの役割"
                >
                  管制塔 — 実行状態の監視と介入
                </div>
                <button
                  type="button"
                  onClick={() => setShowOpsBoards((current) => !current)}
                  className={`ml-2 rounded-full border px-3 py-1 text-[11px] transition ${showOpsBoards ? 'border-cyan-400/60 bg-cyan-400/20 text-cyan-100' : 'border-white/15 bg-white/5 text-white/60 hover:bg-white/10'}`}
                >
                  エージェント/看板
                </button>
              </div>
              {tenantLabel ? (
                <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.22em] text-cyan-100/80">
                  {tenantLabel}
                </div>
              ) : null}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setThemeModePreference((current) =>
                      current === 'system' ? 'light' : current === 'light' ? 'dark' : 'system'
                    )
                  }
                  aria-label={`Chronos theme: ${themeModePreference}`}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/70 transition hover:bg-white/10 hover:text-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                >
                  <Palette size={12} />
                  <span>{themeModePreference}</span>
                </button>
                <IdentityBadge />
                <button
                  type="button"
                  onClick={() => setAgentPanelOpen(true)}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-white/70 transition hover:bg-white/10 hover:text-cyan-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/70"
                >
                  <Cpu size={12} />
                  <span>{uxText('chronos_agent_runtimes', 'Agent Runtimes', locale)}</span>
                </button>
              </div>
            </div>
          </header>

          <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr),minmax(0,0.85fr)]">
            <div className="kyberion-glass rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.28em] text-white/42">
                <span>{webTheme.name}</span>
                <span className="text-white/20">·</span>
                <span>{webDesignSystem.design_system.pack_id}</span>
                <span className="text-white/20">·</span>
                <span>{webTheme.colors.accent}</span>
              </div>
              <div className="mt-4 max-w-3xl">
                <h2 className="text-2xl font-semibold tracking-tight text-white/92 md:text-[2rem]">
                  Web site も PowerPoint と同じように、Theme と Structure を分けて組み立てる。
                </h2>
                <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-200/68">
                  この surface は `web-theme-pack` で色とタイポグラフィを、`web-design-system-pack`
                  でレイアウトとセクション順を管理します。見た目の微調整ではなく、再利用可能な構造を先に固定します。
                </p>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                {webDesignSystem.section_order.map((sectionId) => (
                  <span
                    key={sectionId}
                    className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-white/68"
                  >
                    {sectionId}
                  </span>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="kyberion-glass rounded-[24px] border border-cyan-300/15 bg-cyan-400/[0.06] p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-cyan-100/60">
                  <Palette size={12} />
                  Theme
                </div>
                <div className="mt-2 text-sm font-semibold text-white/90">{webTheme.name}</div>
                <div className="mt-2 text-[11px] leading-6 text-cyan-50/72">
                  {webDesignSystem.theme.web.snapshot_summary}
                </div>
              </div>
              <div className="kyberion-glass rounded-[24px] border border-white/10 bg-black/18 p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-white/48">
                  <LayoutGrid size={12} />
                  Layout
                </div>
                <div className="mt-2 text-sm font-semibold text-white/90">
                  {webLayout.grid_columns}-column grid
                </div>
                <div className="mt-2 text-[11px] leading-6 text-slate-200/60">
                  Container {webLayout.container_max_width}
                </div>
              </div>
              <div className="kyberion-glass rounded-[24px] border border-white/10 bg-black/18 p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-white/48">
                  <Type size={12} />
                  Typography
                </div>
                <div className="mt-2 text-sm font-semibold text-white/90">
                  {webTheme.fonts.heading}
                </div>
                <div className="mt-2 text-[11px] leading-6 text-slate-200/60">
                  Body {webTheme.fonts.body}
                </div>
              </div>
              <div className="kyberion-glass rounded-[24px] border border-white/10 bg-black/18 p-4">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-white/48">
                  <Ruler size={12} />
                  Surface
                </div>
                <div className="mt-2 text-sm font-semibold text-white/90">
                  {webLayout.panel_radius} / {webLayout.surface_radius}
                </div>
                <div className="mt-2 text-[11px] leading-6 text-slate-200/60">
                  {webLayout.section_gap} section gap
                </div>
              </div>
            </div>
          </section>

          <FirstRunBanner />

          <section className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/55">
                  Operator Home
                </div>
                <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                  One place to see what needs attention
                </h2>
              </div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                {operatorHomeSummary?.statusLabel || 'loading'}
              </div>
            </div>
            {operatorHomeError ? (
              <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                {operatorHomeError}
              </div>
            ) : null}
            {operatorHomeSummary ? (
              <>
                <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      Status
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {operatorHomeSummary.statusLabel}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {operatorHomeSummary.statusDetail}
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      Approvals
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {operatorHomeSummary.counts.pendingApprovals}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">pending review</div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      Inbox
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {operatorHomeSummary.counts.unreadInbox}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {operatorHomeSummary.counts.totalInbox} total entries
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      Active
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {operatorHomeSummary.counts.activeMissions}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {operatorHomeSummary.counts.blockedMissions} blocked
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      Next
                    </div>
                    <div className="mt-2 text-sm font-semibold text-white/92">
                      {operatorHomeSummary.nextAction.title}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {operatorHomeSummary.nextAction.reason}
                    </div>
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-[0.16em] text-white/46">
                  {operatorHomeSummary.activeMissions.slice(0, 4).map((mission: any) => (
                    <button
                      key={mission.missionId}
                      type="button"
                      onClick={() => setSelectedMissionId(mission.missionId)}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-white/72 transition hover:bg-white/10"
                    >
                      {mission.missionId}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="mt-4 text-[11px] text-white/50">Loading operator home summary…</div>
            )}
          </section>

          <section className="grid gap-4 xl:grid-cols-[1.05fr,0.95fr]">
            <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/55">
                    SU history
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                    Mission history
                  </h2>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={missionHistoryQuery}
                    onChange={(event) => setMissionHistoryQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none placeholder:text-white/28 focus:border-cyan-300/25"
                  />
                  <select
                    value={missionHistoryStatus}
                    onChange={(event) => setMissionHistoryStatus(event.target.value)}
                    className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none focus:border-cyan-300/25"
                  >
                    <option value="">all</option>
                    <option value="completed">completed</option>
                    <option value="active">active</option>
                    <option value="paused">paused</option>
                    <option value="failed">failed</option>
                  </select>
                  <select
                    value={missionHistoryTier}
                    onChange={(event) => setMissionHistoryTier(event.target.value)}
                    className="rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none focus:border-cyan-300/25"
                  >
                    <option value="">all tiers</option>
                    <option value="public">public</option>
                    <option value="confidential">confidential</option>
                    <option value="personal">personal</option>
                  </select>
                </div>
              </div>
              {missionHistoryError ? (
                <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                  {missionHistoryError}
                </div>
              ) : null}
              <div className="mt-4 max-h-[420px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                {missionHistory.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4 text-[11px] text-white/45">
                    No missions match the current filter.
                  </div>
                ) : (
                  missionHistory.map((mission) => (
                    <button
                      key={mission.missionId}
                      type="button"
                      onClick={() => setSelectedMissionId(mission.missionId)}
                      className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                        selectedMissionId === mission.missionId
                          ? 'border-cyan-400/25 bg-cyan-400/10'
                          : 'border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/48">
                            {mission.missionId}
                          </div>
                          <div className="mt-1 text-sm font-semibold text-white/90">
                            {mission.goalSummary ||
                              mission.intentText ||
                              mission.missionType ||
                              'Mission'}
                          </div>
                        </div>
                        <div className="text-right text-[10px] uppercase tracking-[0.18em] text-cyan-100/68">
                          {mission.status}
                        </div>
                      </div>
                      <div className="mt-2 grid gap-2 text-[10px] text-white/52 sm:grid-cols-2">
                        <div>tier {mission.tier}</div>
                        <div>artifacts {mission.artifactCount}</div>
                        <div>updated {mission.updatedAt || mission.startedAt || '-'}</div>
                        <div className="truncate">
                          tenant {mission.tenantSlug || mission.tenantId || '-'}
                        </div>
                      </div>
                      {mission.successCondition ? (
                        <div className="mt-2 text-[11px] leading-6 text-slate-200/60">
                          {mission.successCondition}
                        </div>
                      ) : null}
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="grid gap-4">
              <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">
                      SU cost
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                      Cost visibility
                    </h2>
                  </div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                    {selectedMissionId ? selectedMissionId : 'today'}
                  </div>
                </div>
                {costSummaryError ? (
                  <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                    {costSummaryError}
                  </div>
                ) : null}
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">usd</div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {typeof costSummary?.totalUsd === 'number'
                        ? `$${costSummary.totalUsd.toFixed(3)}`
                        : '-'}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {costSummary?.entryCount || 0} entries
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      tokens
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {typeof costSummary?.totalTokens === 'number'
                        ? costSummary.totalTokens.toLocaleString()
                        : '-'}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
                      {costSummary?.missionCount || 0} missions
                    </div>
                  </div>
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      budget
                    </div>
                    <div className="mt-2 text-2xl font-semibold text-white/92">
                      {typeof costSummary?.budgetUsd === 'number'
                        ? `$${costSummary.budgetUsd.toFixed(3)}`
                        : 'n/a'}
                    </div>
                    <div className="mt-1 text-[10px] text-white/48">
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
                        className="rounded-xl border border-white/8 bg-black/18 px-3 py-2 text-[10px] text-white/58"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedMissionId(
                                item.missionId === 'UNASSIGNED' ? null : item.missionId
                              )
                            }
                            className="font-mono text-[10px] uppercase tracking-[0.16em] text-cyan-100/70"
                          >
                            {item.missionId}
                          </button>
                          <div className="text-white/80">${item.usd.toFixed(3)}</div>
                        </div>
                        <div className="mt-1 text-white/42">
                          {item.tokens.toLocaleString()} tokens · {item.entryCount} entries
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">
                      SU approvals
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                      Approval queue
                    </h2>
                  </div>
                  <input
                    value={approvalQueueQuery}
                    onChange={(event) => setApprovalQueueQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none placeholder:text-white/28 focus:border-cyan-300/25"
                  />
                </div>
                {approvalQueueError ? (
                  <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                    {approvalQueueError}
                  </div>
                ) : null}
                <div className="mt-4 max-h-[310px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                  {approvalQueue.length === 0 ? (
                    <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4 text-[11px] text-white/45">
                      No pending approvals.
                    </div>
                  ) : (
                    approvalQueue.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-2xl border border-white/8 bg-black/20 px-4 py-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/48">
                              {item.kind} · {item.channel}
                            </div>
                            <div className="mt-1 text-sm font-semibold text-white/90">
                              {item.title}
                            </div>
                          </div>
                          <div className="text-right text-[10px] uppercase tracking-[0.18em] text-cyan-100/68">
                            {item.status}
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] leading-6 text-slate-200/58">
                          {item.summary}
                        </div>
                        <div className="mt-2 grid gap-2 text-[10px] text-white/48 sm:grid-cols-2">
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
                            className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-emerald-100/80 transition hover:bg-emerald-400/16 disabled:opacity-50"
                          >
                            approve
                          </button>
                          <button
                            type="button"
                            disabled={approvalDecisionBusyId === item.id}
                            onClick={() => submitApprovalDecision(item, 'rejected')}
                            className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-rose-100/80 transition hover:bg-rose-400/16 disabled:opacity-50"
                          >
                            reject
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">
                      SU connections
                    </div>
                    <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                      Connection review
                    </h2>
                  </div>
                  <input
                    value={connectionsQuery}
                    onChange={(event) => setConnectionsQuery(event.target.value)}
                    placeholder="search"
                    className="w-36 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none placeholder:text-white/28 focus:border-cyan-300/25"
                  />
                </div>
                {connectionsError ? (
                  <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
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
                            ? 'border-cyan-400/25 bg-cyan-400/10'
                            : 'border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/48">
                              {item.service_type || 'service'} · {item.binding_id}
                            </div>
                            <div className="mt-1 text-sm font-semibold text-white/90">
                              {item.service_id || item.target}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/68">
                            {item.reviewAction || 'pending'}
                          </div>
                        </div>
                        <div className="mt-2 grid gap-2 text-[10px] text-white/52 sm:grid-cols-2">
                          <div>scope {item.scope}</div>
                          <div>target {item.target}</div>
                          <div>policy {Object.keys(item.approval_policy || {}).length}</div>
                          <div>reviewed {item.reviewedAt || '-'}</div>
                        </div>
                      </button>
                    ))}
                </div>
                {selectedConnectionId ? (
                  <div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.05] p-4">
                    {(() => {
                      const selected = connections.find(
                        (item) => item.binding_id === selectedConnectionId
                      );
                      if (!selected)
                        return (
                          <div className="text-[11px] text-white/50">
                            Selected connection not found.
                          </div>
                        );
                      return (
                        <>
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-100/60">
                                review
                              </div>
                              <div className="mt-1 text-sm font-semibold text-white/90">
                                {selected.service_id || selected.binding_id}
                              </div>
                            </div>
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                              {selected.reviewAction || 'pending'}
                            </div>
                          </div>
                          <textarea
                            value={connectionReviewNote}
                            onChange={(event) => setConnectionReviewNote(event.target.value)}
                            placeholder="review note"
                            className="mt-3 min-h-[80px] w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-[12px] leading-6 text-white/82 placeholder:text-white/28 outline-none ring-0 focus:border-cyan-300/25"
                          />
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'approve')}
                              className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-emerald-100/80 transition hover:bg-emerald-400/16 disabled:opacity-50"
                            >
                              approve
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'modify')}
                              className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/16 disabled:opacity-50"
                            >
                              modify
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'hold')}
                              className="rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-amber-100/80 transition hover:bg-amber-400/16 disabled:opacity-50"
                            >
                              hold
                            </button>
                            <button
                              type="button"
                              disabled={connectionReviewBusyId === selected.binding_id}
                              onClick={() => submitConnectionReview(selected.binding_id, 'delete')}
                              className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-rose-100/80 transition hover:bg-rose-400/16 disabled:opacity-50"
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
            <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/55">
                    SU workbench
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                    Plan preview and approval
                  </h2>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={runPlanPreview}
                    disabled={planPreviewBusy}
                    className="rounded-lg border border-cyan-300/18 bg-cyan-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-cyan-100/82 transition hover:bg-cyan-400/16 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {planPreviewBusy ? 'previewing' : 'preview'}
                  </button>
                  <button
                    type="button"
                    onClick={approvePlanAndStart}
                    disabled={planApprovalBusy || !planPreview || planPreviewIsStale}
                    className="rounded-lg border border-emerald-300/18 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-emerald-100/82 transition hover:bg-emerald-400/16 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {planApprovalBusy ? 'starting' : 'approve & start'}
                  </button>
                </div>
              </div>
              {planPreview && planPreviewIsStale ? (
                <div className="mt-3 rounded-xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-[11px] text-amber-100/80">
                  Preview is stale. Re-run preview before approving.
                </div>
              ) : null}
              <textarea
                value={planRequestText}
                onChange={(event) => setPlanRequestText(event.target.value)}
                placeholder="例: 来週までに顧客向け提案資料を作って、承認前にレビューしたい"
                className="mt-4 min-h-[120px] w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-[12px] leading-6 text-white/82 placeholder:text-white/28 outline-none ring-0 focus:border-cyan-300/25"
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <label className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-[10px] uppercase tracking-[0.16em] text-white/52">
                  mission type
                  <input
                    value={planMissionType}
                    onChange={(event) => setPlanMissionType(event.target.value)}
                    className="mt-2 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[11px] tracking-normal text-white/82 outline-none focus:border-cyan-300/25"
                  />
                </label>
                <label className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-[10px] uppercase tracking-[0.16em] text-white/52">
                  persona
                  <input
                    value={planPersona}
                    onChange={(event) => setPlanPersona(event.target.value)}
                    className="mt-2 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[11px] tracking-normal text-white/82 outline-none focus:border-cyan-300/25"
                  />
                </label>
                <label className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3 text-[10px] uppercase tracking-[0.16em] text-white/52">
                  tier
                  <select
                    value={planTier}
                    onChange={(event) =>
                      setPlanTier(event.target.value as 'personal' | 'confidential' | 'public')
                    }
                    className="mt-2 w-full rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[11px] tracking-normal text-white/82 outline-none focus:border-cyan-300/25"
                  >
                    <option value="personal">personal</option>
                    <option value="confidential">confidential</option>
                    <option value="public">public</option>
                  </select>
                </label>
              </div>
              {planPreviewError ? (
                <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                  {planPreviewError}
                </div>
              ) : null}
              {planApprovalMessage ? (
                <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-[11px] text-emerald-100/80">
                  {planApprovalMessage}
                </div>
              ) : null}
              {planPreview ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-[1fr,0.85fr]">
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      goal
                    </div>
                    <div className="mt-2 text-sm font-semibold text-white/90">
                      {planPreview.goal?.summary}
                    </div>
                    <div className="mt-2 text-[11px] leading-6 text-white/58">
                      {planPreview.goal?.successCondition}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-3 text-[10px] text-white/52">
                      <div>
                        delivery mode{' '}
                        <span className="font-mono text-white/80">
                          {planPreview.delivery?.mode}
                        </span>
                      </div>
                      <div>
                        clarification{' '}
                        <span className="font-mono text-white/80">
                          {planPreview.delivery?.clarificationNeeded ? 'needed' : 'clear'}
                        </span>
                      </div>
                      <div>
                        execution{' '}
                        <span className="font-mono text-white/80">
                          {planPreview.execution?.shape}
                        </span>
                      </div>
                      <div>
                        confidence{' '}
                        <span className="font-mono text-white/80">
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
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/42">
                      team + workflow
                    </div>
                    <div className="mt-2 text-[11px] text-white/55">
                      {planPreview.team?.assignments?.length || 0} assignments ·{' '}
                      {planPreview.team?.team_governance?.composition?.required_roles?.length || 0}{' '}
                      required roles
                    </div>
                    <div className="mt-3 space-y-2">
                      {(planPreview.team?.assignments || []).slice(0, 5).map((assignment: any) => (
                        <div
                          key={`${assignment.team_role}-${assignment.agent_id || 'unfilled'}`}
                          className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-white/44">
                              {assignment.team_role}
                            </div>
                            <div className="text-[9px] uppercase tracking-[0.16em] text-white/34">
                              {assignment.status}
                            </div>
                          </div>
                          <div className="mt-1 font-mono text-[10px] text-white/78">
                            {assignment.agent_id || 'unfilled'}
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mt-4 text-[10px] uppercase tracking-[0.16em] text-white/40">
                      workflow steps
                    </div>
                    <div className="mt-2 space-y-2">
                      {(planPreview.workflow || []).slice(0, 5).map((step: any) => (
                        <div
                          key={step.id}
                          className="rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2"
                        >
                          <div className="text-[10px] text-white/82">{step.label}</div>
                          <div className="mt-1 text-[9px] leading-5 text-white/48">
                            {step.description}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <div className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.28em] text-white/42">
                    SU inbox
                  </div>
                  <h2 className="mt-1 text-lg font-semibold tracking-tight text-white/90">
                    Deliverables
                  </h2>
                </div>
                <input
                  value={deliverablesQuery}
                  onChange={(event) => setDeliverablesQuery(event.target.value)}
                  placeholder="search"
                  className="w-36 rounded-lg border border-white/10 bg-black/25 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-white/72 outline-none placeholder:text-white/28 focus:border-cyan-300/25"
                />
              </div>
              {deliverablesError ? (
                <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                  {deliverablesError}
                </div>
              ) : null}
              <div className="mt-4 max-h-[540px] overflow-y-auto pr-1 chronos-scroll space-y-3">
                {deliverables.length === 0 ? (
                  <div className="rounded-2xl border border-white/8 bg-black/20 px-4 py-4 text-[11px] text-white/45">
                    No deliverables found yet.
                  </div>
                ) : (
                  deliverables.map((item) => (
                    <KbArtifactTile
                      key={item.artifactId}
                      type={item.kind}
                      path={item.path || item.externalRef || item.artifactId}
                      previewContent={[
                        item.previewText || item.kind,
                        item.reviewVerdict ? `review: ${item.reviewVerdict}` : '',
                        item.reviewVersion ? `v${item.reviewVersion}` : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      onSelect={() => {
                        setSelectedDeliverableId(item.artifactId);
                        setDeliverableReviewError(null);
                      }}
                      onOpen={() => {
                        if (item.missionId && item.path) {
                          window.open(
                            `/api/mission-asset?missionId=${encodeURIComponent(item.missionId)}&path=${encodeURIComponent(item.path)}`,
                            '_blank',
                            'noreferrer'
                          );
                        }
                      }}
                      onPreview={() => {
                        if (item.missionId && item.path) {
                          window.open(
                            `/api/mission-asset?missionId=${encodeURIComponent(item.missionId)}&path=${encodeURIComponent(item.path)}`,
                            '_blank',
                            'noreferrer'
                          );
                        }
                      }}
                    />
                  ))
                )}
              </div>
              {selectedDeliverableId ? (
                <div className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-400/[0.05] p-4">
                  {(() => {
                    const selected = deliverables.find(
                      (item) => item.artifactId === selectedDeliverableId
                    );
                    if (!selected) {
                      return (
                        <div className="text-[11px] text-white/50">
                          Selected deliverable not found.
                        </div>
                      );
                    }
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-100/60">
                              review
                            </div>
                            <div className="mt-1 text-sm font-semibold text-white/90">
                              {selected.artifactId}
                            </div>
                          </div>
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                            {selected.reviewVerdict
                              ? `latest ${selected.reviewVerdict}`
                              : 'not reviewed'}
                          </div>
                        </div>
                        <div className="mt-2 text-[11px] leading-6 text-slate-200/62">
                          {selected.previewText || selected.kind}
                        </div>
                        <textarea
                          value={deliverableReviewComment}
                          onChange={(event) => setDeliverableReviewComment(event.target.value)}
                          placeholder="review comment"
                          className="mt-3 min-h-[88px] w-full rounded-2xl border border-white/10 bg-black/25 px-4 py-3 text-[12px] leading-6 text-white/82 placeholder:text-white/28 outline-none ring-0 focus:border-cyan-300/25"
                        />
                        {deliverableReviewError ? (
                          <div className="mt-3 rounded-xl border border-red-400/20 bg-red-500/10 px-4 py-3 text-[11px] text-red-100/80">
                            {deliverableReviewError}
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('accept')}
                            className="rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-emerald-100/80 transition hover:bg-emerald-400/16 disabled:opacity-50"
                          >
                            accept
                          </button>
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('request-changes')}
                            className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/16 disabled:opacity-50"
                          >
                            request-changes
                          </button>
                          <button
                            type="button"
                            disabled={deliverableReviewBusy}
                            onClick={() => submitDeliverableReview('reject')}
                            className="rounded-lg border border-rose-400/20 bg-rose-400/10 px-3 py-2 text-[10px] uppercase tracking-[0.16em] text-rose-100/80 transition hover:bg-rose-400/16 disabled:opacity-50"
                          >
                            reject
                          </button>
                        </div>
                        <div className="mt-3 text-[10px] uppercase tracking-[0.16em] text-white/40">
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
                <section
                  id="operator-quick-actions"
                  className="kyberion-glass rounded-[28px] border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.02))] p-4 md:p-5"
                >
                  <div className="mb-4 flex items-center justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-[0.28em] text-white/45">
                        {uxText('chronos_quick_actions', 'Quick Actions', locale)}
                      </div>
                      <div className="mt-1 text-sm text-slate-200/65">
                        {uxText(
                          'chronos_grouped_by_operator_intent',
                          'These drive the active A2UI surface on the right.',
                          locale
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-5">
                    {QUICK_ACTION_GROUPS.map((group) => {
                      const Icon = group.icon;
                      return (
                        <div
                          key={group.title}
                          className="overflow-hidden rounded-2xl border border-white/8 bg-black/20"
                        >
                          <div className={`bg-gradient-to-r ${group.accent} px-3 py-3`}>
                            <div className="flex items-start gap-3">
                              <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/6">
                                <Icon size={14} className={group.accentText} />
                              </div>
                              <div>
                                <div
                                  className={`text-[11px] font-semibold uppercase tracking-[0.2em] ${group.accentText}`}
                                >
                                  {group.title}
                                </div>
                                <div className="mt-1 text-[11px] leading-5 text-slate-200/58">
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
                                className="flex items-center justify-between rounded-xl border border-white/8 bg-slate-950/55 px-3 py-2 text-left transition hover:border-white/18 hover:bg-slate-900/80"
                              >
                                <div className="flex items-center gap-3">
                                  <div className="text-sm">{action.icon}</div>
                                  <div>
                                    <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-white/88">
                                      {action.label}
                                    </div>
                                    <div className="text-[10px] uppercase tracking-[0.14em] text-slate-400/70">
                                      {action.tone}
                                    </div>
                                  </div>
                                </div>
                                <div className="text-[10px] uppercase tracking-[0.2em] text-white/38">
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

                <section className="grid gap-3 xl:grid-cols-[1.35fr,0.85fr]">
                  <div className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.055),rgba(255,255,255,0.02))] p-4">
                    <div className="flex items-end justify-between gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.28em] text-white/45">
                          Scenarios
                        </div>
                        <div className="mt-1 text-sm text-slate-200/65">
                          Pick the task. Jump once.
                        </div>
                      </div>
                      <div className="text-[10px] uppercase tracking-[0.22em] text-cyan-200/70">
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
                                ? 'border-cyan-400/30 bg-cyan-400/10'
                                : 'border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2">
                                  <div className="flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-black/25 text-[9px] uppercase tracking-[0.16em] text-white/60">
                                    {index + 1}
                                  </div>
                                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/52">
                                    {scenario.label}
                                  </div>
                                </div>
                                <div className="mt-2 text-[11px] leading-5 text-slate-200/56">
                                  {scenario.detail}
                                </div>
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/70">
                                {scenario.actionLabel}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    <div className="mt-4 grid gap-2 text-[9px] uppercase tracking-[0.18em] text-white/34 sm:grid-cols-2 xl:grid-cols-4">
                      <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
                        Scenarios · 1-7
                      </div>
                      <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
                        Thread · T / C
                      </div>
                      <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
                        Sessions · 1-9 / J K
                      </div>
                      <div className="rounded-xl border border-white/8 bg-black/18 px-3 py-2">
                        Traces · 1-9 / J K / R
                      </div>
                    </div>
                  </div>

                  {activeScenario ? (
                    <section className="kyberion-glass rounded-[24px] border border-cyan-300/15 bg-cyan-400/[0.06] p-4">
                      <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/55">
                        Current
                      </div>
                      <div className="mt-1 text-sm font-semibold text-white/90">
                        {activeScenario.label}
                      </div>
                      <div className="mt-3 rounded-xl border border-white/8 bg-black/20 px-3 py-3">
                        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40">
                          Next
                        </div>
                        <div className="mt-1 text-[11px] leading-5 text-white/72">
                          {activeScenario.nextStep}
                        </div>
                        <div className="mt-2 text-[9px] uppercase tracking-[0.18em] text-white/30">
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
                          className="mt-3 rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/10"
                        >
                          Clear
                        </button>
                      ) : null}
                    </section>
                  ) : null}
                </section>

                <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-1">
                  {STATUS_CARDS.map((card) => {
                    const Icon = card.icon;
                    return (
                      <button
                        key={card.label}
                        type="button"
                        onClick={() => handleSectionJump(card.targetId)}
                        className="kyberion-glass rounded-2xl border border-white/8 p-4 text-left transition hover:border-white/16 hover:bg-white/5"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`flex h-10 w-10 items-center justify-center rounded-xl border ${card.accent}`}
                          >
                            <Icon size={15} />
                          </div>
                          <div>
                            <div className="text-[10px] uppercase tracking-[0.22em] text-slate-400/80">
                              {card.label}
                            </div>
                            <div className="mt-1 text-base font-semibold text-white/90">
                              {card.value}
                            </div>
                          </div>
                        </div>
                        <p className="mt-3 text-[11px] leading-5 text-slate-200/58">
                          {card.detail}
                        </p>
                        <div className="mt-3 text-[10px] uppercase tracking-[0.2em] text-white/35">
                          {uxText('chronos_jump_to_section', 'Jump to section', locale)}
                        </div>
                      </button>
                    );
                  })}
                </section>

                <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4">
                  <button
                    onClick={() => toggleSection('views')}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
                  >
                    <span>Operator Views</span>
                    {expandedSections.views ? (
                      <ChevronDown size={12} />
                    ) : (
                      <ChevronRight size={12} />
                    )}
                  </button>
                  {expandedSections.views && (
                    <>
                      <div className="mt-2 text-sm text-slate-200/68">
                        Use this menu to switch the main console into a single focused operator
                        view, including the runtime map.
                      </div>
                      <div className="mt-4 grid gap-2">
                        <button
                          type="button"
                          onClick={() => setFocusedOperatorView(null)}
                          className={`rounded-2xl border px-3 py-3 text-left transition ${
                            focusedOperatorView === null
                              ? 'border-cyan-400/30 bg-cyan-400/10'
                              : 'border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]'
                          }`}
                        >
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/52">
                            Full Console
                          </div>
                          <div className="mt-2 text-[11px] leading-5 text-slate-200/56">
                            Show the complete control surface with all operator sections.
                          </div>
                        </button>
                        {OPERATOR_VIEW_LINKS.map((view) => (
                          <button
                            key={view.targetId}
                            type="button"
                            onClick={() => handleOperatorViewOpen(view.targetId)}
                            className={`rounded-2xl border px-3 py-3 text-left transition ${
                              focusedOperatorView === view.targetId
                                ? 'border-cyan-400/30 bg-cyan-400/10'
                                : 'border-white/8 bg-black/20 hover:border-white/16 hover:bg-white/[0.05]'
                            }`}
                          >
                            <div className="text-[10px] uppercase tracking-[0.18em] text-white/52">
                              {view.label}
                            </div>
                            <div className="mt-2 text-[11px] leading-5 text-slate-200/56">
                              {view.detail}
                            </div>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('taxonomy')}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
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
                      <div className="mt-2 text-sm text-slate-200/68">
                        Every surface connects people and agent execution in a different mode.
                        Chronos is the control surface, while A2UI provides drill-down work
                        surfaces.
                      </div>
                      <div className="mt-4 space-y-3">
                        {SURFACE_ROLES.map((role) => (
                          <div
                            key={role.label}
                            className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="text-[10px] uppercase tracking-[0.18em] text-white/44">
                                {role.label}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] text-cyan-100/72">
                                {role.value}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 text-slate-200/58">
                              {role.detail}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>

                <section className="kyberion-glass rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.05),rgba(255,255,255,0.02))] p-4 opacity-60 hover:opacity-100 transition">
                  <button
                    onClick={() => toggleSection('cycle')}
                    className="w-full flex items-center justify-between text-[10px] uppercase tracking-[0.28em] text-white/45 hover:text-white/80 transition"
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
                      <div className="mt-2 text-sm text-slate-200/68">
                        Kyberion should always make this loop legible: a request becomes a mission,
                        execution stays explainable, and the result remains inspectable and
                        reusable.
                      </div>
                      <div className="mt-4 grid gap-2">
                        {MISSION_CYCLE.map((step, index) => (
                          <div
                            key={step.label}
                            className="rounded-2xl border border-white/8 bg-black/20 px-3 py-3"
                          >
                            <div className="flex items-center gap-3">
                              <div className="flex h-6 w-6 items-center justify-center rounded-full border border-cyan-400/20 bg-cyan-400/10 text-[10px] font-semibold text-cyan-400">
                                {index + 1}
                              </div>
                              <div className="text-[10px] uppercase tracking-[0.18em] text-white/50">
                                {step.label}
                              </div>
                            </div>
                            <div className="mt-2 text-[11px] leading-5 text-slate-200/58">
                              {step.detail}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </section>
              </div>
            </aside>

            <section
              ref={mainSurfaceRef}
              className="kyberion-glass flex min-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(180deg,rgba(247,240,223,0.035),rgba(255,255,255,0.02))] xl:max-h-[calc(100vh-11rem)]"
            >
              <div className="flex items-center justify-between border-b border-white/8 px-5 py-4 md:px-6">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.34em] text-stone-200/42">
                    Active Surface
                  </div>
                  <div className="mt-1 text-lg font-semibold tracking-tight text-white/92">
                    {activeSurfaceTitle}
                  </div>
                </div>
                <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/25 px-3 py-1 text-[10px] uppercase tracking-[0.22em] text-slate-300/60">
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
                  <AgentOpsBoards />
                ) : (
                  <div className="flex flex-col gap-6">
                    {a2uiActionNotice ? (
                      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/10 px-4 py-3 text-[11px] text-cyan-100/80">
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

  useEffect(() => {
    const customerId = searchParams.get('customerId') || searchParams.get('customer') || '';
    const brandName = searchParams.get('brandName') || '';
    const designSystemId = searchParams.get('designSystemId') || '';
    if (!customerId && !brandName && !designSystemId) {
      onResolve({}, null);
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
        onResolve(payload.css_vars || {}, payload.brand_name || payload.source || null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [onResolve, searchParams]);

  return null;
}
