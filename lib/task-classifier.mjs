const DEFAULT_CONFIG = {
  complex_file_threshold: 5,
  local_trivial_max_files: 2,
  local_trivial_max_lines: 20,
  complex_signals: [
    /database migration|schema change|ddl|alter\s+table/i,
    /authentication|authorization|encrypt|decrypt|security|secrets?|permissions?|billing|rbac|acl/i,
    /multi.?tenant|data.?isolation|org(?:anization)?.?scope/i,
    /cross.?module|cross.?service|multi.?module/i,
    /broad refactor|redesign|new subsystem|architecture/i,
    /state.?management|concurrency|background\s+(job|task)|queue|schedul(?:e|ing)/i,
    /deployment|infrastructure|ci.?cd|docker|kubernetes|helm/i,
    /api\s+contract|breaking\s+change/i,
    /migration.*data|data.*migration/i,
    /intermittent|flaky|race\s+condition|deadlock/i
  ],
  local_trivial_signals: [
    /version\s+string|bump\s+version/i,
    /typo|misspell/i,
    /configuration\s+value|config\s+key/i,
    /small\s+fixture/i,
    /patch|apply\s+patch/i,
    /formatting|lint\s+fix/i,
    /rename\s+(symbol|variable|function|class)/i
  ]
};

function matchesAny(text, patterns) {
  return patterns.some(p => p.test(text));
}

export function classifyTask(task, { fileCount = 0, moduleScope = 'single', qwythosHealthy = false, previousFailedBuilders = [], config = {} } = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const taskText = typeof task === 'string' ? task : '';
  const allSignals = Object.values(cfg).join(' ') + taskText;

  // Local-trivial: all conditions must be true
  if (qwythosHealthy &&
      fileCount <= cfg.local_trivial_max_files &&
      !matchesAny(taskText, cfg.complex_signals) &&
      matchesAny(taskText, cfg.local_trivial_signals)) {
    return { classification: 'local-trivial-builder', reasons: ['task matches trivial signals', 'Qwythos healthy', 'small scope'] };
  }

  // Complex: any complex signal matches
  if (matchesAny(taskText, cfg.complex_signals) ||
      fileCount > cfg.complex_file_threshold ||
      moduleScope === 'multi' ||
      previousFailedBuilders.includes('routine-builder')) {
    return { classification: 'complex-builder', reasons: ['complex signal matched', fileCount > cfg.complex_file_threshold ? `file count ${fileCount} > ${cfg.complex_file_threshold}` : '', previousFailedBuilders.includes('routine-builder') ? 'previous routine builder failed' : ''].filter(Boolean) };
  }

  // Default: routine
  return { classification: 'routine-builder', reasons: ['default classification', 'no complex or trivial signals detected'] };
}

export function getConfigSignals(config = {}) {
  return { ...DEFAULT_CONFIG, ...config };
}
