'use client';

import * as React from 'react';
import { AutomationClient } from './automation-client';

/**
 * `/ops/automation` — pipeline schedules + manual runs for operators.
 * Thin Suspense wrapper; the work happens in `automation-client.tsx` and the
 * `/ops` layout supplies the `.kb-ops` scope + console stylesheet.
 */
export default function AutomationPage() {
  return (
    <React.Suspense fallback={null}>
      <AutomationClient />
    </React.Suspense>
  );
}
