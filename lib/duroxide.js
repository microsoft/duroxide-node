/**
 * duroxide - Node.js SDK for the Duroxide durable execution runtime.
 *
 * Generator-based orchestrations: users write function*(ctx, input) { ... }
 * and yield ScheduledTask descriptors. The Rust runtime handles DurableFutures.
 */

// Load native bindings from the auto-generated napi-rs loader
const { JsSqliteProvider, JsPostgresProvider, JsClient, JsRuntime, activityTraceLog, orchestrationTraceLog, activityIsCancelled, activityGetClient, orchestrationSetCustomStatus, orchestrationResetCustomStatus, orchestrationGetCustomStatus, initTracing } = require('../index.js');

// ─── Generator Driver ────────────────────────────────────────────

/** @type {Map<number, Generator>} */
const generators = new Map();
/** @type {Map<number, string>} Tracks the task type of the last yielded _typed task per generator */
const generatorTypedState = new Map();
let nextGeneratorId = 1;

/**
 * Registered orchestration functions keyed by name.
 * @type {Map<string, GeneratorFunction>}
 */
const orchestrationFunctions = new Map();

/**
 * Called from Rust via ThreadsafeFunction when starting a new orchestration.
 * Creates a generator, drives it to the first yield, and returns the result.
 *
 * @param {string} payloadJson - JSON: { ctxInfo, input }
 * @returns {string} JSON: GeneratorStepResult
 */
function createGenerator(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson);
    const { ctxInfo, input } = payload;

    // Find the orchestration function by name@version, falling back to name
    const orchName = ctxInfo.orchestrationName;
    const orchVersion = ctxInfo.orchestrationVersion;
    const versionedKey = orchVersion ? `${orchName}@${orchVersion}` : null;
    const fn = (versionedKey && orchestrationFunctions.get(versionedKey)) || orchestrationFunctions.get(orchName);
    if (!fn) {
      const err = JSON.stringify({
        status: 'error',
        message: `Orchestration '${orchName}' not registered on JS side`,
      });
      return err;
    }

    // Create the orchestration context wrapper
    const ctx = new OrchestrationContext(ctxInfo);

    // Create the generator
    const gen = fn(ctx, input ? JSON.parse(input) : undefined);

    // Assign an ID and store
    const id = nextGeneratorId++;
    generators.set(id, gen);

    // Drive to first yield
    return driveStep(id, gen, undefined);
  } catch (e) {
    return JSON.stringify({
      status: 'error',
      message: String(e.stack || e),
    });
  }
}

/**
 * Called from Rust via ThreadsafeFunction to feed a result and get the next step.
 *
 * @param {string} payloadJson - JSON: { generatorId, result, isError }
 * @returns {string} JSON: GeneratorStepResult
 */
function nextStep(payloadJson) {
  try {
    const { generatorId, result, isError } = JSON.parse(payloadJson);

    const gen = generators.get(generatorId);
    if (!gen) {
      return JSON.stringify({
        status: 'error',
        message: `Generator ${generatorId} not found`,
      });
    }

    // Parse the result from Rust
    let value;
    try {
      value = JSON.parse(result);
    } catch {
      value = result;
    }

    // Apply typed post-processing if the last yielded task was _typed
    const typedTaskType = generatorTypedState.get(generatorId);
    if (typedTaskType && !isError) {
      value = applyTypedParsing(value, typedTaskType);
    }

    if (isError) {
      return driveStepWithError(generatorId, gen, value);
    }

    return driveStep(generatorId, gen, value);
  } catch (e) {
    return JSON.stringify({
      status: 'error',
      message: String(e.stack || e),
    });
  }
}

/**
 * Called from Rust to clean up a generator.
 *
 * @param {string} idStr - Generator ID as string
 * @returns {string} "ok"
 */
function disposeGenerator(idStr) {
  const id = parseInt(idStr, 10);
  generators.delete(id);
  generatorTypedState.delete(id);
  return 'ok';
}

/**
 * Try to JSON.parse a value if it's a string; return as-is otherwise.
 */
function tryJsonParse(v) {
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return v; }
  }
  return v;
}

/**
 * Post-process a result value for typed tasks.
 * For activity/subOrchestration: parse the result if it's a JSON string.
 * For join (allTyped): parse each ok/err value.
 * For select (raceTyped): parse the winner value.
 */
function applyTypedParsing(value, taskType) {
  if (taskType === 'activity' || taskType === 'activityWithRetry' || taskType === 'subOrchestration'
      || taskType === 'subOrchestrationWithId' || taskType === 'subOrchestrationVersioned'
      || taskType === 'subOrchestrationVersionedWithId') {
    return tryJsonParse(value);
  }
  if (taskType === 'join' && Array.isArray(value)) {
    return value.map((r) => {
      if (r && typeof r === 'object') {
        if ('ok' in r) return { ...r, ok: tryJsonParse(r.ok) };
        if ('err' in r) return { ...r, err: tryJsonParse(r.err) };
      }
      return r;
    });
  }
  if (taskType === 'select' && value && typeof value === 'object') {
    return { ...value, value: tryJsonParse(value.value) };
  }
  return value;
}

/**
 * Drive a generator one step forward with a value.
 * @returns {string} JSON GeneratorStepResult
 */
function driveStep(generatorId, gen, value) {
  try {
    const { value: task, done } = gen.next(value);

    if (done) {
      generators.delete(generatorId);
      generatorTypedState.delete(generatorId);
      return JSON.stringify({
        status: 'completed',
        output: JSON.stringify(task === undefined ? null : task),
      });
    }

    // Track typed state for post-processing the next result
    if (task && task._typed) {
      generatorTypedState.set(generatorId, task.type);
    } else {
      generatorTypedState.delete(generatorId);
    }

    // task should be a ScheduledTask descriptor
    return JSON.stringify({
      status: 'yielded',
      generatorId,
      task,
    });
  } catch (e) {
    generators.delete(generatorId);
    generatorTypedState.delete(generatorId);
    return JSON.stringify({
      status: 'error',
      message: String(e.stack || e),
    });
  }
}

/**
 * Drive a generator by throwing an error into it.
 * @returns {string} JSON GeneratorStepResult
 */
function driveStepWithError(generatorId, gen, error) {
  try {
    const { value: task, done } = gen.throw(
      new Error(typeof error === 'string' ? error : JSON.stringify(error))
    );

    if (done) {
      generators.delete(generatorId);
      generatorTypedState.delete(generatorId);
      return JSON.stringify({
        status: 'completed',
        output: JSON.stringify(task === undefined ? null : task),
      });
    }

    // Track typed state for post-processing the next result
    if (task && task._typed) {
      generatorTypedState.set(generatorId, task.type);
    } else {
      generatorTypedState.delete(generatorId);
    }

    return JSON.stringify({
      status: 'yielded',
      generatorId,
      task,
    });
  } catch (e) {
    generators.delete(generatorId);
    generatorTypedState.delete(generatorId);
    return JSON.stringify({
      status: 'error',
      message: String(e.stack || e),
    });
  }
}

// ─── OrchestrationContext ────────────────────────────────────────

/**
 * Context object passed to orchestration generator functions.
 * Methods that schedule work return ScheduledTask descriptors to be yielded.
 * Logging methods are fire-and-forget (no yield needed).
 */
class OrchestrationContext {
  constructor(ctxInfo) {
    this.instanceId = ctxInfo.instanceId;
    this.executionId = ctxInfo.executionId;
    this.orchestrationName = ctxInfo.orchestrationName;
    this.orchestrationVersion = ctxInfo.orchestrationVersion;
  }

  // ─── Scheduling (yield these) ──────────────────────────

  /**
   * Schedule an activity. Yield the return value.
   * @param {string} name - Activity name
   * @param {*} input - Activity input (will be JSON-serialized)
   * @returns {ScheduledTask}
   */
  scheduleActivity(name, input, options) {
    const descriptor = {
      type: 'activity',
      name,
      input: JSON.stringify(input === undefined ? null : input),
    };
    if (options && options.sessionId) {
      descriptor.sessionId = options.sessionId;
    }
    return descriptor;
  }

  /**
   * Schedule an activity routed to a specific session. Yield the return value.
   * Activities with the same sessionId are routed to the same worker.
   * @param {string} name - Activity name
   * @param {*} input - Activity input (will be JSON-serialized)
   * @param {string} sessionId - Session identifier for worker affinity
   * @returns {ScheduledTask}
   */
  scheduleActivityOnSession(name, input, sessionId) {
    return {
      type: 'activity',
      name,
      input: JSON.stringify(input === undefined ? null : input),
      sessionId,
    };
  }

  /**
   * Schedule an activity with retry policy. Yield the return value.
   */
  scheduleActivityWithRetry(name, input, retry) {
    return {
      type: 'activityWithRetry',
      name,
      input: JSON.stringify(input === undefined ? null : input),
      retry: {
        maxAttempts: retry.maxAttempts,
        timeoutMs: retry.timeoutMs,
        totalTimeoutMs: retry.totalTimeoutMs,
        backoff: retry.backoff,
      },
    };
  }

  /**
   * Schedule an activity with retry policy on a specific session. Yield the return value.
   * Combines retry semantics with session affinity routing.
   * @param {string} name - Activity name
   * @param {*} input - Activity input
   * @param {object} retry - Retry policy
   * @param {string} sessionId - Session identifier for worker affinity
   * @returns {ScheduledTask}
   */
  scheduleActivityWithRetryOnSession(name, input, retry, sessionId) {
    return {
      type: 'activityWithRetry',
      name,
      input: JSON.stringify(input === undefined ? null : input),
      retry: {
        maxAttempts: retry.maxAttempts,
        timeoutMs: retry.timeoutMs,
        totalTimeoutMs: retry.totalTimeoutMs,
        backoff: retry.backoff,
      },
      sessionId,
    };
  }

  /**
   * Schedule a timer (delay in milliseconds). Yield the return value.
   * @param {number} delayMs
   * @returns {ScheduledTask}
   */
  scheduleTimer(delayMs) {
    return { type: 'timer', delayMs };
  }

  /**
   * Wait for an external event. Yield the return value.
   * @param {string} name - Event name
   * @returns {ScheduledTask}
   */
  waitForEvent(name) {
    return { type: 'waitEvent', name };
  }

  /**
   * Dequeue an event from a named queue (FIFO mailbox). Yield the return value.
   * Messages survive continue-as-new boundaries. Use with client.enqueueEvent().
   * @param {string} queueName - Queue name
   * @returns {ScheduledTask}
   */
  dequeueEvent(queueName) {
    return { type: 'dequeueEvent', queueName };
  }

  /**
   * Schedule a sub-orchestration. Yield the return value.
   * @param {string} name - Orchestration name
   * @param {*} input
   * @returns {ScheduledTask}
   */
  scheduleSubOrchestration(name, input) {
    return {
      type: 'subOrchestration',
      name,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Schedule a sub-orchestration with a specific instance ID.
   */
  scheduleSubOrchestrationWithId(name, instanceId, input) {
    return {
      type: 'subOrchestrationWithId',
      name,
      instanceId,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Schedule a versioned sub-orchestration. Yield the return value.
   */
  scheduleSubOrchestrationVersioned(name, version, input) {
    return {
      type: 'subOrchestrationVersioned',
      name,
      version: version || null,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Schedule a versioned sub-orchestration with a specific instance ID. Yield the return value.
   */
  scheduleSubOrchestrationVersionedWithId(name, version, instanceId, input) {
    return {
      type: 'subOrchestrationVersionedWithId',
      name,
      version: version || null,
      instanceId,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Start a detached orchestration (fire-and-forget). Yield the return value.
   * Unlike scheduleSubOrchestration, this does NOT wait for completion.
   * @param {string} name - Orchestration name
   * @param {string} instanceId - Instance ID for the new orchestration
   * @param {*} input
   * @returns {ScheduledTask}
   */
  startOrchestration(name, instanceId, input) {
    return {
      type: 'orchestration',
      name,
      instanceId,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Start a versioned detached orchestration (fire-and-forget). Yield the return value.
   */
  startOrchestrationVersioned(name, version, instanceId, input) {
    return {
      type: 'orchestrationVersioned',
      name,
      version: version || null,
      instanceId,
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Get a deterministic GUID. Yield the return value.
   * @returns {ScheduledTask}
   */
  newGuid() {
    return { type: 'newGuid' };
  }

  /**
   * Get the current deterministic UTC time. Yield the return value.
   * Returns a timestamp in milliseconds.
   * @returns {ScheduledTask}
   */
  utcNow() {
    return { type: 'utcNow' };
  }

  /**
   * Continue the orchestration as a new instance with new input.
   * @param {*} input
   * @returns {ScheduledTask}
   */
  continueAsNew(input) {
    return {
      type: 'continueAsNew',
      input: JSON.stringify(input === undefined ? null : input),
    };
  }

  /**
   * Continue the orchestration as a new instance with new input and a specific version.
   */
  continueAsNewVersioned(input, version) {
    return {
      type: 'continueAsNewVersioned',
      input: JSON.stringify(input === undefined ? null : input),
      version: version || null,
    };
  }

  // ─── Composition helpers ───────────────────────────────

  /**
   * Join multiple tasks (wait for all). Yield the return value.
   * @param {ScheduledTask[]} tasks - Array of scheduled task descriptors
   * @returns {ScheduledTask}
   */
  all(tasks) {
    return { type: 'join', tasks };
  }

  /**
   * Select/race multiple tasks (wait for first). Yield the return value.
   * @param  {...ScheduledTask} tasks
   * @returns {ScheduledTask}
   */
  race(...tasks) {
    return { type: 'select', tasks };
  }

  // ─── Typed variants (auto-parse JSON results) ─────────

  /**
   * Schedule an activity with auto-parsed results. Yield the return value.
   * Input objects are auto-serialized; the result is auto-parsed from JSON.
   * @param {string} name - Activity name
   * @param {*} input - Activity input
   * @returns {ScheduledTask}
   */
  scheduleActivityTyped(name, input) {
    const task = this.scheduleActivity(name, input);
    task._typed = true;
    return task;
  }

  /**
   * Schedule a sub-orchestration with auto-parsed results. Yield the return value.
   * Input objects are auto-serialized; the result is auto-parsed from JSON.
   * @param {string} name - Orchestration name
   * @param {*} input
   * @returns {ScheduledTask}
   */
  scheduleSubOrchestrationTyped(name, input) {
    const task = this.scheduleSubOrchestration(name, input);
    task._typed = true;
    return task;
  }

  /**
   * Join multiple tasks with auto-parsed results. Yield the return value.
   * Each result's ok/err value is auto-parsed from JSON.
   * @param {ScheduledTask[]} tasks - Array of scheduled task descriptors
   * @returns {ScheduledTask}
   */
  allTyped(tasks) {
    return { type: 'join', tasks, _typed: true };
  }

  /**
   * Race multiple tasks with auto-parsed winner value. Yield the return value.
   * The winning value is auto-parsed from JSON.
   * @param  {...ScheduledTask} tasks
   * @returns {ScheduledTask}
   */
  raceTyped(...tasks) {
    return { type: 'select', tasks, _typed: true };
  }

  /**
   * Schedule an activity on a session with auto-parsed results. Yield the return value.
   * @param {string} name - Activity name
   * @param {*} input - Activity input
   * @param {string} sessionId - Session identifier for worker affinity
   * @returns {ScheduledTask}
   */
  scheduleActivityOnSessionTyped(name, input, sessionId) {
    const task = this.scheduleActivityOnSession(name, input, sessionId);
    task._typed = true;
    return task;
  }

  /**
   * Schedule an activity with retry policy and auto-parsed results. Yield the return value.
   * @param {string} name - Activity name
   * @param {*} input - Activity input
   * @param {object} retry - Retry policy
   * @returns {ScheduledTask}
   */
  scheduleActivityWithRetryTyped(name, input, retry) {
    const task = this.scheduleActivityWithRetry(name, input, retry);
    task._typed = true;
    return task;
  }

  /**
   * Schedule an activity with retry on a session with auto-parsed results. Yield the return value.
   * @param {string} name - Activity name
   * @param {*} input - Activity input
   * @param {object} retry - Retry policy
   * @param {string} sessionId - Session identifier for worker affinity
   * @returns {ScheduledTask}
   */
  scheduleActivityWithRetryOnSessionTyped(name, input, retry, sessionId) {
    const task = this.scheduleActivityWithRetryOnSession(name, input, retry, sessionId);
    task._typed = true;
    return task;
  }

  /**
   * Wait for an external event with auto-parsed result. Yield the return value.
   * @param {string} name - Event name
   * @returns {ScheduledTask}
   */
  waitForEventTyped(name) {
    const task = this.waitForEvent(name);
    task._typed = true;
    return task;
  }

  /**
   * Dequeue an event from a named queue with auto-parsed result. Yield the return value.
   * @param {string} queueName - Queue name
   * @returns {ScheduledTask}
   */
  dequeueEventTyped(queueName) {
    const task = this.dequeueEvent(queueName);
    task._typed = true;
    return task;
  }

  /**
   * Schedule a sub-orchestration with explicit ID and auto-parsed results. Yield the return value.
   * @param {string} name - Orchestration name
   * @param {string} instanceId - Instance ID
   * @param {*} input
   * @returns {ScheduledTask}
   */
  scheduleSubOrchestrationWithIdTyped(name, instanceId, input) {
    const task = this.scheduleSubOrchestrationWithId(name, instanceId, input);
    task._typed = true;
    return task;
  }

  /**
   * Start a detached orchestration with auto-serialized input (fire-and-forget). Yield the return value.
   * @param {string} name - Orchestration name
   * @param {string} instanceId - Instance ID
   * @param {*} input
   * @returns {ScheduledTask}
   */
  startOrchestrationTyped(name, instanceId, input) {
    return this.startOrchestration(name, instanceId, input);
  }

  /**
   * Start a versioned detached orchestration with auto-serialized input (fire-and-forget). Yield the return value.
   * @param {string} name - Orchestration name
   * @param {string} version - Version string
   * @param {string} instanceId - Instance ID
   * @param {*} input
   * @returns {ScheduledTask}
   */
  startOrchestrationVersionedTyped(name, version, instanceId, input) {
    return this.startOrchestrationVersioned(name, version, instanceId, input);
  }

  /**
   * Continue as new with auto-serialized input. Yield the return value.
   * @param {*} input
   * @returns {ScheduledTask}
   */
  continueAsNewTyped(input) {
    return this.continueAsNew(input);
  }

  // ─── Custom Status (fire-and-forget, no yield needed) ───

  /**
   * Set a custom status string for progress tracking.
   * @param {string} status - JSON string or plain text
   */
  setCustomStatus(status) {
    orchestrationSetCustomStatus(this.instanceId, String(status));
  }

  /**
   * Clear the custom status.
   */
  resetCustomStatus() {
    orchestrationResetCustomStatus(this.instanceId);
  }

  /**
   * Read the current custom status value.
   * Returns the status string or null if none has been set.
   * Reflects all set/reset calls made so far, including across turns and CAN boundaries.
   * @returns {string|null}
   */
  getCustomStatus() {
    return orchestrationGetCustomStatus(this.instanceId) ?? null;
  }

  // ─── Logging (fire-and-forget, delegates to Rust ctx.trace()) ───

  traceInfo(message) {
    orchestrationTraceLog(this.instanceId, 'info', String(message));
  }

  traceWarn(message) {
    orchestrationTraceLog(this.instanceId, 'warn', String(message));
  }

  traceError(message) {
    orchestrationTraceLog(this.instanceId, 'error', String(message));
  }

  traceDebug(message) {
    orchestrationTraceLog(this.instanceId, 'debug', String(message));
  }
}

// ─── Public API ──────────────────────────────────────────────────

/**
 * SQLite provider for duroxide.
 */
class SqliteProvider {
  /** @param {JsSqliteProvider} native */
  constructor(native) {
    this._native = native;
  }

  /**
   * Open a SQLite database file.
   * @param {string} path
   * @returns {Promise<SqliteProvider>}
   */
  static async open(path) {
    const n = await JsSqliteProvider.open(path);
    return new SqliteProvider(n);
  }

  /**
   * Create an in-memory SQLite database.
   * @returns {Promise<SqliteProvider>}
   */
  static async inMemory() {
    const n = await JsSqliteProvider.inMemory();
    return new SqliteProvider(n);
  }
}

/**
 * PostgreSQL provider for duroxide.
 */
class PostgresProvider {
  /** @param {JsPostgresProvider} native */
  constructor(native) {
    this._native = native;
    this._type = 'postgres';
  }

  /**
   * Connect to a PostgreSQL database (uses "public" schema).
   * @param {string} databaseUrl - e.g. "postgresql://user:pass@host:5432/db"
   * @returns {Promise<PostgresProvider>}
   */
  static async connect(databaseUrl) {
    const n = await JsPostgresProvider.connect(databaseUrl);
    return new PostgresProvider(n);
  }

  /**
   * Connect to a PostgreSQL database with a custom schema.
   * @param {string} databaseUrl
   * @param {string} schema - Schema name (created if it doesn't exist)
   * @returns {Promise<PostgresProvider>}
   */
  static async connectWithSchema(databaseUrl, schema) {
    const n = await JsPostgresProvider.connectWithSchema(databaseUrl, schema);
    return new PostgresProvider(n);
  }
}

/**
 * Client for starting and managing orchestration instances.
 */
class Client {
  /**
   * @param {SqliteProvider|PostgresProvider} provider
   */
  constructor(provider) {
    if (provider._type === 'postgres') {
      this._native = JsClient.fromPostgres(provider._native);
    } else {
      this._native = new JsClient(provider._native);
    }
  }

  async startOrchestration(instanceId, orchestrationName, input) {
    await this._native.startOrchestration(
      instanceId,
      orchestrationName,
      JSON.stringify(input === undefined ? null : input)
    );
  }

  async startOrchestrationVersioned(instanceId, orchestrationName, input, version) {
    await this._native.startOrchestrationVersioned(
      instanceId,
      orchestrationName,
      JSON.stringify(input === undefined ? null : input),
      version
    );
  }

  async getStatus(instanceId) {
    return await this._native.getStatus(instanceId);
  }

  async waitForOrchestration(instanceId, timeoutMs = 30000) {
    const result = await this._native.waitForOrchestration(instanceId, timeoutMs);
    if (result.output) {
      try {
        result.output = JSON.parse(result.output);
      } catch {}
    }
    return result;
  }

  async cancelInstance(instanceId, reason) {
    await this._native.cancelInstance(instanceId, reason);
  }

  async raiseEvent(instanceId, eventName, data) {
    await this._native.raiseEvent(
      instanceId,
      eventName,
      JSON.stringify(data === undefined ? null : data)
    );
  }

  async enqueueEvent(instanceId, queueName, data) {
    await this._native.enqueueEvent(
      instanceId,
      queueName,
      JSON.stringify(data === undefined ? null : data)
    );
  }

  async waitForStatusChange(instanceId, lastSeenVersion, pollIntervalMs = 500, timeoutMs = 30000) {
    const result = await this._native.waitForStatusChange(instanceId, lastSeenVersion, pollIntervalMs, timeoutMs);
    if (result.output) {
      try { result.output = JSON.parse(result.output); } catch {}
    }
    return result;
  }

  async getSystemMetrics() {
    return await this._native.getSystemMetrics();
  }

  async getQueueDepths() {
    return await this._native.getQueueDepths();
  }

  // ─── Typed Convenience API ──────────────────────────────

  /**
   * Start an orchestration with auto-serialized input.
   * @param {string} instanceId
   * @param {string} orchestrationName
   * @param {*} input
   */
  async startOrchestrationTyped(instanceId, orchestrationName, input) {
    return await this.startOrchestration(instanceId, orchestrationName, input);
  }

  /**
   * Start a versioned orchestration with auto-serialized input.
   * @param {string} instanceId
   * @param {string} orchestrationName
   * @param {*} input
   * @param {string} version
   */
  async startOrchestrationVersionedTyped(instanceId, orchestrationName, input, version) {
    return await this.startOrchestrationVersioned(instanceId, orchestrationName, input, version);
  }

  /**
   * Raise an event with auto-serialized data.
   * @param {string} instanceId
   * @param {string} eventName
   * @param {*} data
   */
  async raiseEventTyped(instanceId, eventName, data) {
    return await this.raiseEvent(instanceId, eventName, data);
  }

  /**
   * Enqueue an event with auto-serialized data.
   * @param {string} instanceId
   * @param {string} queueName
   * @param {*} data
   */
  async enqueueEventTyped(instanceId, queueName, data) {
    return await this.enqueueEvent(instanceId, queueName, data);
  }

  /**
   * Wait for an orchestration and return the parsed output directly.
   * Throws an Error if the orchestration failed.
   * @param {string} instanceId
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<*>} Parsed output value
   */
  async waitForOrchestrationTyped(instanceId, timeoutMs = 30000) {
    const result = await this.waitForOrchestration(instanceId, timeoutMs);
    if (result.status === 'Failed') {
      throw new Error(result.error || 'Orchestration failed');
    }
    return result.output;
  }

  // ─── Management / Admin API ─────────────────────────────

  async listAllInstances() {
    return await this._native.listAllInstances();
  }

  async listInstancesByStatus(status) {
    return await this._native.listInstancesByStatus(status);
  }

  async getInstanceInfo(instanceId) {
    const info = await this._native.getInstanceInfo(instanceId);
    if (info.output) {
      try { info.output = JSON.parse(info.output); } catch {}
    }
    return info;
  }

  async getExecutionInfo(instanceId, executionId) {
    const info = await this._native.getExecutionInfo(instanceId, executionId);
    if (info.output) {
      try { info.output = JSON.parse(info.output); } catch {}
    }
    return info;
  }

  async listExecutions(instanceId) {
    return await this._native.listExecutions(instanceId);
  }

  async readExecutionHistory(instanceId, executionId) {
    return await this._native.readExecutionHistory(instanceId, executionId);
  }

  async getInstanceTree(instanceId) {
    return await this._native.getInstanceTree(instanceId);
  }

  async deleteInstance(instanceId, force = false) {
    return await this._native.deleteInstance(instanceId, force);
  }

  async deleteInstanceBulk(filter = {}) {
    return await this._native.deleteInstanceBulk(filter);
  }

  async pruneExecutions(instanceId, options = {}) {
    return await this._native.pruneExecutions(instanceId, options);
  }

  async pruneExecutionsBulk(filter = {}, options = {}) {
    return await this._native.pruneExecutionsBulk(filter, options);
  }
}

/**
 * Durable execution runtime.
 */
class Runtime {
  /**
   * @param {SqliteProvider|PostgresProvider} provider
   * @param {object} [options]
   */
  constructor(provider, options) {
    if (provider._type === 'postgres') {
      this._native = JsRuntime.fromPostgres(provider._native, options);
    } else {
      this._native = new JsRuntime(provider._native, options);
    }
    // Wire up the generator driver functions
    this._native.setGeneratorDriver(createGenerator, nextStep, disposeGenerator);
  }

  /**
   * Register an activity function.
   * @param {string} name
   * @param {(ctx: ActivityContext, input: any) => Promise<any>} fn
   */
  registerActivity(name, fn) {
    // Wrap the JS function to match the native callback signature
    const wrappedFn = async (payload) => {
      const newlineIdx = payload.indexOf('\n');
      const ctxInfoStr = payload.substring(0, newlineIdx);
      const inputStr = payload.substring(newlineIdx + 1);
      const ctxInfo = JSON.parse(ctxInfoStr);
      const ctx = new ActivityContext(ctxInfo);

      let input;
      try {
        input = JSON.parse(inputStr);
      } catch {
        input = inputStr;
      }

      const result = await fn(ctx, input);
      return JSON.stringify(result === undefined ? null : result);
    };

    this._native.registerActivity(name, wrappedFn);
  }

  /**
   * Register an orchestration generator function.
   * @param {string} name
   * @param {GeneratorFunction} fn - function*(ctx, input) { ... }
   */
  registerOrchestration(name, fn) {
    orchestrationFunctions.set(name, fn);
    this._native.registerOrchestration(name);
  }

  /**
   * Register a typed activity. Input is auto-parsed from JSON; output is auto-serialized.
   * The handler receives a parsed object and returns a plain object (no JSON.stringify needed).
   * Mirrors Rust core's `register_typed` on ActivityRegistryBuilder.
   * @param {string} name
   * @param {(ctx: ActivityContext, input: TIn) => Promise<TOut>} fn
   */
  registerActivityTyped(name, fn) {
    this.registerActivity(name, fn);
  }

  /**
   * Register a typed orchestration. Input is auto-parsed; output is auto-serialized.
   * @param {string} name
   * @param {GeneratorFunction} fn - function*(ctx, input) where input is already parsed
   */
  registerOrchestrationTyped(name, fn) {
    this.registerOrchestration(name, fn);
  }

  /**
   * Register a typed versioned orchestration.
   * @param {string} name
   * @param {string} version
   * @param {GeneratorFunction} fn
   */
  registerOrchestrationVersionedTyped(name, version, fn) {
    this.registerOrchestrationVersioned(name, version, fn);
  }

  /**
   * Register a versioned orchestration generator function.
   * @param {string} name
   * @param {string} version
   * @param {GeneratorFunction} fn
   */
  registerOrchestrationVersioned(name, version, fn) {
    const key = `${name}@${version}`;
    orchestrationFunctions.set(key, fn);
    // Don't overwrite the plain name key — it serves as the fallback
    // for versions registered via registerOrchestration() (unversioned).
    this._native.registerOrchestrationVersioned(name, version);
  }

  /**
   * Start the runtime. Blocks until shutdown is called.
   */
  async start() {
    await this._native.start();
  }

  /**
   * Shutdown the runtime gracefully.
   * @param {number} [timeoutMs]
   */
  async shutdown(timeoutMs) {
    await this._native.shutdown(timeoutMs);
  }

  /**
   * Get a snapshot of runtime metrics.
   * @returns {object|null}
   */
  metricsSnapshot() {
    return this._native.metricsSnapshot();
  }
}

/**
 * Context for activity execution.
 */
class ActivityContext {
  constructor(ctxInfo) {
    this.instanceId = ctxInfo.instanceId;
    this.executionId = ctxInfo.executionId;
    this.orchestrationName = ctxInfo.orchestrationName;
    this.orchestrationVersion = ctxInfo.orchestrationVersion;
    this.activityName = ctxInfo.activityName;
    this.workerId = ctxInfo.workerId;
    this.sessionId = ctxInfo.sessionId || null;
    this._traceToken = ctxInfo._traceToken;
  }

  traceInfo(message) {
    activityTraceLog(this._traceToken, 'info', String(message));
  }

  traceWarn(message) {
    activityTraceLog(this._traceToken, 'warn', String(message));
  }

  traceError(message) {
    activityTraceLog(this._traceToken, 'error', String(message));
  }

  traceDebug(message) {
    activityTraceLog(this._traceToken, 'debug', String(message));
  }

  /**
   * Check if this activity has been cancelled (e.g., lost a race/select).
   * Use this for cooperative cancellation in long-running activities.
   * @returns {boolean}
   */
  isCancelled() {
    return activityIsCancelled(this._traceToken);
  }

  /**
   * Get a Client from the activity context, allowing activities to start new orchestrations.
   * @returns {Client|null}
   */
  getClient() {
    const native = activityGetClient(this._traceToken);
    if (!native) return null;
    const client = Object.create(Client.prototype);
    client._native = native;
    return client;
  }
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
  SqliteProvider,
  PostgresProvider,
  Client,
  Runtime,
  OrchestrationContext,
  ActivityContext,
  initTracing,
};
