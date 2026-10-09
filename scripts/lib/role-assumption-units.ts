/**
 * RN-02 units for scripts/analyze_role_assumptions.ts: module initialisation
 * code and top-level declarations (functions, classes, function-valued
 * consts, direct-entry guarded blocks) of every analysed source file, and the
 * lookup from a node to the unit that owns it.
 */
import * as ts from 'typescript';
import { unwrapExpression } from './role-assumption-delegation.js';
import type { Workspace } from './role-assumption-workspace.js';

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

function isFunctionLikeExpression(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const inner = unwrapExpression(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

export function hasExportModifier(node: ts.Node): boolean {
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

export class UnitIndex {
  readonly units = new Map<string, Unit>();
  /** Units per file in insertion order (unitsOfFile used to filter every unit per call). */
  private readonly unitsByFile = new Map<string, Unit[]>();
  private readonly rootToUnit = new Map<ts.Node, Unit>();
  private readonly moduleUnits = new Map<ts.SourceFile, Unit>();

  constructor(
    private readonly ws: Workspace,
    sourceFiles: readonly ts.SourceFile[]
  ) {
    for (const sourceFile of sourceFiles) this.index(sourceFile);
  }

  private register(unit: Unit): void {
    this.units.set(unit.id, unit);
    const list = this.unitsByFile.get(unit.file);
    if (list) list.push(unit);
    else this.unitsByFile.set(unit.file, [unit]);
  }

  private add(unit: Unit): Unit {
    this.register(unit);
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
    this.register(moduleUnit);
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
    return [...(this.unitsByFile.get(rel) ?? [])];
  }
}
