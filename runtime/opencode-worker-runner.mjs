import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const activeChildren = new Set();

export function getActiveWorkerCount() {
  return activeChildren.size;
}

export function terminateActiveWorkers(signal = 'SIGTERM') {
  for (const child of activeChildren) {
    if (!child.killed) child.kill(signal);
  }
}

export function extractProviderError({ stdout = '', stderr = '', exitCode = 0 } = {}) {
  const combined = `${stderr}\n${stdout}`;
  const statusMatch = combined.match(/\b(410|429|500|502|503|504|401|403|404)\b/);
  const codeMatch = combined.match(/\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EPIPE|UNAUTHORIZED|FORBIDDEN)\b/);
  const providerMatch = combined.match(/provider[\s:]+([a-z0-9._-]+)/i);
  const modelMatch = combined.match(/model[\s:]+([a-z0-9._/-]+(?::free)?)/i);
  const sessionMatch = combined.match(/session(?:ID|Id| id)?[\s:=]+([a-zA-Z0-9_-]+)/);
  return {
    statusCode: statusMatch ? Number(statusMatch[1]) : undefined,
    code: codeMatch ? codeMatch[1] : undefined,
    provider: providerMatch ? providerMatch[1] : undefined,
    model: modelMatch ? modelMatch[1] : undefined,
    sessionId: sessionMatch ? sessionMatch[1] : undefined,
    message: combined.slice(0, 2000),
    exitCode
  };
}

export function deriveProviderFromModel(model) {
  if (!model || typeof model !== 'string') return 'unknown';
  const parts = model.split('/');
  return parts.length >= 2 ? parts[0] : 'unknown';
}

export function resolveTimeoutMs({ model, timeoutMs, providerTimeouts = {}, latencyTimeoutMapping = {} }) {
  if (timeoutMs != null && timeoutMs > 0) return timeoutMs;
  const provider = deriveProviderFromModel(model);
  const providerTier = providerTimeouts[provider];
  if (providerTier != null && providerTier > 0) return providerTier;
  const fallback = providerTimeouts.default;
  if (fallback != null && fallback > 0) return fallback;
  return 20 * 60 * 1000;
}

function parseJsonEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Ignore formatted text mixed into --format json output.
    }
  }
  return events;
}

function extractSessionId(stdout, stderr) {
  for (const event of parseJsonEvents(stdout)) {
    const id = event.sessionID || event.sessionId || event.session?.id || event.properties?.sessionID;
    if (id) return id;
  }
  return extractProviderError({ stdout, stderr }).sessionId;
}

export async function runOpenCodeWorker({
  cwd,
  agent,
  model,
  prompt,
  timeoutMs,
  env = {},
  signal,
  executable = process.env.AGENT_LOOP_WORKER_EXECUTABLE || 'opencode',
  sessionId,
  continueSession = false,
  title,
  progressLogPath,
  providerTimeouts = {},
  latencyTimeoutMapping = {},
  stdoutTailCallback
}) {
  if (!cwd) throw new Error('runOpenCodeWorker requires cwd');
  if (!agent) throw new Error('runOpenCodeWorker requires agent');
  if (!model) throw new Error('runOpenCodeWorker requires explicit model');
  if (!prompt) throw new Error('runOpenCodeWorker requires prompt');

  const effectiveTimeoutMs = resolveTimeoutMs({ model, timeoutMs, providerTimeouts, latencyTimeoutMapping });

  const args = [
    'run',
    '--agent', agent,
    '--model', model,
    '--format', 'json',
    '--dir', cwd,
    '--auto'
  ];
  if (title) args.push('--title', title);
  if (sessionId) args.push('--session', sessionId);
  else if (continueSession) args.push('--continue');
  args.push(prompt);

  const childEnv = {
    ...process.env,
    ...env,
    AGENT_LOOP_CHILD: '1'
  };

  // Ensure executable is absolute
  if (executable === 'opencode' && !process.env.AGENT_LOOP_WORKER_EXECUTABLE) {
    executable = '/home/casaos/.opencode/bin/opencode';
  }
  if (!cwd || cwd === '') {
    cwd = '/home/casaos/opencode-agent-loop';
  }

  return await new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env: childEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    activeChildren.add(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let lastActivityAt = Date.now();
    let lastTailTs = 0;
    const TAIL_LINES = 20;
    const TAIL_THROTTLE_MS = 2000;

    function getStdoutTail() {
      const lines = stdout.split('\n').filter(Boolean);
      return lines.slice(-TAIL_LINES).join('\n');
    }

    const flushProgress = () => {
      if (progressLogPath && (stdout.length > 0 || stderr.length > 0)) {
        try {
          appendFileSync(progressLogPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            type: 'progress',
            stdoutLength: stdout.length,
            stderrLength: stderr.length,
            lastActivityAt: new Date(lastActivityAt).toISOString(),
            tail: getStdoutTail().slice(-1000),
            timedOut,
            running: !timedOut
          }) + '\n');
        } catch { /* best effort */ }
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      flushProgress();
      if (!child.killed) child.kill('SIGTERM');
    }, effectiveTimeoutMs);

    const abort = () => {
      if (!child.killed) child.kill('SIGTERM');
    };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout?.on('data', chunk => {
      stdout += chunk.toString();
      lastActivityAt = Date.now();
      // Throttled tail callback for TUI metadata
      if (stdoutTailCallback) {
        const now = Date.now();
        if (now - lastTailTs >= TAIL_THROTTLE_MS) {
          lastTailTs = now;
          try { stdoutTailCallback(getStdoutTail().slice(-800)); } catch {}
        }
      }
    });
    child.stderr?.on('data', chunk => {
      stderr += chunk.toString();
      lastActivityAt = Date.now();
    });

    // Periodic progress flush
    const progressInterval = setInterval(flushProgress, 5000);

    child.on('error', error => {
      clearTimeout(timeout);
      clearInterval(progressInterval);
      activeChildren.delete(child);
      flushProgress();
      const providerError = extractProviderError({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: -1 });
      resolve({
        success: false, stdout, stderr, exitCode: -1, signal: null, error,
        timedOut: false, lastActivityAt,
        ...providerError
      });
    });
    child.on('close', (exitCode, processSignal) => {
      clearTimeout(timeout);
      clearInterval(progressInterval);
      activeChildren.delete(child);
      if (signal) signal.removeEventListener?.('abort', abort);
      flushProgress();
      const providerError = extractProviderError({ stdout, stderr, exitCode });
      const session = extractSessionId(stdout, stderr);
      resolve({
        success: exitCode === 0 && !timedOut,
        stdout,
        stderr,
        exitCode,
        signal: processSignal,
        timedOut,
        sessionId: session,
        lastActivityAt,
        error: exitCode === 0 && !timedOut ? undefined : providerError,
        statusCode: providerError.statusCode,
        code: timedOut ? 'ETIMEDOUT' : providerError.code
      });
    });
  });
}
