// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use duroxide::runtime::test_hooks::{
    LifecycleHooks, LifecyclePoint, LifecycleTask, ProviderOperation,
};
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use crate::runtime::JsRuntime;
use crate::stop_observation::StopSource;

#[napi]
pub struct LifecycleTestHooks {
    hooks: LifecycleHooks,
    observation: ObservationHooks,
}

#[napi(js_name = "_lifecycleTestHooks")]
pub fn lifecycle_test_hooks(runtime: &JsRuntime) -> LifecycleTestHooks {
    LifecycleTestHooks {
        hooks: runtime.test_hooks.clone(),
        observation: runtime.stop_source.hooks.clone(),
    }
}

#[napi]
impl LifecycleTestHooks {
    #[napi]
    pub fn hold(&self, point: String) -> Result<()> {
        if point.starts_with("observer-") {
            return self.observation.hold(&point);
        }
        let parsed = parse_point(&point)?;
        let gate = if point == "blocking-provider" {
            self.hooks.hold_blocking(parsed)
        } else {
            self.hooks.hold(parsed)
        };
        gate.map(|_| ())
            .map_err(|error| Error::from_reason(format!("test gate: {error:?}")))
    }

    #[napi]
    pub fn release(&self, point: String) -> Result<()> {
        if point.starts_with("observer-") {
            self.observation.gate(&point)?.released.send_replace(true);
            return Ok(());
        }
        self.hooks
            .gate(parse_point(&point)?)
            .ok_or_else(|| Error::from_reason("test gate not armed"))?
            .release();
        Ok(())
    }

    #[napi]
    pub async fn wait_entered(&self, point: String) -> Result<()> {
        if point.starts_with("observer-") {
            let gate = self.observation.gate(&point)?;
            return tokio::time::timeout(
                Duration::from_secs(3),
                signaled(gate.entered.subscribe()),
            )
            .await
            .map_err(|_| Error::from_reason("test gate entry timed out"));
        }
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
        if point == "observer-delivery" {
            self.observation.0.lock().failures.insert(point);
            return Ok(());
        }
        self.hooks
            .fail_once_with_message(parse_point(&point)?, message)
            .map_err(|error| Error::from_reason(format!("test fault: {error:?}")))
    }

    #[napi]
    pub fn retire_observation_publisher(&self, runtime: &mut JsRuntime) -> Result<()> {
        if !Arc::ptr_eq(&self.observation.0, &runtime.stop_source.hooks.0) {
            return Err(Error::from_reason(
                "test observation publisher does not match",
            ));
        }
        // Retain the worker so closure controls can test a later, real core fault.
        drop(std::mem::replace(
            &mut runtime.stop_source,
            StopSource::new(),
        ));
        Ok(())
    }

    #[napi]
    pub fn snapshot(&self) -> String {
        let counts = self.hooks.counts();
        let observation = self.observation.0.lock();
        serde_json::json!({
            "started": counts.iter().map(|count| count.started).sum::<usize>(),
            "completed": counts.iter().map(|count| count.completed).sum::<usize>(),
            "active": counts.iter().map(|count| count.active).sum::<usize>(),
            "cleanupActive": self.hooks.cleanup_counts().active,
            "coordinators": self.hooks.hits(LifecyclePoint::ShutdownCoordinator),
            "forceRequests": self.hooks.hits(LifecyclePoint::ForceRequested),
            "observerPending": observation.pending,
            "observerDeliveries": observation.deliveries,
        })
        .to_string()
    }
}

#[derive(Clone, Default)]
pub(crate) struct ObservationHooks(Arc<parking_lot::Mutex<ObservationState>>);

#[derive(Default)]
struct ObservationState {
    gates: HashMap<String, Arc<ObservationGate>>,
    failures: HashSet<String>,
    pending: usize,
    deliveries: usize,
}

struct ObservationGate {
    entered: watch::Sender<bool>,
    released: watch::Sender<bool>,
}

async fn signaled(mut signal: watch::Receiver<bool>) {
    while !*signal.borrow_and_update() {
        signal
            .changed()
            .await
            .expect("test gate sender is retained");
    }
}

impl ObservationHooks {
    fn hold(&self, point: &str) -> Result<()> {
        if !matches!(point, "observer-delivery" | "observer-final-access") {
            return Err(Error::from_reason("unknown observation test point"));
        }
        let mut state = self.0.lock();
        if state
            .gates
            .get(point)
            .is_some_and(|gate| !*gate.released.borrow())
        {
            return Err(Error::from_reason("observation test gate already armed"));
        }
        state.gates.insert(
            point.to_owned(),
            Arc::new(ObservationGate {
                entered: watch::channel(false).0,
                released: watch::channel(false).0,
            }),
        );
        Ok(())
    }

    fn gate(&self, point: &str) -> Result<Arc<ObservationGate>> {
        self.0
            .lock()
            .gates
            .get(point)
            .cloned()
            .ok_or_else(|| Error::from_reason("observation test gate not armed"))
    }

    pub(crate) async fn checkpoint(&self, point: &str) -> bool {
        let (gate, failed) = {
            let mut state = self.0.lock();
            (
                state.gates.get(point).cloned(),
                state.failures.remove(point),
            )
        };
        if let Some(gate) = gate {
            gate.entered.send_replace(true);
            signaled(gate.released.subscribe()).await;
        }
        failed
    }

    pub(crate) fn register(&self) -> ObservationTask {
        self.0.lock().pending += 1;
        ObservationTask(self.clone())
    }

    pub(crate) fn delivered(&self, queued: bool) {
        if queued {
            self.0.lock().deliveries += 1;
        }
    }
}

pub(crate) struct ObservationTask(ObservationHooks);

impl Drop for ObservationTask {
    fn drop(&mut self) {
        self.0 .0.lock().pending -= 1;
    }
}

fn parse_point(point: &str) -> Result<LifecyclePoint> {
    match point {
        "startup" => Ok(LifecyclePoint::StartupBeforeIo),
        "partial-startup" => Ok(LifecyclePoint::StartupAfterSpawn(
            LifecycleTask::OrchestrationSlot,
        )),
        "provider" | "blocking-provider" => Ok(LifecyclePoint::ProviderReturn(
            ProviderOperation::FetchOrchestration,
        )),
        "worker" => Ok(LifecyclePoint::ParentWork(LifecycleTask::WorkerSlot)),
        "force" => Ok(LifecyclePoint::ForceRequested),
        "coordinator" => Ok(LifecyclePoint::ShutdownCoordinator),
        _ => Err(Error::from_reason("unknown lifecycle test point")),
    }
}
