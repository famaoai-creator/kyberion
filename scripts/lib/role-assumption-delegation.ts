/**
 * DR-01 helpers for the role assumption analysis (role-assumption-graph.ts):
 * the delegated child role (`KYBERION_DELEGATED_ROLE`) that
 * `buildExecutionEnv(env, role)` sets when the child env carries SYSTEM_ROLE,
 * and the launch env builder `buildSystemRoleLaunchEnv` that starts a process
 * under a NEW SYSTEM_ROLE without the launcher's delegation. Pure AST helpers;
 * the graph owns resolution and reporting.
 */
import * as ts from 'typescript';

/**
 * `buildExecutionEnv(env, role)` delegates `role` to the child when the env
 * carries SYSTEM_ROLE; the child then runs as `role` under the parent's
 * SYSTEM_ROLE bounds, so the call is an assumption site of `role` for every
 * system role that reaches it (the child entry itself is walked as a spawn).
 */
export const DELEGATION_FUNCTION = 'buildExecutionEnv';
/** Builds a child env under a NEW SYSTEM_ROLE and clears any delegation. */
export const SYSTEM_ROLE_LAUNCH_FUNCTION = 'buildSystemRoleLaunchEnv';
export const DELEGATED_ROLE_ENV_NAME = 'KYBERION_DELEGATED_ROLE';
const DELEGATED_ROLE_ENV_CONST = 'DELEGATED_ROLE_ENV';

export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function isUndefinedExpression(expression: ts.Expression): boolean {
  const expr = unwrapExpression(expression);
  return (
    expr.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isIdentifier(expr) && expr.text === 'undefined')
  );
}

/**
 * `buildExecutionEnv({ ...env, SYSTEM_ROLE: <s> }, <role>)` delegates <role>
 * to a child that runs under system role <s>, whoever spawns it.
 */
export interface ForeignDelegation<U> {
  unit: U;
  site: string;
  systemRoles: Set<string>;
  /** The SYSTEM_ROLE value could not be resolved: the delegation may target any system role. */
  anySystemRole: boolean;
  roles: Set<string>;
  /** Why the system role or the delegated role is not fully known ("any"). */
  unresolved: string[];
}

/**
 * The `SYSTEM_ROLE` value of an object-literal env, following const
 * initializers through `initializerOf` (the graph's resolver).
 */
export function systemRoleOfEnvLiteral(
  expression: ts.Expression,
  initializerOf: (node: ts.Expression) => ts.Expression | 'parameter' | undefined,
  depth = 0
): ts.Expression | undefined {
  const expr = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(expr)) {
    for (const property of [...expr.properties].reverse()) {
      if (
        ts.isPropertyAssignment(property) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === 'SYSTEM_ROLE'
      ) {
        return property.initializer;
      }
    }
    return undefined;
  }
  if (depth < 3) {
    const initializer = initializerOf(expr);
    if (initializer && initializer !== 'parameter') {
      return systemRoleOfEnvLiteral(initializer, initializerOf, depth + 1);
    }
  }
  return undefined;
}

function namesDelegatedRole(name: ts.Node | undefined): boolean {
  if (!name) return false;
  if (ts.isComputedPropertyName(name)) return namesDelegatedRole(name.expression);
  const expr = ts.isExpression(name) ? unwrapExpression(name) : name;
  if (ts.isIdentifier(expr)) {
    return expr.text === DELEGATED_ROLE_ENV_NAME || expr.text === DELEGATED_ROLE_ENV_CONST;
  }
  return ts.isStringLiteralLike(expr) && expr.text === DELEGATED_ROLE_ENV_NAME;
}

/**
 * The value `node` writes into KYBERION_DELEGATED_ROLE (an object-literal
 * property, an assignment, or `setRegisteredEnv`), unless it is blank ('' or
 * undefined, i.e. a clear). Only libs/core/authority.ts may write it.
 */
export function delegatedRoleWriteValue(node: ts.Node): ts.Expression | undefined {
  let written: ts.Expression | undefined;
  if (ts.isPropertyAssignment(node) && namesDelegatedRole(node.name)) {
    written = node.initializer;
  } else if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ((ts.isPropertyAccessExpression(node.left) &&
      node.left.name.text === DELEGATED_ROLE_ENV_NAME) ||
      (ts.isElementAccessExpression(node.left) && namesDelegatedRole(node.left.argumentExpression)))
  ) {
    written = node.right;
  } else if (ts.isCallExpression(node)) {
    const callee = unwrapExpression(node.expression);
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : '';
    if (name === 'setRegisteredEnv' && namesDelegatedRole(node.arguments[0])) {
      written = node.arguments[1];
    }
  }
  if (!written) return undefined;
  const value = unwrapExpression(written);
  const blank =
    (ts.isStringLiteralLike(value) && value.text === '') || isUndefinedExpression(value);
  return blank ? undefined : written;
}

/**
 * The single `return <expr>` of a function declaration, when that expression
 * is directly a call or an object literal. A returned local variable may have
 * been filled in place (a copy loop over process.env), which its initializer
 * does not show, so it stays opaque (undefined).
 */
export function singleReturnedEnvExpression(
  declaration: ts.FunctionDeclaration
): ts.Expression | undefined {
  if (!declaration.body) return undefined;
  const returns: ts.ReturnStatement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== declaration) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  const returned = returns.length === 1 ? returns[0].expression : undefined;
  const inner = returned ? unwrapExpression(returned) : undefined;
  return inner && (ts.isCallExpression(inner) || ts.isObjectLiteralExpression(inner))
    ? returned
    : undefined;
}
