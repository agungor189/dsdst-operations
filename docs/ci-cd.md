# CI/CD and branch protection

Each application repository has three required CI jobs: `quality`, `secret-scan`, and `container`. Quality uses the repository's existing scripts; test/typecheck/build failures block the job. Gitleaks scans full Git history, npm audit blocks critical production dependency findings, and Trivy blocks fixed high/critical container findings. The operations repository adds Compose/shell/misconfiguration validation and a separate isolated `Operations E2E` workflow.

GitHub branch protection is intentionally not modified by these files. A repository administrator should configure `main` in every repository with:

1. Require pull requests and at least one approval.
2. Require branches to be up to date before merging.
3. Require `CI / quality`, `CI / secret-scan`, and `CI / container` status checks.
4. For `dsdst-operations`, also require `Operations E2E / operations-e2e`.
5. Dismiss stale approvals, require conversation resolution, disallow force-push/deletion, and restrict direct pushes.
6. Enable GitHub secret scanning/push protection and Dependabot alerts where the plan supports them.

Image publishing is deliberately not coupled to PR validation. Add a protected-environment release workflow only after GHCR repository names, immutable tag policy, signing/provenance, and production approval ownership are agreed.
