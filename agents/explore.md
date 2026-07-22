---
mode: subagent
model: opencode/north-mini-code-free
temperature: 0.2
steps: 80
description: >
  Fast codebase exploration and search. Reads files, searches patterns, maps architecture.
  Does not make edits.
permission:
  read: allow
  glob: allow
  grep: allow
  edit: deny
  webfetch: deny
  agent_loop: deny
  task: deny
  bash:
    "*": deny
    "git status*": allow
    "git diff*": allow
    "git log*": allow
    "ls*": allow
    "git commit*": deny
    "git push*": deny
    "git reset*": deny
    "git clean*": deny
    "git checkout*": deny
    "git restore*": deny
---
