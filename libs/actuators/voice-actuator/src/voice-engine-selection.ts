/**
 * TTS engine routing for voice-actuator ops (voice-tts-engine seam).
 *
 * Contract (knowledge/product/architecture/seam-provider-selection.md):
 *   - an engine the caller names explicitly always wins (no selection);
 *     a language it does not declare only produces a warning;
 *   - otherwise governed selection runs only when a purpose is given, an
 *     operator rule matches this request, or the engine the caller would get
 *     today cannot run the request (language / format / local-only / identity)
 *     and the policy has a fallback purpose; in every other case the engine
 *     is exactly the one the op resolved before;
 *   - identity guard: a personal voice engine (enforce_clone_engine_for_personal_tier
 *     or require_personal_voice) is never switched for preference (purpose or
 *     rules); only when it cannot speak the request may another clone engine
 *     (same reference samples) take over, else the request is blocked.
 */

import { matchSeamSelectionRule } from '@agent/core/seam-selection-rules';
import { getSeamSelectionPolicy } from '@agent/core/seam-provider-selection';
import {
  detectTextLanguage,
  normalizeLanguageTag,
  selectVoiceTtsEngine,
  unmetVoiceTtsRequirements,
  VOICE_TTS_ENGINE_SEAM,
  VoiceTtsEngineSelectionError,
  type VoiceEngineRecord,
  type VoiceTtsRequirements,
} from '@agent/core/voice-engine-registry';

export interface VoiceEngineRoutingInput {
  text: string;
  /** The engine the op resolves today (named engine or default, after platform fallback). */
  baselineEngine: VoiceEngineRecord;
  /** True when the caller named the engine (params.engine_id / engine.engine_id). */
  explicit: boolean;
  purpose?: string;
  /** Explicit request language; otherwise detected from the text. */
  language?: string;
  requires?: Omit<VoiceTtsRequirements, 'language'>;
  /** Identity guard for personal voice profiles. */
  personalVoiceLocked?: boolean;
}

export interface VoiceEngineSelectionSummary {
  seam: string;
  /** Why selection ran: a purpose, operator rules, the caller's engine could not run, or the identity guard. */
  trigger: 'purpose' | 'rules' | 'fallback' | 'identity_guard';
  strategy: string;
  purpose?: string;
  rule_id?: string;
  ranked: string[];
  excluded: Array<{ id: string; unmet: string[] }>;
  rationale: string;
}

export interface VoiceEngineRouting {
  engine: VoiceEngineRecord;
  /** Primary subtag the request is spoken in. */
  language: string;
  language_source: 'explicit' | 'detected';
  /** Ranked engine ids for rendering; set only when selection chose the engine. */
  candidateEngineIds?: string[];
  selection?: VoiceEngineSelectionSummary;
  warnings: string[];
  /** Set when the identity guard leaves no engine that can run the request. */
  blocked?: string;
}

function summarize(
  decision: ReturnType<typeof selectVoiceTtsEngine>['decision'],
  trigger: VoiceEngineSelectionSummary['trigger']
): VoiceEngineSelectionSummary {
  return {
    seam: decision.seam,
    trigger,
    strategy: decision.strategy,
    ...(decision.purpose ? { purpose: decision.purpose } : {}),
    ...(decision.rule_id ? { rule_id: decision.rule_id } : {}),
    ranked: decision.ranked,
    excluded: decision.excluded,
    rationale: decision.rationale,
  };
}

export function routeVoiceEngine(input: VoiceEngineRoutingInput): VoiceEngineRouting {
  const explicitLanguage = normalizeLanguageTag(input.language);
  const language = explicitLanguage || detectTextLanguage(input.text);
  const languageSource = explicitLanguage ? 'explicit' : 'detected';
  const purpose = String(input.purpose || '').trim();
  const baseline = input.baselineEngine;
  const requires: VoiceTtsRequirements = { ...(input.requires ?? {}), language };
  const warnings: string[] = [];
  const keep = (): VoiceEngineRouting => ({
    engine: baseline,
    language,
    language_source: languageSource,
    warnings,
  });

  if (input.explicit) {
    if (purpose) {
      warnings.push(
        `purpose '${purpose}' ignored: engine '${baseline.engine_id}' was named explicitly`
      );
    }
    const unmet = unmetVoiceTtsRequirements(baseline, { language });
    if (unmet.length) {
      warnings.push(
        `engine '${baseline.engine_id}' does not declare language '${language}' (${languageSource}); ` +
          `kept because it was named explicitly`
      );
    }
    return keep();
  }

  const baselineUnmet = unmetVoiceTtsRequirements(baseline, requires);

  if (input.personalVoiceLocked) {
    if (baselineUnmet.length === 0) {
      if (purpose) {
        warnings.push(
          `purpose '${purpose}' ignored: identity guard keeps personal voice engine '${baseline.engine_id}'`
        );
      }
      return keep();
    }
    try {
      // A personal voice's reference samples never leave the machine through
      // an automatic switch: only local clone engines may take over.
      const selection = selectVoiceTtsEngine({
        requires: { ...requires, identity: 'clone', localOnly: true },
      });
      return {
        engine: selection.engines[0]!,
        language,
        language_source: languageSource,
        candidateEngineIds: selection.engines.map((engine) => engine.engine_id),
        selection: summarize(selection.decision, 'identity_guard'),
        warnings: [
          ...warnings,
          `personal voice engine '${baseline.engine_id}' cannot run this request (${baselineUnmet.join(', ')}); ` +
            `switched to clone engine '${selection.engines[0]!.engine_id}' with the same reference samples`,
        ],
      };
    } catch (error) {
      if (!(error instanceof VoiceTtsEngineSelectionError)) throw error;
      return {
        ...keep(),
        selection: summarize(error.decision, 'identity_guard'),
        blocked:
          `personal voice engine '${baseline.engine_id}' cannot run this request (${baselineUnmet.join(', ')}) ` +
          `and no other clone engine can: ${error.decision.rationale}`,
      };
    }
  }

  // Rules exist but none matches this request: keep today's engine exactly.
  const hasRules = Boolean(
    matchSeamSelectionRule(VOICE_TTS_ENGINE_SEAM, { context: { language } })
  );
  const fallbackPurpose =
    baselineUnmet.length > 0
      ? getSeamSelectionPolicy(VOICE_TTS_ENGINE_SEAM)?.fallback_purpose
      : undefined;
  if (!purpose && !hasRules && !fallbackPurpose) return keep();
  const trigger = purpose ? 'purpose' : fallbackPurpose ? 'fallback' : 'rules';

  // The caller's engine (not only the policy default) may be the one that
  // cannot run: rank by the policy's fallback purpose then.
  const effectivePurpose = purpose || fallbackPurpose;
  const selection = selectVoiceTtsEngine({
    ...(effectivePurpose ? { purpose: effectivePurpose } : {}),
    requires,
  });
  // Without a purpose or matching rule the seam default is the policy's, not
  // this caller's: keep the engine the op would have used when it can run.
  if (selection.decision.strategy === 'default' && baselineUnmet.length === 0) {
    return { ...keep(), selection: summarize(selection.decision, trigger) };
  }
  const engine = selection.engines[0]!;
  if (baselineUnmet.length && engine.engine_id !== baseline.engine_id) {
    warnings.push(
      `engine '${baseline.engine_id}' cannot run this request (${baselineUnmet.join(', ')}); using '${engine.engine_id}'`
    );
  }
  return {
    engine,
    language,
    language_source: languageSource,
    candidateEngineIds: selection.engines.map((candidate) => candidate.engine_id),
    selection: summarize(selection.decision, trigger),
    warnings,
  };
}
