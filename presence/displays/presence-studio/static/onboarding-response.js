const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VOICE_STATUSES = new Set(['ready', 'needs_setup', 'unsupported']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasSafeTree(value) {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value) {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(value) {
  return value === undefined || typeof value === 'string';
}

function nonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function stringMap(value) {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function optionalRecord(value) {
  return value === undefined || value === null || isRecord(value);
}

function recordArray(value) {
  return Array.isArray(value) && value.every(isRecord);
}

function parseArray(value, parser) {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map(parser);
  return parsed.every((entry) => entry !== undefined) ? parsed : undefined;
}

function parseBrowserState(value) {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  const providers = value.providers;
  if (
    !isRecord(providers) ||
    !stringArray(providers.priority) ||
    !stringMap(providers.default_models)
  ) {
    return undefined;
  }
  if (!optionalRecord(value.identity) || !optionalRecord(value.agent_identity)) return undefined;
  if (isRecord(value.identity)) {
    for (const key of ['name', 'language', 'interaction_style', 'primary_domain', 'agent_id']) {
      if (!optionalString(value.identity[key])) return undefined;
    }
  }
  if (isRecord(value.agent_identity) && !optionalString(value.agent_identity.agent_id)) {
    return undefined;
  }
  if (value.onboarding !== undefined && value.onboarding !== null) {
    if (!isRecord(value.onboarding)) return undefined;
    if (
      value.onboarding.services !== undefined &&
      !parseArray(value.onboarding.services, (entry) =>
        isRecord(entry) && nonEmptyString(entry.service_id) ? entry : undefined
      )
    ) {
      return undefined;
    }
    if (
      value.onboarding.voice !== undefined &&
      (!isRecord(value.onboarding.voice) || !optionalString(value.onboarding.voice.engine_id))
    ) {
      return undefined;
    }
  }
  if (!recordArray(value.voice_profiles) || !recordArray(value.service_bindings)) return undefined;
  if (value.allowed_services !== undefined && !stringArray(value.allowed_services))
    return undefined;

  const readiness = value.readiness;
  if (readiness !== undefined) {
    if (!isRecord(readiness) || !optionalRecord(readiness.microphone)) return undefined;
    if (isRecord(readiness.microphone)) {
      if (
        typeof readiness.microphone.available !== 'boolean' ||
        !optionalString(readiness.microphone.reason)
      ) {
        return undefined;
      }
    }
  }

  const reasoning = value.reasoning_selection;
  if (!isRecord(reasoning) || !isRecord(reasoning.preferences)) return undefined;
  if (
    !optionalString(reasoning.preferences.provider) ||
    !optionalString(reasoning.preferences.model_id) ||
    !parseArray(reasoning.candidates, (entry) =>
      isRecord(entry) &&
      nonEmptyString(entry.provider) &&
      nonEmptyString(entry.display_name) &&
      nonEmptyString(entry.status) &&
      typeof entry.selectable === 'boolean' &&
      stringArray(entry.model_ids) &&
      optionalString(entry.reason)
        ? entry
        : undefined
    )
  ) {
    return undefined;
  }

  const adapterDefaults = value.adapter_defaults;
  if (
    !isRecord(adapterDefaults) ||
    !parseArray(adapterDefaults.categories, (entry) => {
      if (
        !isRecord(entry) ||
        !nonEmptyString(entry.key) ||
        !nonEmptyString(entry.display_name) ||
        !optionalString(entry.selected_id)
      ) {
        return undefined;
      }
      return parseArray(entry.candidates, (candidate) =>
        isRecord(candidate) &&
        nonEmptyString(candidate.id) &&
        nonEmptyString(candidate.display_name) &&
        nonEmptyString(candidate.status) &&
        typeof candidate.selectable === 'boolean' &&
        optionalString(candidate.reason)
          ? candidate
          : undefined
      )
        ? entry
        : undefined;
    })
  ) {
    return undefined;
  }
  return value;
}

function parseOnboardingPreview(value) {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !hasSafeTree(value) ||
    !isRecord(value.draft) ||
    !stringArray(value.warnings) ||
    !stringArray(value.blockers)
  ) {
    return undefined;
  }
  const effects = parseArray(value.effects, (entry) =>
    isRecord(entry) &&
    nonEmptyString(entry.kind) &&
    nonEmptyString(entry.path) &&
    nonEmptyString(entry.description)
      ? entry
      : undefined
  );
  return effects ? { ...value, effects } : undefined;
}

function parseOnboardingApply(value) {
  return isRecord(value) &&
    value.ok === true &&
    hasSafeTree(value) &&
    nonEmptyString(value.applied_at) &&
    stringArray(value.artifacts) &&
    stringArray(value.warnings)
    ? value
    : undefined;
}

function parseVoiceSample(value) {
  return isRecord(value) &&
    hasSafeTree(value) &&
    nonEmptyString(value.sample_ref) &&
    nonNegativeInteger(value.bytes) &&
    nonEmptyString(value.content_type)
    ? value
    : undefined;
}

function parseVoiceSelection(value) {
  if (!isRecord(value) || value.ok !== true || !hasSafeTree(value)) return undefined;
  if (!isRecord(value.preferences) || !nonEmptyString(value.preferences.tts_engine_id)) {
    return undefined;
  }
  if (!isRecord(value.tts) || !nonEmptyString(value.tts.selected_engine_id)) return undefined;
  const candidates = parseArray(value.tts.candidates, (entry) =>
    isRecord(entry) &&
    nonEmptyString(entry.engine_id) &&
    nonEmptyString(entry.display_name) &&
    nonEmptyString(entry.provider) &&
    VOICE_STATUSES.has(entry.status) &&
    typeof entry.selectable === 'boolean' &&
    optionalString(entry.reason)
      ? entry
      : undefined
  );
  return candidates ? { ...value, tts: { ...value.tts, candidates } } : undefined;
}

export {
  parseBrowserState,
  parseOnboardingPreview,
  parseOnboardingApply,
  parseVoiceSample,
  parseVoiceSelection,
};
