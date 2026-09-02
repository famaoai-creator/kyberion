import * as path from 'node:path';
import {
  evaluatePublicationVerification,
  loadPublicationApprovalAtPath,
  loadMarketingRiskPolicy,
  requiredMarketingControls,
  scanMarketingTextForSensitiveData,
  sha256,
  validatePublicationApproval,
  validateSharedPublicationApproval,
  type ArtifactBinding,
} from '@agent/core/marketing-workload';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import { loadApprovalRequest, type ApprovalRequestRecord } from '@agent/core/approval-store';
import { escapeHtml } from '@agent/core/text-escaping';
import { createStandardYargs } from '@agent/core/cli-utils';
import { defineScript, isDirectScript } from './lib/harness.js';

function resolveMarketingPath(value: unknown, label: string, allowMissingLeaf = false): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function requireRegularMarketingInput(filePath: string, label: string): string {
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
  return filePath;
}

function currentArtifactBindings(
  approved: Record<string, ArtifactBinding>
): Record<string, ArtifactBinding> {
  return Object.fromEntries(
    Object.entries(approved).map(([name, artifact]) => {
      const artifactPath = resolveMarketingPath(artifact.path, `approved artifact ${name}`);
      if (!safeExistsSync(artifactPath)) throw new Error(`Approved artifact is missing: ${name}`);
      requireRegularMarketingInput(artifactPath, `approved artifact ${name}`);
      return [
        name,
        {
          path: artifact.path,
          sha256: sha256(safeReadFile(artifactPath) as Buffer),
        },
      ];
    })
  );
}

export function runMarketingPublishDryRun(input: {
  approvalPath: string;
  outputRoot: string;
  now?: Date;
  sharedApprovalRequest?: ApprovalRequestRecord;
}): {
  status: 'dry_run_completed';
  approval_id: string;
  preview: string;
  verification: string;
} {
  const approvalPath = requireRegularMarketingInput(
    resolveMarketingPath(input.approvalPath, 'approvalPath'),
    'approvalPath'
  );
  const approval = loadPublicationApprovalAtPath(approvalPath);
  const sharedApprovalRequest =
    input.sharedApprovalRequest ||
    loadApprovalRequest(
      approval.shared_approval.storage_channel,
      approval.shared_approval.request_id
    );
  const artifacts = currentArtifactBindings(approval.approved_artifacts);
  const textDocuments = Object.entries(approval.approved_artifacts)
    .filter(([, artifact]) => /\.(?:md|txt|vtt|html?|json)$/i.test(artifact.path))
    .map(([name, artifact]) => ({
      location: name,
      content: safeReadFile(
        requireRegularMarketingInput(
          resolveMarketingPath(artifact.path, `approved artifact ${name}`),
          `approved artifact ${name}`
        ),
        { encoding: 'utf8' }
      ) as string,
    }));
  const sensitiveDataScan = scanMarketingTextForSensitiveData([
    { location: 'publication.title', content: approval.title },
    { location: 'publication.description', content: approval.description },
    ...textDocuments,
  ]);
  if (!sensitiveDataScan.passed) {
    throw new Error(
      `Publication classification denied: ${sensitiveDataScan.pii_findings.length} PII finding(s), ${sensitiveDataScan.secret_findings.length} secret finding(s)`
    );
  }
  const controls = requiredMarketingControls(approval.risk_level);
  const approvalGate = validatePublicationApproval({
    approval,
    artifacts,
    destination: approval.destination,
    title: approval.title,
    description: approval.description,
    cta_url: approval.cta_url,
    requiredApprovals: controls.required_approvals,
    now: input.now,
  });
  if (approvalGate.status !== 'passed') {
    throw new Error(`Publication approval denied: ${approvalGate.reasons.join('; ')}`);
  }
  const sharedApprovalGate = validateSharedPublicationApproval({
    approval,
    request: sharedApprovalRequest,
  });
  if (sharedApprovalGate.status !== 'passed') {
    throw new Error(`Shared publication approval denied: ${sharedApprovalGate.reasons.join('; ')}`);
  }

  const outputRoot = resolveMarketingPath(input.outputRoot, 'outputRoot', true);
  const runId = sha256(
    JSON.stringify({
      approval_id: approval.approval_id,
      artifacts,
      destination: approval.destination,
    })
  ).slice(0, 16);
  const runDir = assertSafeRepositoryPath(path.join(outputRoot, 'runs', runId), {
    allowMissingLeaf: true,
  });
  safeMkdir(runDir, { recursive: true });
  const previewPath = assertSafeRepositoryPath(path.join(runDir, 'publication-preview.html'), {
    allowMissingLeaf: true,
  });
  const verificationPath = assertSafeRepositoryPath(
    path.join(runDir, 'publication-verification.json'),
    { allowMissingLeaf: true }
  );
  const artifactRows = Object.entries(artifacts)
    .map(
      ([name, artifact]) =>
        `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(artifact.path)}</td><td><code>${artifact.sha256}</code></td></tr>`
    )
    .join('');
  safeWriteFile(
    previewPath,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(approval.title)}</title><body><main><h1>${escapeHtml(approval.title)}</h1><p>${escapeHtml(approval.description)}</p><dl><dt>Service</dt><dd>${escapeHtml(approval.destination.service)}</dd><dt>Account</dt><dd>${escapeHtml(approval.destination.account)}</dd><dt>Visibility</dt><dd>${escapeHtml(approval.destination.visibility)}</dd><dt>Approval</dt><dd>${escapeHtml(approval.approval_id)}</dd></dl><table><thead><tr><th>Artifact</th><th>Path</th><th>SHA-256</th></tr></thead><tbody>${artifactRows}</tbody></table>${approval.cta_url ? `<p><a href="${escapeHtml(approval.cta_url)}">CTA preview</a></p>` : ''}<p>Local dry-run only. No external publication occurred.</p></main></body></html>`
  );

  let ctaStatus: 'passed' | 'failed' = 'passed';
  if (approval.cta_url) {
    try {
      const hostname = new URL(approval.cta_url).hostname;
      const allowedDomains = loadMarketingRiskPolicy().cta_domain_allowlist;
      if (!allowedDomains.includes(hostname)) ctaStatus = 'failed';
    } catch {
      ctaStatus = 'failed';
    }
  }
  const verification = evaluatePublicationVerification({
    publication_url: `local://${path.relative(pathResolver.rootDir(), previewPath)}`,
    expected_visibility: approval.destination.visibility,
    actual_visibility: approval.destination.visibility,
    artifact_hash_matches: true,
    cta_status: ctaStatus,
    captions_enabled: Boolean(artifacts.captions),
    thumbnail_set: Boolean(artifacts.thumbnail),
    dry_run: true,
  });
  safeWriteFile(
    verificationPath,
    JSON.stringify(
      {
        ...verification,
        approval_id: approval.approval_id,
        shared_approval_request_id: sharedApprovalRequest.id,
        artifact_hashes: artifacts,
        sensitive_data_scan: sensitiveDataScan,
        rendered_artifact: previewPath,
        network_access: false,
        counts_as_publication: false,
      },
      null,
      2
    )
  );
  if (verification.status !== 'passed') {
    throw new Error(`Publication verification failed: ${verification.reasons.join('; ')}`);
  }
  return {
    status: 'dry_run_completed',
    approval_id: approval.approval_id,
    preview: previewPath,
    verification: verificationPath,
  };
}

async function main(args: string[] = []): Promise<void> {
  const argv = createStandardYargs(['node', 'marketing_publish_dry_run', ...args])
    .option('approval', { type: 'string', demandOption: true })
    .option('output-root', { type: 'string', demandOption: true })
    .parseSync();
  logger.success(
    JSON.stringify(
      runMarketingPublishDryRun({
        approvalPath: String(argv.approval),
        outputRoot: String(argv['output-root']),
      })
    )
  );
}

export const runMarketingPublishDryRunScript = defineScript({
  name: 'marketing:publish-dry-run',
  flags: [],
  run: ({ argv }) => main(argv),
});

if (
  isDirectScript(import.meta.url, 'marketing_publish_dry_run.ts') ||
  isDirectScript(import.meta.url, 'marketing_publish_dry_run.js')
)
  void runMarketingPublishDryRunScript();
