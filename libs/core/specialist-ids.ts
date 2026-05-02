export const SPECIALIST_IDS = {
  browserOperator: 'browser-operator',
  documentSpecialist: 'document-specialist',
  harnessEngineer: 'harness-engineer',
  knowledgeSpecialist: 'knowledge-specialist',
  projectLead: 'project-lead',
  serviceOperator: 'service-operator',
  surfaceConcierge: 'surface-concierge',
} as const;

export type SpecialistId = typeof SPECIALIST_IDS[keyof typeof SPECIALIST_IDS];

export const DEFAULT_SPECIALIST_ID: SpecialistId = SPECIALIST_IDS.surfaceConcierge;
