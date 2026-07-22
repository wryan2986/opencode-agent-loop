---
mode: subagent
model: opencode-go/deepseek-v4-flash
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
  bash:
    git status: allow
    git diff: allow
    ls: allow
    mkdir: allow
  git:
    commit: deny
    push: deny
    reset: deny
    clean: deny
    checkout: deny
    restore: deny
---