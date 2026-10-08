#!/usr/bin/env bash
set -euo pipefail

CONTAINER="${CARDRAILS_PG_CONTAINER:-cardrails-postgres}"
DB_USER="${CARDRAILS_PG_USER:-cardrails}"
DB_NAME="${CARDRAILS_PG_NAME:-cardrails}"
DB_URL="postgres://${DB_USER}@${CONTAINER}:5432/${DB_NAME}"

SQL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../sql" && pwd)"

psql() {
  docker exec -i "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 "$@"
}

psql -c "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())" >/dev/null

for file in "$SQL_DIR"/*.sql; do
  name="$(basename "$file")"
  applied="$(psql -tAc "SELECT 1 FROM schema_migrations WHERE name = '${name}'")"
  if [[ "$applied" == "1" ]]; then
    echo "skip    ${name}"
    continue
  fi

  {
    echo "BEGIN;"
    cat "$file"
    printf "INSERT INTO schema_migrations (name) VALUES ('%s');\n" "$name"
    echo "COMMIT;"
  } | psql >/dev/null

  echo "applied ${name}"
done

echo "done ($DB_URL)"
