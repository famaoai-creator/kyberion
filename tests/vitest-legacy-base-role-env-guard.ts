/**
 * Vitest setup file (S4, ADR concept-model-v2 D5): `KYBERION_PERSONA` is the
 * retired name of `KYBERION_BASE_ROLE`, still read for one release when the new
 * name is absent (`libs/core/foundation/base-role-env.ts`). A suite that clears
 * `KYBERION_BASE_ROLE` to run with no base role would otherwise pick up a
 * legacy value inherited from the operator's shell or an older CI env, so the
 * retired name never reaches a test file unless the test sets it itself.
 */
delete process.env.KYBERION_PERSONA;
