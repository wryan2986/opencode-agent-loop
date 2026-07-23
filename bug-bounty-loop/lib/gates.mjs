import { evaluateUrlScope } from './manifest.mjs';

function requireTrue(value, label, failures) {
  if (value !== true) failures.push(label);
}

function requireFalse(value, label, failures) {
  if (value !== false) failures.push(label);
}

function requireEvidence(value, label, failures) {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !item.trim())) {
    failures.push(label);
  }
}

export function evaluateSubmissionGates({ manifest, candidate, reproduction, verification, impact }) {
  const failures = [];
  const scopeResult = evaluateUrlScope(manifest, candidate.url || candidate.asset || '', candidate.method || 'GET');
  if (!scopeResult.allowed) failures.push(...scopeResult.reasons.map(reason => `scope: ${reason}`));

  requireTrue(manifest.authorization.confirmed, 'authorization is not confirmed', failures);
  requireTrue(manifest.safety.only_owned_test_accounts, 'owned test accounts are not mandatory', failures);
  requireTrue(manifest.reporting.human_approval_required, 'human approval is not required', failures);
  requireFalse(manifest.reporting.auto_submit, 'automatic submission is enabled', failures);

  requireTrue(reproduction?.reproduced, 'reproduction did not succeed', failures);
  requireTrue(reproduction?.fresh_state_reproduced, 'reproduction was not repeated from a fresh state', failures);
  requireTrue(reproduction?.negative_control_passed, 'negative control did not pass', failures);
  requireTrue(reproduction?.controlled_accounts_only, 'testing was not limited to controlled accounts', failures);
  requireFalse(reproduction?.unauthorized_data_observed, 'real or unauthorized user data was observed; stop and review manually', failures);
  requireFalse(reproduction?.service_instability_observed, 'service instability was observed; stop testing', failures);
  requireEvidence(reproduction?.evidence_refs, 'reproduction evidence is missing', failures);

  requireTrue(verification?.independent, 'verification was not independent', failures);
  requireTrue(verification?.reproduced, 'independent verifier could not reproduce', failures);
  requireTrue(verification?.fresh_state, 'independent verifier did not use a fresh state', failures);
  requireTrue(verification?.negative_control, 'independent verifier did not confirm a negative control', failures);
  requireTrue(verification?.security_boundary_crossed, 'no security boundary was demonstrated', failures);
  requireFalse(verification?.intended_behavior_likely, 'behavior appears intended or is insufficiently distinguished from intended behavior', failures);
  requireEvidence(verification?.evidence_refs, 'independent verification evidence is missing', failures);

  requireTrue(impact?.concrete_impact, 'concrete security impact was not demonstrated', failures);
  requireFalse(impact?.requires_unrealistic_cooperation, 'impact requires unrealistic victim cooperation', failures);
  requireFalse(impact?.excluded_by_policy, 'finding appears excluded by program policy', failures);
  requireFalse(impact?.duplicate_likely, 'finding appears likely to be a known issue or duplicate', failures);
  if (!Array.isArray(impact?.affected_security_properties) || impact.affected_security_properties.length === 0) {
    failures.push('no affected security property was identified');
  }

  return {
    passed: failures.length === 0,
    status: failures.length === 0 ? 'READY_FOR_HUMAN_REVIEW' : 'QUARANTINED',
    failures,
  };
}
