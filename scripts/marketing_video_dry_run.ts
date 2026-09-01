import * as path from 'node:path';
import { logger } from '@agent/core/core';
import {
  canCompleteMarketingMission,
  scanMarketingTextForSensitiveData,
  sha256,
  validateMarketingIntake,
  validatePublicationClassification,
  validateVideoTechnicalArtifacts,
} from '@agent/core/marketing-workload';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExecResult,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

interface ProbeResult {
  format?: { duration?: string; size?: string };
  streams?: Array<{
    codec_type?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
  }>;
}

interface ImageProbeResult {
  format?: { tags?: Record<string, string> };
}

const GENERATOR_VERSION = '1.4.0';

function resolveMarketingVideoPath(
  value: unknown,
  label: string,
  allowMissingLeaf = false
): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function childOutputPath(runDir: string, name: string): string {
  return assertSafeRepositoryPath(path.join(runDir, name), { allowMissingLeaf: true });
}

function frameRate(value = ''): number | undefined {
  const parts = value.split('/');
  const numerator = Number(parts[0]);
  const denominator = Number(parts[1] ?? '1');
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0)
    return undefined;
  return numerator / denominator;
}

function writeText(filePath: string, content: string): void {
  safeWriteFile(filePath, content.endsWith('\n') ? content : `${content}\n`);
}

function maximumDetectedDuration(output: string, pattern: RegExp): number {
  return [...output.matchAll(pattern)].reduce((maximum, match) => {
    const duration = Number(match[1]);
    return Number.isFinite(duration) ? Math.max(maximum, duration) : maximum;
  }, 0);
}

export function runMarketingVideoDryRun(input: {
  campaignBriefPath: string;
  brandProfilePath: string;
  outputRoot: string;
  channel: string;
  riskLevel: number;
}): { status: 'created' | 'reused'; run_dir: string; review_package: string } {
  const briefPath = resolveMarketingVideoPath(input.campaignBriefPath, 'campaign brief path');
  const brandPath = resolveMarketingVideoPath(input.brandProfilePath, 'brand profile path');
  if (!safeLstat(briefPath).isFile()) {
    throw new Error(`campaign brief path must be a regular file: ${input.campaignBriefPath}`);
  }
  if (!safeLstat(brandPath).isFile()) {
    throw new Error(`brand profile path must be a regular file: ${input.brandProfilePath}`);
  }
  const outputRoot = resolveMarketingVideoPath(input.outputRoot, 'output root', true);
  const brief = safeReadFile(briefPath, { encoding: 'utf8' }) as string;
  const brand = safeReadFile(brandPath, { encoding: 'utf8' }) as string;
  const runId = sha256(
    JSON.stringify({
      generator: GENERATOR_VERSION,
      brief,
      brand,
      channel: input.channel,
      risk: input.riskLevel,
    })
  ).slice(0, 16);
  const runDir = assertSafeRepositoryPath(path.join(outputRoot, 'runs', runId), {
    allowMissingLeaf: true,
  });
  const reviewPackagePath = childOutputPath(runDir, 'review-package.json');
  if (safeExistsSync(reviewPackagePath)) {
    return { status: 'reused', run_dir: runDir, review_package: reviewPackagePath };
  }

  safeMkdir(runDir, { recursive: true });
  const videoPath = childOutputPath(runDir, 'video.mp4');
  const thumbnailPath = childOutputPath(runDir, 'thumbnail.png');
  const captionsPath = childOutputPath(runDir, 'captions.vtt');
  const campaignBriefOutputPath = childOutputPath(runDir, 'campaign-brief.md');
  const scriptOutputPath = childOutputPath(runDir, 'script.md');
  const storyboardPath = childOutputPath(runDir, 'storyboard.json');
  const technicalValidationPath = childOutputPath(runDir, 'technical-validation.json');
  const completionEvidencePath = childOutputPath(runDir, 'completion-evidence.json');

  writeText(
    campaignBriefOutputPath,
    `# Campaign Brief\n\nSource: ${input.campaignBriefPath}\n\nChannel: ${input.channel}\nRisk level: ${input.riskLevel}`
  );
  writeText(
    scriptOutputPath,
    '# Script\n\n00:00 Kyberion governed marketing dry-run.\n\n00:02 Review evidence before publication.'
  );
  safeWriteFile(
    storyboardPath,
    JSON.stringify(
      {
        version: '1.0.0',
        scenes: [
          {
            start: 0,
            end: 3,
            visual: 'Generated test pattern',
            narration: 'Governed marketing dry-run',
          },
        ],
      },
      null,
      2
    )
  );
  writeText(
    captionsPath,
    'WEBVTT\n\n00:00:00.000 --> 00:00:02.800\nKyberion governed marketing dry-run.'
  );

  safeExec('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30:duration=3',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    videoPath,
  ]);
  safeExec('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-frames:v',
    '1',
    thumbnailPath,
  ]);

  const probe = JSON.parse(
    safeExec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', videoPath])
  ) as ProbeResult;
  const blackDetection = safeExecResult(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      videoPath,
      '-vf',
      'blackdetect=d=0.1:pic_th=0.98:pix_th=0.10',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 30_000 }
  );
  const silenceDetection = safeExecResult(
    'ffmpeg',
    [
      '-hide_banner',
      '-i',
      videoPath,
      '-af',
      'silencedetect=n=-50dB:d=0.1',
      '-vn',
      '-f',
      'null',
      '-',
    ],
    { timeoutMs: 30_000 }
  );
  const blackOutput = `${blackDetection.stdout || ''}\n${blackDetection.stderr || ''}`;
  const silenceOutput = `${silenceDetection.stdout || ''}\n${silenceDetection.stderr || ''}`;
  const maxBlackFrameSeconds = maximumDetectedDuration(blackOutput, /black_duration:([0-9.]+)/g);
  const maxSilenceSeconds = maximumDetectedDuration(
    silenceOutput,
    /silence_duration:\s*([0-9.]+)/g
  );
  const imageProbe = JSON.parse(
    safeExec('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format_tags',
      '-of',
      'json',
      thumbnailPath,
    ])
  ) as ImageProbeResult;
  const sensitiveMetadataKeys = Object.keys(imageProbe.format?.tags || {}).filter((key) =>
    /gps|location|author|artist|comment|description|copyright/i.test(key)
  );
  const videoStream = probe.streams?.find((stream) => stream.codec_type === 'video');
  const validationBase = validateVideoTechnicalArtifacts({
    video_exists: safeExistsSync(videoPath),
    readable: Boolean(videoStream),
    duration_seconds: probe.format?.duration ? Number(probe.format.duration) : undefined,
    resolution:
      videoStream?.width && videoStream.height
        ? `${videoStream.width}x${videoStream.height}`
        : undefined,
    frame_rate: frameRate(videoStream?.avg_frame_rate),
    audio_track: Boolean(probe.streams?.some((stream) => stream.codec_type === 'audio')),
    captions_exist: safeExistsSync(captionsPath),
    thumbnail_exists: safeExistsSync(thumbnailPath),
    file_size_bytes: Number(probe.format?.size),
    max_black_frame_seconds: maxBlackFrameSeconds,
    max_silence_seconds: maxSilenceSeconds,
    spec: {
      allowed_resolutions: ['1920x1080', '3840x2160'],
      allowed_frame_rates: [24, 25, 30, 60],
      max_duration_seconds: 95,
      captions_required: true,
      thumbnail_required: true,
      max_file_size_bytes: 256 * 1024 * 1024,
      max_black_frame_seconds: 1,
      max_silence_seconds: 3,
      cta_domain_allowlist: ['example.com', 'localhost'],
    },
  });
  const detectorReasons = [
    ...(blackDetection.status === 0 ? [] : ['black frame detection did not complete']),
    ...(silenceDetection.status === 0 ? [] : ['silence detection did not complete']),
    ...(sensitiveMetadataKeys.length === 0
      ? []
      : [`thumbnail contains sensitive metadata keys: ${sensitiveMetadataKeys.join(', ')}`]),
  ];
  const validation = {
    ...validationBase,
    status:
      validationBase.status === 'passed' && detectorReasons.length === 0
        ? ('passed' as const)
        : ('failed' as const),
    reasons: [...validationBase.reasons, ...detectorReasons],
    evidence:
      validationBase.status === 'passed' && detectorReasons.length === 0
        ? validationBase.evidence
        : [],
  };
  safeWriteFile(
    technicalValidationPath,
    JSON.stringify(
      {
        ...validation,
        probe,
        black_frame_detection: {
          status: blackDetection.status === 0 ? 'completed' : 'failed',
          max_duration_seconds: maxBlackFrameSeconds,
        },
        silence_detection: {
          status: silenceDetection.status === 0 ? 'completed' : 'failed',
          max_duration_seconds: maxSilenceSeconds,
        },
        thumbnail_metadata: {
          tags: imageProbe.format?.tags || {},
          sensitive_metadata_keys: sensitiveMetadataKeys,
          passed: sensitiveMetadataKeys.length === 0,
        },
      },
      null,
      2
    )
  );
  const parsedBrief = JSON.parse(brief) as {
    intake: Parameters<typeof validateMarketingIntake>[0];
  };
  const intakeGate = validateMarketingIntake(parsedBrief.intake);
  const sensitiveDataScan = scanMarketingTextForSensitiveData([
    {
      location: 'campaign-brief.md',
      content: safeReadFile(campaignBriefOutputPath, { encoding: 'utf8' }) as string,
    },
    {
      location: 'script.md',
      content: safeReadFile(scriptOutputPath, { encoding: 'utf8' }) as string,
    },
    {
      location: 'captions.vtt',
      content: safeReadFile(captionsPath, { encoding: 'utf8' }) as string,
    },
  ]);
  const classificationGate = validatePublicationClassification({
    source_classifications: [parsedBrief.intake.data_classification || 'confidential'],
    publication_allowed: parsedBrief.intake.publication_intent !== 'public',
    requires_redaction: false,
    pii_detected: sensitiveDataScan.pii_findings.length > 0,
    secret_detected: sensitiveDataScan.secret_findings.length > 0,
  });
  const requiredGates = ['G0', 'G1', 'G3'] as const;
  const completionEligible = canCompleteMarketingMission({
    requiredGates: [...requiredGates],
    gateResults: [intakeGate, classificationGate, validation],
    publicationIntent: parsedBrief.intake.publication_intent || 'none',
    dryRun: true,
  });
  const completionArtifactNames = [
    'campaign-brief.md',
    'script.md',
    'storyboard.json',
    'video.mp4',
    'captions.vtt',
    'thumbnail.png',
    'technical-validation.json',
  ];
  const completionArtifactBindings = Object.fromEntries(
    completionArtifactNames.map((name) => {
      const artifactPath = childOutputPath(runDir, name);
      return [name, { path: artifactPath, sha256: sha256(safeReadFile(artifactPath) as Buffer) }];
    })
  );
  safeWriteFile(
    completionEvidencePath,
    JSON.stringify(
      {
        workload: 'marketing-video-production',
        run_id: runId,
        publication_intent: parsedBrief.intake.publication_intent,
        dry_run: true,
        required_gates: requiredGates,
        gate_results: [intakeGate, classificationGate, validation],
        artifact_bindings: completionArtifactBindings,
        sensitive_data_scan: sensitiveDataScan,
        completion_eligible: completionEligible,
      },
      null,
      2
    )
  );
  const artifacts = [...completionArtifactNames, 'completion-evidence.json'].map((name) => {
    const artifactPath = childOutputPath(runDir, name);
    const content = safeReadFile(artifactPath) as Buffer;
    return { name, path: artifactPath, sha256: sha256(content) };
  });
  safeWriteFile(
    reviewPackagePath,
    JSON.stringify(
      {
        status: validation.status === 'passed' ? 'ready_for_review' : 'technical_validation_failed',
        generator_version: GENERATOR_VERSION,
        external_effects: false,
        run_id: runId,
        channel: input.channel,
        risk_level: input.riskLevel,
        artifacts,
        technical_validation: technicalValidationPath,
      },
      null,
      2
    )
  );
  if (validation.status !== 'passed')
    throw new Error(`Technical validation failed: ${validation.reasons.join('; ')}`);
  return { status: 'created', run_dir: runDir, review_package: reviewPackagePath };
}

async function main(args: string[] = []): Promise<void> {
  const argv = createStandardYargs(['node', 'marketing_video_dry_run', ...args])
    .option('campaign-brief', { type: 'string', demandOption: true })
    .option('brand-profile', { type: 'string', demandOption: true })
    .option('output-root', { type: 'string', demandOption: true })
    .option('channel', { type: 'string', default: 'youtube' })
    .option('risk-level', { type: 'number', default: 0 })
    .parseSync();
  const result = runMarketingVideoDryRun({
    campaignBriefPath: String(argv['campaign-brief']),
    brandProfilePath: String(argv['brand-profile']),
    outputRoot: String(argv['output-root']),
    channel: String(argv.channel),
    riskLevel: Number(argv['risk-level']),
  });
  logger.success(JSON.stringify(result));
}

export const runMarketingVideoDryRunScript = defineScript({
  name: 'marketing:video-dry-run',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'marketing_video_dry_run.ts') ||
  isDirectScript(import.meta.url, 'marketing_video_dry_run.js')
)
  void runMarketingVideoDryRunScript();
