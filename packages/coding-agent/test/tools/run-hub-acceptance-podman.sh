#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
container="buddha-hub-acceptance-${USER:-runner}-$$"

cleanup() {
	podman rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

podman run --name "$container" \
	--init \
	--network none \
	--memory 3g \
	--pids-limit 1000 \
	--read-only \
	--tmpfs /tmp:rw,nosuid,nodev,size=256m \
	-v "$repo_root:/work:ro" \
	-w /work \
	docker.io/oven/bun:1 \
	bun test \
	packages/coding-agent/test/tools/hub-inbox.test.ts \
	packages/coding-agent/test/tools/hub-inbox-acceptance.test.ts
