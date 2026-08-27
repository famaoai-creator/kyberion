export function intentResolutionA2ui(contract: {
  normalized_intent: string;
  missing_inputs: string[];
  authority_level: string;
  outcome_kind: string;
  next_action: { kind: string; label: string; consequence: string };
}) {
  return [
    {
      type: 'display:section',
      props: {
        title: 'Intent resolution',
        items: [
          {
            type: 'display:kv',
            props: {
              entries: [
                { key: 'Understanding', value: contract.normalized_intent },
                {
                  key: 'Missing input',
                  value:
                    contract.missing_inputs.length > 0
                      ? contract.missing_inputs.join(', ')
                      : 'none',
                },
                { key: 'Next action', value: contract.next_action.label },
                { key: 'Outcome', value: contract.outcome_kind },
              ],
            },
          },
        ],
      },
    },
  ];
}

export function withMissionRole<T>(role: string, fn: () => T): T {
  const previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = role;
  try {
    return fn();
  } finally {
    if (previousRole === undefined) {
      delete process.env.MISSION_ROLE;
    } else {
      process.env.MISSION_ROLE = previousRole;
    }
  }
}

export function sanitizeMissionSlug(value: string): string {
  return (
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'REQUEST'
  );
}

export function buildSurfaceMissionId(
  prefix: string,
  threadTs: string,
  proposal: MissionProposal,
  sourceText?: string
): string {
  const base = proposal.summary || sourceText || proposal.why || proposal.mission_type || 'request';
  const slug = sanitizeMissionSlug(base);
  const numericThread = threadTs.replace(/\D+/g, '').slice(-8) || Date.now().toString().slice(-8);
  return `MSN-${prefix}-${slug}-${numericThread}`;
}
