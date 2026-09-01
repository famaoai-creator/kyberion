import {
  ActivitySquare,
  Bot,
  CalendarClock,
  ClipboardCheck,
  Radar,
  Shield,
  Wrench,
} from 'lucide-react';
import { uxText, type SupportedLocale } from '../lib/ux-vocabulary';
import type { ChronosThemeMode } from '../lib/chronos-theme';
import { parseJsonRecord } from '../lib/json-record';

export type QuickAction = {
  label: string;
  query: string;
  icon: string;
  tone: 'observe' | 'verify' | 'operate';
};

export type QuickActionGroup = {
  title: string;
  hint: string;
  icon: typeof Radar;
  accent: string;
  accentText: string;
  actions: QuickAction[];
};

export type StatusCard = {
  label: string;
  value: string;
  detail: string;
  icon: typeof Shield;
  accent: string;
  targetId: string;
};

export type ConsoleSectionId =
  | 'home'
  | 'organization'
  | 'missions'
  | 'work-items'
  | 'surface-control'
  | 'deliverables'
  | 'approvals'
  | 'knowledge'
  | 'operations'
  | 'governance'
  | 'diagnostics'
  | 'surface';
export type ConsoleContentSection = Exclude<ConsoleSectionId, 'surface'>;
export const SURFACE_TAGLINE_KEY = 'surface:chronos_surface_tagline';

export const CONSOLE_SECTIONS: Array<{
  id: ConsoleSectionId;
  labelKey: string;
  detailKey: string;
}> = [
  { id: 'home', labelKey: 'chronos_nav_home', detailKey: 'chronos_nav_home_hint' },
  {
    id: 'organization',
    labelKey: 'chronos_nav_organization',
    detailKey: 'chronos_nav_organization_hint',
  },
  { id: 'missions', labelKey: 'chronos_nav_missions', detailKey: 'chronos_nav_missions_hint' },
  {
    id: 'work-items',
    labelKey: 'chronos_nav_work_items',
    detailKey: 'chronos_nav_work_items_hint',
  },
  {
    id: 'deliverables',
    labelKey: 'chronos_nav_deliverables',
    detailKey: 'chronos_nav_deliverables_hint',
  },
  {
    id: 'approvals',
    labelKey: 'chronos_nav_approvals',
    detailKey: 'chronos_nav_approvals_hint',
  },
  {
    id: 'knowledge',
    labelKey: 'chronos_nav_knowledge',
    detailKey: 'chronos_nav_knowledge_hint',
  },
  {
    id: 'operations',
    labelKey: 'chronos_nav_operations',
    detailKey: 'chronos_nav_operations_hint',
  },
  {
    id: 'governance',
    labelKey: 'chronos_nav_governance',
    detailKey: 'chronos_nav_governance_hint',
  },
  {
    id: 'surface-control',
    labelKey: 'chronos_nav_surface_control',
    detailKey: 'chronos_nav_surface_control_hint',
  },
  {
    id: 'diagnostics',
    labelKey: 'chronos_nav_diagnostics',
    detailKey: 'chronos_nav_diagnostics_hint',
  },
];
export const OPERATOR_LAYOUT_PREFS_KEY = 'chronos.operator-layout.prefs';
export const CHRONOS_THEME_PREFS_KEY = 'chronos.theme-mode';

export function buildPlanPreviewSignature(input: {
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

export function isPlanPreviewStale(
  previewSignature: string | null,
  currentSignature: string
): boolean {
  if (!previewSignature) return true;
  return previewSignature !== currentSignature;
}

export function loadOperatorLayoutPrefs(): {
  focusedOperatorView: string | null;
  missionIntelligenceFocus: string | null;
} | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(OPERATOR_LAYOUT_PREFS_KEY);
    if (!raw) return null;
    const parsed = parseJsonRecord(raw);
    if (!parsed) return null;
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

export function saveOperatorLayoutPrefs(
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

export function loadChronosThemeMode(): ChronosThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CHRONOS_THEME_PREFS_KEY);
    return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : null;
  } catch {
    return null;
  }
}

export function saveChronosThemeMode(mode: ChronosThemeMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHRONOS_THEME_PREFS_KEY, mode);
  } catch {
    // localStorage may be denied; ignore.
  }
}

export const buildQuickActionGroups = (locale: SupportedLocale): QuickActionGroup[] => [
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

export const buildStatusCards = (locale: SupportedLocale): StatusCard[] => [
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
