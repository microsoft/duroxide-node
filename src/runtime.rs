use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ErrorStrategy, ThreadsafeFunction};
use napi_derive::napi;
use std::sync::Arc;
use std::time::Duration;

use duroxide::runtime::{self, OrchestrationRegistry};
use duroxide::runtime::OrchestrationHandler;

use crate::handlers::{JsActivityHandler, JsOrchestrationHandler};
use crate::provider::JsSqliteProvider;
use crate::pg_provider::JsPostgresProvider;

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
    ) {
        self.create_fn = Some(create_fn);
        self.next_fn = Some(next_fn);
        self.dispose_fn = Some(dispose_fn);
    }

    /// Register a JavaScript activity function.
    /// The JS function receives (contextInfoJson, input) and returns a Promise<string>.
    #[napi]
    pub fn register_activity(
        &mut self,
        name: String,
        callback: ThreadsafeFunction<String, ErrorStrategy::Fatal>,
    ) {
        self.activity_builders.push((name, callback));
    }

    /// Register a JavaScript orchestration (generator function).
    /// The orchestration name is used for both registration and the generator function lookup.
    #[napi]
    pub fn register_orchestration(&mut self, name: String) {
        self.orchestration_names.push((name, None));
    }

    /// Register a versioned JavaScript orchestration.
    #[napi]
    pub fn register_orchestration_versioned(&mut self, name: String, version: String) {
        self.orchestration_names.push((name, Some(version)));
    }

    /// Start the runtime. This processes orchestrations and activities until shutdown.
    ///
    /// # Safety
    /// This is async and takes &mut self. napi-rs requires async &mut methods to be marked unsafe.
    #[napi]
    pub async unsafe fn start(&mut self) -> Result<()> {
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
            .ok_or_else(|| Error::from_reason("Generator driver not set. Call setGeneratorDriver() before start()."))?;
        let next_fn = self
            .next_fn
            .take()
            .ok_or_else(|| Error::from_reason("Generator driver not set."))?;
        let dispose_fn = self
            .dispose_fn
            .take()
            .ok_or_else(|| Error::from_reason("Generator driver not set."))?;

        let mut orch_builder = OrchestrationRegistry::builder();
        for (name, version) in self.orchestration_names.drain(..) {
            let handler = Arc::new(JsOrchestrationHandler::new(
                create_fn.clone(),
                next_fn.clone(),
                dispose_fn.clone(),
            ));
            if let Some(ver) = version {
                orch_builder = orch_builder.register_versioned(&name, &ver, move |ctx, input| {
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
        }

        let provider = self.provider.clone();
        let rt = runtime::Runtime::start_with_options(
            provider,
            activities,
            orchestrations,
            rt_options,
        )
        .await;

        self.inner = Some(rt);
        Ok(())
    }

    /// Shutdown the runtime gracefully.
    #[napi]
    pub async unsafe fn shutdown(&mut self, timeout_ms: Option<i64>) -> Result<()> {
        if let Some(rt) = self.inner.take() {
            let timeout = timeout_ms.map(|ms| ms as u64);
            rt.shutdown(timeout).await;
        }
        Ok(())
    }
}
