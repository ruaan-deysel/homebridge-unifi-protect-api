# Pull Request

## Description

<!-- Provide a clear and concise description of what this PR does -->

## Type of Change

<!-- Check all that apply -->

- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New accessory or characteristic feature
- [ ] Breaking change (change causing existing Homebridge configurations to fail)
- [ ] Documentation update
- [ ] Code refactoring (no functional changes)
- [ ] Test additions or improvements
- [ ] Dependency update

## Pre-Submission Governance

<!--
  REQUIRED for everyone, including AI agents and automation.
  Every box below is mandatory. If any box is left unchecked, the automated
  "PR Governance" check fails and the PR will not be reviewed or merged.
  Do not open multiple overlapping or back-to-back PRs for the same work;
  batch related changes together to avoid wasting CI runner capacity.
-->

- [ ] I built and ran the project locally (`npm run build`) and verified this change actually works
- [ ] I ran `npm test` locally and all tests pass
- [ ] I ran `npm run lint` locally and it passes
- [ ] I pasted real local verification output under **Testing Performed** below (no placeholder text)
- [ ] This PR is self-contained and is not a duplicate; I have not opened other overlapping or back-to-back PRs for the same change
- [ ] If an AI agent created or assisted with this PR, a human reviewed and verified the changes before submission

## Related Issues

<!-- Link to related issues, or specify "None" for self-contained changes -->
<!-- Examples: Fixes #123, Closes https://github.com/..., Related to #456, Part of #789, or None -->

Fixes #

## Changes Made

<!-- List the main changes in this PR -->

-
-
-

## Homebridge Plugin Standards

<!-- Check all that apply to confirm compliance with Homebridge plugin development standards -->

- [ ] Verified against Homebridge Verified Plugin guidelines and best practices
- [ ] Configuration schema (`config.schema.json`) updated if config options changed
- [ ] No unhandled Promise rejections or unhandled exceptions that could crash Homebridge
- [ ] Network errors and accessory disconnections are handled gracefully with retries
- [ ] Sensitive credentials (passwords, tokens, API keys) are redacted from logs
- [ ] Not applicable (documentation-only or metadata change)

## Testing Performed

<!-- Check all that apply and describe what you tested -->

- [ ] Ran unit tests (`npm test`)
- [ ] Ran linter and type-checker (`npm run lint`)
- [ ] Ran build (`npm run build`)
- [ ] Tested live against real device or local Homebridge instance
- [ ] Not applicable (documentation-only or metadata-only change)

### Test Results

```text
[Paste relevant local command output and verification notes]
```

## Documentation

<!-- Check all that apply -->

- [ ] Code comments added/updated where needed
- [ ] README.md updated (if needed)
- [ ] CHANGELOG.md updated under [Unreleased]
- [ ] AGENTS.md / developer documentation updated (if architecture or process changed)
- [ ] No documentation needed

## Breaking Changes

<!-- If this PR introduces breaking changes, describe them and provide migration instructions -->

## Checklist

<!-- Ensure you've completed all required items before submitting -->

- [ ] I have updated CHANGELOG.md under [Unreleased] with details of this change
- [ ] I linked related issues or noted "None" in **Related Issues**
- [ ] I completed all required sections in this template and removed placeholder-only content
- [ ] My code follows the project's coding standards and Homebridge patterns
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas (if applicable)
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works (if applicable)
- [ ] New and existing tests pass locally with my changes
- [ ] No sensitive information (tokens, passwords, personal data) is included
