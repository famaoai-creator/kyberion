export default {
  action: 'pipeline',
  name: 'workflow-as-code-example',
  description: 'Minimal TS workflow module for run_super_pipeline.',
  context: {
    message: 'workflow-as-code example',
  },
  options: {
    max_steps: 5,
  },
  steps: [
    {
      id: 'write-message',
      op: 'system:log',
      params: {
        message: 'workflow-as-code example executed',
      },
    },
    {
      id: 'seed-state',
      op: 'system:set',
      params: {
        export_as: 'workflow_state',
        value: {
          status: 'ok',
          note: '{{message}}',
        },
      },
    },
    {
      id: 'final-note',
      op: 'system:log',
      params: {
        message: 'workflow state ready: {{workflow_state.status}}',
      },
    },
  ],
};
