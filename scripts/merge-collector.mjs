#!/usr/bin/env node
/**
 * merge-collector.mjs
 *
 * Deep-merges JSON files produced by parallel build-workers into a single output file.
 * Used by the orchestrator's collector pattern when multiple parallel workers
 * each contribute additions to the same shared file (e.g., locales/en.json).
 *
 * Usage:
 *   node scripts/merge-collector.mjs \
 *     --files /tmp/worker1.json,/tmp/worker2.json \
 *     --output src/locales/en.json
 *
 *   node scripts/merge-collector.mjs \
 *     --files /tmp/worker-*.json \
 *     --output src/locales/en.json
 *
 * Merge strategy:
 *   - Objects: deep merged (each worker contributes different keys)
 *   - Arrays: concatenated with deduplication (string dedup; object dedup by id if present)
 *   - Scalars: last-writer-wins with a warning if values differ
 *
 * Exit codes:
 *   0 — success
 *   1 — parse error or file not found
 *   2 — merge conflict (scalar collision)
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { mkdirSync } from 'node:fs';

function usage() {
  console.error(`
Usage: node merge-collector.mjs --files <paths> --output <path> [--mode warn|error|last-wins]

Options:
  --files    Comma-separated or glob-matched paths to worker output files
  --output   Path to write the merged result
  --mode     Conflict resolution mode:
               warn       (default) print warning and use last value
               error      exit with code 2 on conflict
               last-wins  silently use last value
  --help     Show this message

Examples:
  node scripts/merge-collector.mjs --files /tmp/w1.json,/tmp/w2.json --output dist/config.json
  node scripts/merge-collector.mjs --files /tmp/worker-*.json --output locales/en.json
`);
  process.exit(1);
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) usage();

  const files = [];
  let output = null;
  let mode = 'warn';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--files' && i + 1 < args.length) {
      const raw = args[++i];
      // Support comma-separated and glob patterns (basic expansion)
      if (raw.includes('*')) {
        // Basic glob: split on the asterisk, read directory, filter by suffix
        const starIdx = raw.indexOf('*');
        const dir = raw.slice(0, starIdx) || '.';
        const suffix = raw.slice(starIdx + 1);
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          entries = [];
        }
        const dirPrefix = dir.endsWith('/') ? dir : dir + '/';
        const matches = entries
          .filter(f => f.endsWith(suffix))
          .map(f => (dir === '.' ? f : (dir.endsWith('/') ? dir : dir + '/') + f));
        files.push(...matches.map(f => resolve(f)));
      } else {
        files.push(...raw.split(',').map(f => f.trim()).filter(Boolean));
      }
    } else if (args[i] === '--output' && i + 1 < args.length) {
      output = resolve(args[++i]);
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      mode = args[++i];
      if (!['warn', 'error', 'last-wins'].includes(mode)) {
        console.error(`Invalid mode "${mode}". Use warn, error, or last-wins.`);
        process.exit(1);
      }
    }
  }

  if (files.length === 0 || !output) usage();
  return { files, output, mode };
}

/**
 * Deep merge two values. Returns [mergedValue, conflict?]
 */
function deepMerge(a, b, keyPath = '', mode = 'warn') {
  // Both scalars or mismatched types
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || a === null || b === null) {
    if (a !== undefined && b !== undefined && a !== b) {
      const msg = `Conflict at "${keyPath}": "${JSON.stringify(a)}" vs "${JSON.stringify(b)}"`;
      if (mode === 'error') {
        console.error(msg);
        process.exit(2);
      }
      if (mode === 'warn') console.warn(`[merge-collector] ${msg} — using last value`);
    }
    return [b ?? a, a !== undefined && b !== undefined && a !== b];
  }

  // Both arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    const merged = [...a];
    for (const item of b) {
      if (typeof item === 'object' && item !== null) {
        // Dedup by id if present
        if (item.id !== undefined) {
          if (!merged.some(existing => existing && existing.id === item.id)) {
            merged.push(item);
          }
        } else {
          // Dedup by JSON stringification for simple objects/values
          const key = JSON.stringify(item);
          if (!merged.some(existing => JSON.stringify(existing) === key)) {
            merged.push(item);
          }
        }
      } else {
        if (!merged.includes(item)) {
          merged.push(item);
        }
      }
    }
    return [merged, false];
  }

  // Both plain objects
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const result = { ...a };
    let hadConflict = false;
    for (const key of Object.keys(b)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (key in result) {
        const [merged, conflict] = deepMerge(result[key], b[key], childPath, mode);
        result[key] = merged;
        if (conflict) hadConflict = true;
      } else {
        result[key] = b[key];
      }
    }
    return [result, hadConflict];
  }

  // Both scalars, same value
  return [b, false];
}

function main() {
  const { files, output, mode } = parseArgs();

  // Read all input files
  const inputs = [];
  for (const file of files) {
    const resolved = resolve(file);
    if (!existsSync(resolved)) {
      console.error(`[merge-collector] File not found: ${resolved}`);
      process.exit(1);
    }
    try {
      const content = readFileSync(resolved, 'utf-8');
      const parsed = JSON.parse(content);
      inputs.push({ file: resolved, data: parsed });
      console.error(`[merge-collector] Read ${resolved} (${content.length} bytes)`);
    } catch (err) {
      console.error(`[merge-collector] Error reading ${resolved}: ${err.message}`);
      process.exit(1);
    }
  }

  if (inputs.length === 0) {
    console.error('[merge-collector] No input files to merge.');
    process.exit(1);
  }

  // Merge sequentially
  let merged = inputs[0].data;
  let hadAnyConflict = false;

  for (let i = 1; i < inputs.length; i++) {
    const [result, conflict] = deepMerge(merged, inputs[i].data, '', mode);
    merged = result;
    if (conflict) hadAnyConflict = true;
  }

  // Write output
  const outDir = dirname(output);
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {}
  writeFileSync(output, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  console.error(`[merge-collector] Wrote ${output}`);

  if (hadAnyConflict) {
    console.error('[merge-collector] Merge completed with conflicts (resolved using configured mode).');
  } else {
    console.error('[merge-collector] Merge completed cleanly.');
  }

  process.exit(0);
}

main();
