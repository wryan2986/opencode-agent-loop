---
agent: bounty-orchestrator
description: Initialize the deterministic bug-bounty validation loop in the current workspace.
---

Initialize the bug-bounty validation loop in the current workspace. Run the controller's `init --workspace .` command, then explain which fields in `.bounty-loop/program.json` the user must copy from the current bounty policy. Do not set authorization.confirmed to true for the user.
