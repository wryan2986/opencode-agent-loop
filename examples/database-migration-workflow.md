# Database migration workflow example

Use one stable task ID for every stage.

1. Inspect the schema, migration framework, backup procedure, and rollback path.
2. Define acceptance criteria for forward migration, rollback, data preservation, and application compatibility.
3. Run `agent_loop` in `smoke` mode.
4. Run baseline tests before editing.
5. Run `build` with the migration request and responsive model IDs.
6. Run migration-specific tests against disposable data.
7. Run the normal `test` and independent `review` stages.
8. Fix findings with the same task ID, then repeat both gates.
9. Commit only the intended migration, application changes, and tests.

Never run an autonomous migration against production data. Use an isolated database, verified backup, and explicit human deployment approval.
