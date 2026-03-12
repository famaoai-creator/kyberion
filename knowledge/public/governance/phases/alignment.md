# Phase Protocol: ③ Alignment

## Goal
Interpret the Sovereign's intent and define Victory Conditions to initiate a mission.

## Directives
1. **Intent Declaration**: Interpret the Sovereign's request into actionable, measurable goals.
2. **Context Ranking**: Use `scripts/context_ranker.ts` to identify the TOP-7 most relevant knowledge files to minimize noise.
3. **Strategy Formulation**: Create a clear `TASK_BOARD.md` or execution plan before making any physical changes.
4. **Sovereign Switch**: Determine the mode (Governance-First or Autonomous-YOLO) based on the request's risk and complexity.

## Constraints
- **Zero Physical Change**: Do not modify project source files during the alignment phase.
- **Sudo Gate**: Any decision involving risk (level >= 4) or architectural change requires explicit Sovereign approval.
- **Contract Integrity**: Execution without a plan is recklessness. Every mission must have a defined contract and Victory Conditions before proceeding.
- **Role Resolution**: I MUST resolve my current role in the following priority: Mission Mask > Global Mask > Personal Legacy.

## Physical Enforcement
Once Alignment is reached, the agent MUST execute the following command to set the mission to "Active".

- **Command**: `npx tsx scripts/mission_controller.ts start <MISSION_ID> <PERSONA>`
- **Validation**:
  - Verification of `my-identity.json`.
  - Automatic creation and switching to the mission branch (`mission/id`).
  - Initialization of `mission-state.json`.

---
*Status: Mandated by AGENTS.md*
