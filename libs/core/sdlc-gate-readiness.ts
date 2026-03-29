import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from './secure-io.js';
import type { ArtifactRecord } from './artifact-record.js';
import type { ProjectRecord } from './project-registry.js';
import type { ProjectTrackRecord } from './project-track-registry.js';
import type { OrganizationWorkLoopSummary } from './work-design.js';

interface SdlcGateCatalogRecord {
  gates: Array<{
    gate_id: string;
    phase: string;
    scope: 'project' | 'track';
    purpose?: string;
    required_artifacts?: string[];
    exit_criteria?: string[];
  }>;
}

export interface TrackGateReadinessGateSummary {
  gate_id: string;
  phase: string;
  purpose?: string;
  required_artifacts: string[];
  present_artifacts: string[];
  missing_artifacts: string[];
  ready: boolean;
}

export interface TrackGateReadinessSummary {
  track_id: string;
  track_name?: string;
  ready_gate_count: number;
  total_gate_count: number;
  current_gate_id?: string;
  current_phase?: string;
  ready: boolean;
  next_required_artifacts: Array<{
    artifact_id: string;
    template_ref?: string;
  }>;
  gates: TrackGateReadinessGateSummary[];
}

export interface TrackNextWorkProposal {
  artifact_id: string;
  template_ref?: string;
  target_path: string;
  seed_id: string;
  title: string;
  summary: string;
  specialist_id: string;
  mission_type_hint: string;
  work_loop: OrganizationWorkLoopSummary;
}

const GATE_CATALOG_PATH = pathResolver.knowledge('public/governance/sdlc-gate-catalog.json');

let cachedCatalog: SdlcGateCatalogRecord | null = null;

function loadGateCatalog(): SdlcGateCatalogRecord {
  if (cachedCatalog) return cachedCatalog;
  if (!safeExistsSync(GATE_CATALOG_PATH)) {
    cachedCatalog = { gates: [] };
    return cachedCatalog;
  }
  cachedCatalog = JSON.parse(safeReadFile(GATE_CATALOG_PATH, { encoding: 'utf8' }) as string) as SdlcGateCatalogRecord;
  return cachedCatalog;
}

function buildArtifactEvidenceSet(input: { track: ProjectTrackRecord; artifacts: ArtifactRecord[] }): Set<string> {
  const refs = new Set<string>();
  for (const artifact of input.artifacts) {
    if (artifact.project_id !== input.track.project_id) continue;
    if (artifact.track_id && artifact.track_id !== input.track.track_id) continue;
    if (!artifact.track_id && input.track.track_id) continue;
    if (artifact.kind) refs.add(String(artifact.kind).toLowerCase());
    if (artifact.path) {
      const base = path.basename(artifact.path, path.extname(artifact.path)).toLowerCase();
      if (base) refs.add(base);
    }
  }
  return refs;
}

function resolveTemplateRef(artifactId: string): string | undefined {
  const logicalPath = `knowledge/public/templates/blueprints/${artifactId}.md`;
  const resolvedPath = pathResolver.resolve(logicalPath);
  return safeExistsSync(resolvedPath) ? logicalPath : undefined;
}

function sanitizeSeedFragment(value: string): string {
  return String(value).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function inferSpecialistForArtifact(artifactId: string): string {
  if (artifactId.includes('test') || artifactId.includes('validation')) return 'quality-engineer';
  if (artifactId.includes('security') || artifactId.includes('compliance')) return 'risk-compliance';
  if (artifactId.includes('runbook') || artifactId.includes('deployment') || artifactId.includes('rollback')) return 'service-operator';
  return 'ecosystem-architect';
}

function inferMissionTypeForArtifact(artifactId: string): string {
  if (artifactId.includes('test') || artifactId.includes('validation')) return 'verification';
  if (artifactId.includes('deployment') || artifactId.includes('rollback') || artifactId.includes('runbook')) return 'operations';
  if (artifactId.includes('security') || artifactId.includes('compliance')) return 'governance';
  return 'documentation';
}

function phaseDirectoryForPhase(phase?: string): string {
  if (phase === 'define') return '02_define';
  if (phase === 'design') return '03_design';
  if (phase === 'build') return '04_control';
  if (phase === 'validate') return '05_validate';
  if (phase === 'transfer_run' || phase === 'close') return '06_transfer_run';
  return '02_define';
}

export function buildTrackGateReadinessSummary(input: {
  track: ProjectTrackRecord;
  artifacts: ArtifactRecord[];
}): TrackGateReadinessSummary {
  const catalog = loadGateCatalog();
  const evidence = buildArtifactEvidenceSet(input);
  const gates = catalog.gates
    .filter((gate) => gate.scope === 'track')
    .map((gate) => {
      const required = gate.required_artifacts || [];
      const present = required.filter((artifactId) => evidence.has(String(artifactId).toLowerCase()));
      const missing = required.filter((artifactId) => !evidence.has(String(artifactId).toLowerCase()));
      return {
        gate_id: gate.gate_id,
        phase: gate.phase,
        purpose: gate.purpose,
        required_artifacts: required,
        present_artifacts: present,
        missing_artifacts: missing,
        ready: missing.length === 0,
      } satisfies TrackGateReadinessGateSummary;
    });
  const currentGate = gates.find((gate) => !gate.ready);
  return {
    track_id: input.track.track_id,
    track_name: input.track.name,
    ready_gate_count: gates.filter((gate) => gate.ready).length,
    total_gate_count: gates.length,
    current_gate_id: currentGate?.gate_id,
    current_phase: currentGate?.phase,
    ready: gates.length > 0 && gates.every((gate) => gate.ready),
    next_required_artifacts: (currentGate?.missing_artifacts || []).slice(0, 3).map((artifactId) => ({
      artifact_id: artifactId,
      template_ref: resolveTemplateRef(artifactId),
    })),
    gates,
  };
}

export function buildTrackGateReadinessSummaries(input: {
  tracks: ProjectTrackRecord[];
  artifacts: ArtifactRecord[];
}): TrackGateReadinessSummary[] {
  return input.tracks.map((track) => buildTrackGateReadinessSummary({ track, artifacts: input.artifacts }));
}

export function buildTrackNextWorkProposal(input: {
  project: ProjectRecord;
  track: ProjectTrackRecord;
  readiness: TrackGateReadinessSummary;
  artifactId?: string;
}): TrackNextWorkProposal | null {
  const target = input.artifactId
    ? input.readiness.next_required_artifacts.find((artifact) => artifact.artifact_id === input.artifactId)
    : input.readiness.next_required_artifacts[0];
  if (!target) return null;
  const specialistId = inferSpecialistForArtifact(target.artifact_id);
  const missionTypeHint = inferMissionTypeForArtifact(target.artifact_id);
  const seedId = `MSD-${sanitizeSeedFragment(input.track.track_id)}-${sanitizeSeedFragment(target.artifact_id)}`;
  const title = `Prepare ${target.artifact_id} for ${input.track.name}`;
  const summary = target.template_ref
    ? `${input.track.name} is blocked at ${input.readiness.current_gate_id || 'the current gate'}. Prepare ${target.artifact_id} using ${target.template_ref}.`
    : `${input.track.name} is blocked at ${input.readiness.current_gate_id || 'the current gate'}. Prepare ${target.artifact_id}.`;
  const targetPath = path.posix.join(
    'tracks',
    input.track.track_id,
    phaseDirectoryForPhase(input.readiness.current_phase),
    `${target.artifact_id}.md`,
  );
  const workLoop: OrganizationWorkLoopSummary = {
    intent: {
      label: `Prepare ${target.artifact_id}`,
    },
    context: {
      project_id: input.project.project_id,
      project_name: input.project.name,
      track_id: input.track.track_id,
      track_name: input.track.name,
      tier: input.project.tier,
      locale: input.project.primary_locale,
      service_bindings: [],
    },
    resolution: {
      execution_shape: 'mission',
      task_type: 'track_gate_artifact',
    },
    outcome_design: {
      outcome_ids: [target.artifact_id],
      labels: [target.artifact_id],
    },
    teaming: {
      specialist_id: specialistId,
      specialist_label: specialistId,
      team_roles: [],
    },
    authority: {
      requires_approval: false,
    },
    learning: {
      reusable_refs: target.template_ref ? [target.template_ref] : [],
    },
  };
  return {
    artifact_id: target.artifact_id,
    template_ref: target.template_ref,
    target_path: targetPath,
    seed_id: seedId,
    title,
    summary,
    specialist_id: specialistId,
    mission_type_hint: missionTypeHint,
    work_loop: workLoop,
  };
}

export function materializeTrackArtifactSkeleton(input: {
  projectRootPath: string;
  proposal: TrackNextWorkProposal;
}): string | null {
  if (!input.proposal.template_ref) return null;
  const templatePath = pathResolver.resolve(input.proposal.template_ref);
  if (!safeExistsSync(templatePath)) return null;
  const projectRoot = pathResolver.resolve(input.projectRootPath);
  const logicalTarget = input.proposal.target_path;
  const targetPath = path.join(projectRoot, logicalTarget);
  const targetDir = path.dirname(targetPath);
  if (!safeExistsSync(targetDir)) {
    safeMkdir(targetDir, { recursive: true });
  }
  if (!safeExistsSync(targetPath)) {
    const templateBody = safeReadFile(templatePath, { encoding: 'utf8' }) as string;
    safeWriteFile(targetPath, `<!-- Instantiated from ${input.proposal.template_ref} -->\n${templateBody}`);
  }
  return logicalTarget;
}
