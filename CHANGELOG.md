# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-02-10

### Fixed
- README doc links now use absolute GitHub URLs so they work on npmjs.com

## [0.1.0] - 2026-02-10

### Added

- **Core SDK** — Node.js wrapper around the Rust duroxide runtime via napi-rs
  - Generator-based orchestrations (`function*` + `yield`) for deterministic replay
  - Async activities (`async function` + `await`) for side effects
  - Structured tracing delegated to Rust (auto-suppressed during replay)

- **Orchestration Context API**
  - `scheduleActivity()`, `scheduleActivityWithRetry()` — activity scheduling with optional retry policies
  - `scheduleTimer()` — durable delays that survive restarts
  - `waitForEvent()` — pause for external signals
  - `scheduleSubOrchestration()`, `scheduleSubOrchestrationWithId()` — child workflows
  - `startOrchestration()` — fire-and-forget orchestration launches
  - `all()` — parallel fan-out/fan-in supporting all task types (activities, timers, waits, sub-orchestrations)
  - `race()` — first-to-complete between 2 tasks, supporting all task types
  - `utcNow()`, `newGuid()` — deterministic values for replay safety
  - `continueAsNew()` — restart orchestrations with fresh history
  - Nested `all()`/`race()` rejection with clear error messages

- **Activity Context API**
  - `isCancelled()` — cooperative cancellation (detects when orchestration no longer needs the result)
  - `traceInfo()`, `traceWarn()`, `traceError()`, `traceDebug()` — structured tracing with full metadata
  - Context fields: `instanceId`, `executionId`, `orchestrationName`, `activityName`, `workerId`

- **Runtime Options**
  - `orchestrationConcurrency`, `workerConcurrency`, `dispatcherPollInterval`
  - `workerLockTimeoutMs` — controls activity cancellation detection latency
  - `observability` — log level, service name, gauge polling interval

- **Client API**
  - `startOrchestration()`, `startOrchestrationVersioned()` — launch workflows
  - `waitForOrchestration()` — poll until completion with timeout
  - `raiseEvent()` — send external events to waiting orchestrations
  - `cancelInstance()` — cancel running orchestrations
  - `getOrchestrationStatus()` — query status without waiting
  - `deleteInstance()` — remove completed instances
  - `getSystemMetrics()`, `getQueueDepths()` — observability
  - `listAllInstances()` — admin listing

- **Storage Providers**
  - SQLite (`SqliteProvider`) — file-backed or in-memory, good for development/testing
  - PostgreSQL (`PostgresProvider`) — production multi-node deployments with schema isolation

- **Versioning** — `registerOrchestrationVersioned()` for safe rolling upgrades

- **50 tests** across 4 test suites
  - `e2e.test.js` — 23 PostgreSQL e2e tests + 1 SQLite smoketest
  - `races.test.js` — 7 tests for `ctx.all()` and `ctx.race()` with mixed task types + cooperative cancellation
  - `admin_api.test.js` — 14 admin/management API tests
  - `scenarios/toygres-node.test.js` — 6 scenario tests modeling real-world patterns
