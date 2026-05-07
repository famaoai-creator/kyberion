import type { CapabilityStatus, EnvironmentCapability, EnvironmentManifest } from '@agent/core';

export type DoctorSeverity = 'must' | 'should' | 'nice';

export interface DoctorFinding {
  manifest_id: string;
  capability_id: string;
  severity: DoctorSeverity;
  reason?: string;
  docs_url?: string;
  instruction?: string;
}

export interface DoctorSummary {
  manifest_id: string;
  version: string;
  findings: DoctorFinding[];
  counts: Record<DoctorSeverity, number>;
}

const MUST_REQUIRED_FOR = new Set([
  'all-of-kyberion',
  'browser-meeting-join-driver',
  'blackhole-audio-bus',
  'pulseaudio-audio-bus',
  'meeting-actuator.speak',
  'meeting-participation-coordinator',
]);

const SHOULD_REQUIRED_FOR = new Set([
  'streaming-stt',
  'streaming-tts',
]);

export function classifyDoctorSeverity(cap: EnvironmentCapability): DoctorSeverity {
  if (cap.optional) return 'nice';
  const requiredFor = new Set(cap.required_for || []);
  if ([...requiredFor].some((item) => MUST_REQUIRED_FOR.has(item))) return 'must';
  if ([...requiredFor].some((item) => SHOULD_REQUIRED_FOR.has(item))) return 'should';
  return 'should';
}

export function summarizeManifestDoctor(
  manifest: EnvironmentManifest,
  probeStatuses: CapabilityStatus[],
): DoctorSummary {
  const byId = new Map(probeStatuses.map((status) => [status.capability_id, status]));
  const findings: DoctorFinding[] = [];
  const counts: Record<DoctorSeverity, number> = { must: 0, should: 0, nice: 0 };

  for (const cap of manifest.capabilities) {
    const status = byId.get(cap.capability_id);
    if (!status || status.satisfied) continue;
    const severity = classifyDoctorSeverity(cap);
    counts[severity] += 1;
    findings.push({
      manifest_id: manifest.manifest_id,
      capability_id: cap.capability_id,
      severity,
      reason: status.reason,
      docs_url: cap.install?.docs_url,
      instruction: cap.install?.instruction,
    });
  }

  return {
    manifest_id: manifest.manifest_id,
    version: manifest.version,
    findings,
    counts,
  };
}

export function formatDoctorSummary(summary: DoctorSummary): string[] {
  const lines: string[] = [];
  lines.push(`📋 ${summary.manifest_id} (${summary.version})`);
  lines.push(
    `   must=${summary.counts.must} should=${summary.counts.should} nice=${summary.counts.nice}`,
  );
  for (const severity of ['must', 'should', 'nice'] as const) {
    const entries = summary.findings.filter((finding) => finding.severity === severity);
    if (entries.length === 0) continue;
    lines.push(`   ${severity.toUpperCase()}:`);
    for (const finding of entries) {
      const details = [
        finding.reason ? finding.reason : '',
        finding.docs_url ? `docs=${finding.docs_url}` : '',
      ]
        .filter(Boolean)
        .join(' | ');
      lines.push(`      - ${finding.capability_id}${details ? ` — ${details}` : ''}`);
      if (finding.instruction) {
        lines.push(`        ${finding.instruction}`);
      }
    }
  }
  return lines;
}
