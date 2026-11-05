#!/usr/bin/env bash
# Run scripts/live-proxy-e2e.ts inside the recording container, from the deploy host.
#
# The harness has to import the deployed `server/hls-proxy.ts` and drive the container's own
# ffmpeg, so it runs in the container rather than on the host. The container image has no
# `scripts/` directory, hence the copy. Set EASYX_SKIP_PROXY_E2E=1 in the gate to bypass it.
#
# Exit code is the harness's own: 0 only when both the fix and control scenarios pass.
set -u
REPO=${EASYX_REPO:-/root/OpenEasyX}
CONTAINER=${EASYX_CONTAINER:-open-easyx}
SOURCE="$REPO/scripts/live-proxy-e2e.ts"
REMOTE="/app/scripts/live-proxy-e2e.ts"

if [ ! -f "$SOURCE" ]; then
  echo "FAIL live-proxy-e2e: missing harness at $SOURCE"
  exit 2
fi

cleanup() {
  docker exec -u 0 "$CONTAINER" rm -f "$REMOTE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker exec -u 0 "$CONTAINER" mkdir -p /app/scripts >/dev/null 2>&1; then
  echo "FAIL live-proxy-e2e: cannot create /app/scripts in $CONTAINER"
  exit 2
fi
if ! docker cp "$SOURCE" "$CONTAINER:$REMOTE" >/dev/null 2>&1; then
  echo "FAIL live-proxy-e2e: cannot copy the harness into $CONTAINER"
  exit 2
fi

# The harness spawns its own ffmpeg on private ports. Call it only after the gate has finished
# counting in-flight captures, or a fixture process would be mistaken for a real recording.
docker exec -w /app "$CONTAINER" npx tsx scripts/live-proxy-e2e.ts
