import * as path from 'node:path';
import {
  evaluatePublicationVerification,
  loadApprovalRequest,
  logger,
  loadMarketingRiskPolicy,
  pathResolver,
  requiredMarketingControls,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  scanMarketingTextForSensitiveData,
  sha256,
  validatePublicationApproval,
  validateSharedPublicationApproval,
  type ApprovalRequestRecord,
  type ArtifactBinding,
  type PublicationApproval,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readJson<T>(filePath: string): T {
  return JSON.parse(
    safeReadFile(pathResolver.rootResolve(filePath), { encoding: 'utf8' }) as string
  ) as T;
}

function currentArtifactBindings(
  approved: Record<string, ArtifactBinding>
): Record<string, ArtifactBinding> {
  return Object.fromEntries(
    Object.entries(approved).map(([name, artifact]) => {
      const artifactPath = pathResolver.rootResolve(artifact.path);
      if (!safeExistsSync(artifactPath)) throw new Error(`Approved artifact is missing: ${name}`);
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
  const approval = readJson<PublicationApproval>(input.approvalPath);
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
      content: safeReadFile(pathResolver.rootResolve(artifact.path), {
        encoding: 'utf8',
      }) as string,
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

  const outputRoot = pathResolver.rootResolve(input.outputRoot);
  const runId = sha256(
    JSON.stringify({
      approval_id: approval.approval_id,
      artifacts,
      destination: approval.destination,
    })
  ).slice(0, 16);
  const runDir = path.join(outputRoot, 'runs', runId);
  safeMkdir(runDir, { recursive: true });
  const previewPath = path.join(runDir, 'publication-preview.html');
  const verificationPath = path.join(runDir, 'publication-verification.json');
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

async function main(): Promise<void> {
  const argv = createStandardYargs()
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

if (process.argv[1] && /marketing_publish_dry_run\.(ts|js)$/.test(process.argv[1])) {
  main().catch((error) => {
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
