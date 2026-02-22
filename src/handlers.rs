use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use duroxide::{ActivityContext, OrchestrationContext};

use crate::client::JsClient;
use crate::types::{GeneratorStepResult, RetryPolicyConfig, ScheduledTask};

// ─── Shared Context Storage ─────────────────────────────────────

// Thread-local for the current activity context — NOT suitable for cross-thread use.
// Activities use call_async which runs JS on the Node thread, so we use a global map instead.

// Global map for activity contexts, keyed by a unique token per invocation.
static ACTIVITY_CTXS: std::sync::LazyLock<Mutex<HashMap<String, ActivityContext>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

static ACTIVITY_TOKEN_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn new_activity_token() -> String {
    let id = ACTIVITY_TOKEN_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("act-{id}")
}

struct ActivityCtxGuard {
    token: String,
}

impl Drop for ActivityCtxGuard {
    fn drop(&mut self) {
        ACTIVITY_CTXS.lock().unwrap().remove(&self.token);
    }
}

/// Called from JS to check if an activity has been cancelled.
pub fn activity_is_cancelled(token: &str) -> bool {
    let map = ACTIVITY_CTXS.lock().unwrap();
    map.get(token).is_some_and(|ctx| ctx.is_cancelled())
}

/// Called from JS to get a Client from the ActivityContext.
pub fn activity_get_client(token: &str) -> Option<JsClient> {
    let map = ACTIVITY_CTXS.lock().unwrap();
    map.get(token).map(|ctx| JsClient::from_client(ctx.get_client()))
}

/// Called from JS to trace through the Rust ActivityContext.
pub fn activity_trace(token: &str, level: &str, message: &str) {
    let map = ACTIVITY_CTXS.lock().unwrap();
    if let Some(ctx) = map.get(token) {
        match level {
            "warn" => ctx.trace_warn(message),
            "error" => ctx.trace_error(message),
            "debug" => ctx.trace_debug(message),
            _ => ctx.trace_info(message),
        }
    }
}

// Global map for orchestration contexts (keyed by instance_id).
// Inserted before calling JS, removed when the handler future is dropped.
static ORCHESTRATION_CTXS: std::sync::LazyLock<Mutex<HashMap<String, OrchestrationContext>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

struct OrchestrationInvokeGuard {
    instance_id: String,
    gen_id: Option<u64>,
    dispose_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
}

impl OrchestrationInvokeGuard {
    fn new(
        instance_id: String,
        dispose_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> Self {
        Self {
            instance_id,
            gen_id: None,
            dispose_fn,
        }
    }

    fn set_gen_id(&mut self, gen_id: u64) {
        self.gen_id = Some(gen_id);
    }
}

impl Drop for OrchestrationInvokeGuard {
    fn drop(&mut self) {
        ORCHESTRATION_CTXS.lock().unwrap().remove(&self.instance_id);

        let Some(gen_id) = self.gen_id.take() else {
            return;
        };

        let Ok(handle) = tokio::runtime::Handle::try_current() else {
            return;
        };

        let dispose_fn = self.dispose_fn.clone();
        tokio::task::block_in_place(|| {
            handle.block_on(async {
                let _: Result<String, _> = dispose_fn.call_async::<String>(gen_id.to_string()).await;
            })
        });
    }
}

/// Called from JS to trace through the Rust OrchestrationContext.
/// Delegates to ctx.trace() which has the correct is_replaying guard.
pub fn orchestration_trace(instance_id: &str, level: &str, message: &str) {
    let map = ORCHESTRATION_CTXS.lock().unwrap();
    if let Some(ctx) = map.get(instance_id) {
        ctx.trace(level, message);
    }
}

/// Called from JS to set custom status on the OrchestrationContext.
pub fn orchestration_set_custom_status(instance_id: &str, status: &str) {
    let map = ORCHESTRATION_CTXS.lock().unwrap();
    if let Some(ctx) = map.get(instance_id) {
        ctx.set_custom_status(status);
    }
}

/// Called from JS to reset (clear) custom status on the OrchestrationContext.
pub fn orchestration_reset_custom_status(instance_id: &str) {
    let map = ORCHESTRATION_CTXS.lock().unwrap();
    if let Some(ctx) = map.get(instance_id) {
        ctx.reset_custom_status();
    }
}

/// Called from JS to read the current custom status from the OrchestrationContext.
pub fn orchestration_get_custom_status(instance_id: &str) -> Option<String> {
    let map = ORCHESTRATION_CTXS.lock().unwrap();
    map.get(instance_id).and_then(|ctx| ctx.get_custom_status())
}

// ─── Activity Bridge ─────────────────────────────────────────────

/// Wraps a JS async function as a Rust ActivityHandler.
pub struct JsActivityHandler {
    name: String,
    callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
}

impl JsActivityHandler {
    pub fn new(name: String, callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>) -> Self {
        Self { name, callback }
    }

    pub async fn invoke(&self, ctx: ActivityContext, input: String) -> Result<String, String> {
        // Store ctx in global map with a unique token so JS trace calls can find it
        let token = new_activity_token();
        ACTIVITY_CTXS.lock().unwrap().insert(token.clone(), ctx.clone());
        let _guard = ActivityCtxGuard { token: token.clone() };

        // Build a context info object as JSON for the JS side
        let ctx_info = serde_json::json!({
            "instanceId": ctx.instance_id(),
            "executionId": ctx.execution_id(),
            "orchestrationName": ctx.orchestration_name(),
            "orchestrationVersion": ctx.orchestration_version(),
            "activityName": ctx.activity_name(),
            "workerId": ctx.worker_id(),
            "sessionId": ctx.session_id(),
            "_traceToken": token,
        });

        // Send "ctxJson\ninput" to JS
        let payload = format!("{}\n{}", ctx_info, input);

        let result: String = self
            .callback
            .call_async::<napi::bindgen_prelude::Promise<String>>(payload)
            .await
            .map_err(|e| format!("Activity '{}' JS call failed: {}", self.name, e))?
            .await
            .map_err(|e| format!("Activity '{}' JS execution failed: {}", self.name, e))?;

        Ok(result)
    }
}

// ─── Orchestration Bridge ────────────────────────────────────────

/// Wraps a JS generator-based orchestration as a Rust OrchestrationHandler.
///
/// Architecture:
/// - JS side: user writes `function*(ctx, input) { yield ctx.scheduleActivity(...) }`
/// - The generator yields ScheduledTask descriptors
/// - Rust handler loop: get next task from JS → execute with real DurableFuture → feed result back
pub struct JsOrchestrationHandler {
    /// Called to create the generator and drive the first step.
    /// Input: JSON string with { input, ctxInfo }
    /// Returns: GeneratorStepResult as JSON
    create_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,

    /// Called to drive the generator one step with a result.
    /// Input: JSON string with { generatorId, result, isError }
    /// Returns: GeneratorStepResult as JSON
    next_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,

    /// Called to dispose of a generator.
    /// Input: generatorId as string
    dispose_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
}

impl JsOrchestrationHandler {
    pub fn new(
        create_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        next_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        dispose_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> Self {
        Self {
            create_fn,
            next_fn,
            dispose_fn,
        }
    }

    /// Call the JS create function synchronously using block_in_place.
    /// This is necessary because the replay engine's poll_once() drops the handler
    /// future before an async call_async can complete (the JS callback fires on the
    /// event loop thread, which is separate from the tokio thread).
    fn call_create_blocking(&self, payload: String) -> Result<GeneratorStepResult, String> {
        let create_fn = self.create_fn.clone();
        let json_str: String = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                create_fn
                    .call_async::<String>(payload)
                    .await
                    .map_err(|e| format!("Generator create failed: {e}"))
            })
        })?;
        serde_json::from_str(&json_str).map_err(|e| format!("Invalid generator step result: {e}"))
    }

    fn call_next_blocking(
        &self,
        gen_id: u64,
        result: &str,
        is_error: bool,
    ) -> Result<GeneratorStepResult, String> {
        let payload = serde_json::json!({
            "generatorId": gen_id,
            "result": result,
            "isError": is_error,
        })
        .to_string();

        let next_fn = self.next_fn.clone();
        let json_str: String = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                next_fn
                    .call_async::<String>(payload)
                    .await
                    .map_err(|e| format!("Generator next failed: {e}"))
            })
        })?;
        serde_json::from_str(&json_str).map_err(|e| format!("Invalid generator step result: {e}"))
    }

    #[allow(dead_code)]
    fn call_dispose_blocking(&self, gen_id: u64) {
        let dispose_fn = self.dispose_fn.clone();
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let _: Result<String, _> = dispose_fn
                    .call_async::<String>(gen_id.to_string())
                    .await;
            })
        });
    }

    /// Execute a ScheduledTask using the real OrchestrationContext.
    async fn execute_task(
        &self,
        ctx: &OrchestrationContext,
        task: ScheduledTask,
    ) -> TaskResult {
        match task {
            ScheduledTask::Activity { name, input, session_id } => {
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_on_session(&name, input, sid).await
                } else {
                    ctx.schedule_activity(&name, input).await
                };
                match result {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::ActivityWithRetry { name, input, retry, session_id } => {
                let policy = convert_retry_policy(&retry);
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_with_retry_on_session(&name, input, policy, sid).await
                } else {
                    ctx.schedule_activity_with_retry(&name, input, policy).await
                };
                match result {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::Timer { delay_ms } => {
                ctx.schedule_timer(Duration::from_millis(delay_ms)).await;
                TaskResult::Ok("null".to_string())
            }
            ScheduledTask::WaitEvent { name } => {
                let data = ctx.schedule_wait(&name).await;
                TaskResult::Ok(data)
            }
            ScheduledTask::SubOrchestration { name, input } => {
                match ctx.schedule_sub_orchestration(&name, input).await {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::SubOrchestrationWithId {
                name,
                instance_id,
                input,
            } => {
                match ctx
                    .schedule_sub_orchestration_with_id(&name, instance_id, input)
                    .await
                {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::Orchestration { name, instance_id, input } => {
                ctx.schedule_orchestration(&name, &instance_id, input);
                TaskResult::Ok("null".to_string())
            }
            ScheduledTask::OrchestrationVersioned { name, version, instance_id, input } => {
                ctx.schedule_orchestration_versioned(&name, version, &instance_id, input);
                TaskResult::Ok("null".to_string())
            }
            ScheduledTask::SubOrchestrationVersioned { name, version, input } => {
                match ctx.schedule_sub_orchestration_versioned(&name, version, input).await {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::SubOrchestrationVersionedWithId { name, version, instance_id, input } => {
                match ctx
                    .schedule_sub_orchestration_versioned_with_id(&name, version, instance_id, input)
                    .await
                {
                    Ok(val) => TaskResult::Ok(val),
                    Err(err) => TaskResult::Err(err),
                }
            }
            ScheduledTask::NewGuid => {
                match ctx.new_guid().await {
                    Ok(g) => TaskResult::Ok(format!("\"{}\"", g)),
                    Err(e) => TaskResult::Err(e),
                }
            }
            ScheduledTask::UtcNow => {
                match ctx.utc_now().await {
                    Ok(t) => {
                        let ms = t
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis();
                        TaskResult::Ok(ms.to_string())
                    }
                    Err(e) => TaskResult::Err(e),
                }
            }
            ScheduledTask::ContinueAsNew { input } => {
                match ctx.continue_as_new(input).await {
                    Ok(_) => TaskResult::Ok("null".to_string()),
                    Err(e) => TaskResult::Err(e),
                }
            }
            ScheduledTask::ContinueAsNewVersioned { input, version } => {
                let result = if let Some(ver) = version {
                    ctx.continue_as_new_versioned(ver, input).await
                } else {
                    ctx.continue_as_new(input).await
                };
                match result {
                    Ok(_) => TaskResult::Ok("null".to_string()),
                    Err(e) => TaskResult::Err(e),
                }
            }
            ScheduledTask::DequeueEvent { queue_name } => {
                let data = ctx.dequeue_event(&queue_name).await;
                TaskResult::Ok(data)
            }
            ScheduledTask::Join { tasks } => {
                // Reject nested join/select — recursive async requires Pin<Box> gymnastics
                // and nested composition is not a meaningful pattern.
                for t in &tasks {
                    match t {
                        ScheduledTask::Join { .. } | ScheduledTask::Select { .. } => {
                            return TaskResult::Err(
                                "nested join/select inside join is not supported".to_string(),
                            );
                        }
                        _ => {}
                    }
                }

                // Normalize all tasks to the same boxed future type so ctx.join() works
                // regardless of whether they're activities, timers, waits, etc.
                let futures: Vec<std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + '_>>> = tasks
                    .into_iter()
                    .map(|t| make_join_future(ctx, t))
                    .collect();

                let results = ctx.join(futures).await;
                let json_results: Vec<serde_json::Value> = results
                    .into_iter()
                    .map(|v| {
                        // Parse the inner JSON value (which make_join_future serialized)
                        serde_json::from_str::<serde_json::Value>(&v)
                            .unwrap_or(serde_json::Value::String(v))
                    })
                    .collect();
                TaskResult::Ok(serde_json::to_string(&json_results).unwrap())
            }
            ScheduledTask::Select { tasks } => {
                if tasks.len() != 2 {
                    return TaskResult::Err("select currently supports exactly 2 tasks".to_string());
                }
                // Reject nested join/select
                for t in &tasks {
                    match t {
                        ScheduledTask::Join { .. } | ScheduledTask::Select { .. } => {
                            return TaskResult::Err(
                                "nested join/select inside select is not supported".to_string(),
                            );
                        }
                        _ => {}
                    }
                }
                let mut iter = tasks.into_iter();
                let t1 = iter.next().unwrap();
                let t2 = iter.next().unwrap();

                // Convert each task to a boxed future returning Result<String, String>
                let f1 = make_select_future(ctx, t1);
                let f2 = make_select_future(ctx, t2);

                match ctx.select2(f1, f2).await {
                    duroxide::Either2::First(val) => {
                        // Parse val as JSON so it's embedded as a structured value,
                        // not double-serialized as a JSON string.
                        let parsed = serde_json::from_str::<serde_json::Value>(&val)
                            .unwrap_or(serde_json::Value::String(val));
                        TaskResult::Ok(
                            serde_json::json!({ "index": 0, "value": parsed }).to_string(),
                        )
                    }
                    duroxide::Either2::Second(val) => {
                        let parsed = serde_json::from_str::<serde_json::Value>(&val)
                            .unwrap_or(serde_json::Value::String(val));
                        TaskResult::Ok(
                            serde_json::json!({ "index": 1, "value": parsed }).to_string(),
                        )
                    }
                }
            }
        }
    }
}

enum TaskResult {
    Ok(String),
    Err(String),
}

/// Convert a ScheduledTask into a type-erased future returning a raw string for use in select.
/// Activity/sub-orch errors are flattened (Ok and Err both become the raw string value).
fn make_select_future(
    ctx: &OrchestrationContext,
    task: ScheduledTask,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + '_>> {
    match task {
        ScheduledTask::Activity { name, input, session_id } => {
            Box::pin(async move {
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_on_session(&name, input, sid).await
                } else {
                    ctx.schedule_activity(&name, input).await
                };
                match result {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        ScheduledTask::ActivityWithRetry { name, input, retry, session_id } => {
            Box::pin(async move {
                let policy = convert_retry_policy(&retry);
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_with_retry_on_session(&name, input, policy, sid).await
                } else {
                    ctx.schedule_activity_with_retry(&name, input, policy).await
                };
                match result {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        ScheduledTask::Timer { delay_ms } => {
            Box::pin(async move {
                ctx.schedule_timer(Duration::from_millis(delay_ms)).await;
                "null".to_string()
            })
        }
        ScheduledTask::WaitEvent { name } => {
            Box::pin(async move {
                ctx.schedule_wait(&name).await
            })
        }
        ScheduledTask::DequeueEvent { queue_name } => {
            Box::pin(async move {
                ctx.dequeue_event(&queue_name).await
            })
        }
        ScheduledTask::SubOrchestration { name, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration(&name, input).await {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        ScheduledTask::SubOrchestrationWithId { name, instance_id, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_with_id(&name, instance_id, input).await {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        ScheduledTask::SubOrchestrationVersioned { name, version, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_versioned(&name, version, input).await {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        ScheduledTask::SubOrchestrationVersionedWithId { name, version, instance_id, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_versioned_with_id(&name, version, instance_id, input).await {
                    Ok(v) => v,
                    Err(e) => e,
                }
            })
        }
        _ => Box::pin(async { "unsupported task in select".to_string() }),
    }
}

/// Wrap a raw string value as `{"ok": <parsed>}` or `{"err": <parsed>}` JSON.
/// Parses the string as JSON first to avoid double-serialization.
fn wrap_ok(val: String) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(&val)
        .unwrap_or(serde_json::Value::String(val));
    serde_json::json!({ "ok": parsed }).to_string()
}

fn wrap_err(val: String) -> String {
    let parsed = serde_json::from_str::<serde_json::Value>(&val)
        .unwrap_or(serde_json::Value::String(val));
    serde_json::json!({ "err": parsed }).to_string()
}

/// Convert a ScheduledTask into a type-erased future returning `{ok:v}/{err:e}` JSON for use in join.
/// Unlike make_select_future, this preserves the ok/err distinction so JS can tell success from failure.
fn make_join_future(
    ctx: &OrchestrationContext,
    task: ScheduledTask,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send + '_>> {
    match task {
        ScheduledTask::Activity { name, input, session_id } => {
            Box::pin(async move {
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_on_session(&name, input, sid).await
                } else {
                    ctx.schedule_activity(&name, input).await
                };
                match result {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        ScheduledTask::ActivityWithRetry { name, input, retry, session_id } => {
            Box::pin(async move {
                let policy = convert_retry_policy(&retry);
                let result = if let Some(sid) = session_id {
                    ctx.schedule_activity_with_retry_on_session(&name, input, policy, sid).await
                } else {
                    ctx.schedule_activity_with_retry(&name, input, policy).await
                };
                match result {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        ScheduledTask::Timer { delay_ms } => {
            Box::pin(async move {
                ctx.schedule_timer(Duration::from_millis(delay_ms)).await;
                serde_json::json!({ "ok": null }).to_string()
            })
        }
        ScheduledTask::WaitEvent { name } => {
            Box::pin(async move {
                let data = ctx.schedule_wait(&name).await;
                wrap_ok(data)
            })
        }
        ScheduledTask::DequeueEvent { queue_name } => {
            Box::pin(async move {
                let data = ctx.dequeue_event(&queue_name).await;
                wrap_ok(data)
            })
        }
        ScheduledTask::SubOrchestration { name, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration(&name, input).await {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        ScheduledTask::SubOrchestrationWithId { name, instance_id, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_with_id(&name, instance_id, input).await {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        ScheduledTask::SubOrchestrationVersioned { name, version, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_versioned(&name, version, input).await {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        ScheduledTask::SubOrchestrationVersionedWithId { name, version, instance_id, input } => {
            Box::pin(async move {
                match ctx.schedule_sub_orchestration_versioned_with_id(&name, version, instance_id, input).await {
                    Ok(v) => wrap_ok(v),
                    Err(e) => wrap_err(e),
                }
            })
        }
        _ => Box::pin(async { serde_json::json!({ "err": "unsupported task in join" }).to_string() }),
    }
}

#[async_trait::async_trait]
impl duroxide::runtime::OrchestrationHandler for JsOrchestrationHandler {
    async fn invoke(&self, ctx: OrchestrationContext, input: String) -> Result<String, String> {
        let instance_id = ctx.instance_id().to_string();

        // Store ctx in global map so JS trace calls can delegate to it
        ORCHESTRATION_CTXS.lock().unwrap().insert(instance_id.clone(), ctx.clone());
        let mut guard = OrchestrationInvokeGuard::new(instance_id.clone(), self.dispose_fn.clone());

        let ctx_info = serde_json::json!({
            "instanceId": ctx.instance_id(),
            "executionId": ctx.execution_id(),
            "orchestrationName": ctx.orchestration_name(),
            "orchestrationVersion": ctx.orchestration_version(),
        });

        let payload = serde_json::json!({
            "ctxInfo": ctx_info,
            "input": input,
        })
        .to_string();

        // Step 1: Create generator and get first step (blocking call to JS)
        let first_step = self.call_create_blocking(payload)?;

        let (gen_id, mut current_step) = match first_step {
            GeneratorStepResult::Completed { output } => return Ok(output),
            GeneratorStepResult::Error { message } => return Err(message),
            GeneratorStepResult::Yielded {
                generator_id,
                task,
            } => {
                guard.set_gen_id(generator_id);
                (generator_id, task)
            }
        };

        // Step 2: Execute task → feed result back → repeat
        loop {
            let result = self.execute_task(&ctx, current_step).await;

            let (result_str, is_error) = match result {
                TaskResult::Ok(val) => (val, false),
                TaskResult::Err(err) => (err, true),
            };

            let next_step = self.call_next_blocking(gen_id, &result_str, is_error)?;

            match next_step {
                GeneratorStepResult::Completed { output } => return Ok(output),
                GeneratorStepResult::Error { message } => return Err(message),
                GeneratorStepResult::Yielded { task, .. } => {
                    current_step = task;
                }
            }
        }
    }
}

fn convert_retry_policy(config: &RetryPolicyConfig) -> duroxide::RetryPolicy {
    let mut policy = duroxide::RetryPolicy::new(config.max_attempts);
    if let Some(ms) = config.timeout_ms {
        policy = policy.with_timeout(Duration::from_millis(ms));
    }
    if let Some(ms) = config.total_timeout_ms {
        policy = policy.with_total_timeout(Duration::from_millis(ms));
    }
    if let Some(ref backoff) = config.backoff {
        let strategy = match backoff.as_str() {
            "exponential" => duroxide::BackoffStrategy::Exponential {
                base: Duration::from_millis(100),
                multiplier: 2.0,
                max: Duration::from_secs(30),
            },
            "fixed" => duroxide::BackoffStrategy::Fixed {
                delay: Duration::from_secs(1),
            },
            _ => duroxide::BackoffStrategy::Linear {
                base: Duration::from_millis(100),
                max: Duration::from_secs(30),
            },
        };
        policy = policy.with_backoff(strategy);
    }
    policy
}
