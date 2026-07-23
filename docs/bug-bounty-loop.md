# Bug Bounty Validation Loop

The bug-bounty extension uses the repository's specialized-agent approach but deliberately does not route active testing through the general feature-development orchestrator.

## Authority split

The deterministic controller owns:

- scope-manifest validation
- exact URL and method checks
- stage order
- candidate limits
- scoped HTTP tooling
- request budgets
- hard-stop events
- evidence presence
- all-pass reportability gates
- local human-approval records

LLM agents own bounded semantic tasks:

- hypothesis generation
- minimal reproduction planning and execution
- independent verification
- adversarial impact review
- report drafting

No model may expand scope, alter authorization, change request budgets, bypass the wrapper, or submit a report.

## Why it is separate from `/feature`

The main `/feature` workflow operates on a local repository and delegates build, test, and review roles through the patched OpenCode runtime. Bug-bounty work has materially different invariants:

- authorization is external and asset-specific
- network requests require exact scope and rate controls
- real-user data and service instability are hard-stop conditions
- independent reproduction must be blind to the finder's confidence and severity
- a candidate can be technically reproducible but still non-reportable
- submission must remain manual

Keeping the module separate avoids granting the development orchestrator network-testing authority or weakening the existing policy kernel.

## Recommended operating sequence

1. Copy the current program policy into `.bounty-loop/program.json`.
2. Record the policy snapshot date and required researcher identity headers.
3. Confirm exact allowed origins, paths, methods, exclusions, and limits.
4. Keep state changes disabled unless the policy and test plan require them.
5. Run one narrow objective with a maximum of three candidates.
6. Review hard-stop and quarantine events before further testing.
7. Inspect raw requests, controls, and response hashes for any passing candidate.
8. Search the program's known issues, public disclosures, changelog, CVEs, and repository advisories manually.
9. Record human approval only after the report remains valid.
10. Submit manually through the program's official channel.

## False-positive controls

The loop intentionally favors false negatives over wasting reviewer time. It suppresses:

- scanner output without manual reproduction
- version disclosure without an exploitable path
- missing headers without demonstrated impact
- status-code differences without a boundary
- public-data exposure claims
- self-XSS and open redirects without a meaningful chain
- speculative dependency CVEs
- rate-limit observations without sustained security impact
- findings requiring unrealistic victim behavior
- third-party or excluded assets
- candidates not repeated from fresh state
- candidates without a negative control
- candidates the independent verifier cannot reproduce

## Security limitations

OpenCode permissions and the wrapper are application-level safeguards, not an operating-system sandbox. Run the loop in a dedicated VM or container, keep credentials limited to bounty test accounts, and do not mount unrelated secrets or production data.
