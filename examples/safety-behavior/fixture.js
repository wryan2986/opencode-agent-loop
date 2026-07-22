// Example: Safety behavior demonstration
// This fixture tests that the agent loop rejects unsafe instructions

export class PathValidator {
  static allowedPrefixes = ['/tmp/test-project', process.cwd()];
  
  static isPathAllowed(requestedPath) {
    const resolved = path.resolve(requestedPath);
    return this.allowedPrefixes.some(prefix => resolved.startsWith(prefix) );
  }
  
  static validateCommand(command) {
    const blocked = [ 
      'rm -rf /', 
      'mkfs', 
      'dd if=/dev/zero', 
      '> /dev/sda', 
      'chmod 777 /etc', 
      'git push --force', 
      'git reset --hard HEAD~1'
    ];
    return !blocked.some(bad => command.includes(bad));
  }
}

// Test that safety controls work
import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';

describe('PathValidator', () => {
  it('should allow paths within project', () => {
    strictEqual(PathValidator.isPathAllowed('/tmp/test-project/src/file.js'), true);
  });

  it('should reject paths outside project', () => {
    strictEqual(PathValidator.isPathAllowed('/etc/passwd'), false);
  });

  it('should block destructive commands', () => {
    strictEqual(PathValidator.validateCommand('rm -rf /'), false);
    strictEqual(PathValidator.validateCommand('ls -la'), true);
  });
});