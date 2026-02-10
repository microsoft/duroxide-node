use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;
use std::time::Duration;

use duroxide::client::Client;
use duroxide::OrchestrationStatus;

use crate::provider::JsSqliteProvider;
use crate::pg_provider::JsPostgresProvider;
use crate::types::{
    JsOrchestrationStatus, JsQueueDepths, JsSystemMetrics,
    JsInstanceInfo, JsExecutionInfo, JsInstanceTree,
    JsDeleteInstanceResult, JsPruneOptions, JsPruneResult,
    JsInstanceFilter, JsEvent,
};

/// Wraps duroxide's Client for use from JavaScript.
#[napi]
pub struct JsClient {
    inner: Client,
}

#[napi]
impl JsClient {
    #[napi(constructor)]
    pub fn new(provider: &JsSqliteProvider) -> Self {
        let p: Arc<dyn duroxide::providers::Provider> = provider.inner.clone();
        Self {
            inner: Client::new(p),
        }
    }

    /// Create a client backed by PostgreSQL.
    #[napi(factory, js_name = "fromPostgres")]
    pub fn from_postgres(provider: &JsPostgresProvider) -> Self {
        Self {
            inner: Client::new(provider.inner.clone()),
        }
    }

    /// Start a new orchestration instance.
    #[napi]
    pub async fn start_orchestration(
        &self,
        instance_id: String,
        orchestration_name: String,
        input: String,
    ) -> Result<()> {
        self.inner
            .start_orchestration(&instance_id, &orchestration_name, input)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Start a new orchestration instance with a specific version.
    #[napi]
    pub async fn start_orchestration_versioned(
        &self,
        instance_id: String,
        orchestration_name: String,
        input: String,
        version: String,
    ) -> Result<()> {
        self.inner
            .start_orchestration_versioned(&instance_id, &orchestration_name, &version, input)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Get the current status of an orchestration instance.
    #[napi]
    pub async fn get_status(&self, instance_id: String) -> Result<JsOrchestrationStatus> {
        let status = self
            .inner
            .get_orchestration_status(&instance_id)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(convert_status(status))
    }

    /// Wait for an orchestration to complete (with timeout in milliseconds).
    #[napi]
    pub async fn wait_for_orchestration(
        &self,
        instance_id: String,
        timeout_ms: i64,
    ) -> Result<JsOrchestrationStatus> {
        let timeout = Duration::from_millis(timeout_ms as u64);
        let status = self
            .inner
            .wait_for_orchestration(&instance_id, timeout)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(convert_status(status))
    }

    /// Cancel a running orchestration instance.
    #[napi]
    pub async fn cancel_instance(&self, instance_id: String, reason: Option<String>) -> Result<()> {
        self.inner
            .cancel_instance(&instance_id, reason.unwrap_or_default())
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Raise an external event to an orchestration instance.
    #[napi]
    pub async fn raise_event(
        &self,
        instance_id: String,
        event_name: String,
        data: String,
    ) -> Result<()> {
        self.inner
            .raise_event(&instance_id, &event_name, data)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Get system metrics (if provider supports management).
    #[napi]
    pub async fn get_system_metrics(&self) -> Result<JsSystemMetrics> {
        let metrics = self
            .inner
            .get_system_metrics()
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsSystemMetrics {
            total_instances: metrics.total_instances as i64,
            total_executions: metrics.total_executions as i64,
            running_instances: metrics.running_instances as i64,
            completed_instances: metrics.completed_instances as i64,
            failed_instances: metrics.failed_instances as i64,
            total_events: metrics.total_events as i64,
        })
    }

    /// Get queue depths (if provider supports management).
    #[napi]
    pub async fn get_queue_depths(&self) -> Result<JsQueueDepths> {
        let depths = self
            .inner
            .get_queue_depths()
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsQueueDepths {
            orchestrator_queue: depths.orchestrator_queue as i64,
            worker_queue: depths.worker_queue as i64,
            timer_queue: depths.timer_queue as i64,
        })
    }

    /// List all orchestration instance IDs.
    #[napi]
    pub async fn list_all_instances(&self) -> Result<Vec<String>> {
        self.inner
            .list_all_instances()
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// List orchestration instance IDs by status.
    #[napi]
    pub async fn list_instances_by_status(&self, status: String) -> Result<Vec<String>> {
        self.inner
            .list_instances_by_status(&status)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))
    }

    /// Get detailed info about a specific instance.
    #[napi]
    pub async fn get_instance_info(&self, instance_id: String) -> Result<JsInstanceInfo> {
        let info = self
            .inner
            .get_instance_info(&instance_id)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsInstanceInfo {
            instance_id: info.instance_id,
            orchestration_name: info.orchestration_name,
            orchestration_version: info.orchestration_version,
            current_execution_id: info.current_execution_id as i64,
            status: info.status,
            output: info.output,
            created_at: info.created_at as i64,
            updated_at: info.updated_at as i64,
            parent_instance_id: info.parent_instance_id,
        })
    }

    /// Get detailed info about a specific execution within an instance.
    #[napi]
    pub async fn get_execution_info(
        &self,
        instance_id: String,
        execution_id: i64,
    ) -> Result<JsExecutionInfo> {
        let info = self
            .inner
            .get_execution_info(&instance_id, execution_id as u64)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsExecutionInfo {
            execution_id: info.execution_id as i64,
            status: info.status,
            output: info.output,
            started_at: info.started_at as i64,
            completed_at: info.completed_at.map(|v| v as i64),
            event_count: info.event_count as i64,
        })
    }

    /// List execution IDs for an instance.
    #[napi]
    pub async fn list_executions(&self, instance_id: String) -> Result<Vec<i64>> {
        let ids = self
            .inner
            .list_executions(&instance_id)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(ids.into_iter().map(|id| id as i64).collect())
    }

    /// Read the event history for a specific execution.
    #[napi]
    pub async fn read_execution_history(
        &self,
        instance_id: String,
        execution_id: i64,
    ) -> Result<Vec<JsEvent>> {
        let events = self
            .inner
            .read_execution_history(&instance_id, execution_id as u64)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(events
            .into_iter()
            .map(|e| JsEvent {
                event_id: e.event_id() as i64,
                kind: format!("{:?}", e.kind).split('{').next().unwrap_or("Unknown").trim().to_string(),
                source_event_id: e.source_event_id.map(|v| v as i64),
                timestamp_ms: e.timestamp_ms as i64,
            })
            .collect())
    }

    /// Get the full instance tree (root + all descendants).
    #[napi]
    pub async fn get_instance_tree(&self, instance_id: String) -> Result<JsInstanceTree> {
        let tree = self
            .inner
            .get_instance_tree(&instance_id)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        let size = tree.size() as i64;
        Ok(JsInstanceTree {
            root_id: tree.root_id,
            all_ids: tree.all_ids,
            size,
        })
    }

    /// Delete an orchestration instance and all its data.
    #[napi]
    pub async fn delete_instance(
        &self,
        instance_id: String,
        force: bool,
    ) -> Result<JsDeleteInstanceResult> {
        let result = self
            .inner
            .delete_instance(&instance_id, force)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsDeleteInstanceResult {
            instances_deleted: result.instances_deleted as i64,
            executions_deleted: result.executions_deleted as i64,
            events_deleted: result.events_deleted as i64,
            queue_messages_deleted: result.queue_messages_deleted as i64,
        })
    }

    /// Delete multiple instances matching a filter.
    #[napi]
    pub async fn delete_instance_bulk(
        &self,
        filter: JsInstanceFilter,
    ) -> Result<JsDeleteInstanceResult> {
        let rust_filter = duroxide::providers::InstanceFilter {
            instance_ids: filter.instance_ids,
            completed_before: filter.completed_before.map(|v| v as u64),
            limit: filter.limit.map(|v| v as u32),
        };
        let result = self
            .inner
            .delete_instance_bulk(rust_filter)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsDeleteInstanceResult {
            instances_deleted: result.instances_deleted as i64,
            executions_deleted: result.executions_deleted as i64,
            events_deleted: result.events_deleted as i64,
            queue_messages_deleted: result.queue_messages_deleted as i64,
        })
    }

    /// Prune old executions from a single instance.
    #[napi]
    pub async fn prune_executions(
        &self,
        instance_id: String,
        options: JsPruneOptions,
    ) -> Result<JsPruneResult> {
        let rust_options = duroxide::providers::PruneOptions {
            keep_last: options.keep_last.map(|v| v as u32),
            completed_before: options.completed_before.map(|v| v as u64),
        };
        let result = self
            .inner
            .prune_executions(&instance_id, rust_options)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsPruneResult {
            instances_processed: result.instances_processed as i64,
            executions_deleted: result.executions_deleted as i64,
            events_deleted: result.events_deleted as i64,
        })
    }

    /// Prune old executions from multiple instances matching a filter.
    #[napi]
    pub async fn prune_executions_bulk(
        &self,
        filter: JsInstanceFilter,
        options: JsPruneOptions,
    ) -> Result<JsPruneResult> {
        let rust_filter = duroxide::providers::InstanceFilter {
            instance_ids: filter.instance_ids,
            completed_before: filter.completed_before.map(|v| v as u64),
            limit: filter.limit.map(|v| v as u32),
        };
        let rust_options = duroxide::providers::PruneOptions {
            keep_last: options.keep_last.map(|v| v as u32),
            completed_before: options.completed_before.map(|v| v as u64),
        };
        let result = self
            .inner
            .prune_executions_bulk(rust_filter, rust_options)
            .await
            .map_err(|e| Error::from_reason(format!("{e}")))?;
        Ok(JsPruneResult {
            instances_processed: result.instances_processed as i64,
            executions_deleted: result.executions_deleted as i64,
            events_deleted: result.events_deleted as i64,
        })
    }
}

fn convert_status(status: OrchestrationStatus) -> JsOrchestrationStatus {
    match status {
        OrchestrationStatus::NotFound => JsOrchestrationStatus {
            status: "NotFound".to_string(),
            output: None,
            error: None,
        },
        OrchestrationStatus::Running => JsOrchestrationStatus {
            status: "Running".to_string(),
            output: None,
            error: None,
        },
        OrchestrationStatus::Completed { output } => JsOrchestrationStatus {
            status: "Completed".to_string(),
            output: Some(output),
            error: None,
        },
        OrchestrationStatus::Failed { details } => JsOrchestrationStatus {
            status: "Failed".to_string(),
            output: None,
            error: Some(details.display_message()),
        },
    }
}
