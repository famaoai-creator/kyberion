import { matchesIntentPhrase } from '../intent/intent-phrase-lexicon.js';
function normalizeRoleHintText(value: string | undefined): string {
  return String(value || '')
    .trim()
    .toLowerCase();
}

export function summarizeRequestText(request: string): string {
  const normalized = request.trim().replace(/\s+/g, ' ');
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

export function inferOptionalRoleHints(request: string): string[] {
  const text = normalizeRoleHintText(request);
  const hints = new Set<string>();
  if (matchesIntentPhrase(text, 'mission_team.role_hint_experience_designer'))
    hints.add('experience_designer');
  if (matchesIntentPhrase(text, 'mission_team.role_hint_product_strategist'))
    hints.add('product_strategist');
  if (matchesIntentPhrase(text, 'mission_team.role_hint_operator')) hints.add('operator');
  if (matchesIntentPhrase(text, 'mission_team.role_hint_surface_liaison'))
    hints.add('surface_liaison');
  return Array.from(hints);
}

export function inferMissingInputs(request: string, artifactPaths: string[] | undefined): string[] {
  const text = normalizeRoleHintText(request);
  const artifacts = (artifactPaths || []).map((entry) => entry.toLowerCase());
  const missing: string[] = [];

  if (!text) missing.push('request_text');
  if (matchesIntentPhrase(text, 'mission_team.missing_reference_context')) {
    missing.push('reference_context');
  }
  if (matchesIntentPhrase(text, 'mission_team.missing_voice_profile')) {
    const hasVoiceProfile = artifacts.some(
      (entry) => entry.includes('voice-profile') || entry.includes('voice_profile')
    );
    if (!hasVoiceProfile) missing.push('voice_profile_id');
  }
  if (matchesIntentPhrase(text, 'mission_team.missing_design_system')) {
    const hasDesignInput = artifacts.some(
      (entry) =>
        entry.includes('design-system') ||
        entry.includes('design_system') ||
        entry.includes('brand-guideline')
    );
    if (!hasDesignInput) missing.push('design_system_reference');
  }

  return missing;
}
