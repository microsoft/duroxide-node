/**
 * TypeScript declarations for duroxide Node.js SDK public API.
 */

import {
  JsRuntimeOptions,
  JsOrchestrationStatus,
  JsSystemMetrics,
  JsQueueDepths,
  JsInstanceInfo,
  JsExecutionInfo,
  JsInstanceTree,
  JsDeleteInstanceResult,
  JsPruneOptions,
  JsPruneResult,
  JsInstanceFilter,
  JsMetricsSnapshot,
  JsEvent,
  JsTracingOptions,
} from '../index';

/** A scheduled task descriptor yielded from an orchestration generator. */
export interface ScheduledTask {
  type: string;
  [key: string]: unknown;
}

/** Result item from ctx.all() / ctx.allTyped(). */
export interface JoinResult<T = unknown> {
  ok?: T;
  err?: unknown;
}

/** Result from ctx.race() / ctx.raceTyped(). */
export interface RaceResult<T = unknown> {
  index: number;
  value: T;
}

/** Retry policy for activities. */
export interface RetryPolicy {
  maxAttempts: number;
  timeoutMs: number;
  totalTimeoutMs?: number;
  backoff?: number;
}

/** Context object passed to orchestration generator functions. */
export declare class OrchestrationContext {
  readonly instanceId: string;
  readonly executionId: string;
  readonly orchestrationName: string;
  readonly orchestrationVersion: string | null;

  // ─── Scheduling (yield these) ──────────────────────────

  scheduleActivity(name: string, input?: unknown, options?: { sessionId?: string }): ScheduledTask;
  scheduleActivityOnSession(name: string, input: unknown, sessionId: string): ScheduledTask;
  scheduleActivityWithRetry(name: string, input: unknown, retry: RetryPolicy): ScheduledTask;
  scheduleActivityWithRetryOnSession(name: string, input: unknown, retry: RetryPolicy, sessionId: string): ScheduledTask;
  scheduleTimer(delayMs: number): ScheduledTask;
  waitForEvent(name: string): ScheduledTask;
  dequeueEvent(queueName: string): ScheduledTask;
  scheduleSubOrchestration(name: string, input?: unknown): ScheduledTask;
  scheduleSubOrchestrationWithId(name: string, instanceId: string, input?: unknown): ScheduledTask;
  scheduleSubOrchestrationVersioned(name: string, version: string, input?: unknown): ScheduledTask;
  scheduleSubOrchestrationVersionedWithId(name: string, version: string, instanceId: string, input?: unknown): ScheduledTask;
  startOrchestration(name: string, instanceId: string, input?: unknown): ScheduledTask;
  startOrchestrationVersioned(name: string, version: string, instanceId: string, input?: unknown): ScheduledTask;
  newGuid(): ScheduledTask;
  utcNow(): ScheduledTask;
  continueAsNew(input?: unknown): ScheduledTask;
  continueAsNewVersioned(input: unknown, version: string): ScheduledTask;

  // ─── Composition helpers ───────────────────────────────

  all(tasks: ScheduledTask[]): ScheduledTask;
  race(...tasks: ScheduledTask[]): ScheduledTask;

  // ─── Typed variants (auto-parse JSON results) ─────────

  /**
   * Schedule an activity with auto-parsed results.
   * Input is auto-serialized; the result is auto-parsed from JSON on completion.
   */
  scheduleActivityTyped<TResult = unknown>(name: string, input?: unknown): ScheduledTask;

  /**
   * Schedule a sub-orchestration with auto-parsed results.
   * Input is auto-serialized; the result is auto-parsed from JSON on completion.
   */
  scheduleSubOrchestrationTyped<TResult = unknown>(name: string, input?: unknown): ScheduledTask;

  /**
   * Schedule an activity on a session with auto-parsed results.
   */
  scheduleActivityOnSessionTyped<TResult = unknown>(name: string, input: unknown, sessionId: string): ScheduledTask;

  /**
   * Schedule an activity with retry and auto-parsed results.
   */
  scheduleActivityWithRetryTyped<TResult = unknown>(name: string, input: unknown, retry: RetryPolicy): ScheduledTask;

  /**
   * Schedule an activity with retry on a session with auto-parsed results.
   */
  scheduleActivityWithRetryOnSessionTyped<TResult = unknown>(name: string, input: unknown, retry: RetryPolicy, sessionId: string): ScheduledTask;

  /**
   * Wait for an external event with auto-parsed result.
   */
  waitForEventTyped<TResult = unknown>(name: string): ScheduledTask;

  /**
   * Dequeue an event with auto-parsed result.
   */
  dequeueEventTyped<TResult = unknown>(queueName: string): ScheduledTask;

  /**
   * Schedule a sub-orchestration with explicit ID and auto-parsed result.
   */
  scheduleSubOrchestrationWithIdTyped<TResult = unknown>(name: string, instanceId: string, input?: unknown): ScheduledTask;

  /**
   * Start a detached orchestration with auto-serialized input.
   */
  startOrchestrationTyped(name: string, instanceId: string, input?: unknown): ScheduledTask;

  /**
   * Start a detached versioned orchestration with auto-serialized input.
   */
  startOrchestrationVersionedTyped(name: string, version: string, instanceId: string, input?: unknown): ScheduledTask;

  /**
   * Continue as new with auto-serialized input.
   */
  continueAsNewTyped(input?: unknown): ScheduledTask;

  /**
   * Join multiple tasks with auto-parsed results.
   * Each result's ok/err value is auto-parsed from JSON.
   */
  allTyped<TResult = unknown>(tasks: ScheduledTask[]): ScheduledTask;

  /**
   * Race multiple tasks with auto-parsed winner value.
   * The winning value is auto-parsed from JSON.
   */
  raceTyped<TResult = unknown>(...tasks: ScheduledTask[]): ScheduledTask;

  // ─── Custom Status ─────────────────────────────────────

  setCustomStatus(status: string): void;
  resetCustomStatus(): void;
  getCustomStatus(): string | null;

  // ─── Logging ───────────────────────────────────────────

  traceInfo(message: string): void;
  traceWarn(message: string): void;
  traceError(message: string): void;
  traceDebug(message: string): void;
}

/** Context for activity execution. */
export declare class ActivityContext {
  readonly instanceId: string;
  readonly executionId: string;
  readonly orchestrationName: string;
  readonly orchestrationVersion: string | null;
  readonly activityName: string;
  readonly workerId: string;
  readonly sessionId: string | null;

  traceInfo(message: string): void;
  traceWarn(message: string): void;
  traceError(message: string): void;
  traceDebug(message: string): void;
  isCancelled(): boolean;
  getClient(): Client | null;
}

/** SQLite provider for duroxide. */
export declare class SqliteProvider {
  static open(path: string): Promise<SqliteProvider>;
  static inMemory(): Promise<SqliteProvider>;
}

/** PostgreSQL provider for duroxide. */
export declare class PostgresProvider {
  static connect(databaseUrl: string): Promise<PostgresProvider>;
  static connectWithSchema(databaseUrl: string, schema: string): Promise<PostgresProvider>;
}

/** Client for starting and managing orchestration instances. */
export declare class Client {
  constructor(provider: SqliteProvider | PostgresProvider);

  startOrchestration(instanceId: string, orchestrationName: string, input?: unknown): Promise<void>;
  startOrchestrationVersioned(instanceId: string, orchestrationName: string, input: unknown, version: string): Promise<void>;
  getStatus(instanceId: string): Promise<JsOrchestrationStatus>;
  waitForOrchestration(instanceId: string, timeoutMs?: number): Promise<JsOrchestrationStatus>;
  cancelInstance(instanceId: string, reason?: string): Promise<void>;
  raiseEvent(instanceId: string, eventName: string, data?: unknown): Promise<void>;
  enqueueEvent(instanceId: string, queueName: string, data?: unknown): Promise<void>;
  waitForStatusChange(instanceId: string, lastSeenVersion: number, pollIntervalMs?: number, timeoutMs?: number): Promise<JsOrchestrationStatus>;
  getSystemMetrics(): Promise<JsSystemMetrics>;
  getQueueDepths(): Promise<JsQueueDepths>;

  // ─── Management / Admin API ─────────────────────────────

  listAllInstances(): Promise<string[]>;
  listInstancesByStatus(status: string): Promise<string[]>;
  getInstanceInfo(instanceId: string): Promise<JsInstanceInfo>;
  getExecutionInfo(instanceId: string, executionId: number): Promise<JsExecutionInfo>;
  listExecutions(instanceId: string): Promise<number[]>;
  readExecutionHistory(instanceId: string, executionId: number): Promise<JsEvent[]>;
  getInstanceTree(instanceId: string): Promise<JsInstanceTree>;
  deleteInstance(instanceId: string, force?: boolean): Promise<JsDeleteInstanceResult>;
  deleteInstanceBulk(filter?: JsInstanceFilter): Promise<JsDeleteInstanceResult>;
  pruneExecutions(instanceId: string, options?: JsPruneOptions): Promise<JsPruneResult>;
  pruneExecutionsBulk(filter?: JsInstanceFilter, options?: JsPruneOptions): Promise<JsPruneResult>;

  // ─── Typed convenience methods ─────────────────────────

  startOrchestrationTyped(instanceId: string, orchestrationName: string, input?: unknown): Promise<void>;
  startOrchestrationVersionedTyped(instanceId: string, orchestrationName: string, input: unknown, version: string): Promise<void>;
  raiseEventTyped(instanceId: string, eventName: string, data?: unknown): Promise<void>;
  enqueueEventTyped(instanceId: string, queueName: string, data?: unknown): Promise<void>;
  waitForOrchestrationTyped<TResult = unknown>(instanceId: string, timeoutMs?: number): Promise<TResult>;
}

/** Durable execution runtime. */
export declare class Runtime {
  constructor(provider: SqliteProvider | PostgresProvider, options?: JsRuntimeOptions);

  registerActivity(name: string, fn: (ctx: ActivityContext, input: any) => Promise<any>): void;
  registerActivityTyped<TIn, TOut>(name: string, fn: (ctx: ActivityContext, input: TIn) => Promise<TOut>): void;
  registerOrchestration(name: string, fn: (ctx: OrchestrationContext, input: any) => Generator): void;
  registerOrchestrationTyped<TIn>(name: string, fn: (ctx: OrchestrationContext, input: TIn) => Generator): void;
  registerOrchestrationVersioned(name: string, version: string, fn: (ctx: OrchestrationContext, input: any) => Generator): void;
  registerOrchestrationVersionedTyped<TIn>(name: string, version: string, fn: (ctx: OrchestrationContext, input: TIn) => Generator): void;
  start(): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
  metricsSnapshot(): JsMetricsSnapshot | null;
}

/** Install a tracing subscriber that writes to a file. */
export declare function initTracing(options: JsTracingOptions): void;
