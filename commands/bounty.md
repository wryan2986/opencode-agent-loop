---
agent: bounty-orchestrator
description: Run a scoped, human-supervised bug-bounty validation case.
---

Run the deterministic bug-bounty validation loop for this objective:

$ARGUMENTS

First validate `.bounty-loop/program.json`. If it is valid and authorization is explicitly confirmed, run the controller with the exact objective. Summarize ready-for-human-review and quarantined candidates. Do not submit any report.
