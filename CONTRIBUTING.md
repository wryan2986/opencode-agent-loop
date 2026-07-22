# Contributing
## Welcome
Thank you for considering contributing to the OpenCode Agent Loop. This project aims to provide a reliable, safe, and extensible framework for autonomous software development.

## Code of Conduct
This project adheres to a Code of Conduct. By participating, you agree to maintain a respectful and inclusive environment.

## How to Contribute

### Reporting Bugs
1. Check existing issues for duplicates
2. Use the bug report template
3. Include your configuration (sanitized), steps to reproduce, and logs
4. Do not include credentials or secrets in bug reports

### Suggesting Features
1. Check existing issues and discussions for similar ideas
2. Use the feature request template
3. Explain the problem and proposed solution
4. Be specific about which agent roles would be affected

### Pull Requests
1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run tests: `npm test`
5. Run validation: `bash scripts/validate.sh`
6. Commit with conventional commit messages
7. Push and open a Pull Request

## Development Setup
```bash
git clone <repository-url>
cd opencode-agent-loop
npm install
```

## Testing
```bash
# Full test suite
npm test

# Individual test suites
node tests/routing-tests.mjs
node tests/runtime-tests.mjs
node tests/tool-integration-tests.mjs
node tests/bypass-detection.mjs
```

## Commit Messages
Use conventional commits format:
```
feat: add new feature
fix: correct bug
docs: update documentation
chore: maintenance tasks
refactor: code restructuring
test: add or update tests
style: formatting changes
```

## Branch Naming
- `feature/<description>` — New features
- `fix/<description>` — Bug fixes
- `docs/<description>` — Documentation
- `chore/<description>` — Maintenance

## Code Review
All submissions require review. The review agent will inspect:
- Correctness against acceptance criteria
- Security implications
- Test coverage
- Documentation accuracy
- Potential regressions

## AI-Generated Contributions
If your contribution was created with assistance from AI tools:
1. Disclose this in your pull request
2. Review all generated code for correctness and security
3. Ensure you have the right to submit the code
4. The same review standards apply regardless of origin

## Questions?
Open a GitHub Discussion for questions and community support.