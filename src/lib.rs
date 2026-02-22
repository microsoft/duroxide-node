#![deny(clippy::all)]

extern crate napi_derive;

mod client;
mod handlers;
mod pg_provider;
mod provider;
mod runtime;
mod types;

pub use client::JsClient;
pub use pg_provider::JsPostgresProvider;
pub use provider::JsSqliteProvider;
pub use runtime::{JsRuntime, JsRuntimeOptions};
pub use types::{JsOrchestrationStatus, JsQueueDepths, JsSystemMetrics};

/// Emit an activity trace through the current Rust ActivityContext.
/// Delegates to ActivityContext.trace_info/warn/error/debug which includes
/// all structured fields (instance_id, activity_name, activity_id, worker_id, etc.)
#[napi_derive::napi]
pub fn activity_trace_log(token: String, level: String, message: String) {
    handlers::activity_trace(&token, &level, &message);
}

/// Emit an orchestration trace through the Rust OrchestrationContext.
/// Delegates to OrchestrationContext.trace() which checks is_replaying
/// and includes all structured fields (instance_id, orchestration_name, etc.)
#[napi_derive::napi]
pub fn orchestration_trace_log(instance_id: String, level: String, message: String) {
    handlers::orchestration_trace(&instance_id, &level, &message);
}

/// Check if an activity's cancellation token has been triggered.
/// Returns true if the activity has been cancelled (e.g., due to losing a race/select).
#[napi_derive::napi]
pub fn activity_is_cancelled(token: String) -> bool {
    handlers::activity_is_cancelled(&token)
}

/// Get a Client from an activity context, allowing activities to start new orchestrations.
#[napi_derive::napi]
pub fn activity_get_client(token: String) -> Option<JsClient> {
    handlers::activity_get_client(&token)
}

/// Set custom status on an orchestration context (fire-and-forget, no yield needed).
#[napi_derive::napi]
pub fn orchestration_set_custom_status(instance_id: String, status: String) {
    handlers::orchestration_set_custom_status(&instance_id, &status);
}

/// Reset (clear) custom status on an orchestration context (fire-and-forget, no yield needed).
#[napi_derive::napi]
pub fn orchestration_reset_custom_status(instance_id: String) {
    handlers::orchestration_reset_custom_status(&instance_id);
}

/// Read the current custom status value from an orchestration context.
/// Returns null if no custom status has been set.
#[napi_derive::napi]
pub fn orchestration_get_custom_status(instance_id: String) -> Option<String> {
    handlers::orchestration_get_custom_status(&instance_id)
}

/// Options for `initTracing`. Call before `runtime.start()` to direct
/// Rust tracing output to a file instead of stdout.
#[napi_derive::napi(object)]
pub struct JsTracingOptions {
    /// Path to the log file. Traces are appended.
    pub log_file: String,
    /// Log level filter (default: "info"). Respects the same syntax as
    /// `ObservabilityConfig.log_level` — the default filter expression is
    /// `warn,duroxide::orchestration={level},duroxide::activity={level}`.
    pub log_level: Option<String>,
    /// Log format: "json", "pretty", or "compact" (default: "compact")
    pub log_format: Option<String>,
}

/// Install a tracing subscriber that writes to a file.
///
/// Must be called **before** `runtime.start()`. Since duroxide uses
/// `try_init()` (first-writer-wins), the runtime's built-in subscriber
/// will silently no-op if one is already installed.
#[napi_derive::napi]
pub fn init_tracing(options: JsTracingOptions) -> napi::Result<()> {
    use std::fs::OpenOptions;
    use tracing_subscriber::{EnvFilter, fmt, layer::SubscriberExt, util::SubscriberInitExt};

    let level = options.log_level.unwrap_or_else(|| "info".to_string());
    let filter_expr = format!("warn,duroxide::orchestration={level},duroxide::activity={level}");
    let env_filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(filter_expr));

    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&options.log_file)
        .map_err(|e| napi::Error::from_reason(format!("Failed to open log file '{}': {e}", options.log_file)))?;

    let format = options.log_format.unwrap_or_default();
    match format.as_str() {
        "json" => {
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt::layer().json().with_writer(file))
                .try_init()
                .map_err(|e| napi::Error::from_reason(format!("Failed to init tracing: {e}")))?;
        }
        "pretty" => {
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt::layer().with_writer(file))
                .try_init()
                .map_err(|e| napi::Error::from_reason(format!("Failed to init tracing: {e}")))?;
        }
        _ => {
            // compact (default)
            tracing_subscriber::registry()
                .with(env_filter)
                .with(fmt::layer().compact().with_writer(file))
                .try_init()
                .map_err(|e| napi::Error::from_reason(format!("Failed to init tracing: {e}")))?;
        }
    }

    Ok(())
}
