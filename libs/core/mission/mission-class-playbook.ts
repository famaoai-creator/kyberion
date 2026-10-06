import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import type { MissionClass, MissionStage } from './mission-classification.js';

export interface MissionClassPlaybookStep {
  stage: MissionStage;
  practice: string;
  know_how: string[];
  evidence: string[];
}

export interface MissionClassPlaybook {
  class_id: MissionClass;
  title_ja: string;
  title_en: string;
  serves: string;
  autonomy: {
    posture: string;
    ai_does: string[];
    human_decides: string[];
    never_ai: string[];
  };
  approach: MissionClassPlaybookStep[];
  quality_bar: string[];
  pitfalls: Array<{ trap: string; countermeasure: string }>;
  escalate_when: string[];
  metrics: string[];
}

export interface MissionClassPlaybookLabels {
  heading_suffix: string;
  posture: string;
  ai_does: string;
  human_decides: string;
  never_ai: string;
  evidence: string;
  pitfalls: string;
  escalate_when: string;
}

export type MissionClassPlaybookLocale = 'ja' | 'en';

export interface MissionClassPlaybookCatalog {
  version: string;
  principles: string[];
  postures: Record<string, string>;
  /** Section labels used when rendering a brief, keyed by locale. */
  labels: Record<string, MissionClassPlaybookLabels>;
  playbooks: MissionClassPlaybook[];
}

/** What a mission carries about how its class should be worked. */
export interface MissionClassPlaybookSummary {
  class_id: MissionClass;
  title_ja: string;
  posture: string;
  posture_description: string;
  human_decides: string[];
  never_ai: string[];
  escalate_when: string[];
  quality_bar: string[];
  /** Markdown guidance for the stage (or the whole approach when no stage is given). */
  brief: string;
}

const playbookCatalog = defineCatalog<MissionClassPlaybookCatalog>({
  id: 'mission-class-playbooks',
  path: () => pathResolver.knowledge('product/governance/mission-class-playbooks.json'),
  schema: pathResolver.knowledge('product/schemas/mission-class-playbooks.schema.json'),
});

export function loadMissionClassPlaybooks(): MissionClassPlaybookCatalog {
  return playbookCatalog.load();
}

export function resolveMissionClassPlaybook(missionClass: MissionClass): MissionClassPlaybook {
  const playbook = loadMissionClassPlaybooks().playbooks.find(
    (candidate) => candidate.class_id === missionClass
  );
  if (!playbook) {
    // Fail closed: a class without a playbook has no defined way of working.
    throw new Error(`No mission class playbook defined for ${missionClass}.`);
  }
  return playbook;
}

function renderStep(step: MissionClassPlaybookStep, labels: MissionClassPlaybookLabels): string[] {
  return [
    `### ${step.stage}`,
    step.practice,
    ...step.know_how.map((item) => `- ${item}`),
    `${labels.evidence}: ${step.evidence.join(' / ')}`,
  ];
}

/**
 * Markdown brief for a worker: the stage's practice and know-how when a stage
 * is given, otherwise the full approach. Always followed by the traps and
 * escalation triggers, which matter at every stage. Playbook content is
 * authored in Japanese; section labels are localized from the catalog.
 */
export function renderMissionClassPlaybookBrief(
  missionClass: MissionClass,
  stage?: MissionStage,
  locale: MissionClassPlaybookLocale = 'ja'
): string {
  const catalog = loadMissionClassPlaybooks();
  const playbook = resolveMissionClassPlaybook(missionClass);
  const labels = catalog.labels[locale] ?? catalog.labels.ja;
  const title = { ja: playbook.title_ja, en: playbook.title_en }[locale] ?? playbook.title_ja;
  const stageSteps = stage ? playbook.approach.filter((step) => step.stage === stage) : [];
  const steps = stageSteps.length > 0 ? stageSteps : playbook.approach;
  return [
    `## ${title} (${playbook.class_id}) ${labels.heading_suffix}`,
    `${labels.posture}: ${playbook.autonomy.posture} — ${catalog.postures[playbook.autonomy.posture] ?? ''}`,
    `${labels.ai_does}: ${playbook.autonomy.ai_does.join(' / ')}`,
    `${labels.human_decides}: ${playbook.autonomy.human_decides.join(' / ')}`,
    `${labels.never_ai}: ${playbook.autonomy.never_ai.join(' / ')}`,
    ...steps.flatMap((step) => renderStep(step, labels)),
    `### ${labels.pitfalls}`,
    ...playbook.pitfalls.map((entry) => `- ${entry.trap} → ${entry.countermeasure}`),
    `### ${labels.escalate_when}`,
    ...playbook.escalate_when.map((item) => `- ${item}`),
  ].join('\n');
}

export function summarizeMissionClassPlaybook(
  missionClass: MissionClass,
  stage?: MissionStage
): MissionClassPlaybookSummary {
  const catalog = loadMissionClassPlaybooks();
  const playbook = resolveMissionClassPlaybook(missionClass);
  return {
    class_id: playbook.class_id,
    title_ja: playbook.title_ja,
    posture: playbook.autonomy.posture,
    posture_description: catalog.postures[playbook.autonomy.posture] ?? '',
    human_decides: playbook.autonomy.human_decides,
    never_ai: playbook.autonomy.never_ai,
    escalate_when: playbook.escalate_when,
    quality_bar: playbook.quality_bar,
    brief: renderMissionClassPlaybookBrief(missionClass, stage),
  };
}
