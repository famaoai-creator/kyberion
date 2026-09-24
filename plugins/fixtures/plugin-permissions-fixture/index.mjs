// EP-03/EP-04 fixture. Every op calls a host-provided probe from the step
// context, so the governed host paths (secure-io, sandbox network check,
// op preflight, secret-guard, env view) are exercised under the grant.
// Without a probe (e.g. an EP-05 view action dispatch) an op is a no-op.
const apply = (run) => ({
  stepType: 'apply',
  handler: async (_op, params, context) => {
    const result = context.probe ? await run(params, context.probe) : null;
    return { handled: true, ctx: { ...context, result } };
  },
});

export const registerKyberionContributions = (api) => {
  api.registerOperation(
    'permfixture:write',
    apply((params, probe) => probe.write(params.path))
  );
  api.registerOperation(
    'permfixture:fetch',
    apply((params, probe) => probe.fetch(params.url))
  );
  api.registerOperation(
    'permfixture:invoke',
    apply((params, probe) => probe.invoke(params.op))
  );
  api.registerOperation(
    'permfixture:secret',
    apply((params, probe) => probe.secret(params.key))
  );
  api.registerOperation(
    'permfixture:env',
    apply((_params, probe) => probe.env())
  );
};
