export interface InboundInquiryLead {
  name: string;
  org: string;
  email: string;
}

export interface InboundInquiry {
  source: string;
  received_at: string;
  lead: InboundInquiryLead;
  message: string;
  metadata?: Record<string, unknown>;
}

function formatMetadata(metadata?: Record<string, unknown>): string {
  if (!metadata || Object.keys(metadata).length === 0) {
    return '  (none)';
  }

  const sorted = Object.fromEntries(
    Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(sorted, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export function renderInboundInquiryText(inquiry: InboundInquiry): string {
  return [
    '# Inbound Inquiry',
    '',
    `Source: ${inquiry.source}`,
    `Received at: ${inquiry.received_at}`,
    '',
    'Lead:',
    `- Name: ${inquiry.lead.name}`,
    `- Org: ${inquiry.lead.org}`,
    `- Email: ${inquiry.lead.email}`,
    '',
    'Message:',
    inquiry.message,
    '',
    'Metadata:',
    formatMetadata(inquiry.metadata),
  ].join('\n');
}

export function adaptInboundInquiryToWorkflow(inquiry: InboundInquiry): string {
  return `${renderInboundInquiryText(inquiry)}\n`;
}
