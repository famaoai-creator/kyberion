import { A2UISurface, dispatchA2UI, logger } from '../libs/core/index.js';

/**
 * A2UI Protocol Demonstration Script
 * This simulates an agent creating a rich dashboard surface.
 */

async function runDemo() {
  logger.info('🚀 Starting A2UI Protocol Demo...');

  // 1. Create a new Surface
  const dashboard = new A2UISurface('dash-001', 'kyberion.org:standard', 'Kyberion Sovereign Dashboard');
  dispatchA2UI(dashboard.buildCreateMessage());

  // 2. Define Components
  dashboard.setComponent({
    id: 'root',
    type: 'layout:column',
    props: { padding: '20px', gap: '10px' },
    children: ['header', 'stats-row', 'status-log']
  });

  dashboard.setComponent({
    id: 'header',
    type: 'text:heading',
    props: { level: 1, text: 'System Integrity Overview' }
  });

  dashboard.setComponent({
    id: 'stats-row',
    type: 'layout:row',
    props: { gap: '15px' },
    children: ['cpu-stat', 'mem-stat']
  });

  dashboard.setComponent({
    id: 'cpu-stat',
    type: 'display:gauge',
    props: { label: 'CPU Usage', value: 45, unit: '%' }
  });

  dashboard.setComponent({
    id: 'mem-stat',
    type: 'display:gauge',
    props: { label: 'Memory Usage', value: 72, unit: '%' }
  });

  dashboard.setComponent({
    id: 'status-log',
    type: 'display:log',
    props: { title: 'Security Events', maxLines: 5 }
  });

  // Dispatch full component tree
  dispatchA2UI(dashboard.buildUpdateMessage());

  // 3. Update Data Model (Reactive Data)
  dashboard.setData('integrity_score', 98.5);
  dashboard.setData('last_audit', new Date().toISOString());
  dispatchA2UI(dashboard.buildDataMessage());

  logger.info('✅ A2UI Demo complete. Inspect output for [A2UI_DISPATCH] logs.');
}

runDemo().catch(err => {
  console.error(err);
  process.exit(1);
});
