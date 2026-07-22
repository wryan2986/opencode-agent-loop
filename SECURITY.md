# Security Policy

## Supported Versions

| Version | Supported |
|---------|--------------------|
| 0.1.x | :white_check_mark: |

## Reporting a Vulnerability

The OpenCode Agent Loop project takes security seriously. If you discover a security vulnerability, please report it privately.
**Do not report security vulnerabilities through public GitHub issues.**

Send a detailed report to the maintainers by opening a draft security advisory on GitHub, or if that is unavailable, by contacting the project maintainers directly through a private channel.

Please include:
- A description of the vulnerability
- Steps to reproduce
- Affected versions
- Any potential mitigations you've identified

You should receive a response within 72 hours. If you don't, please follow up.

## What to expect

- Acknowledgment of your report within 3 business days
- An assessment of the vulnerability's severity and impact
- A timeline for a fix and release
- Credit in the release notes and SECURITY.md (unless you prefer to remain anonymous)

## Scope

This security policy covers the opencode-agent-loop package and its official plugins and commands.
It does not cover:
- Third-party model providers
- OpenCode itself
- Projects that use this package

## Safe Harbor

We consider security research conducted under this policy to be:
- Authorized under the Computer Fraud and Abuse Act
- Exempt from DMCA anti-circumvention provisions
- Not a violation of our terms of service

You agree not to:
- Access or modify user data without permission
- Disrupt production services
- Exploit vulnerabilities beyond what is necessary to confirm the issue

## Security Practices

This project implements the following security practices:
- All agents are read-only or edit-restricted by default
- Destructive git operations (push, reset, clean) are denied for all agents
- Agent-loop recursion is blocked for worker processes
- Privacy-aware model routing with data-policy classification
- Secret detection in staged changes before commit
- Path confinement through allowed-tool scoping