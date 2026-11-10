#!/bin/sh
set -e

# Mermaid Production Process Role Dispatcher
# Defined in docs/architecture/12-deployment-architecture.md
ROLE="${1:-${PROCESS_ROLE:-all}}"

case "$ROLE" in
  web)
    echo "Starting Mermaid Web Service..."
    exec node apps/web/server.ts
    ;;
  worker)
    echo "Starting Mermaid Background Worker (Outbox & ERA)..."
    exec node apps/web/worker.ts
    ;;
  jobs)
    echo "Starting Mermaid Scheduled Jobs Service..."
    exec node apps/web/jobs.ts
    ;;
  all)
    echo "Starting Mermaid in Single-Container Mode (Web + Integrated Worker & Monitors)..."
    exec node apps/web/server.ts
    ;;
  *)
    # Pass arbitrary commands through (e.g. bash, migrate)
    exec "$@"
    ;;
esac
