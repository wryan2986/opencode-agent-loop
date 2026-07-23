function json(value) {
  return JSON.stringify(value, null, 2);
}

const BASE_RULES = `
Hard rules:
- Operate only within the exact origins, paths, methods, rate limits, and exclusions in the manifest.
- Use only accounts and records controlled by the researcher.
- Use the approved HTTP wrapper for all active requests. Do not use curl, wget, browsers, webfetch, raw sockets, scanners, or other network paths.
- Stop immediately if real-user data, service instability, or an out-of-scope redirect appears.
- Do not perform denial of service, credential attacks, social engineering, persistence, destructive actions, or automated submission.
- Output one JSON value only. Do not wrap it in prose.
`;

export function discoveryPrompt({ objective, manifest, caseDir }) {
  return `${BASE_RULES}
You are the discovery stage of a human-supervised bug-bounty validation loop.
Generate a small number of concrete, testable hypotheses. Prefer authorization and business-logic boundaries over generic scanner findings. You may make low-impact requests through .bounty-loop/tooling/bounty-http.mjs when needed.

Objective:\n${objective}

Manifest:\n${json(manifest)}

Case directory: ${caseDir}

Return exactly:
{
  "candidates": [
    {
      "id": "short-stable-id",
      "title": "neutral hypothesis title",
      "url": "https://exact-in-scope-origin/path",
      "method": "GET",
      "hypothesis": "what security boundary may fail",
      "preconditions": ["researcher-controlled prerequisites"],
      "planned_checks": ["minimal checks including a negative control"],
      "confidence": 0.0
    }
  ]
}
Limit candidates to high-signal items. Scanner-only observations, missing headers, version disclosures, and impact-free anomalies must be omitted.`;
}

export function reproductionPrompt({ manifest, candidate, caseDir }) {
  return `${BASE_RULES}
You are the reproduction stage. Test one candidate minimally and conservatively. Reproduce twice, including once from a fresh state, and run a nearly identical negative control. Do not claim impact merely because status codes differ.

Manifest:\n${json(manifest)}

Candidate:\n${json(candidate)}

Case directory: ${caseDir}
Save any response bodies only under ${caseDir}/evidence using the approved wrapper.

Return exactly:
{
  "reproduced": false,
  "fresh_state_reproduced": false,
  "negative_control_passed": false,
  "controlled_accounts_only": true,
  "unauthorized_data_observed": false,
  "service_instability_observed": false,
  "evidence_refs": [],
  "observed_result": "",
  "rejection_reason": ""
}`;
}

export function verificationPrompt({ manifest, blindCandidate, reproductionEvidence, caseDir }) {
  return `${BASE_RULES}
You are an independent verifier. You have not been given the finder model's severity, confidence, or persuasive narrative. Attempt to reproduce the described behavior independently from a fresh state, confirm a negative control, and determine whether an actual security boundary is crossed. Try to disprove the hypothesis.

Manifest:\n${json(manifest)}

Blind candidate facts:\n${json(blindCandidate)}

Reproduction evidence references:\n${json(reproductionEvidence)}

Case directory: ${caseDir}

Return exactly:
{
  "independent": true,
  "reproduced": false,
  "fresh_state": false,
  "negative_control": false,
  "security_boundary_crossed": false,
  "intended_behavior_likely": false,
  "evidence_refs": [],
  "disproof_attempts": [],
  "rejection_reason": ""
}`;
}

export function impactPrompt({ manifest, candidate, reproduction, verification }) {
  return `${BASE_RULES}
You are the adversarial impact reviewer. Do not make active network requests. Assess whether the evidence demonstrates concrete confidentiality, integrity, authentication, authorization, or availability impact. Treat policy exclusions, unrealistic victim cooperation, public data, expected behavior, and known-issue indicators as reasons to reject or quarantine.

Manifest:\n${json(manifest)}
Candidate:\n${json(candidate)}
Reproduction:\n${json(reproduction)}
Independent verification:\n${json(verification)}

Return exactly:
{
  "concrete_impact": false,
  "affected_security_properties": [],
  "attacker_capability": "",
  "victim_role": "",
  "requires_unrealistic_cooperation": false,
  "excluded_by_policy": false,
  "duplicate_likely": false,
  "severity": "informational",
  "reasoning_summary": ""
}`;
}

export function reportPrompt({ manifest, candidate, reproduction, verification, impact, gate }) {
  return `${BASE_RULES}
You are the report-drafting stage. Do not make active requests. Draft a factual, conservative Markdown report from the verified evidence. Do not inflate severity, speculate beyond evidence, or imply that submission occurred. Include a negative control and cleanup/testing notes.

Manifest:\n${json(manifest)}
Candidate:\n${json(candidate)}
Reproduction:\n${json(reproduction)}
Verification:\n${json(verification)}
Impact:\n${json(impact)}
Gate result:\n${json(gate)}

Return exactly:
{
  "title": "",
  "markdown": "# Summary\\n...",
  "suggested_severity": "",
  "cwe": "",
  "reviewer_notes": []
}`;
}
