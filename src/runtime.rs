// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;
use std::time::{Duration, Instant};

use duroxide::runtime::OrchestrationHandler;
use duroxide::runtime::{self, OrchestrationRegistry};

use duroxide::providers::TagFilter;
use duroxide::runtime::LogFormat;

use crate::handlers::{JsActivityHandler, JsOrchestrationHandler};
use crate::pg_provider::JsPostgresProvider;
use crate::provider::JsSqliteProvider;
use crate::types::JsMetricsSnapshot;

/// Runtime options configurable from JavaScript.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsRuntimeOptions {
    /// Orchestration concurrency (default: 4)
    pub orchestration_concurrency: Option<i32>,
    /// Worker/activity concurrency (default: 8)
    pub worker_concurrency: Option<i32>,
    /// Dispatcher poll interval in ms (default: 100)
    pub dispatcher_poll_interval_ms: Option<i64>,
    /// Worker lock timeout in ms (default: 30000). Controls how often the activity
    /// manager renews locks, which affects cancellation detection speed.
    pub worker_lock_timeout_ms: Option<i64>,
    /// Log format: "json", "pretty", or "compact" (default)
    pub log_format: Option<String>,
    /// Log level filter: "info", "debug", "warn", "error", etc.
    pub log_level: Option<String>,
    /// Service name for identification in logs/metrics
    pub service_name: Option<String>,
    /// Optional service version
    pub service_version: Option<String>,
    /// Maximum concurrent sessions per runtime (default: 10)
    pub max_sessions_per_runtime: Option<i32>,
    /// Session idle timeout in ms (default: 300000 = 5 minutes)
    pub session_idle_timeout_ms: Option<i64>,
    /// Stable worker identity for session ownership (e.g., K8s pod name)
    pub worker_node_id: Option<String>,
    /// Worker tag filter mode: "defaultOnly" (default), "any", "none", "tags", or "defaultAnd".
    /// When "tags" or "defaultAnd", provide the tag list in `worker_tag_filter_tags`.
    pub worker_tag_filter: Option<String>,
    /// Tag list for "tags" or "defaultAnd" filter modes.
    pub worker_tag_filter_tags: Option<Vec<String>>,
}

/// Builder for the duroxide runtime, wrapping registration and startup.
#[napi]
pub struct JsRuntime {
    provider: Arc<dyn duroxide::providers::Provider>,
    activity_builders: Vec<(String, ThreadsafeFunction<String, ErrorStrategy::Fatal>)>,
    orchestration_names: Vec<(String, Option<String>)>,
    create_fn: Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
    next_fn: Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
    dispose_fn: Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
    options: Option<JsRuntimeOptions>,
    inner: Option<Arc<runtime::Runtime>>,
    callback_refs: Vec<ThreadsafeFunction<String, ErrorStrategy::Fatal>>,
    started: bool,
    shutdown_requested: bool,
    startup_error: Option<runtime::RuntimeStartError>,
    #[cfg(feature = "test-hooks")]
    pub(crate) test_hooks: runtime::test_hooks::LifecycleHooks,
}

#[napi]
impl JsRuntime {
    #[napi(constructor)]
    pub fn new(provider: &JsSqliteProvider, options: Option<JsRuntimeOptions>) -> Self {
        Self {
            provider: provider.inner.clone(),
            activity_builders: Vec::new(),
            orchestration_names: Vec::new(),
            create_fn: None,
            next_fn: None,
            dispose_fn: None,
            options,
            inner: None,
            callback_refs: Vec::new(),
            started: false,
            shutdown_requested: false,
            startup_error: None,
            #[cfg(feature = "test-hooks")]
            test_hooks: runtime::test_hooks::LifecycleHooks::default(),
        }
    }

    /// Create a runtime backed by PostgreSQL.
    #[napi(factory, js_name = "fromPostgres")]
    pub fn from_postgres(provider: &JsPostgresProvider, options: Option<JsRuntimeOptions>) -> Self {
        Self {
            provider: provider.inner.clone(),
            activity_builders: Vec::new(),
            orchestration_names: Vec::new(),
            create_fn: None,
            next_fn: None,
            dispose_fn: None,
            options,
            inner: None,
            callback_refs: Vec::new(),
            started: false,
            shutdown_requested: false,
            startup_error: None,
            #[cfg(feature = "test-hooks")]
            test_hooks: runtime::test_hooks::LifecycleHooks::default(),
        }
    }

    /// Set the generator driver functions (called once from JS before registering orchestrations).
    /// These three functions handle: creating generators, driving next steps, and disposing.
    #[napi]
    pub fn set_generator_driver(
        &mut self,
        create_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        next_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
        dispose_fn: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> Result<()> {
        self.ensure_configurable()?;
        self.create_fn = Some(create_fn);
        self.next_fn = Some(next_fn);
        self.dispose_fn = Some(dispose_fn);
        Ok(())
    }

    /// Register a JavaScript activity function.
    /// The JS function receives (contextInfoJson, input) and returns a Promise<string>.
    #[napi]
    pub fn register_activity(
        &mut self,
        name: String,
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) -> Result<()> {
        self.ensure_configurable()?;
        self.activity_builders.push((name, callback));
        Ok(())
    }

    /// Register a JavaScript orchestration (generator function).
    /// The orchestration name is used for both registration and the generator function lookup.
    #[napi]
    pub fn register_orchestration(&mut self, name: String) -> Result<()> {
        self.ensure_configurable()?;
        self.orchestration_names.push((name, None));
        Ok(())
    }

    /// Register a versioned JavaScript orchestration.
    #[napi]
    pub fn register_orchestration_versioned(
        &mut self,
        name: String,
        version: String,
    ) -> Result<()> {
        self.ensure_configurable()?;
        self.orchestration_names.push((name, Some(version)));
        Ok(())
    }

    /// Start the runtime. This processes orchestrations and activities until shutdown.
    ///
    /// # Safety
    /// This is async and takes &mut self. napi-rs requires async &mut methods to be marked unsafe.
    #[napi]
    pub async unsafe fn start(&mut self) -> Result<()> {
        self.ensure_configurable()?;
        if self.create_fn.is_none() || self.next_fn.is_none() || self.dispose_fn.is_none() {
            return Err(Error::from_reason(
                "lifecycle_start_failed: generator driver not set",
            ));
        }
        self.started = true;
        let prepared = catch_unwind(AssertUnwindSafe(|| {
            let mut callback_refs: Vec<_> = self
                .activity_builders
                .iter()
                .map(|(_, callback)| callback.clone())
                .collect();

            // Build activity registry
            let mut activity_builder = duroxide::runtime::registry::ActivityRegistry::builder();
            for (name, callback) in self.activity_builders.drain(..) {
                let handler = Arc::new(JsActivityHandler::new(name.clone(), callback));
                activity_builder = activity_builder.register(&name, move |ctx, input| {
                    let h = handler.clone();
                    async move { h.invoke(ctx, input).await }
                });
            }
            let activities = activity_builder.build();

            // Build orchestration registry
            let create_fn = self
                .create_fn
                .take()
                .ok_or(runtime::RuntimeStartError::StartupFailed)?;
            let next_fn = self
                .next_fn
                .take()
                .ok_or(runtime::RuntimeStartError::StartupFailed)?;
            let dispose_fn = self
                .dispose_fn
                .take()
                .ok_or(runtime::RuntimeStartError::StartupFailed)?;
            callback_refs.extend([create_fn.clone(), next_fn.clone(), dispose_fn.clone()]);

            let mut orch_builder = OrchestrationRegistry::builder();
            for (name, version) in self.orchestration_names.drain(..) {
                let handler = Arc::new(JsOrchestrationHandler::new(
                    create_fn.clone(),
                    next_fn.clone(),
                    dispose_fn.clone(),
                ));
                if let Some(ver) = version {
                    orch_builder =
                        orch_builder.register_versioned(&name, &ver, move |ctx, input| {
                            let h = handler.clone();
                            async move { h.invoke(ctx, input).await }
                        });
                } else {
                    orch_builder = orch_builder.register(&name, move |ctx, input| {
                        let h = handler.clone();
                        async move { h.invoke(ctx, input).await }
                    });
                }
            }
            let orchestrations = orch_builder.build();

            // Build runtime options
            let mut rt_options = runtime::RuntimeOptions::default();
            if let Some(ref opts) = self.options {
                if let Some(c) = opts.orchestration_concurrency {
                    rt_options.orchestration_concurrency = c as usize;
                }
                if let Some(c) = opts.worker_concurrency {
                    rt_options.worker_concurrency = c as usize;
                }
                if let Some(ms) = opts.dispatcher_poll_interval_ms {
                    rt_options.dispatcher_min_poll_interval = Duration::from_millis(ms as u64);
                }
                if let Some(ms) = opts.worker_lock_timeout_ms {
                    rt_options.worker_lock_timeout = Duration::from_millis(ms as u64);
                }
                if let Some(ref fmt) = opts.log_format {
                    rt_options.observability.log_format = match fmt.as_str() {
                        "json" => LogFormat::Json,
                        "pretty" => LogFormat::Pretty,
                        _ => LogFormat::Compact,
                    };
                }
                if let Some(ref level) = opts.log_level {
                    rt_options.observability.log_level = level.clone();
                }
                if let Some(ref name) = opts.service_name {
                    rt_options.observability.service_name = name.clone();
                }
                if let Some(ref ver) = opts.service_version {
                    rt_options.observability.service_version = Some(ver.clone());
                }
                if let Some(max) = opts.max_sessions_per_runtime {
                    rt_options.max_sessions_per_runtime = max as usize;
                }
                if let Some(ms) = opts.session_idle_timeout_ms {
                    rt_options.session_idle_timeout = Duration::from_millis(ms as u64);
                }
                if let Some(ref nid) = opts.worker_node_id {
                    rt_options.worker_node_id = Some(nid.clone());
                }
                if let Some(ref filter) = opts.worker_tag_filter {
                    rt_options.worker_tag_filter = match filter.as_str() {
                        "defaultOnly" => TagFilter::DefaultOnly,
                        "any" => TagFilter::Any,
                        "none" => TagFilter::None,
                        "tags" => {
                            let tags = opts.worker_tag_filter_tags.clone().unwrap_or_default();
                            TagFilter::Tags(tags.into_iter().collect())
                        }
                        "defaultAnd" => {
                            let tags = opts.worker_tag_filter_tags.clone().unwrap_or_default();
                            TagFilter::DefaultAnd(tags.into_iter().collect())
                        }
                        _ => TagFilter::DefaultOnly,
                    };
                }
            }

            let provider = self.provider.clone();
            #[cfg(feature = "test-hooks")]
            let provider = Arc::new(runtime::test_hooks::TestProvider::new(
                provider,
                self.test_hooks.clone(),
            ));
            let rt = runtime::Runtime::prepare(provider, activities, orchestrations, rt_options)?;
            self.callback_refs = callback_refs;
            Ok::<_, runtime::RuntimeStartError>(rt)
        }));
        let rt = match prepared {
            Ok(result) => result,
            Err(payload) => {
                // Payload destruction must not reintroduce a panic across the language boundary.
                if let Err(secondary) = catch_unwind(AssertUnwindSafe(|| drop(payload))) {
                    std::mem::forget(secondary);
                }
                Err(runtime::RuntimeStartError::StartupFailed)
            }
        }
        .map_err(|error| {
            self.startup_error = Some(error);
            start_error(error)
        })?;
        self.inner = Some(rt.clone());
        #[cfg(feature = "test-hooks")]
        rt.set_lifecycle_hooks(self.test_hooks.clone())
            .map_err(|error| {
                self.startup_error = Some(error);
                start_error(error)
            })?;
        rt.start_execution().await.map_err(|error| {
            self.startup_error = Some(error);
            start_error(error)
        })
    }

    /// Get a snapshot of runtime metrics.
    #[napi]
    pub fn metrics_snapshot(&self) -> Option<JsMetricsSnapshot> {
        if self.shutdown_requested || self.startup_error.is_some() {
            return None;
        }
        self.inner
            .as_ref()?
            .metrics_snapshot()
            .map(|m| JsMetricsSnapshot {
                orch_starts: m.orch_starts as i64,
                orch_completions: m.orch_completions as i64,
                orch_failures: m.orch_failures as i64,
                orch_application_errors: m.orch_application_errors as i64,
                orch_infrastructure_errors: m.orch_infrastructure_errors as i64,
                orch_configuration_errors: m.orch_configuration_errors as i64,
                orch_poison: m.orch_poison as i64,
                activity_success: m.activity_success as i64,
                activity_app_errors: m.activity_app_errors as i64,
                activity_infra_errors: m.activity_infra_errors as i64,
                activity_config_errors: m.activity_config_errors as i64,
                activity_poison: m.activity_poison as i64,
                orch_dispatcher_items_fetched: m.orch_dispatcher_items_fetched as i64,
                worker_dispatcher_items_fetched: m.worker_dispatcher_items_fetched as i64,
                orch_continue_as_new: m.orch_continue_as_new as i64,
                suborchestration_calls: m.suborchestration_calls as i64,
                provider_errors: m.provider_errors as i64,
            })
    }

    /// Stop with bounded waiting. Do not overlap lifecycle/registration calls.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn shutdown(&mut self, env: Env, timeout_ms: Option<i64>) -> Result<napi::JsObject> {
        let (grace, grace_deadline, total_deadline) = shutdown_deadlines(timeout_ms)?;
        if let Some(rt) = &self.inner {
            rt.request_shutdown_until(grace_deadline, total_deadline)
                .map_err(shutdown_error)?;
        }
        self.shutdown_requested = true;
        if self.inner.is_none() {
            self.activity_builders.clear();
            self.orchestration_names.clear();
            self.create_fn = None;
            self.next_fn = None;
            self.dispose_fn = None;
        }
        let runtime = self.inner.clone();
        let startup_error = self.startup_error;
        let mut callbacks = self.callback_refs.clone();
        env.execute_tokio_future(
            async move {
                Ok(match runtime {
                    Some(runtime) => Some(runtime.shutdown_with_grace(grace).await),
                    None => None,
                })
            },
            move |env, result| {
                let quiescent = match result {
                    None | Some(Ok(_)) => true,
                    Some(Err(error)) => error.is_quiescent(),
                };
                // Keep the core completion record, without keeping Node's event loop
                // alive after retirement. N-API unref must run on the JS thread.
                if quiescent {
                    for callback in &mut callbacks {
                        callback.unref(env).map_err(|_| {
                            Error::from_reason(
                                "lifecycle_shutdown_failed: callback event-loop reference release failed",
                            )
                        })?;
                    }
                }
                match result {
                    Some(result) => result.map_err(shutdown_error).and_then(|_| {
                        startup_error.map_or(Ok(()), |error| Err(start_error(error)))
                    }),
                    None => startup_error.map_or(Ok(()), |error| Err(start_error(error))),
                }
            },
        )
    }
}

impl JsRuntime {
    fn ensure_configurable(&self) -> Result<()> {
        if self.started || self.shutdown_requested {
            return Err(Error::from_reason(
                "lifecycle_terminal: runtime has already started or shutdown was requested",
            ));
        }
        Ok(())
    }
}

fn start_error(error: runtime::RuntimeStartError) -> Error {
    Error::from_reason(format!("lifecycle_start_failed: {error}"))
}

fn shutdown_error(error: runtime::RuntimeShutdownError) -> Error {
    let category = match error {
        runtime::RuntimeShutdownError::TimedOut => "lifecycle_shutdown_timed_out",
        runtime::RuntimeShutdownError::InvalidTimeouts
        | runtime::RuntimeShutdownError::DeadlineOverflow => "lifecycle_invalid_timeout",
        _ => "lifecycle_shutdown_failed",
    };
    Error::from_reason(format!("{category}: {error}"))
}

fn shutdown_deadlines(timeout_ms: Option<i64>) -> Result<(Duration, Instant, Instant)> {
    let invalid = || {
        Error::from_reason(
        "lifecycle_invalid_timeout: timeoutMs must be a nonnegative supported millisecond duration",
    )
    };
    let millis = u64::try_from(timeout_ms.unwrap_or(1000)).map_err(|_| invalid())?;
    let grace = Duration::from_millis(millis);
    let total = grace
        .checked_add(Duration::from_secs(5))
        .ok_or_else(invalid)?;
    if total > Duration::from_nanos(u64::MAX) {
        return Err(invalid());
    }
    let now = Instant::now();
    let grace_deadline = now.checked_add(grace).ok_or_else(invalid)?;
    let total_deadline = now.checked_add(total).ok_or_else(invalid)?;
    total_deadline
        .checked_add(Duration::from_millis(1))
        .ok_or_else(invalid)?;
    Ok((grace, grace_deadline, total_deadline))
}
