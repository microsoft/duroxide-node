// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use duroxide::runtime::test_hooks::{
    LifecycleHooks, LifecyclePoint, LifecycleTask, ProviderOperation,
};
use napi::{Error, Result};
use napi_derive::napi;
use std::time::Duration;

use crate::runtime::JsRuntime;

#[napi]
pub struct LifecycleTestHooks {
    hooks: LifecycleHooks,
}

#[napi(js_name = "_lifecycleTestHooks")]
pub fn lifecycle_test_hooks(runtime: &JsRuntime) -> LifecycleTestHooks {
    LifecycleTestHooks {
        hooks: runtime.test_hooks.clone(),
    }
}

#[napi]
impl LifecycleTestHooks {
    #[napi]
    pub fn hold(&self, point: String) -> Result<()> {
        self.hooks
            .hold(parse_point(&point)?)
            .map(|_| ())
            .map_err(|error| Error::from_reason(format!("test gate: {error:?}")))
    }

    #[napi]
    pub fn release(&self, point: String) -> Result<()> {
        self.hooks
            .gate(parse_point(&point)?)
            .ok_or_else(|| Error::from_reason("test gate not armed"))?
            .release();
        Ok(())
    }

    #[napi]
    pub async fn wait_entered(&self, point: String) -> Result<()> {
        let gate = self
            .hooks
            .gate(parse_point(&point)?)
            .ok_or_else(|| Error::from_reason("test gate not armed"))?;
        tokio::time::timeout(Duration::from_secs(3), gate.entered())
            .await
            .map_err(|_| Error::from_reason("test gate entry timed out"))
    }

    #[napi]
    pub fn fail(&self, point: String, message: String) -> Result<()> {
        self.hooks
            .fail_once_with_message(parse_point(&point)?, message)
            .map_err(|error| Error::from_reason(format!("test fault: {error:?}")))
    }

    #[napi]
    pub fn snapshot(&self) -> String {
        let counts = self.hooks.counts();
        serde_json::json!({
            "started": counts.iter().map(|count| count.started).sum::<usize>(),
            "completed": counts.iter().map(|count| count.completed).sum::<usize>(),
            "active": counts.iter().map(|count| count.active).sum::<usize>(),
            "cleanupActive": self.hooks.cleanup_counts().active,
            "coordinators": self.hooks.hits(LifecyclePoint::ShutdownCoordinator),
            "forceRequests": self.hooks.hits(LifecyclePoint::ForceRequested),
        })
        .to_string()
    }
}

fn parse_point(point: &str) -> Result<LifecyclePoint> {
    match point {
        "startup" => Ok(LifecyclePoint::StartupBeforeIo),
        "partial-startup" => Ok(LifecyclePoint::StartupAfterSpawn(
            LifecycleTask::OrchestrationDispatcher,
        )),
        "provider" => Ok(LifecyclePoint::ProviderReturn(
            ProviderOperation::FetchOrchestration,
        )),
        "worker" => Ok(LifecyclePoint::ParentWork(LifecycleTask::WorkDispatcher)),
        "force" => Ok(LifecyclePoint::ForceRequested),
        "coordinator" => Ok(LifecyclePoint::ShutdownCoordinator),
        _ => Err(Error::from_reason("unknown lifecycle test point")),
    }
}
