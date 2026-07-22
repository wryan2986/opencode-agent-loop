#!/usr/bin/env node
/**
 * manage-cooldowns.mjs — CLI for inspecting and managing model cooldowns.
 *
 * Usage:
 *   node scripts/manage-cooldowns.mjs status          Show cooldown status for all models
 *   node scripts/manage-cooldowns.mjs reap            Clear expired cooldowns
 *   node scripts/manage-cooldowns.mjs clear <provider> Clear all cooldowns for a provider (e.g. nvidia)
 *   node scripts/manage-cooldowns.mjs retire <modelId> Check if a model is retired
 *
 * Examples:
 *   node scripts/manage-cooldowns.mjs status
 *   node scripts/manage-cooldowns.mjs reap
 *   node scripts/manage-cooldowns.mjs clear nvidia
 *   node scripts/manage-cooldowns.mjs retire nvidia/qwen/qwen3-coder-480b-a35b-instruct
 */

import {
  loadState,
  saveState,
  getStatus,
  reapExpiredCooldowns,
  clearProvider,
  isRetired,
  loadRegistry,
  listRetiredModels
} from '../lib/cooldown-manager.mjs';

const command = process.argv[2];
const arg = process.argv[3];

function pad(s, n) {
  return String(s).padEnd(n);
}

async function cmdStatus() {
  const results = getStatus();
  const retired = listRetiredModels();

  console.log('Model Cooldown Status');
  console.log('═'.repeat(90));
  console.log(`${pad('Model ID', 55)} ${pad('Status', 18)} ${pad('Cooldown Until', 30)} Failures`);
  console.log('─'.repeat(90));

  for (const r of results) {
    const id = r.modelId.length > 54 ? r.modelId.slice(0, 51) + '...' : r.modelId;
    console.log(`${pad(id, 55)} ${pad(r.status, 18)} ${pad(r.cooldownUntil || '—', 30)} ${r.consecutiveFailures}`);
  }

  const activeCount = results.filter(r => r.status === 'active').length;
  const cooldownCount = results.filter(r => r.status === 'cooldown').length;
  const expiredCount = results.filter(r => r.status === 'expired').length;
  const retiredCount = results.filter(r => r.status === 'retired').length;

  console.log('─'.repeat(90));
  console.log(`Active: ${activeCount}  |  In cooldown: ${cooldownCount}  |  Expired: ${expiredCount}  |  Retired (registry): ${retired.size}`);
  console.log();

  if (retired.size > 0) {
    console.log('Retired models (registry):');
    for (const id of retired) {
      console.log(`  • ${id}`);
    }
    console.log();
  }
}

async function cmdReap() {
  const now = Date.now();
  const { reaped, remaining, retired } = reapExpiredCooldowns(now);

  console.log(`Cooldown reaper ran at ${new Date(now).toISOString()}`);
  console.log(`  Expired cooldowns cleared:  ${reaped}`);
  console.log(`  Still in cooldown:          ${remaining}`);
  console.log(`  Skipped (retired/disabled): ${retired}`);

  if (reaped > 0) {
    console.log(`\n✓ ${reaped} model(s) restored to active state.`);
  } else if (remaining === 0) {
    console.log('\nNo cooldowns to reap.');
  } else {
    console.log(`\n${remaining} model(s) still in cooldown.`);
  }
}

async function cmdClear(provider) {
  if (!provider) {
    console.error('Usage: node scripts/manage-cooldowns.mjs clear <provider>');
    console.error('  e.g. node scripts/manage-cooldowns.mjs clear nvidia');
    process.exit(1);
  }

  const count = clearProvider(provider);
  if (count > 0) {
    console.log(`✓ Cleared cooldowns for ${count} model(s) from provider "${provider}".`);
  } else {
    console.log(`No models found for provider "${provider}" in state.`);
  }
}

async function cmdRetire(modelId) {
  if (!modelId) {
    console.error('Usage: node scripts/manage-cooldowns.mjs retire <modelId>');
    process.exit(1);
  }

  const retired = isRetired(modelId);
  console.log(`Model: ${modelId}`);
  console.log(`Retired: ${retired ? 'YES' : 'no'}`);
  if (retired) {
    const registry = loadRegistry();
    const entry = registry.models.find(m => m.model_id === modelId);
    if (entry) {
      console.log(`Notes: ${entry.notes || '(none)'}`);
    }
  }
}

async function main() {
  switch (command) {
    case 'status':
      await cmdStatus();
      break;
    case 'reap':
      await cmdReap();
      break;
    case 'clear':
      await cmdClear(arg);
      break;
    case 'retire':
      await cmdRetire(arg);
      break;
    default:
      console.log('Usage:');
      console.log('  node scripts/manage-cooldowns.mjs status');
      console.log('  node scripts/manage-cooldowns.mjs reap');
      console.log('  node scripts/manage-cooldowns.mjs clear <provider>');
      console.log('  node scripts/manage-cooldowns.mjs retire <modelId>');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
