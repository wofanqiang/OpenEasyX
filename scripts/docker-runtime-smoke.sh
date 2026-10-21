#!/usr/bin/env bash
set -euo pipefail

image="${1:-open-easyx:ci}"
version="${2:-ci-test}"
volume="open-easyx-ci-data-${GITHUB_RUN_ID:-local}-$$"
container="open-easyx-ci-${GITHUB_RUN_ID:-local}-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker volume create "$volume"
# The browser-login half of the smoke needs the feature switched on and a known admin password to
# mint the session cookie the gate asks for; both are throwaway values for this container.
docker run -d --name "$container" -e PUID=99 -e PGID=100 -e EASYX_ENABLE_BROWSER_LOGIN=true -e EASYX_ADMIN_PASSWORD="${EASYX_ADMIN_PASSWORD:-smoke-password}" -v "$volume:/data" "$image"

for attempt in {1..20}; do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3210/api/health').then(r => { if (!r.ok) process.exit(1) })" 2>/dev/null; then
    break
  fi
  if [ "$attempt" = 20 ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

# The dependency overrides must preserve the imports used by the authentication helper.
docker exec "$container" /opt/ofscraper/bin/python -c 'from ofscraper.main.open import load; from ofscraper.data.api.init import getstatus; import idna, lxml.etree; print("OF-Scraper imports OK", idna.__version__, lxml.etree.LXML_VERSION)'
docker exec "$container" sh -lc 'test "$(awk "/^Uid:/ { print \$2 }" /proc/1/status)" = 99 && test "$(cat /proc/1/comm)" = tini'
docker exec "$container" sh -lc 'test -w /data && test -f /data/easyx.sqlite && test -f /data/open-easyx-library.sqlite'
docker exec -e EXPECTED_VERSION="$version" "$container" node -e "fetch('http://127.0.0.1:3210/api/health').then(r=>r.json()).then(v=>{if(v.product!=='Open EasyX'||!v.ok||v.version!==process.env.EXPECTED_VERSION)throw Error(JSON.stringify(v))})"
docker exec -e EXPECTED_VERSION="$version" "$container" node -e "fetch('http://127.0.0.1:3210/api/version').then(r=>r.json()).then(v=>{if(v.version!==process.env.EXPECTED_VERSION)throw Error(JSON.stringify(v))})"
# Everything the gate protects: sign in, check the official repository is listed and non-removable,
# then start the integrated browser login and prove the /browser viewer and the paste bridge work.
docker cp scripts/runtime-api-smoke.mjs "$container:/tmp/runtime-api-smoke.mjs"
docker exec "$container" node /tmp/runtime-api-smoke.mjs
sleep 1
docker exec "$container" sh -lc 'if ps -eo stat | grep -q "^Z"; then exit 1; fi'
