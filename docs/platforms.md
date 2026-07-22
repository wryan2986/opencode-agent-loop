# Platform support

The runtime is written in Node.js and is tested on Linux, macOS, and Windows. Shell-based installation and agent validation still require a POSIX-compatible shell.

## Linux

Linux is the primary supported environment. Run the standard installer:

```bash
bash scripts/install.sh
```

## macOS

Install Node.js 18 or newer and a patched OpenCode build, then run the standard installer from Terminal. Both Intel and Apple Silicon use the same package files; the OpenCode executable itself must match the machine architecture.

## Windows

Supported workflows are:

1. **WSL 2** — recommended; follow the Linux instructions inside WSL.
2. **Git Bash** — supported for installation and shell validation when Node and the patched OpenCode executable are available on `PATH`.
3. **Native PowerShell/cmd** — the Node runtime and tests are portable, but `scripts/install.sh` and Bash validation scripts are not native PowerShell installers.

Do not mix Windows and WSL configuration directories. Install and run OpenCode in the same environment where the agent loop is installed.

## Verification

On every platform:

```bash
node --version
npm ci
npm test
npm run validate:portable
```

The cross-platform CI matrix runs the portable test suite on Ubuntu, macOS, and Windows. Linux CI additionally runs Bash permission and installation-oriented checks.
