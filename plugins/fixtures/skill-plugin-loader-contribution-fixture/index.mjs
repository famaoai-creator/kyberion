export const registerKyberionContributions = (api) => {
  api.registerOperation('fixture:run', {
    stepType: 'apply',
    handler: async (_op, _params, context) => ({ handled: true, ctx: context }),
  });
  api.registerHook('settlement-audit', {
    id: 'hook',
    event: 'task_settled',
    handler: () => undefined,
  });
  api.registerPromptSection('fixture-note', 'Fixture contribution prompt section.');
};
