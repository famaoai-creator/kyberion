# Mission Contract: MSN-REF-EVAL-001
## Post-Refactor Structural & Behavioral Integrity Evaluation

### 1. Victory Conditions
- [ ] **Infrastructure Integrity**: Verify that `libs/core` and `libs/actuators` are free of skill-specific hardcoded parameters.
- [ ] **Background Alignment**: Verify that `presence/sensors` and `scripts/check_*.ts` are correctly aligned with the new Actuator/Procedure paradigm.
- [ ] **Functional Parity**: Confirm that critical deleted skills (e.g., `schema-validator`, `doc-to-text`) have equivalent `knowledge/procedures` or generic Actuator support.
- [ ] **Knowledge Architecture**: Validate the `knowledge/procedures/` classification and `global_skill_index.json` consistency.
- [ ] **Executable Validation**: Successfully execute a simple mission using the new paradigm.

### 2. Task Board
- [ ] **[Research]** Inventory of all remaining background sensors and check scripts (`presence/`, `scripts/`).
- [ ] **[Research]** Scan `libs/actuators` and `libs/core` for hardcoded constants or skill-specific logic.
- [ ] **[Research]** Mapping deleted skill functionalities to the new `knowledge/procedures/` directory.
- [ ] **[Strategy]** Identify critical gaps or "ghost logic" (code that expects deleted skills).
- [ ] **[Execution]** Fix/Align mismatched sensors or scripts.
- [ ] **[Validation]** Run a "Dry Run" mission using a Procedure and an Actuator.
- [ ] **[Conclusion]** Final Report on Migration Integrity.

### 3. Context
This mission evaluates the massive 50,000+ line deletion refactor in the `kyberion` ecosystem, ensuring that the shift to generic Actuators and Knowledge Procedures hasn't introduced regressions or architectural pollution.
