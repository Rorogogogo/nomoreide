use serde::Serialize;
use serde_json::Value;
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::sync::Arc;

pub type SharedEventSink = Arc<dyn EventSink>;

/// Receives runtime events without coupling their producers to a transport.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value) -> Result<(), EventSinkError>;
}

/// Serializes a typed payload before passing it to an [`EventSink`].
pub fn emit_event(
    sink: &dyn EventSink,
    event: &str,
    payload: impl Serialize,
) -> Result<(), EventSinkError> {
    let payload = serde_json::to_value(payload).map_err(EventSinkError::serialization)?;
    sink.emit(event, payload)
}

#[derive(Debug)]
pub struct EventSinkError {
    message: String,
}

impl EventSinkError {
    pub fn delivery(error: impl Display) -> Self {
        Self {
            message: error.to_string(),
        }
    }

    fn serialization(error: serde_json::Error) -> Self {
        Self {
            message: error.to_string(),
        }
    }
}

impl Display for EventSinkError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl Error for EventSinkError {}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::ser::{Error as _, Serializer};
    use serde_json::json;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<(String, Value)>>,
    }

    impl EventSink for RecordingSink {
        fn emit(&self, event: &str, payload: Value) -> Result<(), EventSinkError> {
            self.events
                .lock()
                .unwrap()
                .push((event.to_string(), payload));
            Ok(())
        }
    }

    #[test]
    fn serializes_typed_payloads_and_preserves_event_order() {
        let sink = RecordingSink::default();

        emit_event(&sink, "first", json!({ "count": 1 })).unwrap();
        emit_event(&sink, "terminal-output-session-1", "ready").unwrap();

        assert_eq!(
            *sink.events.lock().unwrap(),
            vec![
                ("first".to_string(), json!({ "count": 1 })),
                ("terminal-output-session-1".to_string(), json!("ready")),
            ]
        );
    }

    struct Unserializable;

    impl Serialize for Unserializable {
        fn serialize<S>(&self, _serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            Err(S::Error::custom("payload cannot be serialized"))
        }
    }

    #[test]
    fn reports_serialization_errors_without_calling_the_sink() {
        let sink = RecordingSink::default();

        let error = emit_event(&sink, "broken", Unserializable).unwrap_err();

        assert!(error.to_string().contains("payload cannot be serialized"));
        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[test]
    fn exposes_delivery_errors_from_the_sink() {
        struct FailingSink;

        impl EventSink for FailingSink {
            fn emit(&self, _event: &str, _payload: Value) -> Result<(), EventSinkError> {
                Err(EventSinkError::delivery("receiver disconnected"))
            }
        }

        let error = emit_event(&FailingSink, "event", json!({})).unwrap_err();

        assert_eq!(error.to_string(), "receiver disconnected");
    }
}
