export type DeliverableKind = 'doc' | 'deck' | 'code' | 'media';
export type DeliverableQualitySeverity = 'ok' | 'warn' | 'poor';

export interface DeliverableQualityReport {
  kind: DeliverableKind;
  severity: DeliverableQualitySeverity;
  hard_checks: string[];
  soft_checks: string[];
  reason: string;
}

export function inferDeliverableKind(kind: string): DeliverableKind | null {
  const normalized = String(kind || '')
    .toLowerCase()
    .trim();
  if (!normalized) return null;
  if (
    normalized === 'doc' ||
    normalized === 'docx' ||
    normalized === 'md' ||
    normalized === 'markdown' ||
    normalized === 'txt' ||
    normalized === 'text' ||
    normalized === 'report' ||
    normalized === 'proposal'
  ) {
    return 'doc';
  }
  if (
    normalized === 'deck' ||
    normalized === 'ppt' ||
    normalized === 'pptx' ||
    normalized === 'slide' ||
    normalized === 'slides' ||
    normalized === 'presentation'
  ) {
    return 'deck';
  }
  if (
    normalized === 'code' ||
    normalized === 'ts' ||
    normalized === 'js' ||
    normalized === 'tsx' ||
    normalized === 'jsx' ||
    normalized === 'json' ||
    normalized === 'yaml' ||
    normalized === 'yml' ||
    normalized === 'script'
  ) {
    return 'code';
  }
  if (
    normalized === 'media' ||
    normalized === 'video' ||
    normalized === 'audio' ||
    normalized === 'image' ||
    normalized === 'png' ||
    normalized === 'jpg' ||
    normalized === 'jpeg' ||
    normalized === 'gif' ||
    normalized === 'mp4' ||
    normalized === 'webm' ||
    normalized === 'wav'
  ) {
    return 'media';
  }
  return null;
}

export function qualityScoreFromReport(report: DeliverableQualityReport): number {
  if (report.severity === 'poor') return 0;
  if (report.severity === 'warn') return 50;
  return 100;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNestedRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const metadata = value.metadata;
  return isRecord(metadata) ? metadata : undefined;
}

function readTextCandidate(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return undefined;
  const keys = [
    'text',
    'content',
    'body',
    'markdown',
    'summary',
    'description',
    'document',
    'preview_text',
  ];
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  const nested = readNestedRecord(value);
  if (nested) {
    for (const key of keys) {
      const candidate = nested[key];
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
  }
  return undefined;
}

function readSlidesCount(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const slides = value.slides ?? readNestedRecord(value)?.slides;
  if (Array.isArray(slides)) return slides.length;
  const nested = readNestedRecord(value);
  const count =
    value.slide_count ??
    value.slides_count ??
    value.total_slides ??
    nested?.slide_count ??
    nested?.slides_count ??
    nested?.total_slides;
  return typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : undefined;
}

function readVerificationFlags(value: unknown): Record<string, boolean | undefined> {
  if (!isRecord(value)) return {};
  const nested = readNestedRecord(value);
  return {
    build_passed:
      typeof value.build_passed === 'boolean'
        ? value.build_passed
        : typeof nested?.build_passed === 'boolean'
          ? nested.build_passed
          : undefined,
    lint_passed:
      typeof value.lint_passed === 'boolean'
        ? value.lint_passed
        : typeof nested?.lint_passed === 'boolean'
          ? nested.lint_passed
          : undefined,
    tests_passed:
      typeof value.tests_passed === 'boolean'
        ? value.tests_passed
        : typeof nested?.tests_passed === 'boolean'
          ? nested.tests_passed
          : undefined,
    generated:
      typeof value.generated === 'boolean'
        ? value.generated
        : typeof nested?.generated === 'boolean'
          ? nested.generated
          : undefined,
    rendered:
      typeof value.rendered === 'boolean'
        ? value.rendered
        : typeof nested?.rendered === 'boolean'
          ? nested.rendered
          : undefined,
    matches_spec:
      typeof value.matches_spec === 'boolean'
        ? value.matches_spec
        : typeof nested?.matches_spec === 'boolean'
          ? nested.matches_spec
          : undefined,
    validated:
      typeof value.validated === 'boolean'
        ? value.validated
        : typeof nested?.validated === 'boolean'
          ? nested.validated
          : undefined,
  };
}

function summarizeChecks(kind: DeliverableKind, hard: string[], soft: string[]): string {
  const parts: string[] = [
    `kind=${kind}`,
    `severity=${hard.length > 0 ? 'poor' : soft.length > 0 ? 'warn' : 'ok'}`,
  ];
  if (hard.length > 0) parts.push(`hard=${hard.join(', ')}`);
  if (soft.length > 0) parts.push(`soft=${soft.join(', ')}`);
  return parts.join('; ');
}

export function evaluateDeliverableQuality(
  kind: DeliverableKind | string,
  artifact: unknown
): DeliverableQualityReport {
  const normalizedKind = String(kind || '').toLowerCase();
  const hard: string[] = [];
  const soft: string[] = [];

  if (
    normalizedKind !== 'doc' &&
    normalizedKind !== 'deck' &&
    normalizedKind !== 'code' &&
    normalizedKind !== 'media'
  ) {
    return {
      kind: 'doc',
      severity: 'poor',
      hard_checks: [`unsupported deliverable kind: ${normalizedKind || 'unknown'}`],
      soft_checks: [],
      reason: summarizeChecks(
        'doc',
        [`unsupported deliverable kind: ${normalizedKind || 'unknown'}`],
        []
      ),
    };
  }

  switch (normalizedKind) {
    case 'doc': {
      const text = readTextCandidate(artifact);
      if (!text) {
        hard.push('document text is missing');
      } else {
        if (text.length < 60) hard.push(`document text is too short (${text.length} chars)`);
        if (text.length < 160) soft.push('document is short');
        if (!/^#{1,6}\s+/m.test(text) && !/^\s*\d+\./m.test(text)) {
          soft.push('document has no obvious structure markers');
        }
      }
      break;
    }
    case 'deck': {
      const slidesCount = readSlidesCount(artifact);
      if (slidesCount === undefined) {
        hard.push('slide list is missing');
      } else {
        if (slidesCount < 1) hard.push('slide deck has no slides');
        if (slidesCount < 3) soft.push(`slide deck is short (${slidesCount} slide(s))`);
      }
      break;
    }
    case 'code': {
      const flags = readVerificationFlags(artifact);
      if (flags.build_passed === false) hard.push('build failed');
      if (flags.lint_passed === false) hard.push('lint failed');
      if (flags.tests_passed === false) hard.push('tests failed');
      if (
        flags.build_passed === undefined &&
        flags.lint_passed === undefined &&
        flags.tests_passed === undefined
      ) {
        soft.push('no verification evidence attached');
      }
      break;
    }
    case 'media': {
      const flags = readVerificationFlags(artifact);
      if (flags.generated === false) hard.push('media generation failed');
      if (flags.rendered === false) hard.push('media render failed');
      if (flags.validated === false || flags.matches_spec === false)
        hard.push('media does not match spec');
      if (
        flags.generated === undefined &&
        flags.rendered === undefined &&
        flags.matches_spec === undefined &&
        flags.validated === undefined
      ) {
        soft.push('no generation or validation evidence attached');
      }
      break;
    }
  }

  const severity: DeliverableQualitySeverity =
    hard.length > 0 ? 'poor' : soft.length > 0 ? 'warn' : 'ok';
  return {
    kind: normalizedKind,
    severity,
    hard_checks: hard,
    soft_checks: soft,
    reason: summarizeChecks(normalizedKind, hard, soft),
  };
}
