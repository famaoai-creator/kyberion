import { readGovernanceJson, ContractCheck } from './check_contract_schemas_shared.js';

export function createProductionEvidenceRegisterChecks(): ContractCheck[] {
  return [
    {
      id: 'production-evidence-register',
      schemaPath: 'knowledge/product/schemas/production-evidence-register.schema.json',
      validPayloads: [
        readGovernanceJson('knowledge/product/governance/production-evidence-register.json'),
      ],
      invalidPayloads: [
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'production_ready',
          items: [],
        },
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'pending_external_evidence',
          items: [
            {
              id: 'EV-UNTRACKED',
              gate: 'Roadmap D2',
              required_evidence: '30-day run log',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-30day-ops.md',
              acceptance_criteria: ['operation_window_days >= 30'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'run_summary',
                  description: '30-day run summary',
                  accepted_ref_patterns: ['docs/operator/'],
                },
              ],
              evidence_refs: [],
            },
          ],
        },
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'pending_external_evidence',
          items: [
            {
              id: 'EV-30DAY-OPS',
              gate: 'Roadmap D2',
              required_evidence: '30-day run log',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-30day-ops.md',
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              evidence_refs: [],
            },
            {
              id: 'EV-EXT-CONTRIB',
              gate: 'Roadmap D5',
              required_evidence: 'external contribution',
              status: 'pending_external_evidence',
              owner: 'maintainer',
              template_ref: 'docs/operator/templates/production-evidence-external-contribution.md',
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              evidence_refs: [],
            },
            {
              id: 'EV-FDE-DEPLOY',
              gate: 'Roadmap Phase D',
              required_evidence: 'FDE deployment',
              status: 'pending_external_evidence',
              owner: 'operator + maintainer',
              template_ref: 'docs/operator/templates/production-evidence-fde-deployment.md',
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              evidence_refs: [],
            },
            {
              id: 'EV-FDE-DEPLOY',
              gate: 'duplicate',
              required_evidence: 'duplicate',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-fde-deployment.md',
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              evidence_refs: [],
            },
          ],
        },
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'pending_external_evidence',
          items: [
            {
              id: 'EV-30DAY-OPS',
              gate: 'Roadmap D2',
              required_evidence: '30-day run log',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-30day-ops.md',
              acceptance_criteria: ['operation_window_days >= 30'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'run_summary',
                  description: '30-day run summary',
                  accepted_ref_patterns: ['docs/operator/'],
                },
              ],
              evidence_refs: [],
            },
            {
              id: 'EV-EXT-CONTRIB',
              gate: 'Roadmap D5',
              required_evidence: 'external contribution',
              status: 'pending_external_evidence',
              owner: 'maintainer',
              template_ref: 'docs/operator/templates/production-evidence-external-contribution.md',
              acceptance_criteria: ['merge completed within 7 days of contributor start'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'issue_url',
                  description: 'GitHub issue URL',
                  accepted_ref_patterns: ['/issues/'],
                },
              ],
              evidence_refs: [],
            },
            {
              id: 'EV-EXT-CONTRIB',
              gate: 'duplicate missing FDE',
              required_evidence: 'duplicate',
              status: 'pending_external_evidence',
              owner: 'maintainer',
              template_ref: 'docs/operator/templates/production-evidence-external-contribution.md',
              acceptance_criteria: ['duplicate'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'pr_url',
                  description: 'GitHub PR URL',
                  accepted_ref_patterns: ['/pull/'],
                },
              ],
              evidence_refs: [],
            },
          ],
        },
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'pending_external_evidence',
          items: [
            {
              id: 'EV-30DAY-OPS',
              gate: 'Roadmap D2',
              required_evidence: '30-day run log',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-30day-ops.md',
              acceptance_criteria: ['operation_window_days >= 30'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'run_summary',
                  description: '30-day run summary',
                  accepted_ref_patterns: ['docs/operator/'],
                },
              ],
              evidence_refs: [
                'docs/operator/templates/production-evidence-30day-ops.md',
                'docs/operator/templates/production-evidence-30day-ops.md',
              ],
            },
          ],
        },
        {
          version: '1.0.0',
          last_updated: '2026-05-15',
          release_decision: 'pending_external_evidence',
          items: [
            {
              id: 'EV-30DAY-OPS',
              gate: 'Roadmap D2',
              required_evidence: '30-day run log',
              status: 'pending_external_evidence',
              owner: 'operator',
              template_ref: 'docs/operator/templates/production-evidence-fde-deployment.md',
              acceptance_criteria: ['operation_window_days >= 30'],
              verification_artifact: 'docs/operator/PRODUCTION_EVIDENCE_COLLECTION.md',
              reviewed_at: null,
              reviewer: null,
              ref_requirements: [
                {
                  id: 'run_summary',
                  description: '30-day run summary',
                  accepted_ref_patterns: ['docs/operator/'],
                },
              ],
              evidence_refs: [],
            },
          ],
        },
        (() => {
          const payload = readGovernanceJson(
            'knowledge/product/governance/production-evidence-register.json'
          ) as {
            items: Array<
              Record<string, unknown> & {
                ref_requirements: Array<Record<string, unknown> & { id: string }>;
              }
            >;
          };
          payload.items[0] = {
            ...payload.items[0],
            ref_requirements: payload.items[0].ref_requirements.filter(
              (requirement: { id: string }) => requirement.id !== 'incident_summary'
            ),
          };
          return payload;
        })(),
        (() => {
          const payload = readGovernanceJson(
            'knowledge/product/governance/production-evidence-register.json'
          ) as {
            items: Array<
              Record<string, unknown> & {
                ref_requirements: Array<Record<string, unknown> & { id: string }>;
              }
            >;
          };
          payload.items[1] = {
            ...payload.items[1],
            ref_requirements: [
              ...payload.items[1].ref_requirements,
              {
                id: 'misc_url',
                description: 'Non-canonical evidence URL',
                accepted_ref_patterns: ['https://'],
              },
            ],
          };
          return payload;
        })(),
        (() => {
          const payload = readGovernanceJson(
            'knowledge/product/governance/production-evidence-register.json'
          ) as {
            items: Array<
              Record<string, unknown> & {
                ref_requirements: Array<Record<string, unknown> & { id: string }>;
              }
            >;
          };
          payload.items[1] = {
            ...payload.items[1],
            ref_requirements: payload.items[1].ref_requirements.map((requirement) =>
              requirement.id === 'issue_url'
                ? {
                    ...requirement,
                    accepted_ref_patterns: ['https://github.com/'],
                  }
                : requirement
            ),
          };
          return payload;
        })(),
        (() => {
          const payload = readGovernanceJson(
            'knowledge/product/governance/production-evidence-register.json'
          ) as {
            items: Array<
              Record<string, unknown> & {
                ref_requirements: Array<Record<string, unknown> & { id: string }>;
              }
            >;
          };
          payload.items[2] = {
            ...payload.items[2],
            gate: '   ',
          };
          return payload;
        })(),
      ],
    },
  ];
}
