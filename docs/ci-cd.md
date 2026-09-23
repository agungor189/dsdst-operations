# CI/CD and branch protection

Each application repository has three required CI jobs: `quality`, `secret-scan`, and `container`. Quality uses the repository's existing scripts; test/typecheck/build failures block the job. Gitleaks scans full Git history, npm audit blocks critical production dependency findings, and Trivy blocks fixed high/critical container findings. The operations repository adds Compose/shell/misconfiguration validation and a separate isolated `Operations E2E` workflow.

GitHub branch protection is intentionally not modified by these files. A repository administrator should configure `main` in every repository with:

1. Require pull requests and at least one approval.
2. Require branches to be up to date before merging.
3. Require `CI / quality`, `CI / secret-scan`, and `CI / container` status checks.
4. For `dsdst-operations`, also require `Operations E2E / operations-e2e`.
5. Dismiss stale approvals, require conversation resolution, disallow force-push/deletion, and restrict direct pushes.
6. Enable GitHub secret scanning/push protection and Dependabot alerts where the plan supports them.

Image publishing remains separate from PR validation and has no push, release, or schedule
trigger. `.github/workflows/publish-v2-18-images.yml` is a manually dispatched V2-18
artifact workflow with only `contents: read` and `packages: write`. It reads all six
source revisions from `config/v2-18-source-set.json`, checks out each exact revision,
builds with mandatory OCI source/revision labels, pushes to the approved GHCR names, and
then reads the image config back from `repository@sha256:<digest>`. A checkout, digest, or
label mismatch fails the run before the final manifest is created.

The workflow publishes six images. The Label Printer record expands into both
`label-printer` and `warehouse-label-renderer`, with the same image reference and digest.
The final `v2-18-image-manifest` artifact is redacted and machine-readable; each service
record contains `service`, source `repository`, exact `revision`, immutable
`image_reference`, and `digest`. Revision-derived tags are transport/discovery aids only
and are never accepted as runtime provenance.

GitHub exposes a `workflow_dispatch` workflow only after its definition exists on the
default branch. After separate review and owner-authorized merge (not performed by this
change), run it from GitHub Actions by selecting **Publish V2-18 immutable images**,
choosing the reviewed `codex/v2-18-independent-system-gate` ref, and selecting
**Run workflow**. The built-in `GITHUB_TOKEN` performs the GHCR push. If any source repository is private,
configure `DSDST_SOURCE_READ_TOKEN` as a repository secret with read-only Contents access
to those source repositories; never place a token in the workflow or artifact. Existing
GHCR packages must grant this repository Actions write access. A successful image build
does not deploy, start a candidate, create/restore a recovery point, mutate Cloudflare,
or establish PR01 runtime provenance.
