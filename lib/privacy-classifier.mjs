/**
 * privacy-classifier.mjs
 *
 * Classifies tasks by privacy sensitivity and filters available models/providers
 * based on data-handling policies. Ensures sensitive or local-only tasks are
 * routed only to providers with the appropriate privacy guarantees.
 *
 * @module privacy-classifier
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @typedef {'normal'|'sensitive'|'local-only'|'trusted-provider-only'} TaskClassification
 */

/**
 * Keywords in task descriptions that indicate sensitive content.
 * @type {string[]}
 */
const SENSITIVE_KEYWORDS = [
  'password', 'passwords',
  'token', 'tokens',
  'api.key', 'api.keys', 'apikey', 'apikeys',
  'secret', 'secrets',
  'credential', 'credentials',
  'env', '.env',
  'database', 'databases',
  'encryption', 'encrypt', 'decrypt',
  'billing', 'billing',
  'payment', 'payments', 'credit card', 'credit.card',
  'household', 'personal',
  'ssn', 'social security', 'social.security',
  'pii', 'personally.identifiable',
  'private.key', 'private key', 'private.keys',
  'access.key', 'access.keys', 'accesskey',
  'oauth', 'oauth2',
  'jwt', 'json.web.token',
  'session', 'sessions'
];

/**
 * File path patterns that indicate sensitive content.
 * @type {RegExp[]}
 */
const SENSITIVE_FILE_PATTERNS = [
  /\.env$/,
  /\.env\./,
  /credentials/i,
  /secret/i,
  /\.pem$/,
  /\.key$/,
  /\.cert$/,
  /id_rsa/,
  /\.pgp$/,
  /\.gpg$/,
  /token/i,
  /\.htpasswd$/,
  /\.netrc$/,
  /config\.json$/i
];

export class PrivacyClassifier {
  /**
   * @param {string} registryPath - Path to model-registry.json
   * @param {string} configPath - Path to free-first-config.json
   */
  constructor(registryPath = './config/model-registry.json', configPath = './config/free-first-config.json') {
    this.registryPath = resolve(registryPath);
    this.configPath = resolve(configPath);
    /** @type {Object|null} */
    this.registry = null;
    /** @type {Object|null} */
    this.config = null;
  }

  /**
   * Lazy-load the model registry.
   * @returns {Object}
   */
  _loadRegistry() {
    if (this.registry) return this.registry;
    const raw = readFileSync(this.registryPath, 'utf-8');
    this.registry = JSON.parse(raw);
    return this.registry;
  }

  /**
   * Lazy-load the config.
   * @returns {Object}
   */
  _loadConfig() {
    if (this.config) return this.config;
    const raw = readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw);
    return this.config;
  }

  /**
   * Classify a task based on its description and associated file paths.
   *
   * Classification levels (from least to most restrictive):
   * - "normal" — No sensitive content detected
   * - "sensitive" — Contains sensitive keywords/patterns; should use models
   *   that allow sensitive code
   * - "local-only" — Should only use models with privacy "trusted-provider-only"
   * - "trusted-provider-only" — Already at the trusted-provider level
   *
   * @param {string} taskDescription - The task description / prompt text
   * @param {string[]} [filePaths=[]] - File paths associated with the task
   * @returns {TaskClassification}
   */
  classifyTask(taskDescription, filePaths = []) {
    const descLower = (taskDescription || '').toLowerCase();
    const paths = filePaths || [];

    // ---- Check for local-only indicators -----------------------------------
    // If the task explicitly mentions local-only processing
    if (descLower.includes('local-only') || descLower.includes('local only') || descLower.includes('localonly')) {
      return 'local-only';
    }

    // ---- Check for trusted-provider-only indicators -------------------------
    if (descLower.includes('trusted-provider-only') || descLower.includes('trusted provider only') || descLower.includes('trustedprovideronly')) {
      return 'trusted-provider-only';
    }

    // ---- Check file paths for sensitive patterns ----------------------------
    for (const filePath of paths) {
      for (const pattern of SENSITIVE_FILE_PATTERNS) {
        if (pattern.test(filePath)) {
          return 'sensitive';
        }
      }
    }

    // ---- Check task description for sensitive keywords ----------------------
    for (const keyword of SENSITIVE_KEYWORDS) {
      // For multi-word keywords, check as-is and with spaces/dots normalized
      const normalized = keyword.replace(/[.\s]/g, '[.\\s]');
      const regex = new RegExp(`\\b${normalized}\\b`, 'i');
      if (regex.test(descLower)) {
        return 'sensitive';
      }
    }

    // ---- Default: normal ---------------------------------------------------
    return 'normal';
  }

  /**
   * Given a task classification and pool data, return only the models
   * that are suitable for that classification.
   *
   * @param {TaskClassification} taskClassification
   * @param {Object} pools - Parsed free-first-pools.json content (or a pool object)
   * @returns {Array<{model_id: string, role: string}>} Suitable models
   */
  getSuitableModels(taskClassification, pools) {
    const registry = this._loadRegistry();
    const registryModels = registry.models || [];

    // For each pool, cross-reference against the registry
    const suitable = [];

    const allPools = pools?.pools || {};
    for (const [poolName, pool] of Object.entries(allPools)) {
      for (const modelEntry of (pool.models || [])) {
        // Find the full registry entry
        const registryEntry = registryModels.find(m => m.model_id === modelEntry.model_id);
        if (!registryEntry) continue;
        if (!registryEntry.enabled) continue;

        if (this.isModelSuitableForTask(registryEntry, taskClassification)) {
          suitable.push({
            model_id: modelEntry.model_id,
            role: modelEntry.role,
            pool: poolName
          });
        }
      }
    }

    return suitable;
  }

  /**
   * Check if a model's privacy/data-policy permits the given task classification.
   *
   * @param {Object} modelRegistryEntry - A single model entry from model-registry.json
   * @param {TaskClassification} taskClassification
   * @returns {boolean}
   */
  isModelSuitableForTask(modelRegistryEntry, taskClassification) {
    if (!modelRegistryEntry.enabled) return false;

    const privacyClass = modelRegistryEntry.privacy_classification || 'standard';
    const sensitiveAllowed = modelRegistryEntry.sensitive_code_allowed === true;

    switch (taskClassification) {
      case 'normal':
        // Normal tasks can use any enabled model
        return true;

      case 'sensitive':
        // Sensitive tasks require sensitive_code_allowed = true
        return sensitiveAllowed;

      case 'local-only':
        // Local-only tasks require privacy "trusted-provider-only" or "local-private"
        return privacyClass === 'trusted-provider-only' || privacyClass === 'local-private';

      case 'trusted-provider-only':
        // Trusted-provider-only tasks can use any model
        return true;

      default:
        return false;
    }
  }

  /**
   * Convenience: classify a task AND return the filtered list of suitable models
   * from every pool.
   *
   * @param {string} taskDescription
   * @param {string[]} [filePaths]
   * @param {Object} pools - Parsed pool data
   * @returns {{ classification: TaskClassification, suitableModels: Array<{model_id: string, role: string, pool: string}> }}
   */
  classifyAndFilter(taskDescription, filePaths = [], pools) {
    const classification = this.classifyTask(taskDescription, filePaths);
    const suitableModels = this.getSuitableModels(classification, pools);
    return { classification, suitableModels };
  }
}
