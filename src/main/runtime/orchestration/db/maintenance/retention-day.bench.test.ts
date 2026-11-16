// Scratch benchmark (not part of the PR): a simulated day of orchestration.db growth and maintenance.
import { describe, it } from 'vitest'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setImmediate as yieldImmediate } from 'node:timers/promises'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OrchestrationDb } from '../orchestration-db'
import { OrchestrationDbMaintenance } from './orchestration-db-maintenance'
import { ensureMutationReceiptCapacity } from '../mutation-receipts/mutation-receipt-capacity'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

type Shape = {
  baseRuns: number
  baseSpreadHours: number
  tasksPerRun: number
  specBytes: number
  messagesPerRun: number
  messageBytes: number
  questionsPerRun: number
  answerBytes: number
  relayPerDispatch: number
  relayBytes: number
  receiptsPerRun: number
  receiptBytes: number
  runsPerHour: number
  abandonedRuns: number
  liveCoordinatorEvery: number
}

const SHAPES: Record<string, Shape> = {
  tiny: {
    baseRuns: 20,
    baseSpreadHours: 48,
    tasksPerRun: 2,
    specBytes: 1_000,
    messagesPerRun: 3,
    messageBytes: 500,
    questionsPerRun: 1,
    answerBytes: 500,
    relayPerDispatch: 2,
    relayBytes: 200,
    receiptsPerRun: 2,
    receiptBytes: 200,
    runsPerHour: 2,
    abandonedRuns: 1,
    liveCoordinatorEvery: 5
  },
  // #41756: ~350 Runs/day, 88 MB, tasks 35 / messages 18 / relay 9 / questions 8 MB.
  issue88: {
    baseRuns: 250,
    baseSpreadHours: 30,
    tasksPerRun: 3,
    specBytes: 45_000,
    messagesPerRun: 8,
    messageBytes: 9_000,
    questionsPerRun: 1,
    answerBytes: 30_000,
    relayPerDispatch: 4,
    relayBytes: 3_000,
    receiptsPerRun: 4,
    receiptBytes: 5_000,
    runsPerHour: 15,
    abandonedRuns: 0,
    liveCoordinatorEvery: 25
  },
  // Windows data point: ~500 MB, 1,370 Runs, ~10,400 Dispatches, ~42,000 messages, 13 abandoned open.
  windows500: {
    baseRuns: 1370,
    baseSpreadHours: 24 * 90,
    tasksPerRun: 8,
    specBytes: 22_000,
    messagesPerRun: 30,
    messageBytes: 4_000,
    questionsPerRun: 2,
    answerBytes: 8_000,
    relayPerDispatch: 1,
    relayBytes: 2_000,
    receiptsPerRun: 6,
    receiptBytes: 5_000,
    runsPerHour: 15,
    abandonedRuns: 13,
    liveCoordinatorEvery: 50
  }
}

const filler = (bytes: number, seed: number): string => {
  const unit = `${seed.toString(36)}-lorem-ipsum-dolor-sit-amet-`
  return unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes)
}

let sequence = 0

function createRun(db: OrchestrationDb, shape: Shape, label: string): string {
  const n = ++sequence
  const run = db.createRun({
    objective: `job ${label} ${n}`,
    coordinatorHandle: `term_coord_${n}`,
    coordinatorPaneKey: `tab_${n}:11111111-1111-4111-8111-${String(n).padStart(12, '0')}`
  })
  for (let t = 0; t < shape.tasksPerRun; t++) {
    const task = db.createTask({ spec: filler(shape.specBytes, n * 100 + t), runId: run.id })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { worktree: 'current' },
      runtimeEpoch: 'runtime_1',
      federation: {
        environmentId: 'environment_1',
        environmentName: 'Windows',
        peerFingerprint: 'peer_1',
        protocolVersion: 1
      },
      mutationReceipt: {
        callerFingerprint: 'caller_1',
        requestId: `request_${n}_${t}`,
        method: 'orchestration.workerStart',
        payloadHash: 'hash_1'
      }
    })
    const dispatchId = started.dispatch.id
    // A real start completes its receipt; pending ones would fill the ledger.
    db.db
      .prepare(
        `UPDATE mutation_receipts SET state = 'completed', receipt = '{}'
         WHERE caller_fingerprint = 'caller_1' AND request_id = ?`
      )
      .run(`request_${n}_${t}`)
    for (let r = 0; r < shape.relayPerDispatch; r++) {
      db.enqueueFederationRelay({
        dispatchId,
        direction: 'to_home',
        kind: 'status',
        payload: JSON.stringify({ text: filler(shape.relayBytes, r) }),
        messageId: `status_${n}_${t}_${r}`
      })
    }
    db.db
      .prepare(
        `INSERT INTO worker_terminal_resources
           (id, origin_dispatch_id, owner_dispatch_id, terminal_handle, ownership_state, release_state)
         VALUES (?, ?, ?, ?, 'released', 'released')`
      )
      .run(`resource_${n}_${t}`, dispatchId, dispatchId, `term_worker_${n}_${t}`)
    if (t < shape.questionsPerRun) {
      db.createQuestion({ runId: run.id, dispatchId, askerHandle: 'worker', question: 'Continue?' })
    }
  }
  for (let m = 0; m < shape.messagesPerRun; m++) {
    db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'report',
      body: filler(shape.messageBytes, n * 1000 + m)
    })
  }
  const receipt = db.db.prepare(
    `INSERT INTO mutation_receipts
       (caller_fingerprint, request_id, method, payload_hash, state, receipt)
     VALUES ('caller_1', ?, 'orchestration.check', 'hash', 'completed', ?)`
  )
  for (let r = 0; r < shape.receiptsPerRun; r++) {
    receipt.run(`check_${n}_${r}`, JSON.stringify({ messages: [filler(shape.receiptBytes, r)] }))
  }
  ensureMutationReceiptCapacity(db.db)
  db.db
    .prepare('UPDATE question_threads SET answer_body = ? WHERE run_id = ?')
    .run(filler(shape.answerBytes, n), run.id)
  return run.id
}

function settle(db: OrchestrationDb, runId: string): void {
  const inRun = 'IN (SELECT id FROM dispatch_contexts WHERE run_id = ?)'
  db.db.exec('BEGIN IMMEDIATE')
  db.db
    .prepare(
      "UPDATE tasks SET status = 'completed', completed_at = datetime('now') WHERE run_id = ?"
    )
    .run(runId)
  db.db
    .prepare(
      "UPDATE dispatch_contexts SET status = 'completed', completed_at = datetime('now') WHERE run_id = ?"
    )
    .run(runId)
  db.db
    .prepare(`UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id ${inRun}`)
    .run(runId)
  db.db
    .prepare(
      "UPDATE question_threads SET status = 'answered', answered_at = datetime('now') WHERE run_id = ?"
    )
    .run(runId)
  db.db
    .prepare(`UPDATE remote_questions SET status = 'answered' WHERE dispatch_id ${inRun}`)
    .run(runId)
  db.db
    .prepare(
      `UPDATE federation_relay_items SET acked_at = datetime('now') WHERE dispatch_id ${inRun}`
    )
    .run(runId)
  db.db.prepare('UPDATE messages SET read = 1 WHERE run_id = ?').run(runId)
  db.db.exec('COMMIT')
}

function timestampColumns(db: OrchestrationDb): [string, string][] {
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
  return tables.flatMap((table) =>
    db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => String(column.name))
      .filter((name) => name.endsWith('_at') && name !== 'pruned_at')
      .map((name): [string, string] => [table, name])
  )
}

/** Moves every timestamp back, as if `hours` passed. */
function passTime(db: OrchestrationDb, hours: number): void {
  db.db.exec('BEGIN IMMEDIATE')
  for (const [table, column] of timestampColumns(db)) {
    db.db.exec(
      `UPDATE ${table} SET ${column} = datetime(julianday(${column}) - ${hours} / 24.0) WHERE ${column} IS NOT NULL`
    )
  }
  db.db.exec('COMMIT')
}

/** Ages each Run's rows by its own offset, spreading the base set over `spreadHours`. */
function spreadAges(db: OrchestrationDb, runIds: string[], spreadHours: number): void {
  db.db.exec('CREATE TEMP TABLE run_age (run_id TEXT PRIMARY KEY, hours REAL)')
  const insert = db.db.prepare('INSERT INTO run_age VALUES (?, ?)')
  runIds.forEach((id, i) => insert.run(id, spreadHours * (1 - i / runIds.length)))
  db.db.exec('BEGIN IMMEDIATE')
  for (const [table, column] of timestampColumns(db)) {
    const cols = db.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c) => String(c.name))
    const runOf = cols.includes('run_id')
      ? `${table}.run_id`
      : table === 'runs'
        ? 'runs.id'
        : cols.includes('dispatch_id')
          ? `(SELECT run_id FROM dispatch_contexts WHERE id = ${table}.dispatch_id)`
          : cols.includes('owner_dispatch_id')
            ? `(SELECT run_id FROM dispatch_contexts WHERE id = ${table}.owner_dispatch_id)`
            : null
    if (!runOf) {
      continue
    }
    db.db.exec(
      `UPDATE ${table} SET ${column} = datetime(julianday(${column}) -
         COALESCE((SELECT hours FROM run_age WHERE run_id = ${runOf}), 0) / 24.0)
       WHERE ${column} IS NOT NULL`
    )
  }
  // Receipts carry no Run: spread them by insertion order over the same window.
  const max = Number(db.db.prepare('SELECT MAX(rowid) AS m FROM mutation_receipts').get()?.m ?? 1)
  db.db.exec(
    `UPDATE mutation_receipts SET updated_at = datetime(julianday(updated_at) - ${spreadHours} * (1 - rowid * 1.0 / ${max}) / 24.0),
       created_at = datetime(julianday(created_at) - ${spreadHours} * (1 - rowid * 1.0 / ${max}) / 24.0)`
  )
  db.db.exec('COMMIT')
  db.db.exec('DROP TABLE temp.run_age')
}

function sizes(db: OrchestrationDb, path: string) {
  db.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const n = (sql: string) => Number(db.db.prepare(sql).get()?.n)
  return {
    fileMB: +(statSync(path).size / 1e6).toFixed(1),
    freeMB: +((n('SELECT freelist_count AS n FROM pragma_freelist_count') * 4096) / 1e6).toFixed(1),
    runs: n('SELECT COUNT(*) AS n FROM runs'),
    dispatches: n('SELECT COUNT(*) AS n FROM dispatch_contexts'),
    messages: n('SELECT COUNT(*) AS n FROM messages'),
    relay: n('SELECT COUNT(*) AS n FROM federation_relay_items'),
    receipts: n('SELECT COUNT(*) AS n FROM mutation_receipts')
  }
}

const pct = (values: number[], p: number): number => {
  if (!values.length) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  return +sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!.toFixed(2)
}

describe.runIf(process.env.ORCA_RETENTION_BENCH)('retention day benchmark', () => {
  it('simulates a day', { timeout: 3_600_000 }, async () => {
    const shapeName = process.env.ORCA_RETENTION_BENCH!
    const shape = SHAPES[shapeName]!
    const incremental = process.env.ORCA_RETENTION_BENCH_AUTOVACUUM === 'incremental'
    const dir = mkdtempSync(join(tmpdir(), 'orch-retention-'))
    const path = join(dir, 'orchestration.db')
    const db = new OrchestrationDb(path)
    const out: Record<string, unknown> = { shape: shapeName, incremental }
    try {
      const started = performance.now()
      const runIds: string[] = []
      for (let i = 0; i < shape.baseRuns; i++) {
        const id = createRun(db, shape, 'base')
        if (i >= shape.abandonedRuns) {
          settle(db, id)
        }
        runIds.push(id)
      }
      spreadAges(db, runIds, shape.baseSpreadHours)
      const liveRuns = new Set(runIds.filter((_, i) => i % shape.liveCoordinatorEvery === 1))
      const liveHandles = new Set(
        [...liveRuns].map((id) => String(db.getRun(id)?.coordinator_handle))
      )
      if (!incremental) {
        // Existing profiles predate incremental auto-vacuum.
        db.db.exec('PRAGMA auto_vacuum = NONE; VACUUM')
      } else {
        db.db.exec('PRAGMA auto_vacuum = INCREMENTAL; VACUUM')
      }
      if (process.env.ORCA_RETENTION_BENCH_INDEX) {
        // First open after upgrade builds the retention indexes on the existing tables.
        const indexes = [
          'idx_question_threads_run ON question_threads(run_id)',
          'idx_worker_terminal_resources_origin ON worker_terminal_resources(origin_dispatch_id)',
          'idx_attempt_observation_facts_task ON attempt_observation_facts(task_id)',
          'idx_message_dispatch_provenance_dispatch ON message_dispatch_provenance(dispatch_id)',
          'idx_remote_run_links_run ON remote_run_links(run_id)',
          'idx_remote_placements_run ON remote_placements(run_id)'
        ]
        for (const index of indexes) {
          db.db.exec(`DROP INDEX IF EXISTS ${index.split(' ')[0]}`)
        }
        const t = performance.now()
        for (const index of indexes) {
          db.db.exec(`CREATE INDEX IF NOT EXISTS ${index}`)
        }
        out.indexCreateMs = +(performance.now() - t).toFixed(1)
      }
      out.setupSeconds = +((performance.now() - started) / 1000).toFixed(1)
      out.base = sizes(db, path)

      const maintenance = new (OrchestrationDbMaintenance as unknown as new (
        ...args: unknown[]
      ) => { pass(): Promise<void>; slice: unknown })(db, () => true, {
        isLiveHandle: (handle: string) => liveHandles.has(handle),
        isLivePane: () => false
      })
      let steps: number[] = []
      // No pacing rest, so the day runs fast; each step still blocks the thread for exactly as long.
      maintenance.slice = async <T>(step: () => T): Promise<T> => {
        await yieldImmediate()
        const t = performance.now()
        const result = step()
        steps.push(performance.now() - t)
        return result
      }
      const ticks: unknown[] = []
      const allSteps: number[] = []
      const passBusy: number[] = []
      let loopMax = 0
      for (let hour = 1; hour <= 24; hour++) {
        passTime(db, 1)
        for (let r = 0; r < shape.runsPerHour; r++) {
          settle(db, createRun(db, shape, 'day'))
        }
        db.db.exec('DELETE FROM orchestration_maintenance')
        steps = []
        const histogram = monitorEventLoopDelay({ resolution: 1 })
        histogram.enable()
        const wall = performance.now()
        await maintenance.pass()
        const wallMs = performance.now() - wall
        histogram.disable()
        const busy = steps.reduce((a, b) => a + b, 0)
        allSteps.push(...steps)
        passBusy.push(busy)
        loopMax = Math.max(loopMax, histogram.max / 1e6)
        ticks.push({
          hour,
          ...sizes(db, path),
          passBusyMs: +busy.toFixed(1),
          passWallMs: +wallMs.toFixed(1),
          steps: steps.length,
          stepMaxMs: pct(steps, 100),
          loopDelayMaxMs: +(histogram.max / 1e6).toFixed(1)
        })
      }
      out.ticks = ticks
      out.summary = {
        passBusyMs: { p50: pct(passBusy, 50), p95: pct(passBusy, 95), max: pct(passBusy, 100) },
        stepMs: {
          count: allSteps.length,
          p50: pct(allSteps, 50),
          p95: pct(allSteps, 95),
          max: pct(allSteps, 100)
        },
        eventLoopDelayMaxMs: +loopMax.toFixed(1),
        // Production rests nine times each 25 ms of work, so wall time is about ten times busy time.
        pacedWallEstimateFirstPassS: +((passBusy[0]! * 10) / 1000).toFixed(1)
      }
      out.final = sizes(db, path)
    } finally {
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
    const json = JSON.stringify(out)
    writeFileSync(process.env.ORCA_RETENTION_BENCH_OUT ?? '/tmp/retention-bench.json', json)
  })
})
