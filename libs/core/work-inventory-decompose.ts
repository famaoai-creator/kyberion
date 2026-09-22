/**
 * WI-04: free-text decomposition of a business task into a draft
 * `WorkInventoryEntry`.
 *
 * Per docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md
 * §2.1/§2.2 ("LLM は分解の提案だけを担う。手段は必ず規則で再判定"), this module
 * has exactly one job: turn a free-text description into an ordered list of
 * `{stage, verb, description, system?, effects[], data_sensitivity}` steps.
 * An LLM may *propose* a `method_proposal` per step, but `applyClassification`
 * (WI-02) always re-derives the final `method` from the governed taxonomy
 * rules — the model never decides the method directly.
 *
 * Two decomposition paths:
 *  - model: delegates to a reasoning backend (`ReasoningBackend.delegateTask`)
 *    with a prompt that lists the allowed stage/verb/effect/method enums read
 *    from the taxonomy (never hardcoded) and expects strict JSON back.
 *  - heuristic: deterministic, offline. Splits the description on arrows,
 *    newlines, bullets, and Japanese sentence breaks, then maps each fragment
 *    to a verb via the taxonomy's per-verb `keywords.ja` / `keywords.en`
 *    lists (WI-04 addition to `WorkInventoryVerbDef`).
 *
 * Effect detection on the heuristic path reads `effects[].keywords` (and
 * `only_with_verbs`) from the same taxonomy, so both tables are data.
 *
 * The model path never decides the method or fails the call: an unusable
 * reply, a thrown error, a timeout, or the deterministic stub backend all
 * fall back to the heuristic path with a `warnings[]` entry explaining why.
 */
import { getReasoningBackend, type ReasoningBackend } from './reasoning-backend.js';
import { parseStructuredJson } from './structured-reasoning.js';
import { nowIso } from './foundation/time.js';
import {
  applyClassification,
  createWorkInventoryEntry,
  loadWorkInventoryTaxonomy,
  validateWorkInventoryEntry,
  type WorkDataSensitivity,
  type WorkEffect,
  type WorkInventoryEntry,
  type WorkInventoryFrequency,
  type WorkInventoryObservation,
  type WorkInventoryScope,
  type WorkInventoryStep,
  type WorkInventoryStepMethod,
  type WorkInventoryTaxonomy,
  type WorkInventoryTrigger,
  type WorkMethod,
  type WorkStage,
  type WorkVerb,
} from './work-inventory.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ProposeWorkDecompositionInput {
  title: string;
  description: string;
  scope: WorkInventoryScope;
  systems?: string[];
  /** System names (case-insensitive match against `systems`) that already have a service-binding API. */
  apiSystems?: string[];
  trigger?: WorkInventoryTrigger;
  frequency?: WorkInventoryFrequency;
  effort_minutes_per_run?: number;
}

export interface ProposeWorkDecompositionOptions {
  /** Test seam: a fake/limited backend. Defaults to `getReasoningBackend()`. */
  backend?: Pick<ReasoningBackend, 'delegateTask'>;
  /** Set false to skip the model path entirely and go straight to heuristic. Default true. */
  useModel?: boolean;
  timeoutMs?: number;
  now?: Date;
  taxonomy?: WorkInventoryTaxonomy;
}

export interface ProposeWorkDecompositionResult {
  entry: WorkInventoryEntry;
  warnings: string[];
  source: 'model' | 'heuristic';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_STEPS = 40;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Not carried by the taxonomy catalog (see module doc); closed enum matching `WorkDataSensitivity`. */
const DATA_SENSITIVITY_VALUES: readonly WorkDataSensitivity[] = [
  'public',
  'internal',
  'confidential',
  'personal',
];

/** Local effect-keyword table — see module doc for why this isn't in the taxonomy JSON. */

// ---------------------------------------------------------------------------
// Draft step (pre-classification)
// ---------------------------------------------------------------------------

interface DraftStep {
  description: string;
  verb: WorkVerb;
  stage: WorkStage;
  effects: WorkEffect[];
  data_sensitivity: WorkDataSensitivity;
  system?: string;
  /** Only set on the model path when the reply carried a usable `method_proposal`. */
  method?: WorkInventoryStepMethod;
}

function buildStep(draft: DraftStep, index: number): WorkInventoryStep {
  return {
    step_id: `S${index + 1}`,
    stage: draft.stage,
    verb: draft.verb,
    description: draft.description,
    ...(draft.system ? { system: draft.system } : {}),
    data_sensitivity: draft.data_sensitivity,
    effects: draft.effects,
    // No proposal on the heuristic path: 'rule' source tells applyClassification
    // there is nothing to compare against, so the rationale stays single-reason.
    method: draft.method ?? {
      assigned: 'human',
      source: 'rule',
      rationale: 'placeholder pending rule classification',
    },
  };
}

// ---------------------------------------------------------------------------
// Heuristic path
// ---------------------------------------------------------------------------

const ARROW_PATTERN = /→|⇒|->/g;
const BULLET_PREFIX_PATTERN = /^\s*(?:[-*・•]|\d+[.)、]|[①②③④⑤⑥⑦⑧⑨⑩])\s*/;

/** Splits on arrows/newlines/bullets first, then Japanese sentence breaks within each line. */
function splitFragments(description: string): string[] {
  const normalized = description.replace(/\r\n/g, '\n').replace(ARROW_PATTERN, '\n');
  const fragments: string[] = [];
  for (const rawLine of normalized.split('\n')) {
    const withoutBullet = rawLine.replace(BULLET_PREFIX_PATTERN, '').trim();
    if (!withoutBullet) continue;
    const sentences = withoutBullet
      .split(/(?<=。)/)
      .map((part) => part.trim())
      .filter(Boolean);
    fragments.push(...(sentences.length > 0 ? sentences : [withoutBullet]));
  }
  return fragments;
}

/**
 * Picks the verb whose keyword list contains a match starting earliest in
 * the fragment; ties (same start index) resolve to the verb declared first
 * in the taxonomy's `verbs` array. Falls back to `read` (generic
 * understand/process) when nothing matches.
 */
function pickVerbForFragment(fragment: string, taxonomy: WorkInventoryTaxonomy): WorkVerb {
  const lowerFragment = fragment.toLowerCase();
  let bestVerb: WorkVerb | undefined;
  let bestPosition = Number.POSITIVE_INFINITY;
  let bestVerbIndex = Number.POSITIVE_INFINITY;

  taxonomy.verbs.forEach((verbDef, verbIndex) => {
    const keywords = [...(verbDef.keywords?.ja ?? []), ...(verbDef.keywords?.en ?? [])];
    for (const keyword of keywords) {
      if (!keyword) continue;
      const position = lowerFragment.indexOf(keyword.toLowerCase());
      if (position === -1) continue;
      if (position < bestPosition || (position === bestPosition && verbIndex < bestVerbIndex)) {
        bestVerb = verbDef.id;
        bestPosition = position;
        bestVerbIndex = verbIndex;
      }
    }
  });

  return bestVerb ?? 'read';
}

function detectEffects(
  fragment: string,
  verb: WorkVerb,
  taxonomy: WorkInventoryTaxonomy
): WorkEffect[] {
  const lowerFragment = fragment.toLowerCase();
  const effects: WorkEffect[] = [];
  for (const effect of taxonomy.effects) {
    if (effect.only_with_verbs && !effect.only_with_verbs.includes(verb)) continue;
    const keywords = [...(effect.keywords?.ja ?? []), ...(effect.keywords?.en ?? [])];
    const hit = keywords.some((keyword) => lowerFragment.includes(keyword.toLowerCase()));
    if (hit) effects.push(effect.id);
  }
  return effects;
}

function detectSystem(fragment: string, systems: string[] | undefined): string | undefined {
  if (!systems || systems.length === 0) return undefined;
  const lowerFragment = fragment.toLowerCase();
  return systems.find((system) => system && lowerFragment.includes(system.toLowerCase()));
}

function heuristicDecompose(
  description: string,
  systems: string[] | undefined,
  taxonomy: WorkInventoryTaxonomy,
  warnings: string[]
): DraftStep[] {
  const fragments = splitFragments(description);
  if (fragments.length === 0) {
    warnings.push('heuristic decomposition found no fragments in the description');
    return [];
  }
  if (fragments.length > MAX_STEPS) {
    warnings.push(
      `description split into ${fragments.length} fragments; truncated to the first ${MAX_STEPS}`
    );
  }

  return fragments.slice(0, MAX_STEPS).map((fragment, index) => {
    const verb = pickVerbForFragment(fragment, taxonomy);
    const verbDef = taxonomy.verbs.find((entry) => entry.id === verb);
    const defaultStage = verbDef?.default_stage ?? 'act';
    const stage: WorkStage = index === 0 && verb === 'receive' ? 'trigger' : defaultStage;
    const effects = detectEffects(fragment, verb, taxonomy);
    const data_sensitivity: WorkDataSensitivity = effects.includes('personal_data')
      ? 'personal'
      : 'internal';
    const system = detectSystem(fragment, systems);
    return { description: fragment, verb, stage, effects, data_sensitivity, system };
  });
}

// ---------------------------------------------------------------------------
// Model path
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildDecompositionPrompt(
  input: ProposeWorkDecompositionInput,
  taxonomy: WorkInventoryTaxonomy
): string {
  const stageIds = taxonomy.stages.map((stage) => stage.id).join(', ');
  const verbIds = taxonomy.verbs.map((verb) => verb.id).join(', ');
  const effectIds = taxonomy.effects.map((effect) => effect.id).join(', ');
  const methodIds = taxonomy.methods.map((method) => method.id).join(', ');
  const dataSensitivityIds = DATA_SENSITIVITY_VALUES.join(', ');
  const systemsHint = input.systems?.length ? `Known systems: ${input.systems.join(', ')}.` : '';

  return [
    'You decompose a free-text description of a business task into an ordered list of concrete steps for a work inventory.',
    '',
    `Task title: ${input.title}`,
    `Task description: ${input.description}`,
    systemsHint,
    '',
    `Allowed stage values: ${stageIds}`,
    `Allowed verb values: ${verbIds}`,
    `Allowed effect values (zero or more per step): ${effectIds}`,
    `Allowed data_sensitivity values: ${dataSensitivityIds}`,
    `Allowed method_proposal values (your best guess only; a separate rule engine always re-decides the final method): ${methodIds}`,
    '',
    'Respond with strict JSON only, no markdown fences, no commentary, matching exactly this shape:',
    '{"steps": [{"stage": "...", "verb": "...", "description": "...", "system": "...", "effects": ["..."], "data_sensitivity": "...", "method_proposal": "...", "why": "..."}]}',
    '',
    `Each step requires "description". "stage", "system", "effects", "data_sensitivity", "method_proposal", and "why" are optional. Emit at most ${MAX_STEPS} steps, one per concrete action, in order.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Races `backend.delegateTask` against a timer; never lets the caller hang. */
function delegateWithTimeout(
  backend: Pick<ReasoningBackend, 'delegateTask'>,
  prompt: string,
  context: string,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const unref = (timer as unknown as { unref?: () => void }).unref;
  if (typeof unref === 'function') unref.call(timer);
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(new Error(`[WORK_INVENTORY_DECOMPOSE_TIMEOUT] generation exceeded ${timeoutMs}ms`));
    });
  });
  return Promise.race([
    backend.delegateTask(prompt, context, { signal: controller.signal }),
    timedOut,
  ]).finally(() => clearTimeout(timer));
}

function parseModelSteps(
  raw: string,
  taxonomy: WorkInventoryTaxonomy,
  warnings: string[]
): DraftStep[] {
  const json = parseStructuredJson(raw, 'work-inventory-decompose');
  if (
    !json ||
    typeof json !== 'object' ||
    !Array.isArray((json as Record<string, unknown>).steps)
  ) {
    throw new Error('reply did not contain a "steps" array');
  }
  const rawSteps = (json as { steps: unknown[] }).steps;

  const verbIds = new Set<string>(taxonomy.verbs.map((verb) => verb.id));
  const stageIds = new Set<string>(taxonomy.stages.map((stage) => stage.id));
  const effectIds = new Set<string>(taxonomy.effects.map((effect) => effect.id));
  const methodIds = new Set<string>(taxonomy.methods.map((method) => method.id));
  const verbDefaultStage = new Map(taxonomy.verbs.map((verb) => [verb.id, verb.default_stage]));

  const drafts: DraftStep[] = [];
  rawSteps.forEach((rawStep, index) => {
    if (drafts.length >= MAX_STEPS) return;
    if (!rawStep || typeof rawStep !== 'object') {
      warnings.push(`model step ${index + 1} dropped: not an object`);
      return;
    }
    const obj = rawStep as Record<string, unknown>;

    const description = typeof obj.description === 'string' ? obj.description.trim() : '';
    if (!description) {
      warnings.push(`model step ${index + 1} dropped: missing description`);
      return;
    }

    const verb =
      typeof obj.verb === 'string' && verbIds.has(obj.verb) ? (obj.verb as WorkVerb) : undefined;
    if (!verb) {
      warnings.push(`model step ${index + 1} dropped: invalid verb "${String(obj.verb)}"`);
      return;
    }

    const stage: WorkStage =
      typeof obj.stage === 'string' && stageIds.has(obj.stage)
        ? (obj.stage as WorkStage)
        : (verbDefaultStage.get(verb) ?? 'act');

    const effects: WorkEffect[] = Array.isArray(obj.effects)
      ? obj.effects.filter(
          (effect): effect is WorkEffect => typeof effect === 'string' && effectIds.has(effect)
        )
      : [];

    const data_sensitivity: WorkDataSensitivity =
      typeof obj.data_sensitivity === 'string' &&
      DATA_SENSITIVITY_VALUES.includes(obj.data_sensitivity as WorkDataSensitivity)
        ? (obj.data_sensitivity as WorkDataSensitivity)
        : effects.includes('personal_data')
          ? 'personal'
          : 'internal';

    const system =
      typeof obj.system === 'string' && obj.system.trim() ? obj.system.trim() : undefined;

    let method: WorkInventoryStepMethod | undefined;
    if (typeof obj.method_proposal === 'string' && methodIds.has(obj.method_proposal)) {
      const why =
        typeof obj.why === 'string' && obj.why.trim()
          ? obj.why.trim()
          : `model proposed ${obj.method_proposal}`;
      method = { assigned: obj.method_proposal as WorkMethod, source: 'proposal', rationale: why };
    }

    drafts.push({ description, verb, stage, effects, data_sensitivity, system, method });
  });

  return drafts;
}

function resolveBackend(options: ProposeWorkDecompositionOptions): {
  backend: Pick<ReasoningBackend, 'delegateTask'>;
  isStub: boolean;
} {
  if (options.backend) return { backend: options.backend, isStub: false };
  const backend = getReasoningBackend();
  return { backend, isStub: backend.name === 'stub' };
}

async function tryModelDecomposition(
  input: ProposeWorkDecompositionInput,
  taxonomy: WorkInventoryTaxonomy,
  options: ProposeWorkDecompositionOptions,
  warnings: string[]
): Promise<DraftStep[] | null> {
  const { backend, isStub } = resolveBackend(options);
  if (isStub) {
    warnings.push(
      'reasoning backend is the deterministic stub; using heuristic decomposition instead of a model proposal'
    );
    return null;
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const prompt = buildDecompositionPrompt(input, taxonomy);

  let raw: string;
  try {
    raw = await delegateWithTimeout(
      backend,
      prompt,
      `work-inventory-decompose:${input.title}`,
      timeoutMs
    );
  } catch (error) {
    warnings.push(
      `model decomposition call failed (${errorMessage(error)}); using heuristic decomposition instead`
    );
    return null;
  }

  let steps: DraftStep[];
  try {
    steps = parseModelSteps(raw, taxonomy, warnings);
  } catch (error) {
    warnings.push(
      `model decomposition reply was unusable (${errorMessage(error)}); using heuristic decomposition instead`
    );
    return null;
  }

  if (steps.length === 0) {
    warnings.push(
      'model decomposition reply had no valid steps; using heuristic decomposition instead'
    );
    return null;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Turns a free-text task description into a draft `WorkInventoryEntry`.
 * Never rejects on a model failure — an unusable model path always falls
 * back to the deterministic heuristic path, recording why in `warnings`.
 */
export async function proposeWorkDecomposition(
  input: ProposeWorkDecompositionInput,
  options: ProposeWorkDecompositionOptions = {}
): Promise<ProposeWorkDecompositionResult> {
  const now = options.now ?? new Date();
  const taxonomy = options.taxonomy ?? loadWorkInventoryTaxonomy();
  const warnings: string[] = [];
  const useModel = options.useModel !== false;

  let draftSteps: DraftStep[] | null = null;
  if (useModel) {
    draftSteps = await tryModelDecomposition(input, taxonomy, options, warnings);
  }
  const source: 'model' | 'heuristic' = draftSteps ? 'model' : 'heuristic';
  if (!draftSteps) {
    draftSteps = heuristicDecompose(input.description, input.systems, taxonomy, warnings);
  }

  const steps = draftSteps.map((draft, index) => buildStep(draft, index));

  let entry = createWorkInventoryEntry(
    {
      title: input.title,
      scope: input.scope,
      trigger: input.trigger ?? {
        kind: 'ad_hoc',
        description: (input.description.trim() || input.title).slice(0, 500),
      },
      ...(input.frequency ? { frequency: input.frequency } : {}),
      ...(input.effort_minutes_per_run !== undefined
        ? { effort_minutes_per_run: input.effort_minutes_per_run }
        : {}),
      ...(input.systems ? { systems: input.systems } : {}),
      steps,
    },
    now
  );

  entry = applyClassification(entry, { apiSystems: input.apiSystems }, taxonomy);

  const observation: WorkInventoryObservation = {
    source: 'self_report',
    ref: `decompose:${source}`,
    observed_at: nowIso(now),
    digest: `${steps.length} steps`,
  };
  entry = { ...entry, observations: [...(entry.observations ?? []), observation] };

  const check = validateWorkInventoryEntry(entry);
  if (!check.valid) {
    throw new Error(
      `proposeWorkDecomposition produced an invalid entry: ${check.errors.join('; ')}`
    );
  }

  return { entry, warnings, source };
}
