# Bug Bounty Validation Loop

A human-supervised bug-bounty research workflow for OpenCode. It is designed to reject weak candidates before they become reports.

The deterministic controller—not an LLM—owns stage order, scope checks, rate limits, evidence requirements, hard stops, and the final reportability gate.

```text
scope manifest
      |
      v
high-signal discovery
      |
      v
minimal reproduction + negative control
      |
      v
blind independent verification
      |
      v
adversarial impact review
      |
      v
deterministic all-pass gate
      |
      v
report draft -> human review -> manual submission
```

## Non-goals

This module does not:

- mass scan targets
- bypass a bounty program's rules
- test real users or uncontrolled data
- perform denial of service, credential attacks, persistence, or destructive actions
- automatically submit reports
- turn scanner output into a report without independent evidence

## Requirements

- Node.js 18 or newer
- OpenCode installed and authenticated
- this repository configured as `OPENCODE_CONFIG_DIR`
- a current, manually reviewed bounty-program policy
- explicit authorization for the exact assets and testing methods in the manifest

The controller launches isolated OpenCode CLI runs with `opencode run --agent ...`, which is supported by OpenCode's non-interactive CLI.

## Quick start

From the target workspace:

```bash
node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" init --workspace .
```

Edit `.bounty-loop/program.json` using the current program policy. Keep exact origins; wildcard domains are intentionally unsupported. Leave `authorization.confirmed` false until you personally verify scope and restrictions.

Validate:

```bash
node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" validate --workspace .
```

Run a bounded case:

```bash
node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" run \
  --workspace . \
  --objective "Check whether one test user can read another test user's saved object"
```

Or use OpenCode commands:

```text
/bounty-init
/bounty Check whether one test user can read another test user's saved object
```

## Manifest design

The manifest is the enforcement boundary. It records:

- program and policy snapshot
- who confirmed authorization
- exact allowed and excluded origins
- allowed and excluded path prefixes
- allowed methods
- request and response limits
- redirect policy
- required identifying headers
- state-change permission
- hard-stop conditions
- mandatory human approval and disabled automatic submission

The default example is passive and unconfirmed. It allows only `GET`, `HEAD`, and `OPTIONS` at six requests per minute.

## Scoped HTTP wrapper

Agents cannot use `curl`, `wget`, webfetch, scanners, raw sockets, or arbitrary shell commands. Active requests must use:

```bash
node .bounty-loop/tooling/bounty-http.mjs \
  --manifest .bounty-loop/program.json \
  --method GET \
  --url https://in-scope.example/path \
  --output .bounty-loop/cases/<case-id>/evidence/response.bin
```

The wrapper enforces:

- exact-origin and path-prefix scope
- allowed methods and state-change policy
- DNS checks against private or reserved networks for public programs
- per-minute and per-case request limits
- redirect scope
- response-size caps
- controlled body-file and evidence-output directories
- secret-header redaction
- response-body hashing

Response bodies are not printed to stdout. They are saved only when an explicit evidence path is supplied.

## Submission gates

Every candidate must satisfy all gates:

1. exact asset, path, and method are in scope
2. authorization is confirmed
3. only controlled accounts and objects were used
4. reproduction succeeds twice, including from fresh state
5. a nearly identical negative control passes
6. an independent verifier reproduces the issue
7. a real security boundary is demonstrated
8. behavior is unlikely to be intended
9. concrete security impact exists
10. no policy exclusion, unrealistic victim cooperation, or likely duplicate indicator applies
11. both reproduction and verifier evidence references exist
12. report generation succeeds
13. a human reviews the draft before manual submission

One failed or uncertain gate quarantines the candidate.

## Case files

Cases are stored under `.bounty-loop/cases/<case-id>/`:

```text
state.json
manifest.snapshot.json
events.jsonl
discovery.json
candidates/<candidate-id>/
  candidate.json
  reproduction.json
  verification.json
  impact.json
  result.json
evidence/
reports/
```

Raw agent output and evidence files are mode `0600` where supported. Add `.bounty-loop/` to the target workspace's `.gitignore`; it may contain session metadata or sensitive test evidence.

## Human approval

A passing candidate is only `READY_FOR_HUMAN_REVIEW`. After personally reviewing the raw evidence and draft, record approval locally:

```bash
node "$OPENCODE_CONFIG_DIR/bug-bounty-loop/bin/bounty-loop.mjs" approve \
  --workspace . \
  --case-id <case-id> \
  --candidate <candidate-id> \
  --statement "I reviewed the raw requests, controls, scope, impact, and report draft."
```

This changes local state to `APPROVED_FOR_MANUAL_SUBMISSION`. It does not contact HackerOne, Bugcrowd, Intigriti, or any program.

## Local training labs

`config/local-lab.example.json` permits private networking and a state-changing method for an intentionally installed, owned training environment. Never use those settings for a public bounty target.

## Validation

```bash
cd "$OPENCODE_CONFIG_DIR/bug-bounty-loop"
npm test
npm run validate
```
