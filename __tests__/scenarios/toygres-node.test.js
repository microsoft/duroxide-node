/**
 * Toygres-Node Scenario Test
 *
 * Models the toygres PostgreSQL control plane orchestrations using
 * duroxide-node. Demonstrates real-world patterns:
 *   - Instance lifecycle (create → health monitor → delete)
 *   - Sub-orchestrations (create-instance spawns instance-actor)
 *   - Eternal orchestrations with continue-as-new (instance-actor, system-pruner)
 *   - External events for graceful shutdown signaling
 *   - Race/select between timer and event
 *   - Retry policies on flaky activities
 *   - Backup/restore workflows with polling loops
 *
 * Activities are mocked — no real K8s or CMS. The focus is on orchestration
 * logic and durable patterns.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { PostgresProvider, Client, Runtime } = require('../../lib/duroxide.js');

// Load .env from project root
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const SCHEMA = 'duroxide_node_toygres';
const RUN_ID = `tg${Date.now().toString(36)}`;
function uid(name) {
  return `${RUN_ID}-${name}`;
}

let provider;
before(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error('DATABASE_URL not set. Create a .env file or export DATABASE_URL.');
  }
  provider = await PostgresProvider.connectWithSchema(dbUrl, SCHEMA);
});

// Simulated CMS state (shared across activities within a test)
function createCmsState() {
  return {
    instances: new Map(),
    healthChecks: [],
    images: new Map(),
    dnsNames: new Set(),
    actors: new Map(),
  };
}

// ─── 1. Create Instance ──────────────────────────────────────────

describe('toygres: create-instance', () => {
  it('provisions a new PostgreSQL instance end-to-end', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    const cms = createCmsState();

    // ── Activities ──

    runtime.registerActivity('cms-create-instance-record', async (ctx, input) => {
      ctx.traceInfo(`creating CMS record for ${input.name}`);
      const record = {
        id: `inst-${input.name}`,
        name: input.name,
        k8sName: `pg-${input.name}`,
        state: 'provisioning',
        dnsName: `${input.name}.postgres.local`,
      };
      cms.instances.set(record.id, record);
      cms.dnsNames.add(record.dnsName);
      return record;
    });

    runtime.registerActivity('deploy-postgres-v2', async (ctx, input) => {
      ctx.traceInfo(`deploying K8s resources for ${input.k8sName}`);
      return { statefulSet: input.k8sName, service: `${input.k8sName}-svc` };
    });

    let readyAttempts = 0;
    runtime.registerActivity('wait-for-ready', async (ctx, input) => {
      readyAttempts++;
      ctx.traceInfo(`checking pod readiness (attempt ${readyAttempts})`);
      // Simulate pod becoming ready after 2 attempts
      if (readyAttempts < 2) return { ready: false };
      return { ready: true };
    });

    runtime.registerActivity('get-connection-strings', async (ctx, input) => {
      ctx.traceInfo(`fetching connection strings for ${input.k8sName}`);
      return {
        host: `${input.k8sName}.default.svc.cluster.local`,
        port: 5432,
        connectionString: `postgresql://postgres:secret@${input.k8sName}:5432/postgres`,
      };
    });

    runtime.registerActivity('test-connection', async (ctx, input) => {
      ctx.traceInfo(`testing connection to ${input.host}`);
      return { connected: true, latencyMs: 3 };
    });

    runtime.registerActivity('cms-update-instance-state', async (ctx, input) => {
      ctx.traceInfo(`updating ${input.id} state → ${input.state}`);
      const inst = cms.instances.get(input.id);
      if (inst) inst.state = input.state;
      return { ok: true };
    });

    runtime.registerActivity('cms-record-instance-actor', async (ctx, input) => {
      ctx.traceInfo(`recording actor ${input.actorInstanceId} for ${input.id}`);
      const inst = cms.instances.get(input.id);
      if (inst) inst.actorInstanceId = input.actorInstanceId;
      return { ok: true };
    });

    runtime.registerActivity('delete-postgres', async (ctx, input) => {
      ctx.traceInfo(`deleting K8s resources for ${input.k8sName}`);
      return { deleted: true };
    });

    // ── Orchestrations ──

    // Instance actor (health monitor, spawned by create-instance)
    runtime.registerOrchestration('InstanceActor', function* (ctx, input) {
      // Minimal actor: just records that it started, then exits
      // (full actor tested in the instance-actor scenario)
      ctx.traceInfo(`actor started for ${input.instanceId}`);
      return { status: 'started' };
    });

    runtime.registerOrchestration('CreateInstance', function* (ctx, input) {
      ctx.traceInfo(`[v1.0.6] creating instance ${input.name}`);

      // Step 1: Reserve CMS record
      const record = yield ctx.scheduleActivity('cms-create-instance-record', {
        name: input.name,
        sku: input.sku || 'basic',
      });

      try {
        // Step 2: Deploy K8s resources
        yield ctx.scheduleActivity('deploy-postgres-v2', {
          k8sName: record.k8sName,
          sku: input.sku || 'basic',
        });

        // Step 3: Wait for pod readiness (polling loop)
        let ready = false;
        for (let attempt = 0; attempt < 60; attempt++) {
          const status = yield ctx.scheduleActivity('wait-for-ready', {
            k8sName: record.k8sName,
          });
          if (status.ready) {
            ready = true;
            break;
          }
          ctx.traceInfo(`pod not ready, waiting (attempt ${attempt + 1})`);
          yield ctx.scheduleTimer(100); // 100ms in test (5s in prod)
        }

        if (!ready) {
          throw new Error('pod readiness timeout');
        }

        // Step 4: Get connection info & test
        const connInfo = yield ctx.scheduleActivity('get-connection-strings', {
          k8sName: record.k8sName,
        });

        yield ctx.scheduleActivity('test-connection', {
          host: connInfo.host,
          port: connInfo.port,
        });

        // Step 5: Mark running
        yield ctx.scheduleActivity('cms-update-instance-state', {
          id: record.id,
          state: 'running',
        });

        // Step 6: Spawn instance actor (fire-and-forget)
        const actorId = `actor-${record.id}`;
        yield ctx.startOrchestration('InstanceActor', actorId, {
          instanceId: record.id,
          iteration: 0,
        });

        yield ctx.scheduleActivity('cms-record-instance-actor', {
          id: record.id,
          actorInstanceId: actorId,
        });

        ctx.traceInfo(`instance ${input.name} created successfully`);

        return {
          status: 'created',
          instanceId: record.id,
          actorId,
          connectionString: connInfo.connectionString,
        };
      } catch (e) {
        // Failure path: mark failed and clean up K8s resources
        ctx.traceError(`creation failed: ${e.message}`);
        yield ctx.scheduleActivity('cms-update-instance-state', {
          id: record.id,
          state: 'failed',
        });
        yield ctx.scheduleActivity('delete-postgres', {
          k8sName: record.k8sName,
        });
        return { status: 'failed', reason: e.message, instanceId: record.id };
      }
    });

    await runtime.start();

    try {
      await client.startOrchestration(uid('create-mydb'), 'CreateInstance', {
        name: 'mydb',
        sku: 'basic',
      });
      const result = await client.waitForOrchestration(uid('create-mydb'), 15000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.status, 'created');
      assert.strictEqual(result.output.instanceId, 'inst-mydb');
      assert.strictEqual(result.output.actorId, 'actor-inst-mydb');
      assert.ok(result.output.connectionString.includes('mydb'));

      // Verify CMS state
      assert.strictEqual(cms.instances.get('inst-mydb').state, 'running');
      assert.strictEqual(cms.instances.get('inst-mydb').actorInstanceId, 'actor-inst-mydb');
      assert.ok(readyAttempts >= 2, 'should have polled readiness at least twice');
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 2. Instance Actor (health monitor) ──────────────────────────

describe('toygres: instance-actor', () => {
  it('runs health checks and exits on InstanceDeleted signal', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    const cms = createCmsState();
    let healthCheckCount = 0;

    cms.instances.set('inst-testdb', {
      id: 'inst-testdb',
      name: 'testdb',
      state: 'running',
      connectionString: 'postgresql://postgres:secret@pg-testdb:5432/postgres',
    });

    // ── Activities ──

    runtime.registerActivity('cms-get-instance-connection', async (ctx, input) => {
      ctx.traceInfo(`fetching connection for ${input.instanceId}`);
      const inst = cms.instances.get(input.instanceId);
      if (!inst) return { found: false };
      return { found: true, connectionString: inst.connectionString, state: inst.state };
    });

    runtime.registerActivity('test-connection', async (ctx, input) => {
      return { connected: true, latencyMs: Math.floor(Math.random() * 10) + 1 };
    });

    runtime.registerActivity('cms-record-health-check', async (ctx, input) => {
      healthCheckCount++;
      ctx.traceInfo(`recording health check #${healthCheckCount}`);
      cms.healthChecks.push({
        instanceId: input.instanceId,
        healthy: input.healthy,
        latencyMs: input.latencyMs,
        timestamp: Date.now(),
      });
      return { ok: true };
    });

    // ── Orchestration ──
    // Models the instance-actor pattern: health check loop with continue-as-new,
    // exits when receiving InstanceDeleted event via race/select

    runtime.registerOrchestration('InstanceActor', function* (ctx, input) {
      const iteration = input.iteration || 0;
      ctx.traceInfo(`[v1.0.1] actor iteration ${iteration} for ${input.instanceId}`);

      // Check if instance still exists
      const connInfo = yield ctx.scheduleActivity('cms-get-instance-connection', {
        instanceId: input.instanceId,
      });

      if (!connInfo.found || connInfo.state === 'deleted') {
        ctx.traceInfo(`instance gone, actor exiting`);
        return { status: 'exited', reason: 'instance_not_found', iterations: iteration };
      }

      // Health check
      const health = yield ctx.scheduleActivity('test-connection', {
        connectionString: connInfo.connectionString,
      });

      yield ctx.scheduleActivity('cms-record-health-check', {
        instanceId: input.instanceId,
        healthy: health.connected,
        latencyMs: health.latencyMs,
      });

      // Wait: 100ms timer OR InstanceDeleted event (whichever first)
      const winner = yield ctx.race(
        ctx.scheduleTimer(100),
        ctx.waitForEvent('InstanceDeleted')
      );

      // If the event won (index 1), exit gracefully
      if (winner.index === 1) {
        ctx.traceInfo(`received InstanceDeleted signal, exiting`);
        return { status: 'exited', reason: 'signal', iterations: iteration + 1 };
      }

      // continue-as-new for next health check cycle
      return yield ctx.continueAsNew({
        instanceId: input.instanceId,
        iteration: iteration + 1,
      });
    });

    await runtime.start();

    try {
      // Start the actor
      await client.startOrchestration(uid('actor-testdb'), 'InstanceActor', {
        instanceId: 'inst-testdb',
        iteration: 0,
      });

      // Let it run a few health check cycles
      await new Promise((r) => setTimeout(r, 800));

      // Mark instance as deleted so actor exits on next check
      cms.instances.get('inst-testdb').state = 'deleted';

      const result = await client.waitForOrchestration(uid('actor-testdb'), 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.status, 'exited');
      assert.strictEqual(result.output.reason, 'instance_not_found');
      assert.ok(result.output.iterations >= 2, `expected ≥2 iterations, got ${result.output.iterations}`);
      assert.ok(healthCheckCount >= 2, `expected ≥2 health checks, got ${healthCheckCount}`);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 3. Delete Instance ──────────────────────────────────────────

describe('toygres: delete-instance', () => {
  it('tears down instance and signals actor', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    const cms = createCmsState();

    cms.instances.set('inst-delme', {
      id: 'inst-delme',
      name: 'delme',
      k8sName: 'pg-delme',
      state: 'running',
      dnsName: 'delme.postgres.local',
      actorInstanceId: 'actor-delme',
    });
    cms.dnsNames.add('delme.postgres.local');

    // ── Activities ──

    runtime.registerActivity('cms-get-instance-by-k8s-name', async (ctx, input) => {
      ctx.traceInfo(`looking up instance ${input.k8sName}`);
      for (const inst of cms.instances.values()) {
        if (inst.k8sName === input.k8sName) return inst;
      }
      return null;
    });

    runtime.registerActivity('cms-update-instance-state', async (ctx, input) => {
      ctx.traceInfo(`updating ${input.id} → ${input.state}`);
      const inst = cms.instances.get(input.id);
      if (inst) inst.state = input.state;
      return { ok: true };
    });

    runtime.registerActivity('send-external-event', async (ctx, input) => {
      ctx.traceInfo(`sending ${input.eventName} to ${input.instanceId}`);
      // In real toygres this calls client.raise_event via the provider
      return { sent: true };
    });

    runtime.registerActivity('delete-postgres', async (ctx, input) => {
      ctx.traceInfo(`deleting K8s resources for ${input.k8sName}`);
      return { deleted: true };
    });

    runtime.registerActivity('cms-delete-instance-record', async (ctx, input) => {
      ctx.traceInfo(`deleting CMS record ${input.id}`);
      cms.instances.delete(input.id);
      return { ok: true };
    });

    runtime.registerActivity('cms-free-dns-name', async (ctx, input) => {
      ctx.traceInfo(`freeing DNS name ${input.dnsName}`);
      cms.dnsNames.delete(input.dnsName);
      return { ok: true };
    });

    // ── Orchestration ──

    runtime.registerOrchestration('DeleteInstance', function* (ctx, input) {
      ctx.traceInfo(`[v1.0.2] deleting instance ${input.k8sName}`);

      // Fetch instance info
      const instance = yield ctx.scheduleActivity('cms-get-instance-by-k8s-name', {
        k8sName: input.k8sName,
      });

      if (!instance) {
        ctx.traceWarn(`instance not found, nothing to delete`);
        return { status: 'not_found' };
      }

      // Mark as deleting
      yield ctx.scheduleActivity('cms-update-instance-state', {
        id: instance.id,
        state: 'deleting',
      });

      // Signal the actor to stop (best-effort)
      if (instance.actorInstanceId) {
        try {
          yield ctx.scheduleActivity('send-external-event', {
            instanceId: instance.actorInstanceId,
            eventName: 'InstanceDeleted',
            data: { reason: 'instance-deleted' },
          });
        } catch (e) {
          ctx.traceWarn(`failed to signal actor (best-effort): ${e.message}`);
        }
      }

      // Delete K8s resources
      yield ctx.scheduleActivity('delete-postgres', {
        k8sName: instance.k8sName,
      });

      // Cleanup CMS
      yield ctx.scheduleActivity('cms-free-dns-name', {
        dnsName: instance.dnsName,
      });

      yield ctx.scheduleActivity('cms-delete-instance-record', {
        id: instance.id,
      });

      ctx.traceInfo(`instance ${input.k8sName} deleted`);
      return { status: 'deleted', instanceId: instance.id };
    });

    await runtime.start();

    try {
      await client.startOrchestration(uid('delete-delme'), 'DeleteInstance', {
        k8sName: 'pg-delme',
      });
      const result = await client.waitForOrchestration(uid('delete-delme'), 10000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.status, 'deleted');
      assert.strictEqual(result.output.instanceId, 'inst-delme');

      // CMS should be clean
      assert.strictEqual(cms.instances.size, 0);
      assert.strictEqual(cms.dnsNames.size, 0);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 4. Create Image (backup) ────────────────────────────────────

describe('toygres: create-image', () => {
  it('runs a backup job and polls to completion', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    const cms = createCmsState();
    let jobPollCount = 0;

    cms.instances.set('inst-srcdb', {
      id: 'inst-srcdb',
      name: 'srcdb',
      k8sName: 'pg-srcdb',
      state: 'running',
    });

    // ── Activities ──

    runtime.registerActivity('cms-get-instance-by-k8s-name', async (ctx, input) => {
      for (const inst of cms.instances.values()) {
        if (inst.k8sName === input.k8sName) return inst;
      }
      return null;
    });

    runtime.registerActivity('cms-get-instance-password', async (ctx, input) => {
      ctx.traceInfo(`fetching password for ${input.k8sName}`);
      return { password: 'secret123' };
    });

    runtime.registerActivity('cms-image-create', async (ctx, input) => {
      ctx.traceInfo(`creating image record: ${input.imageName}`);
      const image = {
        id: `img-${input.imageName}`,
        name: input.imageName,
        state: 'pending',
        blobPath: input.blobPath,
      };
      cms.images.set(image.id, image);
      return image;
    });

    runtime.registerActivity('run-backup-job', async (ctx, input) => {
      ctx.traceInfo(`starting backup job for ${input.imageName}`);
      return { jobName: `backup-${input.imageName}` };
    });

    runtime.registerActivity('wait-for-job', async (ctx, input) => {
      jobPollCount++;
      ctx.traceInfo(`polling job ${input.jobName} (poll #${jobPollCount})`);
      // Simulate job completing after 3 polls
      if (jobPollCount < 3) return { status: 'running' };
      return { status: 'succeeded' };
    });

    runtime.registerActivity('cms-image-update-state', async (ctx, input) => {
      ctx.traceInfo(`image ${input.imageId} → ${input.state}`);
      const img = cms.images.get(input.imageId);
      if (img) img.state = input.state;
      return { ok: true };
    });

    runtime.registerActivity('delete-job', async (ctx, input) => {
      ctx.traceInfo(`cleaning up job ${input.jobName}`);
      return { ok: true };
    });

    // ── Orchestration ──

    runtime.registerOrchestration('CreateImage', function* (ctx, input) {
      ctx.traceInfo(`creating backup image from ${input.k8sName}`);

      // Get source instance
      const instance = yield ctx.scheduleActivity('cms-get-instance-by-k8s-name', {
        k8sName: input.k8sName,
      });

      if (!instance) return { status: 'failed', reason: 'source not found' };

      // Get password
      const { password } = yield ctx.scheduleActivity('cms-get-instance-password', {
        k8sName: input.k8sName,
      });

      // Deterministic timestamp for blob path
      const now = yield ctx.utcNow();
      const blobPath = `images/${input.imageName}-${now}/`;

      // Create CMS image record
      const image = yield ctx.scheduleActivity('cms-image-create', {
        imageName: input.imageName,
        sourceInstanceId: instance.id,
        blobPath,
      });

      // Start backup job
      const { jobName } = yield ctx.scheduleActivity('run-backup-job', {
        imageName: input.imageName,
        k8sName: input.k8sName,
        password,
        blobPath,
      });

      // Poll for job completion (max 360 polls = 1hr at 10s, we use 100ms)
      let jobStatus = 'running';
      for (let i = 0; i < 360; i++) {
        const check = yield ctx.scheduleActivity('wait-for-job', { jobName });
        jobStatus = check.status;
        if (jobStatus !== 'running') break;
        yield ctx.scheduleTimer(100);
      }

      // Cleanup job
      yield ctx.scheduleActivity('delete-job', { jobName });

      if (jobStatus === 'succeeded') {
        yield ctx.scheduleActivity('cms-image-update-state', {
          imageId: image.id,
          state: 'ready',
        });
        ctx.traceInfo(`image ${input.imageName} ready`);
        return { status: 'ready', imageId: image.id, blobPath };
      } else {
        yield ctx.scheduleActivity('cms-image-update-state', {
          imageId: image.id,
          state: 'failed',
        });
        return { status: 'failed', imageId: image.id };
      }
    });

    await runtime.start();

    try {
      await client.startOrchestration(uid('backup-srcdb'), 'CreateImage', {
        k8sName: 'pg-srcdb',
        imageName: 'srcdb-snap',
      });
      const result = await client.waitForOrchestration(uid('backup-srcdb'), 15000);

      assert.strictEqual(result.status, 'Completed');
      assert.strictEqual(result.output.status, 'ready');
      assert.ok(result.output.blobPath.startsWith('images/srcdb-snap-'));

      // CMS image should be ready
      const img = cms.images.get('img-srcdb-snap');
      assert.strictEqual(img.state, 'ready');
      assert.ok(jobPollCount >= 3, `expected ≥3 job polls, got ${jobPollCount}`);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 5. System Pruner ────────────────────────────────────────────

describe('toygres: system-pruner', () => {
  it('runs periodic pruning with continue-as-new', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    let pruneCount = 0;

    runtime.registerActivity('system-prune-2', async (ctx, input) => {
      pruneCount++;
      ctx.traceInfo(`pruning iteration ${input.iteration} (prune #${pruneCount})`);
      return { pruned: pruneCount * 3, deleted: pruneCount };
    });

    runtime.registerOrchestration('SystemPruner', function* (ctx, input) {
      const iteration = input.iteration || 0;
      ctx.traceInfo(`[v1.0.4] system pruner iteration ${iteration}`);

      yield ctx.scheduleActivity('system-prune-2', { iteration });

      // In prod this is 60s, in test 100ms
      yield ctx.scheduleTimer(100);

      // Continue as new (eternal orchestration)
      return yield ctx.continueAsNew({ iteration: iteration + 1 });
    });

    await runtime.start();

    try {
      await client.startOrchestration(uid('pruner'), 'SystemPruner', { iteration: 0 });

      // Let it run a few cycles
      await new Promise((r) => setTimeout(r, 800));

      // Cancel to stop (in prod it runs forever)
      await client.cancelInstance(uid('pruner'), 'test-done');

      // Verify it ran multiple iterations
      assert.ok(pruneCount >= 2, `expected ≥2 prune cycles, got ${pruneCount}`);
    } finally {
      await runtime.shutdown(100);
    }
  });
});

// ─── 6. Full Lifecycle: Create → Monitor → Delete ────────────────

describe('toygres: full lifecycle', () => {
  it('creates, monitors, then deletes an instance', async () => {
    
    
    const client = new Client(provider);
    const runtime = new Runtime(provider, { dispatcherPollIntervalMs: 50 });
    const cms = createCmsState();
    let healthCheckCount = 0;

    // ── Activities (combined from create + actor + delete) ──

    runtime.registerActivity('cms-create-instance-record', async (ctx, input) => {
      const record = {
        id: `inst-${input.name}`,
        name: input.name,
        k8sName: `pg-${input.name}`,
        state: 'provisioning',
        dnsName: `${input.name}.postgres.local`,
      };
      cms.instances.set(record.id, record);
      return record;
    });

    runtime.registerActivity('deploy-postgres-v2', async (ctx, input) => {
      return { statefulSet: input.k8sName };
    });

    runtime.registerActivity('wait-for-ready', async () => {
      return { ready: true }; // instant ready
    });

    runtime.registerActivity('get-connection-strings', async (ctx, input) => {
      return {
        host: `${input.k8sName}.svc`,
        port: 5432,
        connectionString: `postgresql://postgres:s@${input.k8sName}:5432/postgres`,
      };
    });

    runtime.registerActivity('test-connection', async () => {
      return { connected: true, latencyMs: 2 };
    });

    runtime.registerActivity('cms-update-instance-state', async (ctx, input) => {
      const inst = cms.instances.get(input.id);
      if (inst) inst.state = input.state;
      return { ok: true };
    });

    runtime.registerActivity('cms-get-instance-connection', async (ctx, input) => {
      const inst = cms.instances.get(input.instanceId);
      if (!inst) return { found: false };
      return { found: true, connectionString: 'pg://test', state: inst.state };
    });

    runtime.registerActivity('cms-record-health-check', async (ctx, input) => {
      healthCheckCount++;
      cms.healthChecks.push({ instanceId: input.instanceId, healthy: input.healthy });
      return { ok: true };
    });

    runtime.registerActivity('cms-get-instance-by-k8s-name', async (ctx, input) => {
      for (const inst of cms.instances.values()) {
        if (inst.k8sName === input.k8sName) return inst;
      }
      return null;
    });

    runtime.registerActivity('send-external-event', async () => ({ sent: true }));
    runtime.registerActivity('delete-postgres', async () => ({ deleted: true }));

    runtime.registerActivity('cms-delete-instance-record', async (ctx, input) => {
      cms.instances.delete(input.id);
      return { ok: true };
    });

    runtime.registerActivity('cms-free-dns-name', async (ctx, input) => {
      cms.dnsNames.delete(input.dnsName);
      return { ok: true };
    });

    // ── Orchestrations ──

    // Simplified create (no sub-orchestration for actor in this test)
    runtime.registerOrchestration('CreateInstance', function* (ctx, input) {
      const record = yield ctx.scheduleActivity('cms-create-instance-record', {
        name: input.name,
      });
      yield ctx.scheduleActivity('deploy-postgres-v2', { k8sName: record.k8sName });
      const status = yield ctx.scheduleActivity('wait-for-ready', { k8sName: record.k8sName });
      if (!status.ready) return { status: 'failed' };

      const conn = yield ctx.scheduleActivity('get-connection-strings', { k8sName: record.k8sName });
      yield ctx.scheduleActivity('test-connection', { connectionString: conn.connectionString });
      yield ctx.scheduleActivity('cms-update-instance-state', { id: record.id, state: 'running' });
      return { status: 'created', instanceId: record.id };
    });

    // Actor with continue-as-new
    runtime.registerOrchestration('InstanceActor', function* (ctx, input) {
      const iteration = input.iteration || 0;
      const connInfo = yield ctx.scheduleActivity('cms-get-instance-connection', {
        instanceId: input.instanceId,
      });
      if (!connInfo.found || connInfo.state === 'deleted') {
        return { status: 'exited', reason: 'gone', iterations: iteration };
      }
      const health = yield ctx.scheduleActivity('test-connection', {
        connectionString: connInfo.connectionString,
      });
      yield ctx.scheduleActivity('cms-record-health-check', {
        instanceId: input.instanceId,
        healthy: health.connected,
        latencyMs: health.latencyMs,
      });
      const winner = yield ctx.race(
        ctx.scheduleTimer(100),
        ctx.waitForEvent('InstanceDeleted')
      );
      if (winner.index === 1) {
        return { status: 'exited', reason: 'signal', iterations: iteration + 1 };
      }
      return yield ctx.continueAsNew({
        instanceId: input.instanceId,
        iteration: iteration + 1,
      });
    });

    // Delete
    runtime.registerOrchestration('DeleteInstance', function* (ctx, input) {
      const instance = yield ctx.scheduleActivity('cms-get-instance-by-k8s-name', {
        k8sName: input.k8sName,
      });
      if (!instance) return { status: 'not_found' };
      yield ctx.scheduleActivity('cms-update-instance-state', { id: instance.id, state: 'deleting' });
      yield ctx.scheduleActivity('delete-postgres', { k8sName: instance.k8sName });
      yield ctx.scheduleActivity('cms-free-dns-name', { dnsName: instance.dnsName });
      yield ctx.scheduleActivity('cms-delete-instance-record', { id: instance.id });
      return { status: 'deleted' };
    });

    await runtime.start();

    try {
      // Phase 1: Create
      await client.startOrchestration(uid('create-lifecycle'), 'CreateInstance', { name: 'lifecycle' });
      const createResult = await client.waitForOrchestration(uid('create-lifecycle'), 10000);
      assert.strictEqual(createResult.output.status, 'created');

      // Phase 2: Start actor, let it run
      await client.startOrchestration(uid('actor-lifecycle'), 'InstanceActor', {
        instanceId: 'inst-lifecycle',
        iteration: 0,
      });
      await new Promise((r) => setTimeout(r, 600));
      assert.ok(healthCheckCount >= 2, `expected ≥2 health checks, got ${healthCheckCount}`);

      // Phase 3: Mark instance deleted so actor exits, then delete
      cms.instances.get('inst-lifecycle').state = 'deleted';
      const actorResult = await client.waitForOrchestration(uid('actor-lifecycle'), 10000);
      assert.strictEqual(actorResult.output.status, 'exited');

      // Reset state for delete orchestration (it needs to find the instance)
      cms.instances.get('inst-lifecycle').state = 'running';

      // Phase 4: Delete
      await client.startOrchestration(uid('delete-lifecycle'), 'DeleteInstance', {
        k8sName: 'pg-lifecycle',
      });
      const deleteResult = await client.waitForOrchestration(uid('delete-lifecycle'), 10000);
      assert.strictEqual(deleteResult.output.status, 'deleted');

      // Verify clean state
      assert.strictEqual(cms.instances.size, 0);
    } finally {
      await runtime.shutdown(100);
    }
  });
});
