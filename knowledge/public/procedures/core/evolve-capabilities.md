# Procedure: Self-Evolution & Prompt Optimization

## 1. Goal
Continuously improve the agent's reasoning capabilities by optimizing prompts and generating new, verified procedures.

## 2. Dependencies
- **Actuator**: `Wisdom-Actuator` (Alignment/Audit)
- **Actuator**: `Code-Actuator` (Refactoring/Verification)
- **Actuator**: `Orchestrator-Actuator` (Evolution Workflow)

## 3. Step-by-Step Instructions
1.  **Drift Detection**: Use `Wisdom-Actuator` (mirror) to identify areas where the current Persona or Procedure is failing.
2.  **Optimization Drafting**:
    - Use `Code-Actuator` (analyze) to read the target `SKILL.md` or Procedure.
    - Apply AI-driven prompt engineering patterns (e.g., Chain-of-Thought, Context-Compaction).
3.  **Code Patching**: Use `Code-Actuator` (refactor) to apply the optimized prompt or create a new Procedure file.
4.  **Fidelity Check**:
    - Use `Code-Actuator` (verify) to ensure the change compiles.
    - Run a test mission using `Orchestrator-Actuator` to verify behavioral improvement.
5.  **Wisdom Vaulting**: Register the successful evolution into the `Wisdom Vault`.

## 4. Expected Output
An upgraded cognitive layer with higher efficiency and lower token consumption.
