import { spawn } from 'node:child_process';

function extractFencedJson(text) {
  const matches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const match of matches.reverse()) {
    try {
      return JSON.parse(match[1].trim());
    } catch {
      // Try another fenced block.
    }
  }
  return null;
}

function extractBalancedJson(text) {
  for (let start = text.length - 1; start >= 0; start -= 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === open) depth += 1;
      if (char === close) depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, index + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

export function extractJson(text) {
  const trimmed = String(text || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return extractFencedJson(trimmed) ?? extractBalancedJson(trimmed);
  }
}

export async function runOpenCodeAgent({
  agent,
  prompt,
  workspace,
  timeoutMs = 10 * 60 * 1000,
  opencodeBin = process.env.OPENCODE_BIN || 'opencode',
  attach,
}) {
  const args = ['run', '--agent', agent, '--format', 'default', '--dir', workspace];
  if (attach) args.push('--attach', attach);
  args.push(prompt);

  return await new Promise((resolve, reject) => {
    const child = spawn(opencodeBin, args, {
      cwd: workspace,
      env: {
        ...process.env,
        AGENT_LOOP_CHILD: '1',
        BUG_BOUNTY_CHILD: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(`Could not start OpenCode agent '${agent}': ${error.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      const parsed = extractJson(stdout);
      if (code !== 0) {
        const error = new Error(`OpenCode agent '${agent}' exited with code ${code}: ${stderr.trim() || stdout.trim()}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = code;
        reject(error);
        return;
      }
      if (parsed === null) {
        const error = new Error(`OpenCode agent '${agent}' did not return valid JSON`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ parsed, stdout, stderr, exitCode: code });
    });
  });
}
