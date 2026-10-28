//! Defines the provider interface and exports provider implementations.
mod anthropic;
mod attempt;
mod event;
mod normalize;
mod openai_chat;
mod openai_responses;
mod recorder;
pub(crate) mod request_options;
mod request_template;
mod router;
pub(crate) mod text_tools;

use std::pin::Pin;

use futures_util::Stream;
use tokio_util::sync::CancellationToken;

use crate::{model::ModelInvocation, Result};

pub use anthropic::AnthropicProvider;
pub use event::*;
pub use openai_chat::OpenAiChatProvider;
pub use openai_responses::OpenAiResponsesProvider;
pub use recorder::CallRecorder;
pub(crate) use request_template::render_json_strings;
pub(crate) use router::custom_headers;

pub(crate) fn native_usage(
    kind: crate::model::ProviderType,
    value: &serde_json::Value,
) -> crate::model::Usage {
    match kind {
        crate::model::ProviderType::OpenAiChat => openai_chat::openai_usage(value),
        crate::model::ProviderType::OpenAiResponses => openai_responses::responses_usage(value),
        crate::model::ProviderType::Anthropic => anthropic::anthropic_usage(value),
        crate::model::ProviderType::Plugin => {
            unreachable!("plugin calls have no native HTTP protocol")
        }
    }
}
pub use router::{build as build_provider, ProviderRouter};

pub type ProviderStream = Pin<Box<dyn Stream<Item = Result<ModelEvent>> + Send>>;

pub trait Provider: Send + Sync {
    fn stream(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
    ) -> ProviderStream;
}

fn map_sse_error(
    label: &str,
    error: eventsource_stream::EventStreamError<crate::Error>,
) -> crate::Error {
    match error {
        eventsource_stream::EventStreamError::Transport(error) => error,
        eventsource_stream::EventStreamError::Utf8(error) => {
            crate::Error::Provider(format!("{label} SSE UTF-8 error: {error}"))
        }
        eventsource_stream::EventStreamError::Parser(error) => {
            crate::Error::Provider(format!("{label} SSE parse error: {error}"))
        }
    }
}

fn provider_event_error(label: &str, value: &serde_json::Value) -> Option<crate::Error> {
    let kind = value.get("type").and_then(serde_json::Value::as_str);
    let direct_error = value.get("error").filter(|error| !error.is_null());
    if !matches!(kind, Some("error" | "response.failed")) && direct_error.is_none() {
        return None;
    }

    let message = value
        .get("message")
        .and_then(serde_json::Value::as_str)
        .or_else(|| {
            value
                .pointer("/error/message")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| {
            value
                .pointer("/response/error/message")
                .and_then(serde_json::Value::as_str)
        })
        .or_else(|| direct_error.and_then(serde_json::Value::as_str))
        .or_else(|| {
            value
                .pointer("/response/error")
                .and_then(serde_json::Value::as_str)
        })
        .unwrap_or("provider returned an error event without a message");

    Some(crate::Error::Provider(format!("{label} error: {message}")))
}

fn apply_body_allowlist(
    body: &mut serde_json::Value,
    allowed: Option<&std::collections::HashSet<String>>,
) -> Result<()> {
    let Some(allowed) = allowed else {
        return Ok(());
    };
    body.as_object_mut()
        .ok_or_else(|| crate::Error::Provider("provider request body must be an object".into()))?
        .retain(|name, _| allowed.contains(name));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_transport_errors_are_not_relabelled_as_parse_errors() {
        let error = map_sse_error(
            "test provider",
            eventsource_stream::EventStreamError::Transport(crate::Error::Provider(
                "connection closed".into(),
            )),
        );

        let crate::Error::Provider(message) = error else {
            panic!("transport error category must be preserved");
        };
        assert_eq!(message, "connection closed");
    }

    #[test]
    fn provider_error_events_extract_flat_and_nested_messages() {
        assert_provider_error(
            "OpenAI Responses",
            serde_json::json!({
                "type": "error",
                "message": "Internal error during token generation"
            }),
            "OpenAI Responses error: Internal error during token generation",
        );
        assert_provider_error(
            "OpenAI Chat",
            serde_json::json!({
                "error": {"message": "quota exceeded", "type": "server_error"}
            }),
            "OpenAI Chat error: quota exceeded",
        );
        assert_provider_error(
            "Anthropic",
            serde_json::json!({
                "type": "error",
                "error": {"type": "overloaded_error", "message": "Overloaded"}
            }),
            "Anthropic error: Overloaded",
        );
        assert_provider_error(
            "OpenAI Responses",
            serde_json::json!({
                "type": "response.failed",
                "response": {"error": {"message": "generation failed"}}
            }),
            "OpenAI Responses error: generation failed",
        );
    }

    #[test]
    fn successful_provider_events_are_not_errors() {
        assert!(provider_event_error(
            "OpenAI Responses",
            &serde_json::json!({"type": "response.completed", "error": null})
        )
        .is_none());
    }

    fn assert_provider_error(label: &str, value: serde_json::Value, expected: &str) {
        let Some(crate::Error::Provider(message)) = provider_event_error(label, &value) else {
            panic!("expected provider error");
        };
        assert_eq!(message, expected);
    }
}

#[cfg(test)]
mod request_policy_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configured_request_options_preserve_explicit_values_and_accept_session_cache_keys() {
        let mut body = json!({"reasoning":{"effort":"low"},"max_output_tokens":100});
        request_options::merge_extra_params(&mut body, &json!({"reasoning":{"effort":"high"},"max_output_tokens":200,"prompt_cache_key":"conversation-one"})).unwrap();
        assert_eq!(body["reasoning"]["effort"], "low");
        assert_eq!(body["max_output_tokens"], 100);
        assert_eq!(body["prompt_cache_key"], "conversation-one");
    }
}
