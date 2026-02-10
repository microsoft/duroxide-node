/**
 * duroxide - Node.js SDK for the Duroxide durable execution runtime.
 *
 * Generator-based orchestrations: users write function*(ctx, input) { ... }
 * and yield ScheduledTask descriptors. The Rust runtime handles DurableFutures.
 */

// Load native bindings from the auto-generated napi-rs loader
const { JsSqliteProvider, JsPostgresProvider, JsClient, JsRuntime, activityTraceLog, orchestrationTraceLog } = require('../index.js');

// ─── Generator Driver ────────────────────────────────────────────

/** @type {Map<number, Generator>} */
const generators = new Map();
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
  return 'ok';
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
      return JSON.stringify({
        status: 'completed',
        output: JSON.stringify(task === undefined ? null : task),
      });
    }

    // task should be a ScheduledTask descriptor
    return JSON.stringify({
      status: 'yielded',
      generatorId,
      task,
    });
  } catch (e) {
    generators.delete(generatorId);
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
      return JSON.stringify({
        status: 'completed',
        output: JSON.stringify(task === undefined ? null : task),
      });
    }

    return JSON.stringify({
      status: 'yielded',
      generatorId,
      task,
    });
  } catch (e) {
    generators.delete(generatorId);
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
  scheduleActivity(name, input) {
    return {
      type: 'activity',
      name,
      input: JSON.stringify(input === undefined ? null : input),
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

  async getSystemMetrics() {
    return await this._native.getSystemMetrics();
  }

  async getQueueDepths() {
    return await this._native.getQueueDepths();
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
}

// ─── Exports ─────────────────────────────────────────────────────

module.exports = {
  SqliteProvider,
  PostgresProvider,
  Client,
  Runtime,
  OrchestrationContext,
  ActivityContext,
};
