---
mode: subagent
model: opencode-go/mimo-v2.5
temperature: 0.2
steps: 80
description: >
  Handles small, bounded changes (1-2 files, under 20 lines total).
  Fast and lightweight. Use for trivial fixes, simple additions, and
  small refactors that don't need a full build-worker. Not suitable for
  multi-file features, complex logic, or architectural decisions.
permission:
  read: allow
  glob: allow
  grep: allow
  write: allow
  edit: allow
  bash:
    git status: allow
    git diff: allow
    ls: allow
    mkdir: allow
    npm run build: allow
  webfetch: deny
  agent_loop: deny
  task: deny
  git:
    commit: deny
    push: deny
    reset: deny
    clean: deny
    checkout: deny
    restore: deny
---
