# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.15] - 2026-03-13

- **KV store support:** Durable key-value store for per-instance state
  - `OrchestrationContext`: `setValue()`, `getValue()`, `clearValue()`, `clearAllValues()`
  - `Client`: `getValue()`, `waitForValue()`
  - Constants: `MAX_KV_KEYS`, `MAX_KV_VALUE_BYTES`
- Added KV e2e tests (`kv_store.test.js`)
- Bumped duroxide to 0.1.24, duroxide-pg to 0.1.25

## [0.1.14] - 2026-03-08

### Added
- 5 new e2e tests: heterogeneous workers pipeline, starvation-safe tagged activity fallback, dual runtime tag cooperation, nested error handling propagation, error recovery with logging.
- `MAX_WORKER_TAGS` (5) and `MAX_TAG_NAME_BYTES` (256) constants exported.

### Changed
- Bumped `duroxide` core from 0.1.22 to 0.1.23 (activity tag ack validation test).
- Bumped `duroxide-pg` from local path to published 0.1.24 (tag routing + migration fixes).

## [0.1.10] - 2026-02-28

### Added
- Typed APIs parity pass: typed scheduling/wait/event/dequeue variants and typed-path tests.
- Async block and advanced-feature parity suites integrated into default test scripts.

### Changed
- Unified schedule/whenAll/whenAny terminology across docs and examples.
- Refactored .NET/Java parity alignment and cross-SDK test consistency.


## [0.1.9] - 2026-02-21

### Added
- **`getCustomStatus()`** — read the current custom status value from within an orchestration. Returns the status string or `null` if none has been set. Reflects all `setCustomStatus`/`resetCustomStatus` calls, including across turn boundaries and continue-as-new.

### Changed
- Upgraded duroxide to 0.1.20, duroxide-pg to 0.1.22

## [0.1.7] - 2026-02-20

### Added
- **Custom Status API**: `ctx.setCustomStatus(status)` and `ctx.resetCustomStatus()` — set/clear custom status from orchestrations (fire-and-forget, no yield needed)
- **Custom Status on OrchestrationStatus**: `customStatus` and `customStatusVersion` fields on status objects returned by `getStatus()`, `waitForOrchestration()`, etc.
- **Custom Status Polling**: `client.waitForStatusChange(instanceId, lastSeenVersion, pollIntervalMs, timeoutMs)` — poll for custom status changes
- **Event Queue API (Context)**: `ctx.dequeueEvent(queueName)` — dequeue from a named FIFO mailbox (survives continue-as-new)
- **Event Queue API (Client)**: `client.enqueueEvent(instanceId, queueName, data)` — enqueue to an instance's event queue
- **Retry with Session**: `ctx.scheduleActivityWithRetryOnSession(name, input, retry, sessionId)` — retry with session affinity
- `scheduleActivityWithRetry` now respects `sessionId` when present
- EventKind support for `QueueSubscribed`, `QueueEventDelivered`, `QueueSubscriptionCancelled`

### Changed
- Upgraded duroxide to 0.1.19, duroxide-pg to 0.1.21

### Deprecated
- `client.raiseEvent()` for persistent messaging — use `client.enqueueEvent()` instead
- `ctx.waitForEvent()` for persistent subscriptions — use `ctx.dequeueEvent()` instead

## [0.1.5] - 2026-02-13

### Added
- `initTracing({ logFile, logLevel?, logFormat? })` — install a file-based tracing subscriber before `runtime.start()`. Uses first-writer-wins (`try_init`) so the runtime's built-in subscriber silently no-ops if one is already installed. Supports `"json"`, `"pretty"`, and `"compact"` (default) log formats.
- 3 new tests for `initTracing`: export check, file write, invalid path error

## [0.1.3] - 2026-02-12

### Added
- `data` field on history events (`readExecutionHistory`) — exposes activity results, inputs, errors, timer fire times, and all event-specific content as JSON strings
- Management API section in README with usage examples
- New test: `includes data field with event-specific content`

## [0.1.2] - 2026-02-10

### Added
- `ctx.getClient()` on ActivityContext — activities can now start orchestrations, raise events, etc.
- `runtime.metricsSnapshot()` — get runtime metric counters (orchestration starts/completions, activity results, provider errors)
- Observability options on RuntimeOptions: `logLevel`, `logFormat`, `serviceName`, `serviceVersion`
- 2 new e2e tests: activity getClient, metrics snapshot

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
