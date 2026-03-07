# Phase Protocol: ③ Alignment

## Goal
Interpret the Sovereign's intent, define Victory Conditions, and physically initiate the mission.

## Directives
1. **Intent Interpretation**: Distill the Sovereign's request into actionable and measurable goals.
2. **Context Ranking**: Use `scripts/context_ranker.js` to identify the TOP-7 most relevant knowledge files to minimize noise.
3. **Strategy Formulation**: Create a clear `TASK_BOARD.md` or execution plan before making any physical changes.
4. **Sovereign Switch**: Determine the execution mode (Governance-First or Autonomous-YOLO) based on the mission's risk and complexity.

## Constraints
- **Zero Physical Change**: Do not modify project source files during the alignment phase.
- **Sudo Gate**: Any decision involving significant risk (level >= 4) or architectural change requires explicit Sovereign approval.
- **Contract Integrity**: Execution without a plan is recklessness. Every mission must have a defined contract and Victory Conditions.

## Physical Enforcement
Once Alignment is achieved, the agent MUST execute the following command to set the mission to "Active".

- **Command**: `npx tsx scripts/mission_controller.ts start <MISSION_ID> <PERSONA>`
- **Validation**:
  - Verification of `my-identity.json`.
  - Automatic creation and switching to the mission branch (`mission/id`).
  - Initialization of `mission-state.json`.

---
*Status: Mandated by GEMINI.md*
