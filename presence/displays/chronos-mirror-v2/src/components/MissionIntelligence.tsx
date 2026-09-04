'use client';

import { useEffect, useRef, useState } from 'react';
import { buildAttentionItems, type AttentionItem } from '../lib/operator-console';
import { resolveChronosLocale, uxText, uxTextOr } from '../lib/ux-vocabulary';
import { MissionIntelligenceMissionPanel } from './MissionIntelligenceMissionPanel';
import { MissionIntelligenceApprovalsPanel } from './MissionIntelligenceApprovalsPanel';
import { MissionIntelligenceRuntimePanel } from './MissionIntelligenceRuntimePanel';
import { MissionIntelligenceAgentTrafficPanel } from './MissionIntelligenceAgentTrafficPanel';
import { MissionIntelligenceSurfaceOverview } from './MissionIntelligenceSurfaceOverview';
import { MissionIntelligenceDangerousActionDialog } from './MissionIntelligenceDangerousActionDialog';
import { MissionIntelligenceStatusGate } from './MissionIntelligenceStatusGate';
import { LiveSyncScheduler, bindVisibilityToLiveSync } from '../lib/live-sync';
import { parseMissionIntelligenceResponse } from '../lib/mission-intelligence-response';
import {
  buildMissionThread,
  missionActionLabel,
  resolveMissionControlFocusId,
  resolveMissionThreadHotkeyAction,
  toDomId,
} from './MissionIntelligenceViewHelpers';
import {
  MetricCard,
  MiniSummaryCard,
  Panel,
  RuntimeCell,
  providerResolutionSummary,
} from './MissionIntelligencePrimitives';
import type {
  ArtifactRecordSummary,
  CompanySnapshot,
  ControlActionAvailability,
  ControlActionCatalog,
  ControlActionDefinition,
  ControlActionSummary,
  DistillCandidateSummary,
  IntelligencePayload,
  MissionIntelligenceWorkspace,
  MissionProgressSummary,
  MissionSeedRecordSummary,
  MissionSummary,
  MissionThreadEntry,
  OwnerSummary,
  PendingApprovalSummary,
  ProjectManagementSummary,
  ProjectRecordSummary,
  ProjectTrackRecordSummary,
  ReferenceDetail,
  RuntimeDoctorFinding,
  RuntimeLease,
  RuntimeSummary,
  ServiceBindingRecordSummary,
  SurfaceOutboxMessage,
  SurfaceSummary,
  WorkLoopPreview,
} from './MissionIntelligenceTypes';

export { buildDangerousActionPrompt } from './MissionIntelligenceViewHelpers';
export {
  pickDefaultMissionId,
  resolveMissionControlFocusId,
  resolveMissionThreadHotkeyAction,
} from './MissionIntelligenceViewHelpers';

function buildMissionIntentSummary(data: IntelligencePayload, mission: MissionSummary): string {
  const latestHandoff = data.a2aHandoffs
    .filter((handoff) => handoff.missionId === mission.missionId)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (latestHandoff?.promptExcerpt) return latestHandoff.promptExcerpt;
  if (latestHandoff?.intent) return latestHandoff.intent;
  if (mission.missionType) return mission.missionType;
  return 'Durable work item';
}

export function MissionIntelligence({
  workspace = 'surface',
  focusedView = null,
  onClearFocus,
  onOpenWorkspace,
  focusedMissionId = null,
  hideSurfaceControl = false,
  showMissionIntelligenceLabel = false,
  tenant = '',
}: {
  workspace?: MissionIntelligenceWorkspace;
  focusedView?: string | null;
  onClearFocus?: () => void;
  onOpenWorkspace?: (
    workspace: Exclude<MissionIntelligenceWorkspace, 'surface'>,
    panelId: string
  ) => void;
  focusedMissionId?: string | null;
  hideSurfaceControl?: boolean;
  showMissionIntelligenceLabel?: boolean;
  tenant?: string;
}) {
  const locale = resolveChronosLocale();
  const mt = (key: string, fallbackEn: string) => uxTextOr(key, fallbackEn, locale);
  const missionActionText = (action: ControlActionDefinition) => missionActionLabel(action, locale);
  const missionIntelligenceEyebrow = showMissionIntelligenceLabel
    ? uxText('chronos_mission_intelligence', locale)
    : undefined;
  const intelligenceUrl = tenant
    ? `/api/intelligence?tenant=${encodeURIComponent(tenant)}`
    : '/api/intelligence';
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remediationTarget, setRemediationTarget] = useState<string | null>(null);
  const [outboxTarget, setOutboxTarget] = useState<string | null>(null);
  const [missionActionTarget, setMissionActionTarget] = useState<string | null>(null);
  const [missionSeedTarget, setMissionSeedTarget] = useState<string | null>(null);
  const [trackSeedTarget, setTrackSeedTarget] = useState<string | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<string | null>(null);
  const [surfaceActionTarget, setSurfaceActionTarget] = useState<string | null>(null);
  const [memoryPromotionTarget, setMemoryPromotionTarget] = useState<'dry-run' | 'promote' | null>(
    null
  );
  const [nextActionTarget, setNextActionTarget] = useState<string | null>(null);
  const [browserSessionTarget, setBrowserSessionTarget] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [distillCandidateTarget, setDistillCandidateTarget] = useState<string | null>(null);
  const [dangerousAction, setDangerousAction] = useState<{
    title: string;
    detail: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  const [expandedMissionCardActionId, setExpandedMissionCardActionId] = useState<string | null>(
    null
  );
  const [expandedSurfaceCardActionId, setExpandedSurfaceCardActionId] = useState<string | null>(
    null
  );
  const [expandedGlobalSurfaceActionId, setExpandedGlobalSurfaceActionId] = useState<string | null>(
    null
  );
  const [messageMissionFilter, setMessageMissionFilter] = useState<string>('all');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(() =>
    loadMissionIntelligenceSelectedMissionId()
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [showMissionDetails, setShowMissionDetails] = useState(false);
  const [selectedReferencePath, setSelectedReferencePath] = useState<string | null>(null);
  const [referenceDetail, setReferenceDetail] = useState<ReferenceDetail | null>(null);
  const missionThreadPanelRef = useRef<HTMLDivElement | null>(null);
  // Render-computed view state for the hoisted mission-control effects. The
  // effects must sit ABOVE the error/mounted/data early returns (hook count
  // must not change between renders), so they read the latest values here.
  const missionControlViewRef = useRef<{
    filteredMissions: MissionSummary[];
    effectiveMissionId: string | null;
  }>({ filteredMissions: [], effectiveMissionId: null });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Risky actions are always routed through a confirmation step before state changes.
  const requestDangerousAction = (
    title: string,
    detail: string,
    confirmLabel: string,
    onConfirm: () => Promise<void> | void
  ) => {
    setDangerousAction({ title, detail, confirmLabel, onConfirm });
  };

  const clearDangerousAction = () => {
    setDangerousAction(null);
  };

  const confirmDangerousAction = async () => {
    if (!dangerousAction) return;
    const action = dangerousAction;
    setDangerousAction(null);
    await action.onConfirm();
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const mission = params.get('mission');
    const project = params.get('project');
    const track = params.get('track');
    if (mission) {
      setSelectedMissionId(mission);
      setMessageMissionFilter(mission);
    }
    if (project) setSelectedProjectId(project);
    if (track) setSelectedTrackId(track);
  }, []);

  useEffect(() => {
    saveMissionIntelligenceSelectedMissionId(selectedMissionId);
  }, [selectedMissionId]);

  const jumpToTarget = (action: ControlActionSummary) => {
    const id =
      action.kind === 'mission'
        ? toDomId('mission', action.target)
        : toDomId('surface', action.target);
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const refreshData = async () => {
    const refreshed = await fetch(intelligenceUrl, { cache: 'no-store' });
    const payload = parseMissionIntelligenceResponse(await refreshed.json().catch(() => null));
    if (!refreshed.ok || !payload) throw new Error('Invalid mission intelligence response');
    setData(payload);
    setError(null);
  };

  useEffect(() => {
    let alive = true;
    const scheduler = new LiveSyncScheduler<IntelligencePayload>({
      fetchSnapshot: async () => {
        const res = await fetch(intelligenceUrl, { cache: 'no-store' });
        const payload = parseMissionIntelligenceResponse(await res.json().catch(() => null));
        if (!res.ok || !payload) throw new Error('Invalid mission intelligence response');
        return payload;
      },
      onSnapshot: (snapshot) => {
        if (!alive) return;
        setData(snapshot);
        setError(null);
      },
      onError: (err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      },
      revisionOf: (snapshot) => snapshot.revision,
      isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    });
    void scheduler.refresh().catch(() => undefined);
    const source = new EventSource(
      tenant
        ? `/api/intelligence/stream?tenant=${encodeURIComponent(tenant)}`
        : '/api/intelligence/stream'
    );
    source.onmessage = () => scheduler.invalidate();
    source.onerror = () => scheduler.invalidate();
    const unbindVisibility = bindVisibilityToLiveSync(scheduler);
    scheduler.start();
    return () => {
      alive = false;
      source.close();
      unbindVisibility();
      scheduler.stop();
    };
  }, [intelligenceUrl, tenant]);

  const focusMissionThread = (missionId: string) => {
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
    setShowMissionDetails(true);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      missionThreadPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const focusMissionCard = (missionId: string) => {
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
    setShowMissionDetails(true);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      document.getElementById(`mission-card-${missionId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  useEffect(() => {
    if (!focusedView) return;
    window.requestAnimationFrame(() => {
      document.getElementById(focusedView)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [focusedView]);

  const remediateLease = async (
    agentId: string,
    action: 'cleanup_runtime_lease' | 'restart_runtime_lease'
  ) => {
    try {
      setRemediationTarget(agentId);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          agentId,
        }),
      });
      if (!res.ok) throw new Error('Failed to remediate runtime lease');
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Failed to remediate runtime lease');
    } finally {
      setRemediationTarget(null);
    }
  };

  const clearOutboxMessage = async (surface: 'slack' | 'chronos', messageId: string) => {
    try {
      setOutboxTarget(messageId);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'clear_surface_outbox',
          surface,
          messageId,
        }),
      });
      if (!res.ok) throw new Error('Failed to clear outbox message');
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Failed to clear outbox message');
    } finally {
      setOutboxTarget(null);
    }
  };

  const runMissionControl = async (missionId: string, operation: string) => {
    try {
      setMissionActionTarget(`${missionId}:${operation}`);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mission_control',
          missionId,
          operation,
        }),
      });
      if (!res.ok) throw new Error('Mission control action failed');
      setActionResult(`${missionId}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Mission control action failed');
    } finally {
      setMissionActionTarget(null);
    }
  };

  const promoteMissionSeed = async (seedId: string) => {
    try {
      setMissionSeedTarget(seedId);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promote_mission_seed',
          seedId,
        }),
      });
      if (!res.ok) throw new Error('Mission seed promotion failed');
      setActionResult(`${seedId}: promoted`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Mission seed promotion failed');
    } finally {
      setMissionSeedTarget(null);
    }
  };

  const createTrackSeed = async (trackId: string, artifactId?: string) => {
    try {
      setTrackSeedTarget(trackId);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_track_seed',
          trackId,
          artifactId,
        }),
      });
      if (!res.ok) throw new Error('Track seed creation failed');
      setActionResult(`${trackId}: seed ready`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Track seed creation failed');
    } finally {
      setTrackSeedTarget(null);
    }
  };

  const parseReferenceContent = (
    rawText: string,
    logicalPath: string,
    endpoint: string,
    openLabel: string
  ): ReferenceDetail => {
    const lines = String(rawText || '').split(/\r?\n/);
    const detail: ReferenceDetail = {
      path: logicalPath,
      title:
        String(logicalPath || 'reference')
          .split('/')
          .pop() || 'reference',
      summary: '',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel,
    };
    let startIndex = 0;
    if (lines[0] === '---') {
      const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
      if (endIndex > 0) {
        for (const line of lines.slice(1, endIndex)) {
          const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (match) detail.metadata[match[1]] = match[2].trim();
        }
        startIndex = endIndex + 1;
      }
    }
    let currentSection: { title: string; lines: string[] } | null = null;
    const bodyLines: string[] = [];
    for (const line of lines.slice(startIndex)) {
      if (line.startsWith('# ')) {
        detail.title = line.slice(2).trim() || detail.title;
        continue;
      }
      if (line.startsWith('## ')) {
        currentSection = { title: line.slice(3).trim(), lines: [] };
        detail.sections.push(currentSection);
        continue;
      }
      if (currentSection) currentSection.lines.push(line);
      else bodyLines.push(line);
    }
    detail.body = bodyLines.join('\n').trim();
    detail.summary =
      detail.metadata.summary || detail.body.split('\n').find((line) => line.trim()) || '';
    return detail;
  };

  const openRuntimeReference = async (logicalPath: string) => {
    const path = String(logicalPath || '').trim();
    if (!path) return;
    const endpoint = '/api/runtime-file';
    setSelectedReferencePath(path);
    setReferenceDetail({
      path,
      title: path.split('/').pop() || path,
      summary: 'Loading skeleton...',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel: 'open raw skeleton',
    });
    try {
      const res = await fetch(`${endpoint}?path=${encodeURIComponent(path)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setReferenceDetail(parseReferenceContent(text, path, endpoint, 'open raw skeleton'));
    } catch (err: any) {
      setReferenceDetail({
        path,
        title: path.split('/').pop() || path,
        summary: err.message || 'Failed to load skeleton',
        metadata: {},
        sections: [],
        body: '',
        endpoint,
        openLabel: 'open raw skeleton',
      });
    }
  };

  const openKnowledgeReference = async (logicalPath: string) => {
    const path = String(logicalPath || '').trim();
    if (!path) return;
    const endpoint = '/api/knowledge-ref';
    setSelectedReferencePath(path);
    setReferenceDetail({
      path,
      title: path.split('/').pop() || path,
      summary: 'Loading template...',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel: 'open raw template',
    });
    try {
      const res = await fetch(`${endpoint}?path=${encodeURIComponent(path)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setReferenceDetail(parseReferenceContent(text, path, endpoint, 'open raw template'));
    } catch (err: any) {
      setReferenceDetail({
        path,
        title: path.split('/').pop() || path,
        summary: err.message || 'Failed to load template',
        metadata: {},
        sections: [],
        body: '',
        endpoint,
        openLabel: 'open raw template',
      });
    }
  };

  const decideApproval = async (
    approval: PendingApprovalSummary,
    decision: 'approved' | 'rejected'
  ) => {
    try {
      setApprovalTarget(approval.id);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approval_decision',
          requestId: approval.id,
          channel: approval.channel,
          storageChannel: approval.storageChannel,
          decision,
        }),
      });
      if (!res.ok) throw new Error('Approval decision failed');
      setActionResult(`${approval.id}: ${decision}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Approval decision failed');
    } finally {
      setApprovalTarget(null);
    }
  };

  const decideDistillCandidate = async (
    candidate: DistillCandidateSummary,
    decision: 'promote' | 'archive'
  ) => {
    try {
      setDistillCandidateTarget(candidate.candidate_id);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'distill_candidate_decision',
          candidateId: candidate.candidate_id,
          decision,
        }),
      });
      if (!res.ok) throw new Error('Distill candidate decision failed');
      setActionResult(`${candidate.candidate_id}: ${decision}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Distill candidate decision failed');
    } finally {
      setDistillCandidateTarget(null);
    }
  };

  const runSurfaceControl = async (surfaceId: string | null, operation: string) => {
    try {
      setSurfaceActionTarget(`${surfaceId || 'all'}:${operation}`);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'surface_control',
          surfaceId,
          operation,
        }),
      });
      if (!res.ok) throw new Error('Surface control action failed');
      setActionResult(`${surfaceId || 'surfaces'}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Surface control action failed');
    } finally {
      setSurfaceActionTarget(null);
    }
  };

  const runMemoryPromotion = async (dryRun: boolean) => {
    try {
      setMemoryPromotionTarget(dryRun ? 'dry-run' : 'promote');
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'memory_promote_pending',
          dryRun,
        }),
      });
      if (!res.ok) throw new Error('Memory promotion action failed');
      if (dryRun) {
        const pending = Array.isArray(body.pending) ? body.pending.length : 0;
        setActionResult(`memory promotion dry-run: ${pending} candidate(s)`);
      } else {
        setActionResult(
          `memory promoted: ${body.promoted_count || 0} success, ${body.failed_count || 0} failed`
        );
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Memory promotion action failed');
    } finally {
      setMemoryPromotionTarget(null);
    }
  };

  const recordNextActionExecution = async (input: {
    actionId: string;
    operation?: string;
    outcome?: 'completed' | 'failed';
    target?: string;
    detail?: string;
  }) => {
    try {
      await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'next_action_execute',
          actionId: input.actionId,
          operation: input.operation || 'next_action_execute',
          outcome: input.outcome || 'completed',
          target: input.target || 'next-actions',
          detail: input.detail || '',
        }),
      });
    } catch {
      // best-effort audit emission only
    }
  };

  const navigateToPanel = (
    targetWorkspace: Exclude<MissionIntelligenceWorkspace, 'surface'>,
    panelId: string
  ) => {
    if (workspace !== targetWorkspace && onOpenWorkspace) {
      onOpenWorkspace(targetWorkspace, panelId);
      return;
    }
    document.getElementById(panelId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const runNextAction = async (action: NonNullable<IntelligencePayload['nextActions']>[number]) => {
    try {
      setNextActionTarget(action.action_id);
      if (action.action_id === 'chronos-promote-memory') {
        await runMemoryPromotion(false);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'memory_promote_pending',
          target: 'memory-promotion-queue',
          detail: 'Executed promote approved memory action from next-actions panel.',
        });
        return;
      }
      if (action.action_id === 'chronos-approve-pending' || action.next_action_type === 'approve') {
        navigateToPanel('governance', 'approvals');
        setActionResult(`next action routed: ${action.action_id} -> approvals`);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'route_to_approvals',
          target: 'approvals',
          detail: 'Routed operator to approvals panel from next-actions.',
        });
        return;
      }
      if (
        action.action_id === 'chronos-promote-seed' ||
        action.next_action_type === 'promote_mission_seed'
      ) {
        navigateToPanel('missions', 'mission-seeds');
        setActionResult(`next action routed: ${action.action_id} -> mission seeds`);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'route_to_mission_seeds',
          target: 'mission-seeds',
          detail: 'Routed operator to mission seeds panel from next-actions.',
        });
        return;
      }
      if ((action.suggested_command || '').includes('promote-memory')) {
        await runMemoryPromotion(true);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'memory_promote_pending_dry_run',
          target: 'memory-promotion-queue',
          detail: 'Executed dry-run memory promotion from suggested command hint.',
        });
        return;
      }
      setActionResult(`manual next action: ${action.suggested_command || action.reason}`);
      await recordNextActionExecution({
        actionId: action.action_id,
        operation: 'manual_follow_up',
        target: 'next-actions',
        detail: action.suggested_command || action.reason,
      });
    } catch (err: any) {
      setError(err.message || 'Next action execution failed');
      await recordNextActionExecution({
        actionId: action.action_id,
        operation: 'next_action_execute',
        outcome: 'failed',
        target: 'next-actions',
        detail: err?.message || 'Next action execution failed',
      });
    } finally {
      setNextActionTarget(null);
    }
  };

  const resolveNextActionRoute = (
    action: NonNullable<IntelligencePayload['nextActions']>[number]
  ): { panelId: string; label: string } | null => {
    const panelFromApi = String(action.suggested_surface_action || '').trim();
    if (panelFromApi === 'approvals') return { panelId: 'approvals', label: 'Approvals Panel' };
    if (panelFromApi === 'mission-seeds')
      return { panelId: 'mission-seeds', label: 'Mission Seeds Panel' };
    if (panelFromApi === 'memory-promotion-queue')
      return { panelId: 'memory-promotion-queue', label: 'Memory Promotion Queue' };
    const suggested = String(action.suggested_command || '').toLowerCase();
    if (
      action.action_id === 'chronos-approve-pending' ||
      action.next_action_type === 'approve' ||
      suggested.includes('chronos approvals')
    ) {
      return { panelId: 'approvals', label: 'Approvals Panel' };
    }
    if (
      action.action_id === 'chronos-promote-seed' ||
      action.next_action_type === 'promote_mission_seed' ||
      suggested.includes('mission-seeds')
    ) {
      return { panelId: 'mission-seeds', label: 'Mission Seeds Panel' };
    }
    if (
      action.action_id === 'chronos-promote-memory' ||
      suggested.includes('promote-memory') ||
      suggested.includes('memory-promote')
    ) {
      return { panelId: 'memory-promotion-queue', label: 'Memory Promotion Queue' };
    }
    return null;
  };

  const jumpToNextActionRoute = (
    action: NonNullable<IntelligencePayload['nextActions']>[number]
  ) => {
    const route = resolveNextActionRoute(action);
    if (!route) {
      setActionResult(`next action route unavailable: ${action.action_id}`);
      return;
    }
    const targetWorkspace =
      route.panelId === 'approvals' || route.panelId === 'memory-promotion-queue'
        ? 'governance'
        : 'missions';
    navigateToPanel(targetWorkspace, route.panelId);
    setActionResult(`next action route preview: ${action.action_id} -> ${route.label}`);
  };

  const runBrowserSessionControl = async (
    sessionId: string,
    action: 'close_browser_session' | 'restart_browser_session'
  ) => {
    try {
      setBrowserSessionTarget(`${sessionId}:${action}`);
      const res = await fetch(intelligenceUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          sessionId,
        }),
      });
      if (!res.ok) throw new Error('Browser session control action failed');
      setActionResult(`${sessionId}: ${action}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Browser session control action failed');
    } finally {
      setBrowserSessionTarget(null);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // pin mission thread selection into the URL so a mission pinned view survives reload/share.
    const url = new URL(window.location.href);
    if (selectedMissionId) {
      url.searchParams.set('mission', selectedMissionId);
    } else {
      url.searchParams.delete('mission');
    }
    if (selectedProjectId) {
      url.searchParams.set('project', selectedProjectId);
    } else {
      url.searchParams.delete('project');
    }
    if (selectedTrackId) {
      url.searchParams.set('track', selectedTrackId);
    } else {
      url.searchParams.delete('track');
    }
    window.history.replaceState({}, '', url.toString());
  }, [selectedMissionId, selectedProjectId, selectedTrackId]);

  useEffect(() => {
    if (focusedMissionId && focusedMissionId !== selectedMissionId) {
      setSelectedMissionId(focusedMissionId);
      setMessageMissionFilter(focusedMissionId);
      setShowMissionDetails(true);
      return;
    }
    if (focusedMissionId === selectedMissionId && focusedMissionId) {
      setShowMissionDetails(true);
    }
    if (focusedView !== 'mission-control-plane') return;
    const missionId = resolveMissionControlFocusId(
      missionControlViewRef.current.filteredMissions,
      selectedMissionId,
      focusedMissionId
    );
    if (!missionId || missionId === selectedMissionId) return;
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
  }, [data, focusedMissionId, focusedView, selectedMissionId]);

  useEffect(() => {
    if (focusedView !== 'mission-control-plane') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableHotkeyTarget(event.target)) return;
      const action = resolveMissionThreadHotkeyAction(event.key);
      const effectiveMissionId = missionControlViewRef.current.effectiveMissionId;
      if (!action || !effectiveMissionId) return;
      event.preventDefault();
      if (action === 'thread') {
        focusMissionThread(effectiveMissionId);
        return;
      }
      focusMissionCard(effectiveMissionId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedView]);

  const missionPinStatusLabel = selectedMissionId
    ? mt('chronos_mission_selected', 'Mission selected')
    : mt('chronos_mission_not_selected', 'Select a mission');

  if (error || !mounted || !data) {
    return (
      <MissionIntelligenceStatusGate
        context={{ error, locale, missionIntelligenceEyebrow, refreshData, mounted, data, mt }}
      />
    );
  }

  const selectedProject = selectedProjectId
    ? data.projects.find((project) => project.project_id === selectedProjectId) || null
    : null;
  const selectedProjectManagement = selectedProject
    ? (data.projectManagement || []).find(
        (item) => item.project.project_id === selectedProject.project_id
      ) || null
    : null;
  const selectedMission = selectedMissionId
    ? data.activeMissions.find((mission) => mission.missionId === selectedMissionId) || null
    : null;
  const availableTracks = selectedProject
    ? data.projectTracks.filter((track) => track.project_id === selectedProject.project_id)
    : data.projectTracks;
  const gateReadinessByTrack = new Map(
    (data.gateReadiness || []).map((item) => [item.track_id, item])
  );
  const hydratedTracks = availableTracks.map((track) => ({
    ...track,
    gate_readiness: track.gate_readiness || gateReadinessByTrack.get(track.track_id),
  }));
  const selectedTrack = selectedTrackId
    ? hydratedTracks.find((track) => track.track_id === selectedTrackId) || null
    : null;
  const selectedProjectMissionIds = new Set(selectedProject?.active_missions || []);
  const selectedProjectBootstrapItems = selectedProject?.bootstrap_work_items || [];
  const projectFilteredMissions = selectedProject
    ? data.activeMissions.filter((mission) => selectedProjectMissionIds.has(mission.missionId))
    : data.activeMissions;
  const filteredMissions = selectedTrack
    ? projectFilteredMissions.filter((mission) => mission.trackId === selectedTrack.track_id)
    : projectFilteredMissions;
  const filteredServiceBindings = selectedProject
    ? data.serviceBindings.filter((binding) =>
        (selectedProject.service_bindings || []).includes(binding.binding_id)
      )
    : data.serviceBindings;
  const filteredMissionSeeds = selectedProject
    ? data.missionSeeds.filter((seed) => seed.project_id === selectedProject.project_id)
    : data.missionSeeds;
  const filteredMissionSeedsByTrack = selectedTrack
    ? filteredMissionSeeds.filter(
        (seed) =>
          seed.track_id === selectedTrack.track_id ||
          seed.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredMissionSeeds;
  const filteredDistillCandidates = selectedProject
    ? data.distillCandidates.filter(
        (candidate) => candidate.project_id === selectedProject.project_id
      )
    : data.distillCandidates;
  const filteredDistillCandidatesByTrack = selectedTrack
    ? filteredDistillCandidates.filter(
        (candidate) =>
          candidate.track_id === selectedTrack.track_id ||
          candidate.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredDistillCandidates;
  const filteredRecentArtifacts = selectedProject
    ? data.recentArtifacts.filter((artifact) => artifact.project_id === selectedProject.project_id)
    : data.recentArtifacts;
  const filteredRecentArtifactsByTrack = selectedTrack
    ? filteredRecentArtifacts.filter(
        (artifact) =>
          artifact.track_id === selectedTrack.track_id ||
          artifact.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredRecentArtifacts;
  const filteredPendingApprovals = selectedProject
    ? data.pendingApprovals.filter(
        (approval) => !approval.missionId || selectedProjectMissionIds.has(approval.missionId)
      )
    : data.pendingApprovals;
  const filteredPendingApprovalsByTrack = selectedTrack
    ? filteredPendingApprovals.filter(
        (approval) =>
          approval.trackId === selectedTrack.track_id ||
          approval.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredPendingApprovals;
  const allMemoryCandidates = Array.isArray(data.memoryCandidates) ? data.memoryCandidates : [];
  const filteredMemoryCandidates = selectedProject
    ? allMemoryCandidates.filter((candidate) => {
        const sourceRef = String(candidate.source_ref || '');
        const missionMatch = sourceRef.match(/^mission:([A-Za-z0-9-]+)/u);
        if (!missionMatch) return true;
        return selectedProjectMissionIds.has(missionMatch[1] || '');
      })
    : allMemoryCandidates;
  const filteredMemoryCandidatesByTrack = selectedTrack
    ? filteredMemoryCandidates.filter((candidate) => {
        const sourceRef = String(candidate.source_ref || '');
        const missionMatch = sourceRef.match(/^mission:([A-Za-z0-9-]+)/u);
        if (!missionMatch) return true;
        const mission = data.activeMissions.find((item) => item.missionId === missionMatch[1]);
        if (!mission) return true;
        return mission.trackId === selectedTrack.track_id;
      })
    : filteredMemoryCandidates;
  const filteredAgentMessages = data.agentMessages.filter((message) => {
    if (selectedProject && message.missionId && !selectedProjectMissionIds.has(message.missionId))
      return false;
    if (messageMissionFilter !== 'all' && message.missionId !== messageMissionFilter) return false;
    return true;
  });
  const filteredA2AHandoffs = data.a2aHandoffs.filter((handoff) => {
    if (selectedProject && !selectedProjectMissionIds.has(handoff.missionId)) return false;
    if (messageMissionFilter !== 'all' && handoff.missionId !== messageMissionFilter) return false;
    return true;
  });
  const learnedProjectRefs = (projectId: string) =>
    filteredDistillCandidatesByTrack
      .filter((candidate) => candidate.project_id === projectId && candidate.promoted_ref)
      .slice(0, 3);
  const learnedMissionSeedRefs = (seedId: string, projectId: string, missionId?: string) =>
    filteredDistillCandidatesByTrack
      .filter((candidate) => {
        if (candidate.project_id !== projectId || !candidate.promoted_ref) return false;
        const evidence = candidate.evidence_refs || [];
        return (
          evidence.includes(`mission_seed:${seedId}`) ||
          (missionId ? candidate.mission_id === missionId : false)
        );
      })
      .slice(0, 3);
  const effectiveMissionId =
    selectedMissionId ||
    (messageMissionFilter !== 'all' ? messageMissionFilter : filteredMissions[0]?.missionId) ||
    null;
  const missionThread =
    effectiveMissionId && (!selectedProject || selectedProjectMissionIds.has(effectiveMissionId))
      ? buildMissionThread(effectiveMissionId, data.agentMessages, data.a2aHandoffs)
      : [];
  missionControlViewRef.current = { filteredMissions, effectiveMissionId };
  const missionExceptions = filteredMissions.filter(
    (mission) => mission.controlTone === 'attention' || mission.controlTone === 'pending'
  );

  const surfaceExceptions = data.surfaces.filter(
    (surface) => surface.controlTone === 'attention' || surface.health === 'unhealthy'
  );
  const deliveryExceptions = data.recentSurfaceOutbox;
  const attentionItems = buildAttentionItems({
    missions: data.activeMissions,
    runtimeDoctor: data.runtimeDoctor,
    surfaces: data.surfaces,
    outbox: data.recentSurfaceOutbox,
  });

  const runAttentionAction = (item: AttentionItem) => {
    if (item.targetType === 'mission') {
      setSelectedMissionId(item.targetId);
      setMessageMissionFilter(item.targetId);
      if (workspace !== 'missions' && onOpenWorkspace) {
        onOpenWorkspace('missions', 'mission-control-plane');
      } else {
        document
          .getElementById(toDomId('mission', item.targetId))
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    if (item.targetType === 'runtime' && item.remediationAction) {
      remediateLease(item.targetId, item.remediationAction);
      return;
    }
    if (item.targetType === 'surface') {
      if (workspace !== 'surface-control' && onOpenWorkspace) {
        onOpenWorkspace('surface-control', 'surface-control');
      } else {
        document
          .getElementById(toDomId('surface', item.targetId))
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    navigateToPanel('diagnostics', 'recent-surface-outbox');
  };
  const panelVisible = (panelId: string) => {
    if (workspace === 'surface') {
      if (!focusedView) return false;
      if (focusedView === 'mission-control-plane') {
        return ['mission-control-plane', 'selected-mission-thread', 'a2a-handoff-trail'].includes(
          panelId
        );
      }
      return focusedView === panelId;
    }

    const missionDetailsFocused =
      showMissionDetails || focusedView === 'mission-control-plane' || Boolean(focusedMissionId);
    const panelWorkspaces: Record<Exclude<MissionIntelligenceWorkspace, 'surface'>, string[]> = {
      missions: missionDetailsFocused
        ? [
            'next-actions',
            'needs-attention',
            'mission-control-plane',
            'projects',
            'tracks',
            'service-bindings',
            'mission-seeds',
            'skeleton-detail',
            'selected-mission-thread',
            'a2a-handoff-trail',
          ]
        : ['next-actions', 'needs-attention', 'mission-control-plane'],
      deliverables: ['recent-artifacts'],
      operations: [
        'runtime-topology-map',
        'runtime-lease-doctor',
        'runtime-summary',
        'browser-sessions',
        'browser-guidance',
        'browser-conversation-sessions',
        'agent-traffic',
      ],
      governance: ['approvals', 'distill-candidates', 'memory-promotion-queue'],
      diagnostics: [
        'needs-attention',
        'recent-surface-outbox',
        'orchestration-audit',
        'owner-summaries',
      ],
      'surface-control': ['recent-control-actions', 'control-model'],
    };
    return panelWorkspaces[workspace].includes(panelId);
  };
  const focusTitle = focusedView
    ? (
        {
          'needs-attention': 'Needs Attention',
          'mission-control-plane': 'Mission Control',
          'runtime-topology-map': 'Runtime Topology',
          'runtime-lease-doctor': 'Runtime Governance',
          'recent-surface-outbox': 'Delivery Exceptions',
          'owner-summaries': 'Audit Trail',
        } as Record<string, string>
      )[focusedView] || 'Focused View'
    : null;
  const referenceMetadataEntries = Object.entries(referenceDetail?.metadata || {}).filter(
    ([, value]) => String(value || '').trim()
  );
  const referenceSections = Array.isArray(referenceDetail?.sections)
    ? referenceDetail.sections
    : [];
  const selectedReferenceSeed = selectedReferencePath
    ? filteredMissionSeedsByTrack.find(
        (seed) =>
          seed.metadata?.skeleton_path === selectedReferencePath ||
          seed.metadata?.template_ref === selectedReferencePath
      ) || null
    : null;
  const nextAction = data.nextActions?.[0] || null;
  const nextActions = Array.isArray(data.nextActions) ? data.nextActions : [];
  const memoryCandidateCount = (data.memoryCandidates || []).length;
  return (
    <div className="w-full h-full flex flex-col gap-6 overflow-y-auto pr-1">
      <MissionIntelligenceDangerousActionDialog
        context={{ dangerousAction, clearDangerousAction, confirmDangerousAction }}
      />

      <MissionIntelligenceSurfaceOverview
        context={{
          workspace,
          focusedView,
          selectedProject,
          selectedMissionId,
          showMissionDetails,
          setShowMissionDetails,
          mt,
          data,
          attentionItems,
          missionExceptions,
          surfaceExceptions,
          deliveryExceptions,
          panelVisible,
          nextActions,
          nextAction,
          nextActionTarget,
          runNextAction,
          jumpToNextActionRoute,
          selectedTrack,
          selectedProjectManagement,
          selectedMission,
          setSelectedMissionId,
          setSelectedProjectId,
          setSelectedTrackId,
          trackSeedTarget,
          memoryPromotionTarget,
          actionResult,
          runMemoryPromotion,
          runAttentionAction,
          focusTitle,
          missionSeedAssessment,
          memoryCandidateCount,
          runtime,
          runtimeLeases,
          runtimeDoctor,
        }}
      />

      <MissionIntelligenceMissionPanel
        context={{
          data,
          locale,
          mt,
          missionActionText,
          selectedProject,
          selectedProjectId,
          selectedProjectBootstrapItems,
          selectedTrackId,
          missionActionTarget,
          missionSeedTarget,
          trackSeedTarget,
          remediationTarget,
          outboxTarget,
          expandedMissionCardActionId,
          expandedActionId,
          selectedReferencePath,
          referenceDetail,
          referenceMetadataEntries,
          referenceSections,
          selectedReferenceSeed,
          effectiveMissionId,
          learnedProjectRefs,
          learnedMissionSeedRefs,
          deliveryExceptions,
          filteredMissions,
          filteredServiceBindings,
          filteredPendingApprovalsByTrack,
          filteredMemoryCandidatesByTrack,
          filteredMissionSeedsByTrack,
          hydratedTracks,
          missionProgress,
          runtime,
          runtimeLeases,
          runtimeDoctor,
          runtimeTopology,
          recentSurfaceOutbox,
          projectManagement,
          missionSeedAssessment,
          requestDangerousAction,
          clearOutboxMessage,
          createTrackSeed,
          focusMissionCard,
          focusMissionThread,
          openKnowledgeReference,
          openRuntimeReference,
          promoteMissionSeed,
          remediateLease,
          runMissionControl,
          setSelectedMissionId,
          setSelectedProjectId,
          setSelectedTrackId,
          setMessageMissionFilter,
          setExpandedMissionCardActionId,
          jumpToTarget,
          panelVisible,
          buildMissionIntentSummary,
        }}
      />

      <MissionIntelligenceAgentTrafficPanel
        context={{
          data,
          mt,
          panelVisible,
          messageMissionFilter,
          setMessageMissionFilter,
          setSelectedMissionId,
          filteredMissions,
          filteredAgentMessages,
          missionThreadPanelRef,
          effectiveMissionId,
          missionPinStatusLabel,
          focusMissionCard,
          missionThread,
          filteredA2AHandoffs,
        }}
      />

      <MissionIntelligenceRuntimePanel
        context={{
          data,
          locale,
          mt,
          panelVisible,
          runtime,
          runtimeLeases,
          runtimeDoctor,
          runtimeTopology,
          recentSurfaceOutbox,
          browserSessionTarget,
          surfaceActionTarget,
          expandedSurfaceCardActionId,
          filteredMissions,
          filteredAgentMessages,
          filteredA2AHandoffs,
          missionThread,
          effectiveMissionId,
          missionPinStatusLabel,
          focusMissionCard,
          runBrowserSessionControl,
          runSurfaceControl,
          setBrowserSessionTarget,
          setSurfaceActionTarget,
          setExpandedSurfaceCardActionId,
          setSelectedMissionId,
          setMessageMissionFilter,
          selectedMissionId,
          missionExceptions,
          surfaceExceptions,
          deliveryExceptions,
          selectedProject,
          selectedProjectId,
          selectedTrackId,
          selectedProjectBootstrapItems,
          selectedReferencePath,
          referenceDetail,
          referenceMetadataEntries,
          referenceSections,
          openKnowledgeReference,
          openRuntimeReference,
          clearOutboxMessage,
          outboxTarget,
          setOutboxTarget,
          remediationTarget,
          remediateLease,
          setRemediationTarget,
          requestDangerousAction,
          clearDangerousAction,
          confirmDangerousAction,
          dangerousAction,
          actionResult,
          setActionResult,
          selectedProjectManagement,
          filteredServiceBindings,
          filteredMissionSeedsByTrack,
          hydratedTracks,
          missionProgress,
          projectManagement,
          missionSeedAssessment,
          selectedTrack,
        }}
      />

      <MissionIntelligenceApprovalsPanel
        context={{
          data,
          locale,
          mt,
          selectedProject,
          selectedProjectId,
          selectedProjectBootstrapItems,
          selectedTrackId,
          missionActionTarget,
          missionSeedTarget,
          trackSeedTarget,
          remediationTarget,
          outboxTarget,
          expandedMissionCardActionId,
          selectedReferencePath,
          referenceDetail,
          referenceMetadataEntries,
          referenceSections,
          selectedReferenceSeed,
          effectiveMissionId,
          learnedProjectRefs,
          learnedMissionSeedRefs,
          deliveryExceptions,
          filteredMissions,
          filteredServiceBindings,
          filteredMissionSeedsByTrack,
          hydratedTracks,
          missionProgress,
          runtime,
          runtimeLeases,
          runtimeDoctor,
          runtimeTopology,
          recentSurfaceOutbox,
          projectManagement,
          missionSeedAssessment,
          requestDangerousAction,
          clearOutboxMessage,
          createTrackSeed,
          focusMissionCard,
          focusMissionThread,
          openKnowledgeReference,
          openRuntimeReference,
          promoteMissionSeed,
          remediateLease,
          runMissionControl,
          setSelectedMissionId,
          setSelectedProjectId,
          setSelectedTrackId,
          setMessageMissionFilter,
          setExpandedMissionCardActionId,
          panelVisible,
          buildMissionIntentSummary,
        }}
      />
    </div>
  );
}
