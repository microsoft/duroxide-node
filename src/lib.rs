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
