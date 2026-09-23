#!/usr/bin/env sh
set -eu

echo "Refusing blind in-place deployment: scripts/deploy.sh was retired by V2-17." >&2
echo "Use the approved append-only release workflow in docs/runtime-release.md." >&2
echo "No containers, routes, databases, volumes, images, or backups were changed." >&2
exit 1
