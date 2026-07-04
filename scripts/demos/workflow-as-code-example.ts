export default {
  action: 'pipeline',
  name: 'workflow-as-code-example',
  description: 'Minimal TS workflow module for run_super_pipeline with parallel and budget hints.',
  context: {
    message: 'workflow-as-code example',
  },
  options: {
    max_steps: 7,
  },
  steps: [
    {
      id: 'write-message',
      op: 'system:log',
      effort: 'low',
      params: {
        message: 'workflow-as-code example executed',
      },
    },
    {
      id: 'seed-state',
      effort: 'low',
      budget: {
        max_prompt_chars: 4000,
        max_response_chars: 2000,
      },
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
      id: 'fan-out',
      op: 'core:parallel_foreach',
      effort: 'medium',
      budget: {
        max_combined_chars: 8000,
      },
      params: {
        items: [1, 2],
        as: 'item',
        concurrency: 2,
        export_as: 'parallel_items',
        do: [
          {
            op: 'system:log',
            params: {
              message: 'processing item {{item}}',
            },
          },
        ],
      },
    },
    {
      id: 'accumulate-sample',
      op: 'core:accumulate',
      effort: 'medium',
      budget: {
        max_combined_chars: 6000,
      },
      params: {
        items: ['alpha', 'alpha', 'beta'],
        as: 'item',
        target_count: 2,
        dry_streak_limit: 2,
        export_as: 'accumulated_items',
        collect_as: 'seen',
        do: [
          {
            op: 'system:log',
            params: {
              message: 'accumulating item {{item}}',
            },
          },
        ],
      },
    },
    {
      id: 'final-note',
      op: 'system:log',
      effort: 'low',
      params: {
        message: 'workflow state ready: {{workflow_state.status}}',
      },
    },
  ],
};
