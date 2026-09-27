/**
 * RN-02 reference graph for scripts/analyze_role_assumptions.ts: units
 * (module initialisation code and top-level declarations), the edges between
 * them, the resolved role of every withExecutionContext* call (including
 * roles forwarded through wrapper parameters) and the child processes that
 * may inherit SYSTEM_ROLE.
 *
 * Process and module patterns (S9):
 *  - detected: child_process / node-pty spawn functions reached through an
 *    import, a namespace, a require() of the child_process module,
 *    `createRequire(...)('child_process')` or `await import(...)` binding,
 *    and `promisify(<child_process fn>)` wrappers; the secure-io exec
 *    helpers and managed-process spawners; `worker_threads` `new Worker(...)`
 *    (an in-process thread with the same SYSTEM_ROLE: its module is loaded
 *    like a dynamic import, a same-module `new URL(import.meta.url)` worker is
 *    already reachable, anything else is an any-role site).
 *  - not modelled: commands that start further commands (git hooks run by a
 *    `git` child, npm lifecycle scripts, an external agent CLI that runs
 *    Kyberion commands): a literal external command is not followed, so such
 *    a child only matters when it inherits SYSTEM_ROLE and runs Kyberion
 *    code; the secure-io exec helpers drop SYSTEM_ROLE unless the caller
 *    passes it back in, and provider CLIs get buildProviderChildEnv (unless
 *    KYBERION_PROVIDER_ENV_ALLOWLIST=0). Spawn functions reached through a
 *    value the checker cannot bind (a callback parameter, a registry entry)
 *    are not seen either.
 */
import * as ts from 'typescript';
import * as path from 'node:path';
import {
  REVIEWED_CHILD_PROCESSES,
  REVIEWED_DYNAMIC_IMPORTS,
  REVIEWED_UNANALYSED_MODULES,
} from './role-assumption-reviews.js';
import {
  expandModuleGlobs,
  isProjectSource,
  sourceForScriptReference,
  type ModuleResolver,
  type Workspace,
} from './role-assumption-workspace.js';

/** Specifiers that name Kyberion code (relative, `@/`, workspace scopes). */
const INTERNAL_SPECIFIER = /^(?:\.{1,2}\/|\/|@\/|@agent\/|@actuator\/)/;
/** Extensions of code the analysis must see; assets (.json, .css, ...) are not code. */
const CODE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

function isInternalCodeSpecifier(specifier: string): boolean {
  if (!INTERNAL_SPECIFIER.test(specifier)) return false;
  const last = specifier.split('/').pop() ?? '';
  return !last.includes('.') || CODE_EXTENSION.test(last);
}

const ASSUMPTION_FUNCTIONS = new Set(['withExecutionContext', 'withExecutionContextAsync']);
/**
 * DR-01: `buildExecutionEnv(env, role)` delegates `role` to the child when the
 * env carries SYSTEM_ROLE; the child then runs as `role` under the parent's
 * SYSTEM_ROLE bounds, so the call is an assumption site of `role` for every
 * system role that reaches it (the child entry itself is walked as a spawn).
 */
const DELEGATION_FUNCTION = 'buildExecutionEnv';
const AUTHORITY_FILE = 'libs/core/authority.ts';

/**
 * Spawn helpers, matched as the exported functions of their module whose name
 * matches `name`: where their options argument is and whether a call without
 * an explicit env inherits process.env (the secure-io exec helpers build an
 * allowlisted env that drops SYSTEM_ROLE unless the caller passes one back in;
 * the managed-process spawner hands its spawn options to child_process).
 */
const CORE_SPAWN_HELPERS: ReadonlyArray<{
  file: string;
  name: RegExp;
  inheritsByDefault: boolean;
  optionsIndex: number;
}> = [
  {
    file: 'libs/core/secure-io.ts',
    name: /^safe(?:Exec|Spawn)/,
    inheritsByDefault: false,
    optionsIndex: 2,
  },
  {
    file: 'libs/core/managed-process.ts',
    name: /^spawn/,
    inheritsByDefault: true,
    optionsIndex: 0,
  },
];
/** Modules whose spawn functions start a process that inherits process.env by default. */
const PROCESS_SPAWN_MODULES = new Set(['child_process', 'node:child_process', 'node-pty']);
const CHILD_PROCESS_FUNCTIONS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
/** Commands that can start Kyberion code; anything else is an external binary. */
const ENTRY_CAPABLE_COMMANDS = new Set(['node', 'pnpm', 'npm', 'npx', 'tsx', 'bash', 'sh']);

// ---------------------------------------------------------------------------
// Units: module initialisation code and top-level declarations
// ---------------------------------------------------------------------------

export interface Unit {
  id: string;
  file: string;
  lazy: boolean;
  exported: boolean;
  /** A direct-entry guarded block: runs only when the file is the process entry point. */
  entryOnly?: boolean;
  roots: ts.Node[];
}

const DIRECT_ENTRY_GUARDS = new Set(['isDirectEntry', 'isDirectScript', 'isMainModule']);

/** `if (isDirectEntry(import.meta.url, ...)) { ... }` and its equivalents. */
function isDirectEntryGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  let guarded = false;
  const visit = (node: ts.Node): void => {
    if (guarded) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DIRECT_ENTRY_GUARDS.has(node.expression.text)
    ) {
      guarded = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement.expression);
  if (guarded) {
    // Only a pure disjunction of guard calls qualifies; `guard || other` would
    // also run for other reasons.
    const onlyGuards = (node: ts.Expression): boolean => {
      const expr = unwrapExpression(node);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        return onlyGuards(expr.left) && onlyGuards(expr.right);
      }
      return (
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        DIRECT_ENTRY_GUARDS.has(expr.expression.text)
      );
    };
    return onlyGuards(statement.expression);
  }
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
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

function isFunctionLikeExpression(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const inner = unwrapExpression(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function classNeedsEagerEvaluation(node: ts.ClassDeclaration): boolean {
  return node.members.some(
    (member) =>
      ts.isClassStaticBlockDeclaration(member) ||
      (ts.isPropertyDeclaration(member) &&
        !!member.initializer &&
        (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword))
  );
}

class UnitIndex {
  readonly units = new Map<string, Unit>();
  private readonly rootToUnit = new Map<ts.Node, Unit>();
  private readonly moduleUnits = new Map<ts.SourceFile, Unit>();

  constructor(
    private readonly ws: Workspace,
    sourceFiles: readonly ts.SourceFile[]
  ) {
    for (const sourceFile of sourceFiles) this.index(sourceFile);
  }

  private add(unit: Unit): Unit {
    this.units.set(unit.id, unit);
    for (const root of unit.roots) this.rootToUnit.set(root, unit);
    return unit;
  }

  private index(sourceFile: ts.SourceFile): void {
    const rel = this.ws.rel(sourceFile.fileName);
    const moduleUnit: Unit = {
      id: `${rel}#<module>`,
      file: rel,
      lazy: false,
      exported: false,
      roots: [],
    };
    this.units.set(moduleUnit.id, moduleUnit);
    this.moduleUnits.set(sourceFile, moduleUnit);
    const named = new Map<string, number>();
    const unitId = (name: string): string => {
      const count = named.get(name) ?? 0;
      named.set(name, count + 1);
      return `${rel}#${count === 0 ? name : `${name}~${count + 1}`}`;
    };
    for (const statement of sourceFile.statements) {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.body) {
        const name = statement.name?.text ?? 'default';
        this.add({
          id: unitId(name),
          file: rel,
          lazy: true,
          exported: hasExportModifier(statement),
          roots: [statement],
        });
        continue;
      }
      if (ts.isClassDeclaration(statement) && !classNeedsEagerEvaluation(statement)) {
        const name = statement.name?.text ?? 'default';
        this.add({
          id: unitId(name),
          file: rel,
          lazy: true,
          exported: hasExportModifier(statement),
          roots: [statement],
        });
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            isFunctionLikeExpression(declaration.initializer)
          ) {
            this.add({
              id: unitId(declaration.name.text),
              file: rel,
              lazy: true,
              exported,
              roots: [declaration],
            });
          } else {
            moduleUnit.roots.push(declaration);
            this.rootToUnit.set(declaration, moduleUnit);
          }
        }
        continue;
      }
      if (ts.isExportAssignment(statement) && isFunctionLikeExpression(statement.expression)) {
        this.add({
          id: unitId('default'),
          file: rel,
          lazy: true,
          exported: true,
          roots: [statement],
        });
        continue;
      }
      if (isDirectEntryGuard(statement)) {
        this.add({
          id: unitId('<main>'),
          file: rel,
          lazy: true,
          exported: false,
          entryOnly: true,
          roots: [statement],
        });
        continue;
      }
      moduleUnit.roots.push(statement);
      this.rootToUnit.set(statement, moduleUnit);
    }
  }

  moduleUnit(sourceFile: ts.SourceFile): Unit | undefined {
    return this.moduleUnits.get(sourceFile);
  }

  /** The unit that owns `node`, or undefined when `node` is outside the project. */
  unitOf(node: ts.Node): Unit | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      const unit = this.rootToUnit.get(current);
      if (unit) return unit;
      if (ts.isSourceFile(current)) return this.moduleUnits.get(current);
      current = current.parent;
    }
    return undefined;
  }

  unitsOfFile(rel: string): Unit[] {
    return [...this.units.values()].filter((unit) => unit.file === rel);
  }
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

interface RoleResolution {
  roles: Set<string>;
  unresolved: string[];
  forwards: Forward[];
}

interface Forward {
  fn: ts.SignatureDeclaration;
  index: number;
  property?: string;
  /** The literal union of the parameter's declared type, when it has one. */
  declared?: string[];
}

interface CallRef {
  unit: Unit;
  call: ts.CallExpression | ts.NewExpression;
}

export interface RoleRecord {
  unit: Unit;
  site: string;
  roles: Set<string>;
  unresolved: string[];
}

export interface SpawnRecord {
  unit: Unit;
  site: string;
  inheritsSystemRole: boolean;
  kyberionCapable: boolean;
  targets: string[];
}

function emptyResolution(): RoleResolution {
  return { roles: new Set(), unresolved: [], forwards: [] };
}

function mergeResolution(into: RoleResolution, from: RoleResolution): RoleResolution {
  for (const role of from.roles) into.roles.add(role);
  into.unresolved.push(...from.unresolved);
  into.forwards.push(...from.forwards);
  return into;
}

function isInTypePosition(node: ts.Node): boolean {
  return ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);
}

function functionLikeOf(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration;
  }
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    declaration.initializer
  ) {
    const inner = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
  }
  return undefined;
}

export class Analyzer {
  readonly checker: ts.TypeChecker;
  readonly units: UnitIndex;
  readonly edges = new Map<Unit, Set<Unit>>();
  readonly unresolvedEdges = new Map<Unit, string[]>();
  readonly roleRecords: RoleRecord[] = [];
  readonly spawnRecords: SpawnRecord[] = [];
  private readonly callRefs = new Map<ts.SignatureDeclaration, CallRef[]>();
  private readonly valueRefs = new Map<ts.SignatureDeclaration, Unit[]>();
  private readonly pendingForwards: Array<{
    unit: Unit;
    site: string;
    resolution: RoleResolution;
  }> = [];
  private readonly assumptionDeclarations = new Set<ts.Declaration>();
  private readonly delegationDeclarations = new Set<ts.Declaration>();
  private readonly spawnHelperDeclarations = new Map<
    ts.Declaration,
    { inheritsByDefault: boolean; optionsIndex: number }
  >();
  private readonly projectFiles: readonly ts.SourceFile[];

  constructor(
    private readonly ws: Workspace,
    readonly program: ts.Program,
    private readonly packageScripts: Record<string, string>,
    private readonly resolveModule: ModuleResolver
  ) {
    this.checker = program.getTypeChecker();
    this.projectFiles = program
      .getSourceFiles()
      .filter((sourceFile) => isProjectSource(ws, sourceFile.fileName));
    this.units = new UnitIndex(ws, this.projectFiles);
    this.indexKnownDeclarations();
    for (const sourceFile of this.projectFiles) this.scanFile(sourceFile);
    this.resolveForwards();
  }

  private indexKnownDeclarations(): void {
    for (const sourceFile of this.projectFiles) {
      const rel = this.ws.rel(sourceFile.fileName);
      for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
        const name = statement.name.text;
        if (rel === AUTHORITY_FILE && ASSUMPTION_FUNCTIONS.has(name)) {
          this.assumptionDeclarations.add(statement);
        }
        if (rel === AUTHORITY_FILE && name === DELEGATION_FUNCTION) {
          this.delegationDeclarations.add(statement);
        }
        const helper = CORE_SPAWN_HELPERS.find(
          (candidate) => candidate.file === rel && candidate.name.test(name)
        );
        if (helper && hasExportModifier(statement)) {
          this.spawnHelperDeclarations.set(statement, helper);
        }
      }
    }
  }

  private addEdge(from: Unit, to: Unit | undefined): void {
    if (!to || to === from) return;
    let targets = this.edges.get(from);
    if (!targets) this.edges.set(from, (targets = new Set()));
    targets.add(to);
  }

  private addUnresolvedEdge(from: Unit, reason: string): void {
    const list = this.unresolvedEdges.get(from) ?? [];
    list.push(reason);
    this.unresolvedEdges.set(from, list);
  }

  private resolveAlias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        const aliased = this.checker.getAliasedSymbol(symbol);
        if (aliased && !(aliased.flags & ts.SymbolFlags.Alias)) return aliased;
        return aliased;
      } catch {
        return undefined;
      }
    }
    return symbol;
  }

  private moduleSourceFile(specifier: ts.Expression): ts.SourceFile | undefined {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && ts.isSourceFile(declaration) ? declaration : undefined;
  }

  /**
   * The program source a literal specifier loads. An internal code specifier
   * that resolves to nothing the program holds is recorded as an any-role
   * edge on `unit` rather than silently dropped.
   */
  private loadSpecifier(
    unit: Unit,
    specifier: ts.StringLiteralLike,
    viaChecker: boolean
  ): ts.SourceFile | undefined {
    const fromChecker = viaChecker ? this.moduleSourceFile(specifier) : undefined;
    if (fromChecker) return fromChecker;
    const text = specifier.text;
    if (!isInternalCodeSpecifier(text)) return undefined;
    const fromFile = specifier.getSourceFile().fileName;
    const resolved = this.resolveModule(text, fromFile);
    const target = resolved ? this.program.getSourceFile(resolved) : undefined;
    if (!target && !this.isReviewedUnanalysedModule(text, fromFile)) {
      this.addUnresolvedEdge(
        unit,
        `module specifier '${text}' does not resolve to an analysed source (${this.position(specifier)})`
      );
    }
    return target;
  }

  private readonly reviewedUnanalysed = new Map<string, boolean>();

  /** A relative load of a reviewed browser-only JS module that still passes its guard. */
  private isReviewedUnanalysedModule(specifier: string, fromFile: string): boolean {
    if (!specifier.startsWith('.')) return false;
    const file = path.resolve(path.dirname(fromFile), specifier);
    const cached = this.reviewedUnanalysed.get(file);
    if (cached !== undefined) return cached;
    const reviewed = new Set(
      REVIEWED_UNANALYSED_MODULES.flatMap((entry) =>
        expandModuleGlobs(this.ws, [entry.pattern]).filter((match) => /\.m?js$/.test(match))
      )
    );
    let ok = reviewed.has(file);
    if (ok) {
      // Parse (comments and JSDoc type imports are not code) and check every load.
      const source = ts.createSourceFile(
        file,
        this.ws.read(file),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS
      );
      const loadsReviewed = (spec: ts.Expression | undefined): boolean =>
        !!spec &&
        ts.isStringLiteralLike(spec) &&
        spec.text.startsWith('./') &&
        reviewed.has(path.resolve(path.dirname(file), spec.text));
      const visit = (node: ts.Node): void => {
        if (!ok) return;
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          !loadsReviewed(node.moduleSpecifier)
        ) {
          ok = false;
        } else if (
          ts.isCallExpression(node) &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
          !loadsReviewed(node.arguments[0])
        ) {
          ok = false;
        } else if (ts.isIdentifier(node) && ASSUMPTION_FUNCTIONS.has(node.text)) {
          ok = false;
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    this.reviewedUnanalysed.set(file, ok);
    return ok;
  }

  /** `require` itself, or an identifier bound to `createRequire(...)`. */
  private isRequireCallee(expression: ts.Expression): boolean {
    const callee = unwrapExpression(expression);
    if (!ts.isIdentifier(callee)) return false;
    if (callee.text === 'require') return true;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(callee));
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return false;
    }
    const init = unwrapExpression(declaration.initializer);
    if (!ts.isCallExpression(init)) return false;
    const factory = unwrapExpression(init.expression);
    const name = ts.isPropertyAccessExpression(factory)
      ? factory.name.text
      : ts.isIdentifier(factory)
        ? factory.text
        : '';
    return name === 'createRequire';
  }

  /** Every declaration exported by `sourceFile` (following re-exports). */
  private exportedUnits(sourceFile: ts.SourceFile): Unit[] {
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    const result: Unit[] = [];
    const moduleUnit = this.units.moduleUnit(sourceFile);
    if (moduleUnit) result.push(moduleUnit);
    if (!moduleSymbol) return result;
    for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
      const target = this.resolveAlias(exported);
      for (const declaration of target?.declarations ?? []) {
        const unit = this.units.unitOf(declaration);
        if (unit) result.push(unit);
      }
    }
    return result;
  }

  private importedModuleOf(symbol: ts.Symbol): ts.SourceFile | undefined {
    const declaration = symbol.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isNamespaceImport(declaration)) {
      return this.moduleSourceFile(declaration.parent.parent.moduleSpecifier);
    }
    if (ts.isNamespaceExport(declaration)) {
      const specifier = declaration.parent.moduleSpecifier;
      return specifier ? this.moduleSourceFile(specifier) : undefined;
    }
    return undefined;
  }

  /**
   * The module a binding comes from: an import declaration, or a variable
   * initialised by `require('x')`, a createRequire-bound call or
   * `await import('x')` (including destructuring of those).
   */
  private importModuleSpecifierOf(symbol: ts.Symbol): string | undefined {
    const declaration = symbol.declarations?.[0];
    if (!declaration) return undefined;
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isImportDeclaration(current)) {
        return ts.isStringLiteral(current.moduleSpecifier)
          ? current.moduleSpecifier.text
          : undefined;
      }
      if (ts.isVariableDeclaration(current)) {
        return current.initializer ? this.loadedModuleText(current.initializer) : undefined;
      }
      current = current.parent;
    }
    return undefined;
  }

  /** `require('x')`, `<createRequire-bound>('x')`, `import('x')`, awaited or not. */
  private loadedModuleText(expression: ts.Expression): string | undefined {
    let inner = unwrapExpression(expression);
    if (ts.isAwaitExpression(inner)) inner = unwrapExpression(inner.expression);
    if (!ts.isCallExpression(inner)) return undefined;
    const [argument] = inner.arguments;
    if (!argument || !ts.isStringLiteralLike(argument)) return undefined;
    const isLoad =
      inner.expression.kind === ts.SyntaxKind.ImportKeyword ||
      this.isRequireCallee(inner.expression);
    return isLoad ? argument.text : undefined;
  }

  /** A child_process / node-pty spawn function, directly or through its owner. */
  private isProcessSpawnFunction(expression: ts.Expression): boolean {
    const inner = unwrapExpression(expression);
    const nameNode = ts.isPropertyAccessExpression(inner) ? inner.name : inner;
    if (!ts.isIdentifier(nameNode) || !CHILD_PROCESS_FUNCTIONS.has(nameNode.text)) return false;
    const ownerNode = ts.isPropertyAccessExpression(inner) ? inner.expression : nameNode;
    const owner = this.checker.getSymbolAtLocation(ownerNode);
    const specifier = owner ? this.importModuleSpecifierOf(owner) : undefined;
    return !!specifier && PROCESS_SPAWN_MODULES.has(specifier);
  }

  /** An identifier bound to `promisify(<spawn function>)` (util.promisify too). */
  private isPromisifiedSpawn(expression: ts.Expression): boolean {
    const callee = unwrapExpression(expression);
    if (!ts.isIdentifier(callee)) return false;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(callee));
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) {
      return false;
    }
    const init = unwrapExpression(declaration.initializer);
    if (!ts.isCallExpression(init) || init.arguments.length !== 1) return false;
    const factory = unwrapExpression(init.expression);
    const name = ts.isPropertyAccessExpression(factory)
      ? factory.name.text
      : ts.isIdentifier(factory)
        ? factory.text
        : '';
    return name === 'promisify' && this.isProcessSpawnFunction(init.arguments[0]);
  }

  private scanFile(sourceFile: ts.SourceFile): void {
    const moduleUnit = this.units.moduleUnit(sourceFile);
    if (!moduleUnit) return;
    // Module loading: imports and re-exports load the target module.
    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteralLike(specifier)) continue;
        const target = this.loadSpecifier(moduleUnit, specifier, true);
        if (target) this.addEdge(moduleUnit, this.units.moduleUnit(target));
      }
    }
    for (const unit of this.units.unitsOfFile(this.ws.rel(sourceFile.fileName))) {
      for (const root of unit.roots) this.scanNode(unit, root);
    }
  }

  private scanNode(unit: Unit, node: ts.Node): void {
    if (isInTypePosition(node)) return;
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      this.scanIdentifier(unit, node);
    } else if (ts.isCallExpression(node)) {
      this.scanCall(unit, node);
    } else if (ts.isNewExpression(node)) {
      this.scanNewExpression(unit, node);
    }
    ts.forEachChild(node, (child) => this.scanNode(unit, child));
  }

  private scanCall(unit: Unit, call: ts.CallExpression): void {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = call.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        const target = this.loadSpecifier(unit, argument, true);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
        return;
      }
      // A computed specifier built from a repo path literal (rootResolve('dist/...js')).
      const sources = argument
        ? this.collectStrings(argument)
            .map((value) => sourceForScriptReference(this.ws, value))
            .filter((value): value is string => !!value)
        : [];
      const reviewed = REVIEWED_DYNAMIC_IMPORTS[unit.id];
      const modules = [
        ...sources,
        ...(reviewed ? expandModuleGlobs(this.ws, reviewed.modules) : []),
      ];
      for (const file of modules) {
        const target = this.program.getSourceFile(file);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
      }
      if (sources.length === 0 && !reviewed) {
        this.addUnresolvedEdge(
          unit,
          `dynamic import with a computed specifier at ${this.position(call)}`
        );
      }
      return;
    }
    if (this.isRequireCallee(call.expression)) {
      const [argument] = call.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        // The checker does not bind require() in ESM sources: resolve it here.
        const target = this.loadSpecifier(unit, argument, false);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
      } else {
        this.addUnresolvedEdge(unit, `require with a computed specifier at ${this.position(call)}`);
      }
      return;
    }
    const callee = this.calleeDeclaration(call);
    if (callee && this.assumptionDeclarations.has(callee)) {
      const [roleArgument] = call.arguments;
      const resolution = roleArgument
        ? this.resolveRoleExpression(roleArgument)
        : { ...emptyResolution(), unresolved: ['missing role argument'] };
      this.pendingForwards.push({ unit, site: this.position(call), resolution });
      return;
    }
    if (callee && this.delegationDeclarations.has(callee)) {
      this.recordDelegation(unit, call);
      return;
    }
    const spawnKind = this.spawnKind(call, callee);
    if (spawnKind)
      this.recordSpawn(unit, call, spawnKind.inheritsByDefault, spawnKind.optionsIndex);
  }

  private calleeDeclaration(
    call: ts.CallExpression | ts.NewExpression
  ): ts.Declaration | undefined {
    const expression = unwrapExpression(call.expression);
    const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(nameNode));
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  private spawnKind(
    call: ts.CallExpression,
    callee: ts.Declaration | undefined
  ): { inheritsByDefault: boolean; optionsIndex?: number } | undefined {
    const helper = callee ? this.spawnHelperDeclarations.get(callee) : undefined;
    if (helper) return helper;
    return this.isProcessSpawnFunction(call.expression) || this.isPromisifiedSpawn(call.expression)
      ? { inheritsByDefault: true }
      : undefined;
  }

  /**
   * `new Worker(...)` from worker_threads runs a module in-process with the
   * same SYSTEM_ROLE: load it like a dynamic import.
   */
  private scanNewExpression(unit: Unit, node: ts.NewExpression): void {
    const callee = unwrapExpression(node.expression);
    const nameNode = ts.isPropertyAccessExpression(callee) ? callee.name : callee;
    if (!ts.isIdentifier(nameNode) || nameNode.text !== 'Worker') return;
    const ownerNode = ts.isPropertyAccessExpression(callee) ? callee.expression : nameNode;
    const owner = this.checker.getSymbolAtLocation(ownerNode);
    const specifier = owner ? this.importModuleSpecifierOf(owner) : undefined;
    if (specifier !== 'worker_threads' && specifier !== 'node:worker_threads') return;
    const [target] = node.arguments ?? [];
    const inner = target ? unwrapExpression(target) : undefined;
    // new Worker(new URL(import.meta.url)): the current module, already loaded.
    if (
      inner &&
      ts.isNewExpression(inner) &&
      inner.arguments?.length === 1 &&
      unwrapExpression(inner.arguments[0]).getText() === 'import.meta.url'
    ) {
      return;
    }
    const files = inner
      ? this.collectStrings(inner)
          .map((value) => sourceForScriptReference(this.ws, value))
          .filter((value): value is string => !!value)
      : [];
    let loaded = false;
    for (const file of files) {
      const source = this.program.getSourceFile(file);
      if (!source) continue;
      loaded = true;
      for (const exported of this.exportedUnits(source)) this.addEdge(unit, exported);
    }
    if (!loaded) {
      this.addUnresolvedEdge(
        unit,
        `worker thread module could not be resolved at ${this.position(node)}`
      );
    }
  }

  private position(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    const unit = this.units.unitOf(node);
    return unit ? unit.id : this.ws.rel(sourceFile.fileName);
  }

  private scanIdentifier(unit: Unit, node: ts.Identifier | ts.PrivateIdentifier): void {
    const parent = node.parent;
    let symbol: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(parent);
    } else {
      symbol = this.checker.getSymbolAtLocation(node);
    }
    if (!symbol) return;
    // A namespace import used as a value (not `ns.member`) exposes every export.
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const namespaceModule = this.importedModuleOf(symbol);
      if (namespaceModule) {
        const isMemberAccess =
          (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
          (ts.isElementAccessExpression(parent) &&
            parent.expression === node &&
            ts.isStringLiteralLike(parent.argumentExpression));
        if (!isMemberAccess) {
          for (const exported of this.exportedUnits(namespaceModule)) this.addEdge(unit, exported);
        }
        return;
      }
    }
    const target = this.resolveAlias(symbol);
    for (const declaration of target?.declarations ?? []) {
      if (!isProjectSource(this.ws, declaration.getSourceFile().fileName)) continue;
      const targetUnit = this.units.unitOf(declaration);
      this.addEdge(unit, targetUnit);
      if (
        this.assumptionDeclarations.has(declaration) &&
        !this.isCallee(node) &&
        !this.isDeclarationName(node)
      ) {
        this.addUnresolvedEdge(
          unit,
          `withExecutionContext passed as a value at ${this.position(node)}`
        );
      }
      const fn = functionLikeOf(declaration);
      if (!fn) continue;
      const call = this.enclosingCallForCallee(node);
      if (call) {
        const refs = this.callRefs.get(fn) ?? [];
        refs.push({ unit, call });
        this.callRefs.set(fn, refs);
      } else if (!this.isDeclarationName(node)) {
        const refs = this.valueRefs.get(fn) ?? [];
        refs.push(unit);
        this.valueRefs.set(fn, refs);
      }
    }
  }

  private isDeclarationName(node: ts.Node): boolean {
    const parent = node.parent;
    return (
      !!parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportSpecifier(parent)) &&
      (parent as ts.NamedDeclaration).name === node
    );
  }

  private isCallee(node: ts.Node): boolean {
    return this.enclosingCallForCallee(node) !== undefined;
  }

  private enclosingCallForCallee(node: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
    let current: ts.Node = node;
    if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) {
      current = current.parent;
    }
    while (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAsExpression(current.parent)
    ) {
      current = current.parent;
    }
    const parent = current.parent;
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression === current
    ) {
      return parent;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Role argument resolution
  // -------------------------------------------------------------------------

  private literalStrings(type: ts.Type): string[] | undefined {
    const members = type.isUnion() ? type.types : [type];
    const values: string[] = [];
    for (const member of members) {
      if (member.isStringLiteral()) values.push(member.value);
      else if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      else return undefined;
    }
    return values.length > 0 ? values : undefined;
  }

  resolveRoleExpression(expression: ts.Expression, depth = 0): RoleResolution {
    const result = emptyResolution();
    const expr = unwrapExpression(expression);
    if (depth > 8) {
      result.unresolved.push(`role expression too deep at ${this.position(expr)}`);
      return result;
    }
    if (ts.isStringLiteralLike(expr)) {
      result.roles.add(expr.text);
      return result;
    }
    if (ts.isBinaryExpression(expr)) {
      const operator = expr.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        if (operator !== ts.SyntaxKind.AmpersandAmpersandToken) {
          mergeResolution(result, this.resolveRoleExpression(expr.left, depth + 1));
        }
        return mergeResolution(result, this.resolveRoleExpression(expr.right, depth + 1));
      }
    }
    if (ts.isConditionalExpression(expr)) {
      mergeResolution(result, this.resolveRoleExpression(expr.whenTrue, depth + 1));
      return mergeResolution(result, this.resolveRoleExpression(expr.whenFalse, depth + 1));
    }
    // A role taken from a parameter is attributed to each call site (below),
    // which is more precise than the parameter's declared union.
    if (ts.isIdentifier(expr)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isParameter(declaration)) {
        return this.forwardParameter(declaration, undefined, result, depth, expr);
      }
      if (declaration && ts.isBindingElement(declaration)) {
        const forwarded = this.forwardBindingElement(declaration, result, depth, expr);
        if (forwarded) return forwarded;
      }
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = unwrapExpression(expr.expression);
      if (ts.isIdentifier(owner)) {
        const ownerSymbol = this.resolveAlias(this.checker.getSymbolAtLocation(owner));
        const ownerDeclaration = ownerSymbol?.valueDeclaration ?? ownerSymbol?.declarations?.[0];
        if (ownerDeclaration && ts.isParameter(ownerDeclaration)) {
          return this.forwardParameter(ownerDeclaration, expr.name.text, result, depth, expr);
        }
      }
    }
    const literal = this.literalStrings(this.checker.getTypeAtLocation(expr));
    if (literal) {
      for (const value of literal) result.roles.add(value);
      return result;
    }
    if (ts.isIdentifier(expr)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return mergeResolution(
          result,
          this.resolveRoleExpression(declaration.initializer, depth + 1)
        );
      }
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = unwrapExpression(expr.expression);
      const fromObject = this.propertyInitializerOfConstObject(owner, expr.name.text);
      if (fromObject) {
        return mergeResolution(result, this.resolveRoleExpression(fromObject, depth + 1));
      }
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr.name));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (
        declaration &&
        (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) &&
        declaration.initializer
      ) {
        return mergeResolution(
          result,
          this.resolveRoleExpression(declaration.initializer, depth + 1)
        );
      }
    }
    result.unresolved.push(
      `role argument \`${expr.getText().slice(0, 80)}\` could not be resolved at ${this.position(expr)}`
    );
    return result;
  }

  /** `CONST.prop` where CONST is a (possibly Object.freeze-wrapped) object literal. */
  private propertyInitializerOfConstObject(
    owner: ts.Expression,
    property: string
  ): ts.Expression | undefined {
    const initializer = this.initializerOf(owner);
    if (!initializer || initializer === 'parameter') return undefined;
    let objectExpression = unwrapExpression(initializer);
    if (ts.isCallExpression(objectExpression) && objectExpression.arguments.length === 1) {
      objectExpression = unwrapExpression(objectExpression.arguments[0]);
    }
    if (!ts.isObjectLiteralExpression(objectExpression)) return undefined;
    for (const entry of objectExpression.properties) {
      if (
        ts.isPropertyAssignment(entry) &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === property
      ) {
        return entry.initializer;
      }
    }
    return undefined;
  }

  private forwardParameter(
    parameter: ts.ParameterDeclaration,
    property: string | undefined,
    result: RoleResolution,
    depth: number,
    reference?: ts.Expression
  ): RoleResolution {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    if (parameter.dotDotDotToken || index < 0) {
      result.unresolved.push(`role taken from a rest parameter at ${this.position(parameter)}`);
      return result;
    }
    const declared = reference
      ? this.literalStrings(this.checker.getTypeAtLocation(reference))
      : undefined;
    result.forwards.push({
      fn,
      index,
      ...(property ? { property } : {}),
      ...(declared ? { declared } : {}),
    });
    if (!property && parameter.initializer) {
      mergeResolution(result, this.resolveRoleExpression(parameter.initializer, depth + 1));
    }
    return result;
  }

  private forwardBindingElement(
    element: ts.BindingElement,
    result: RoleResolution,
    depth: number,
    reference?: ts.Expression
  ): RoleResolution | undefined {
    const pattern = element.parent;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isParameter(pattern.parent)) return undefined;
    const propertyName = element.propertyName ?? element.name;
    if (!ts.isIdentifier(propertyName)) return undefined;
    if (element.initializer) {
      mergeResolution(result, this.resolveRoleExpression(element.initializer, depth + 1));
    }
    return this.forwardParameter(pattern.parent, propertyName.text, result, depth, reference);
  }

  private resolveArgument(
    call: ts.CallExpression | ts.NewExpression,
    forward: Forward
  ): RoleResolution {
    const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    const spreadIndex = args.findIndex((arg) => ts.isSpreadElement(arg));
    if (spreadIndex >= 0 && spreadIndex <= forward.index) {
      return { ...emptyResolution(), unresolved: [`spread argument at ${this.position(call)}`] };
    }
    const argument = args[forward.index];
    if (!argument) return emptyResolution();
    if (!forward.property) return this.resolveRoleExpression(argument);
    const inner = unwrapExpression(argument);
    if (ts.isObjectLiteralExpression(inner)) {
      let found: RoleResolution | undefined;
      for (const property of inner.properties) {
        if (ts.isSpreadAssignment(property)) {
          return {
            ...emptyResolution(),
            unresolved: [`spread options object at ${this.position(call)}`],
          };
        }
        const name =
          property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
        if (name !== forward.property) continue;
        if (ts.isPropertyAssignment(property))
          found = this.resolveRoleExpression(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property))
          found = this.resolveRoleExpression(property.name);
        else {
          found = {
            ...emptyResolution(),
            unresolved: [
              `role option \`${forward.property}\` is not a value at ${this.position(call)}`,
            ],
          };
        }
      }
      return found ?? emptyResolution();
    }
    const type = this.checker.getTypeAtLocation(inner);
    const property = type.getProperty(forward.property);
    if (property) {
      const literal = this.literalStrings(this.checker.getTypeOfSymbolAtLocation(property, inner));
      if (literal) return { ...emptyResolution(), roles: new Set(literal) };
    }
    if (ts.isIdentifier(inner)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(inner));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isParameter(declaration)) {
        return this.forwardParameter(declaration, forward.property, emptyResolution(), 0);
      }
    }
    return {
      ...emptyResolution(),
      unresolved: [
        `role option \`${forward.property}\` of \`${inner.getText().slice(0, 60)}\` could not be resolved at ${this.position(call)}`,
      ],
    };
  }

  private isDispatchableMethod(fn: ts.SignatureDeclaration): boolean {
    if (ts.isMethodDeclaration(fn)) return true;
    const parent = fn.parent;
    return (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      !!parent &&
      (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    );
  }

  /** Attribute forwarded roles to the call sites of role-forwarding wrappers. */
  private resolveForwards(): void {
    const queue = [...this.pendingForwards];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { unit, site, resolution } = item;
      if (resolution.roles.size > 0 || resolution.unresolved.length > 0) {
        this.roleRecords.push({
          unit,
          site:
            unit.id === site || site.startsWith(`${unit.id} [`) ? site : `${unit.id} (via ${site})`,
          roles: new Set(resolution.roles),
          unresolved: [...resolution.unresolved],
        });
      }
      for (const forward of resolution.forwards) {
        const key = `${unit.id}|${site}|${forward.fn.pos}:${forward.fn.getSourceFile().fileName}|${forward.index}|${forward.property ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const ref of this.callRefs.get(forward.fn) ?? []) {
          queue.push({
            unit: ref.unit,
            site: `${site}`,
            resolution: this.resolveArgument(ref.call, forward),
          });
        }
        const fallback = (reason: string): RoleResolution =>
          forward.declared
            ? { ...emptyResolution(), roles: new Set(forward.declared) }
            : { ...emptyResolution(), unresolved: [reason] };
        const wrapperUnit = this.units.unitOf(forward.fn);
        for (const valueUnit of this.valueRefs.get(forward.fn) ?? []) {
          if (valueUnit === wrapperUnit) continue;
          queue.push({
            unit: valueUnit,
            site,
            resolution: fallback(
              `role-forwarding function ${wrapperUnit?.id ?? '?'} is passed as a value in ${valueUnit.id}`
            ),
          });
        }
        // A method can also be invoked through an interface or `this`-less
        // dispatch the checker does not bind to it: attribute its declared
        // role type (or "any") to the method's own unit as well.
        if (wrapperUnit && this.isDispatchableMethod(forward.fn)) {
          queue.push({
            unit: wrapperUnit,
            site,
            resolution: fallback(
              `role-forwarding method at ${wrapperUnit.id} may be invoked through dynamic dispatch`
            ),
          });
        }
      }
    }
  }

  /**
   * DR-01: a `buildExecutionEnv(env, role)` whose env may carry SYSTEM_ROLE
   * delegates `role` to the child: record it as an assumption of `role`
   * (resolved like a withExecutionContext role argument, forwarded through
   * wrapper parameters, "any role" when unresolvable). Without a role, or
   * with an env that cannot carry SYSTEM_ROLE, nothing is delegated.
   */
  private recordDelegation(unit: Unit, call: ts.CallExpression): void {
    const [baseEnv, roleArgument] = call.arguments;
    if (!roleArgument) return;
    const role = unwrapExpression(roleArgument);
    if (
      role.kind === ts.SyntaxKind.UndefinedKeyword ||
      (ts.isIdentifier(role) && role.text === 'undefined')
    ) {
      return;
    }
    if (baseEnv && !this.envInherits(baseEnv)) return;
    this.pendingForwards.push({
      unit,
      site: `${this.position(call)} [delegated child role]`,
      resolution: this.resolveRoleExpression(roleArgument),
    });
  }

  // -------------------------------------------------------------------------
  // Child processes
  // -------------------------------------------------------------------------

  private collectStrings(node: ts.Node, depth = 0, out: string[] = []): string[] {
    if (depth > 3) return out;
    const visit = (current: ts.Node): void => {
      if (ts.isStringLiteralLike(current)) {
        out.push(current.text);
        for (const token of current.text.split(/[\s'"`=;&|()]+/)) if (token) out.push(token);
      } else if (ts.isCallExpression(current)) {
        const parts = current.arguments.filter(ts.isStringLiteralLike).map((arg) => arg.text);
        if (parts.length > 1) out.push(parts.join('/'));
      } else if (ts.isIdentifier(current) && depth < 3) {
        const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(current));
        const declaration = symbol?.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          isProjectSource(this.ws, declaration.getSourceFile().fileName)
        ) {
          this.collectStrings(declaration.initializer, depth + 1, out);
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return out;
  }

  /** Resolve an identifier to its variable initializer (project sources only). */
  private initializerOf(node: ts.Expression): ts.Expression | 'parameter' | undefined {
    const inner = unwrapExpression(node);
    if (!ts.isIdentifier(inner)) return undefined;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(inner));
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !isProjectSource(this.ws, declaration.getSourceFile().fileName)) {
      return undefined;
    }
    if (ts.isParameter(declaration) || ts.isBindingElement(declaration)) return 'parameter';
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
    return undefined;
  }

  /**
   * Could the env built by `expression` carry the parent's SYSTEM_ROLE?
   * process.env and anything derived from it do, unless it is filtered by
   * buildProviderChildEnv (which drops SYSTEM_ROLE) or sets SYSTEM_ROLE itself.
   * Anything opaque (a parameter, an unknown call) is assumed to.
   */
  private envInherits(expression: ts.Expression, depth = 0): boolean {
    const expr = unwrapExpression(expression);
    if (depth > 4) return true;
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === 'env' &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'process'
    ) {
      return true;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      if (this.objectHasOwnProperty(expr, 'SYSTEM_ROLE')) return false;
      return expr.properties.some((property) => {
        if (ts.isSpreadAssignment(property))
          return this.envInherits(property.expression, depth + 1);
        return false;
      });
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        this.envInherits(expr.whenTrue, depth + 1) || this.envInherits(expr.whenFalse, depth + 1)
      );
    }
    if (ts.isBinaryExpression(expr)) {
      return this.envInherits(expr.left, depth + 1) || this.envInherits(expr.right, depth + 1);
    }
    if (ts.isCallExpression(expr)) {
      const callee = unwrapExpression(expr.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      if (name === 'buildProviderChildEnv') return false;
      if (name === 'buildSafeExecEnv') {
        return expr.arguments.some((arg) => this.envInherits(arg, depth + 1));
      }
      return true;
    }
    if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return false;
    if (ts.isIdentifier(expr) && expr.text === 'undefined') return false;
    const initializer = this.initializerOf(expr);
    if (initializer === 'parameter' || initializer === undefined) return true;
    return this.envInherits(initializer, depth + 1);
  }

  private objectHasOwnProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
    return node.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name
    );
  }

  /**
   * The `env` value of a spawn call's options: the expression, 'absent', or
   * 'opaque' when the options object cannot be inspected.
   */
  private spawnEnv(
    call: ts.CallExpression,
    optionsIndex: number | undefined
  ): ts.Expression | 'absent' | 'opaque' {
    let opaque = false;
    const search = (expression: ts.Expression, depth: number): ts.Expression | undefined => {
      const expr = unwrapExpression(expression);
      if (ts.isObjectLiteralExpression(expr)) {
        for (const property of expr.properties) {
          if (ts.isSpreadAssignment(property)) {
            opaque = true;
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const name =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined;
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
          if (name === 'env') return value;
          if (name === 'spawnOptions' || name === 'options') {
            const nested = search(value, depth + 1);
            if (nested) return nested;
          }
        }
        return undefined;
      }
      if (ts.isArrayLiteralExpression(expr) || ts.isStringLiteralLike(expr)) return undefined;
      if (depth < 3) {
        const initializer = this.initializerOf(expr);
        if (initializer && initializer !== 'parameter') return search(initializer, depth + 1);
      }
      opaque = true;
      return undefined;
    };
    // Known helpers name their options argument; for child_process the options
    // follow the command and an optional argv array.
    const optionArgs =
      optionsIndex !== undefined
        ? call.arguments.slice(optionsIndex, optionsIndex + 1)
        : call.arguments.slice(1).filter((arg) => !this.isArgvArgument(arg));
    for (const arg of optionArgs) {
      const found = search(arg, 0);
      if (found) return found;
    }
    return opaque ? 'opaque' : 'absent';
  }

  private isArgvArgument(arg: ts.Expression): boolean {
    const expr = unwrapExpression(arg);
    if (ts.isArrayLiteralExpression(expr) || ts.isStringLiteralLike(expr)) return true;
    if (ts.isIdentifier(expr) && /^(args|argv|.*Args)$/.test(expr.text)) return true;
    const initializer = this.initializerOf(expr);
    return (
      !!initializer &&
      initializer !== 'parameter' &&
      ts.isArrayLiteralExpression(unwrapExpression(initializer))
    );
  }

  private recordSpawn(
    unit: Unit,
    call: ts.CallExpression,
    inheritsByDefault: boolean,
    optionsIndex?: number
  ): void {
    // The helpers themselves are modelled at their call sites.
    const enclosing = unit.roots[0];
    if (
      enclosing &&
      ts.isFunctionDeclaration(enclosing) &&
      this.spawnHelperDeclarations.has(enclosing)
    ) {
      return;
    }
    const env = this.spawnEnv(call, optionsIndex);
    const inheritsSystemRole =
      env === 'absent' ? inheritsByDefault : env === 'opaque' ? true : this.envInherits(env);
    const strings = call.arguments.flatMap((arg) => this.collectStrings(arg));
    const targets = new Set<string>();
    const [command] = call.arguments;
    const commandExpression = command ? unwrapExpression(command) : undefined;
    const commandText =
      commandExpression && ts.isStringLiteralLike(commandExpression)
        ? commandExpression.text
        : undefined;
    const packageRunner = commandText === 'pnpm' || commandText === 'npm';
    for (const value of strings) {
      const source = sourceForScriptReference(this.ws, value);
      if (source) targets.add(this.ws.rel(source));
      const script = packageRunner ? this.packageScripts[value] : undefined;
      if (script) {
        for (const token of script.split(/\s+/)) {
          const scriptSource = sourceForScriptReference(this.ws, token);
          if (scriptSource) targets.add(this.ws.rel(scriptSource));
        }
      }
    }
    const reviewed = REVIEWED_CHILD_PROCESSES[unit.id];
    let reviewedExternal = false;
    if (reviewed && inheritsSystemRole) {
      const reviewedTargets =
        typeof reviewed.targets === 'function' ? reviewed.targets(this.ws) : reviewed.targets;
      for (const file of expandModuleGlobs(this.ws, reviewedTargets))
        targets.add(this.ws.rel(file));
      reviewedExternal = reviewedTargets.length === 0;
    }
    const kyberionCapable =
      !reviewedExternal &&
      (commandText === undefined ||
        ENTRY_CAPABLE_COMMANDS.has(commandText.split(/\s+/)[0] ?? '') ||
        targets.size > 0);
    this.spawnRecords.push({
      unit,
      site: this.position(call),
      inheritsSystemRole,
      kyberionCapable,
      targets: [...targets].sort(),
    });
  }
}
