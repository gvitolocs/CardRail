#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

tag="$(git rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$tag" ] || tag="dev"

compose=(docker compose -p cardrails -f deploy/compose.yml)
health_url="http://127.0.0.1:18200/healthz"

docker build -t "cardrails-api:${tag}" -t cardrails-api:latest .

previous_id="$(docker inspect --format '{{.Image}}' cardrails-api 2>/dev/null || true)"

"${compose[@]}" up -d --force-recreate cardrails-api

deadline=$((SECONDS + 30))
until curl -fsS "$health_url" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
        echo "health check failed after 30s" >&2
        docker logs --tail 50 cardrails-api >&2 || true
        if [ -n "$previous_id" ]; then
            docker tag "$previous_id" cardrails-api:latest
            "${compose[@]}" up -d --force-recreate cardrails-api
            echo "rolled back to previous image" >&2
        fi
        exit 1
    fi
    sleep 1
done

echo "deployed ${tag}"
