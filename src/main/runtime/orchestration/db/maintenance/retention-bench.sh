#!/usr/bin/env bash
# Scratch benchmark runner (not part of the PR).
F=src/main/runtime/orchestration/db/maintenance/retention-day.bench.test.ts
for spec in issue88:none issue88:incremental windows500:none; do
  shape=${spec%%:*}
  av=${spec##*:}
  out=/tmp/rb-$$-$shape-$av.json
  rm -f "$out"
  ORCA_RETENTION_BENCH_INDEX=${INDEX:-} ORCA_RETENTION_BENCH=$shape ORCA_RETENTION_BENCH_AUTOVACUUM=$av \
    ORCA_RETENTION_BENCH_OUT=$out pnpm exec vitest run --config config/vitest.config.ts --maxWorkers=1 $F > /tmp/rb-$$-vitest.log 2>&1
  echo "vitest $spec exit=$?"
  grep -E "Error|failed" /tmp/rb-$$-vitest.log | head -5
  [ -f "$out" ] && echo "RB_JSON $(cat "$out")"
done
