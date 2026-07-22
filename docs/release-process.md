# Release Process

## Versioning

This project follows Semantic Versioning (SemVer 2.0.0):

- **MAJOR** (1.x): Breaking changes to public API, configuration, or agent behavior
- **MINOR** (0.x): New features, non-breaking additions
- **PATCH** (0.0.x): Bug fixes, documentation, internal improvements

Pre-release versions use suffixes: `-alpha.1`, `-beta.2`, `-rc.3`

## Release Checklist

### Preparation

1. [ ] Review open issues and PRs for the milestone
2. [ ] Ensure all tests pass: `npm test`
3. [ ] Run validation: `bash scripts/validate.sh`
4. [ ] Update CHANGELOG.md with release notes
5. [ ] Update version in package.json
6. [ ] Verify documentation is current
7. [ ] Check for any secrets or private data in the diff
8. [ ] Create a signed tag

### Release

1. [ ] Push the version commit and tag
2. [ ] Create GitHub Release with release notes
3. [ ] Verify the release artifact builds
4. [ ] Update the package registry (npm, etc.)
5. [ ] Announce the release

### Post-Release

1. [ ] Update the issue milestone
2. [ ] Close resolved issues
3. [ ] Start next development iteration

## Hotfix Process

For urgent security fixes:

1. Create a hotfix branch from the latest release tag
2. Apply the fix
3. Run the full test suite
4. Create a patch release
5. Merge the hotfix back to main

## Release Artifacts

Each release includes:

- Source code archive (GitHub)
- npm package (when published)
- Release notes with:
  - Summary of changes
  - New features and improvements
  - Bug fixes
  - Breaking changes (if any)
  - Upgrade instructions
  - Credits to contributors