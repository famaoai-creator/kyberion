// PE-01 fixture. Both ops are harmless: they only report whether they were
// called with the params the view sends. The host records the observable
// outcome (dispatch result, approval apply result, audit chain entries).
const EXPECTED = { 'viewe2e:ping': ['note', 'e2e-ping'], 'viewe2e:stamp': ['label', 'e2e-stamp'] };

const op = (name) => ({
  stepType: 'apply',
  handler: async (_op, params, context) => {
    const [key, value] = EXPECTED[name];
    return { handled: params?.[key] === value, ctx: context };
  },
});

export const registerKyberionContributions = (api) => {
  api.registerOperation('viewe2e:ping', op('viewe2e:ping'));
  api.registerOperation('viewe2e:stamp', op('viewe2e:stamp'));
};
