use nomoreide_core::event_sink::{EventSink, EventSinkError, SharedEventSink};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

pub fn tauri_event_sink(app: AppHandle) -> SharedEventSink {
    Arc::new(TauriEventSink::new(app))
}

impl EventSink for TauriEventSink {
    fn emit(&self, event: &str, payload: Value) -> Result<(), EventSinkError> {
        self.app
            .emit(event, payload)
            .map_err(EventSinkError::delivery)
    }
}
