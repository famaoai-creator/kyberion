# AI-Driven Life Cycle (AI DLC) Playbook

This document outlines the workflow for using the Kyberion suite to accelerate software engineering tasks. By delegating specific phases of the development cycle to AI via these skills, you can focus on high-level architecture and decision-making.

## 🔄 The Cycle

### Phase 0: Alignment & Discovery (作戦立案)

_Before writing code, the AI must understand the intent and the existing system. Action-oriented execution is forbidden until a TASK_BOARD.md is created._

1.  **Map the Terrain**: Use `codebase-mapper` (as a read-only probe) to get a high-level view.

    ```bash
    npm run cli -- run codebase-mapper -- --dir .
    ```

    _Prompt:_ "Here is the project structure. Where should I add the new 'UserAuthentication' feature? Create a Task Board for this."

2.  **Understand Data**: Use `schema-inspector` to read DB/API definitions.
    ```bash
    npm run cli -- run schema-inspector -- --dir .
    ```
    _Prompt:_ "Based on this schema, write a SQL query to fetch active users."

### Phase 1: Execution (実装)

_AI generates code based on the Task Board and context._

1.  **Drafting**: AI writes code (using standard Kyberion output or ad-hoc `scratch/` scripts).
2.  **Unit Tests**: Ask AI to generate tests for the new code immediately.

### Phase 2: Verification (検証)

_Ensure the code works as expected._

1.  **Run Tests**: Use `test-genie` to execute the suite.
    ```bash
    npm run cli -- run test-genie -- --dir .
    ```
    _Prompt:_ "Here is the test output. Fix the failing test cases."

### Phase 3: Review (品質保証)

_Self-correction before human review._

1.  **Stage Changes**:
    ```bash
    git add .
    ```
2.  **Self-Review**: Use `local-reviewer` to analyze the diff.
    ```bash
    npm run cli -- run local-reviewer
    ```
    _Prompt:_ "Review these changes for security flaws and code style issues. Suggest improvements."

### Phase 4: Debugging & Ops (保守)

_When things go wrong. If an unexpected error occurs during execution, trigger a Circuit Breaker and return to Phase 0 (Re-Alignment)._

1.  **Analyze Logs**: Use `log-analyst` to read runtime errors.
    ```bash
    npm run cli -- run log-analyst -- --file server.log
    ```
    _Prompt:_ "Here is the error log. What caused the crash and how do I fix it?"

---

## 🛠 Skill Quick Reference

| Skill                | Usage                                         | Purpose                          |
| -------------------- | --------------------------------------------- | -------------------------------- |
| **Codebase Mapper**  | `npm run cli -- run codebase-mapper`          | Visualize directory structure.   |
| **Schema Inspector** | `npm run cli -- run schema-inspector`         | Read SQL/OpenAPI/Prisma schemas. |
| **Test Genie**       | `npm run cli -- run test-genie`               | Run tests and capture output.    |
| **Local Reviewer**   | `npm run cli -- run local-reviewer`           | Analyze staged git changes.      |
| **Log Analyst**      | `npm run cli -- run log-analyst`              | Read last N lines of a log file. |
| **Doc-to-Text**      | `npm run cli -- run doc-to-text`              | Read specs/docs (PDF/Office).    |
