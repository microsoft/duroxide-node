use napi_derive::napi;
use serde::{Deserialize, Serialize};

/// A scheduled task descriptor yielded from orchestration generators.
/// The Rust runtime executes these using the real OrchestrationContext.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ScheduledTask {
    #[serde(rename = "activity")]
    Activity { name: String, input: String },
    #[serde(rename = "activityWithRetry")]
    ActivityWithRetry {
        name: String,
        input: String,
        retry: RetryPolicyConfig,
    },
    #[serde(rename = "timer")]
    Timer {
        #[serde(rename = "delayMs")]
        delay_ms: u64,
    },
    #[serde(rename = "waitEvent")]
    WaitEvent { name: String },
    #[serde(rename = "subOrchestration")]
    SubOrchestration { name: String, input: String },
    #[serde(rename = "subOrchestrationWithId")]
    SubOrchestrationWithId {
        name: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        input: String,
    },
    #[serde(rename = "subOrchestrationVersioned")]
    SubOrchestrationVersioned {
        name: String,
        version: Option<String>,
        input: String,
    },
    #[serde(rename = "subOrchestrationVersionedWithId")]
    SubOrchestrationVersionedWithId {
        name: String,
        version: Option<String>,
        #[serde(rename = "instanceId")]
        instance_id: String,
        input: String,
    },
    #[serde(rename = "orchestration")]
    Orchestration {
        name: String,
        #[serde(rename = "instanceId")]
        instance_id: String,
        input: String,
    },
    #[serde(rename = "orchestrationVersioned")]
    OrchestrationVersioned {
        name: String,
        version: Option<String>,
        #[serde(rename = "instanceId")]
        instance_id: String,
        input: String,
    },
    #[serde(rename = "newGuid")]
    NewGuid,
    #[serde(rename = "utcNow")]
    UtcNow,
    #[serde(rename = "continueAsNew")]
    ContinueAsNew { input: String },
    #[serde(rename = "continueAsNewVersioned")]
    ContinueAsNewVersioned { input: String, version: Option<String> },
    #[serde(rename = "join")]
    Join { tasks: Vec<ScheduledTask> },
    #[serde(rename = "select")]
    Select { tasks: Vec<ScheduledTask> },
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RetryPolicyConfig {
    #[serde(rename = "maxAttempts")]
    pub max_attempts: u32,
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    #[serde(rename = "totalTimeoutMs")]
    pub total_timeout_ms: Option<u64>,
    pub backoff: Option<String>,
}

/// Result of driving a generator one step.
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum GeneratorStepResult {
    #[serde(rename = "yielded")]
    Yielded {
        #[serde(rename = "generatorId")]
        generator_id: u64,
        task: ScheduledTask,
    },
    #[serde(rename = "completed")]
    Completed { output: String },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Orchestration status returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsOrchestrationStatus {
    pub status: String,
    pub output: Option<String>,
    pub error: Option<String>,
}

/// System metrics returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsSystemMetrics {
    pub total_instances: i64,
    pub total_executions: i64,
    pub running_instances: i64,
    pub completed_instances: i64,
    pub failed_instances: i64,
    pub total_events: i64,
}

/// Queue depths returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsQueueDepths {
    pub orchestrator_queue: i64,
    pub worker_queue: i64,
    pub timer_queue: i64,
}

/// Instance info returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsInstanceInfo {
    pub instance_id: String,
    pub orchestration_name: String,
    pub orchestration_version: String,
    pub current_execution_id: i64,
    pub status: String,
    pub output: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub parent_instance_id: Option<String>,
}

/// Execution info returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsExecutionInfo {
    pub execution_id: i64,
    pub status: String,
    pub output: Option<String>,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub event_count: i64,
}

/// Instance tree returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsInstanceTree {
    pub root_id: String,
    pub all_ids: Vec<String>,
    pub size: i64,
}

/// Delete result returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsDeleteInstanceResult {
    pub instances_deleted: i64,
    pub executions_deleted: i64,
    pub events_deleted: i64,
    pub queue_messages_deleted: i64,
}

/// Prune options from JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsPruneOptions {
    pub keep_last: Option<i64>,
    pub completed_before: Option<i64>,
}

/// Prune result returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsPruneResult {
    pub instances_processed: i64,
    pub executions_deleted: i64,
    pub events_deleted: i64,
}

/// Instance filter from JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsInstanceFilter {
    pub instance_ids: Option<Vec<String>>,
    pub completed_before: Option<i64>,
    pub limit: Option<i64>,
}

/// Runtime metrics snapshot returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsMetricsSnapshot {
    pub orch_starts: i64,
    pub orch_completions: i64,
    pub orch_failures: i64,
    pub orch_application_errors: i64,
    pub orch_infrastructure_errors: i64,
    pub orch_configuration_errors: i64,
    pub orch_poison: i64,
    pub activity_success: i64,
    pub activity_app_errors: i64,
    pub activity_infra_errors: i64,
    pub activity_config_errors: i64,
    pub activity_poison: i64,
    pub orch_dispatcher_items_fetched: i64,
    pub worker_dispatcher_items_fetched: i64,
    pub orch_continue_as_new: i64,
    pub suborchestration_calls: i64,
    pub provider_errors: i64,
}

/// A single history event returned to JS.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct JsEvent {
    pub event_id: i64,
    pub kind: String,
    pub source_event_id: Option<i64>,
    pub timestamp_ms: i64,
    /// Event-specific data (activity result, input, error, timer fire_at, etc.)
    pub data: Option<String>,
}
