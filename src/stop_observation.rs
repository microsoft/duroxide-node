// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use duroxide::runtime::{RuntimeStopObserver, RuntimeStopStatus};
use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use tokio::sync::watch;

#[derive(Clone)]
struct SourceState {
    status: RuntimeStopStatus,
    core: Option<RuntimeStopObserver>,
    closed: bool,
}

fn merge(left: RuntimeStopStatus, right: RuntimeStopStatus) -> RuntimeStopStatus {
    use RuntimeStopStatus::*;
    match (left, right) {
        (Faulted, _) | (_, Faulted) => Faulted,
        (Requested, _) | (_, Requested) => Requested,
        _ => NotRequested,
    }
}

impl SourceState {
    fn status(&self) -> RuntimeStopStatus {
        merge(
            self.status,
            self.core.as_ref().map_or(self.status, |core| core.state()),
        )
    }
}

pub(crate) struct StopSource {
    state: watch::Sender<SourceState>,
    #[cfg(feature = "test-hooks")]
    pub(crate) hooks: crate::test_hooks::ObservationHooks,
}

impl StopSource {
    pub fn new() -> Self {
        Self {
            state: watch::channel(SourceState {
                status: RuntimeStopStatus::NotRequested,
                core: None,
                closed: false,
            })
            .0,
            #[cfg(feature = "test-hooks")]
            hooks: crate::test_hooks::ObservationHooks::default(),
        }
    }

    pub fn subscribe(&self) -> JsRuntimeStopSource {
        JsRuntimeStopSource {
            state: self.state.subscribe(),
            #[cfg(feature = "test-hooks")]
            hooks: self.hooks.clone(),
        }
    }

    pub fn attach(&self, core: RuntimeStopObserver) {
        self.state.send_modify(|state| {
            assert!(!state.closed && state.core.is_none());
            state.status = merge(state.status, core.state());
            state.core = Some(core);
        });
    }

    pub fn requested(&self) {
        self.state.send_if_modified(|state| {
            let status = merge(state.status, RuntimeStopStatus::Requested);
            if state.closed || state.status == status {
                return false;
            }
            state.status = status;
            true
        });
    }

    pub fn close(&self) {
        self.state.send_modify(|state| {
            state.status = state.status();
            state.core = None;
            state.closed = true;
        });
    }
}

impl Drop for StopSource {
    fn drop(&mut self) {
        // Dropping only the sender would leave a live core receiver behind.
        self.close();
    }
}

fn encode(status: RuntimeStopStatus) -> String {
    match status {
        RuntimeStopStatus::NotRequested => "NotRequested",
        RuntimeStopStatus::Requested => "Requested",
        RuntimeStopStatus::Faulted => "Faulted",
    }
    .to_owned()
}

fn decode(status: &str) -> Result<RuntimeStopStatus> {
    match status {
        "NotRequested" => Ok(RuntimeStopStatus::NotRequested),
        "Requested" => Ok(RuntimeStopStatus::Requested),
        "Faulted" => Ok(RuntimeStopStatus::Faulted),
        _ => Err(Error::new(
            Status::InvalidArg,
            "stop_observation_invalid_status: invalid last-seen status",
        )),
    }
}

#[napi(object)]
pub struct JsRuntimeStopSnapshot {
    pub state: String,
    pub closed: bool,
}

#[napi]
pub struct JsRuntimeStopSource {
    state: watch::Receiver<SourceState>,
    #[cfg(feature = "test-hooks")]
    hooks: crate::test_hooks::ObservationHooks,
}

#[napi]
impl JsRuntimeStopSource {
    #[napi]
    pub fn snapshot(&self) -> JsRuntimeStopSnapshot {
        let state = self.state.borrow();
        JsRuntimeStopSnapshot {
            state: encode(state.status()),
            closed: state.closed,
        }
    }

    #[napi]
    pub fn wait_for_change(
        &self,
        env: Env,
        last_seen: String,
        mut callback: ThreadsafeFunction<Option<String>>,
    ) -> Result<JsRuntimeStopWait> {
        let last_seen = decode(&last_seen)?;
        callback.unref(&env)?;
        let mut source = self.state.clone();
        let (cancel, mut canceled) = watch::channel(());
        #[cfg(feature = "test-hooks")]
        let hooks = self.hooks.clone();
        #[cfg(feature = "test-hooks")]
        let pending = hooks.register();
        spawn(async move {
            let result = match tokio::spawn(async move {
                tokio::select! {
                    biased;
                    _ = canceled.changed() => Err(Error::from_reason(
                        "stop_observation_canceled: notification was canceled")),
                    status = changed(&mut source, last_seen) => Ok(status.map(encode)),
                }
            })
            .await
            {
                Ok(result) => result,
                Err(error) => {
                    if error.is_panic() {
                        crate::runtime::discard_panic_payload(error.into_panic());
                    }
                    Err(Error::from_reason(
                        "stop_observation_failed: native observation failed",
                    ))
                }
            };
            #[cfg(feature = "test-hooks")]
            let result = if hooks.checkpoint("observer-delivery").await {
                Err(Error::from_reason(
                    "stop_observation_failed: native observation failed",
                ))
            } else {
                result
            };
            let status = callback.call(result, ThreadsafeFunctionCallMode::NonBlocking);
            if status != Status::Ok && status != Status::Closing {
                eprintln!("stop_observation_failed: notification could not be delivered");
            }
            #[cfg(feature = "test-hooks")]
            {
                hooks.delivered(status == Status::Ok);
                hooks.checkpoint("observer-final-access").await;
            }
            drop(callback);
            #[cfg(feature = "test-hooks")]
            drop(pending);
        });
        Ok(JsRuntimeStopWait {
            cancel: Some(cancel),
        })
    }
}

async fn changed(
    source: &mut watch::Receiver<SourceState>,
    last_seen: RuntimeStopStatus,
) -> Option<RuntimeStopStatus> {
    loop {
        let (state, status) = {
            let state = source.borrow_and_update();
            (state.clone(), state.status())
        };
        if status != last_seen {
            return Some(status);
        }
        if state.closed {
            return None;
        }
        if let Some(mut core) = state.core {
            let native_status = core.state();
            if merge(state.status, native_status) != last_seen {
                continue;
            }
            tokio::select! {
                _ = source.changed() => {},
                result = core.changed(native_status) => {
                    if result.is_none() {
                        // The SDK publisher owns source lifetime, independently of core cleanup.
                        let _ = source.changed().await;
                    }
                },
            }
        } else {
            let _ = source.changed().await;
        }
    }
}

#[napi]
pub struct JsRuntimeStopWait {
    cancel: Option<watch::Sender<()>>,
}

#[napi]
impl JsRuntimeStopWait {
    #[napi]
    pub fn close(&mut self) {
        self.cancel.take();
    }
}
