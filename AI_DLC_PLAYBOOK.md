# AI-Driven Life Cycle (AI DLC) Playbook

This document outlines the workflow for using the Gemini Skills suite to accelerate software engineering tasks. By delegating specific phases of the development cycle to AI via these skills, you can focus on high-level architecture and decision-making.

## 🔄 The Cycle

### Phase 1: Context & Discovery (理解)

_Before writing code, the AI must understand the existing system._

1.  **Map the Terrain**: Use `codebase-mapper` to get a high-level view.

    ```bash
    node codebase-mapper/scripts/map.cjs .
    ```

    _Prompt:_ "Here is the project structure. Where should I add the new 'UserAuthentication' feature?"

2.  **Understand Data**: Use `schema-inspector` to read DB/API definitions.
    ```bash
    node schema-inspector/scripts/inspect.cjs .
    ```
    _Prompt:_ "Based on this schema, write a SQL query to fetch active users."

### Phase 2: Implementation (実装)

_AI generates code based on the context._

1.  **Drafting**: AI writes code (using standard Gemini output).
2.  **Unit Tests**: Ask AI to generate tests for the new code immediately.

### Phase 3: Verification (検証)

_Ensure the code works as expected._

1.  **Run Tests**: Use `test-genie` to execute the suite.
    ```bash
    node test-genie/scripts/run.cjs .
    ```
    _Prompt:_ "Here is the test output. Fix the failing test cases."

### Phase 4: Review (品質保証)

_Self-correction before human review._

1.  **Stage Changes**:
    ```bash
    git add .
    ```
2.  **Self-Review**: Use `local-reviewer` to analyze the diff.
    ```bash
    node local-reviewer/scripts/review.cjs
    ```
    _Prompt:_ "Review these changes for security flaws and code style issues. Suggest improvements."

### Phase 5: Debugging & Ops (保守)

_When things go wrong._

1.  **Analyze Logs**: Use `log-analyst` to read runtime errors.
    ```bash
    node log-analyst/scripts/tail.cjs server.log
    ```
    _Prompt:_ "Here is the error log. What caused the crash and how do I fix it?"

---

## 🛠 Skill Quick Reference

| Skill                | Script Path                                   | Purpose                          |
| -------------------- | --------------------------------------------- | -------------------------------- |
| **Codebase Mapper**  | `codebase-mapper/scripts/map.cjs`             | Visualize directory structure.   |
| **Schema Inspector** | `schema-inspector/scripts/inspect.cjs`        | Read SQL/OpenAPI/Prisma schemas. |
| **Test Genie**       | `test-genie/scripts/run.cjs`                  | Run tests and capture output.    |
| **Local Reviewer**   | `local-reviewer/scripts/review.cjs`           | Analyze staged git changes.      |
| **Log Analyst**      | `log-analyst/scripts/tail.cjs`                | Read last N lines of a log file. |
| **GitHub Manager**   | `github-skills-manager/scripts/dashboard.cjs` | Manage these skills.             |
| **Doc-to-Text**      | `doc-to-text/scripts/extract.cjs`             | Read specs/docs (PDF/Office).    |
