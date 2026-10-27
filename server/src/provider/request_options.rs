//! Shared configuration policy for raw forwarding and protocol serialization.
use serde_json::{json, Value};

use crate::{
    model::{ModelLatency, ModelSpec, ProviderType},
    Error, Result,
};

use crate::model::validate_extra_params;

/// Configuration fills absent fields. Explicit values, including null, win.
pub(crate) fn merge_extra_params(body: &mut Value, extra: &Value) -> Result<()> {
    validate_extra_params(extra)?;
    if !body.is_object() {
        return Err(Error::Protocol("request body must be an object".into()));
    }
    fill_missing(body, extra);
    Ok(())
}

fn fill_missing(body: &mut Value, defaults: &Value) {
    if let (Some(body), Some(defaults)) = (body.as_object_mut(), defaults.as_object()) {
        for (name, value) in defaults {
            match body.entry(name.clone()) {
                serde_json::map::Entry::Vacant(entry) => {
                    entry.insert(value.clone());
                }
                serde_json::map::Entry::Occupied(mut entry) => fill_missing(entry.get_mut(), value),
            }
        }
    }
}

pub(crate) fn apply(
    protocol: ProviderType,
    body: &mut Value,
    model: &ModelSpec,
    route_max_output_tokens: Option<u64>,
    conversation_id: &str,
) -> Result<()> {
    let mut defaults = json!({});
    if let Some(max) = model.max_output_tokens.or(route_max_output_tokens) {
        let field = match protocol {
            ProviderType::OpenAiChat => "max_completion_tokens",
            ProviderType::OpenAiResponses => "max_output_tokens",
            ProviderType::Anthropic => "max_tokens",
            ProviderType::Plugin => {
                return Err(Error::Config(
                    "plugin protocol options belong to its provider".into(),
                ))
            }
        };
        if !(protocol == ProviderType::OpenAiChat && body.get("max_tokens").is_some()) {
            defaults[field] = json!(max);
        }
    }
    match protocol {
        ProviderType::OpenAiChat => {
            if let Some(effort) = &model.reasoning.effort {
                defaults["reasoning_effort"] = json!(effort);
            }
        }
        ProviderType::OpenAiResponses
            if model.reasoning.enabled || model.reasoning.effort.is_some() =>
        {
            defaults["reasoning"] = json!({"summary":"auto"});
            if let Some(effort) = &model.reasoning.effort {
                defaults["reasoning"]["effort"] = json!(effort);
            }
        }
        ProviderType::Anthropic => {
            if model.reasoning.enabled {
                defaults["thinking"] = json!({"type":"adaptive","display":"summarized"});
            }
            if let Some(effort) = &model.reasoning.effort {
                defaults["output_config"] = json!({"effort":effort});
            }
        }
        _ => {}
    }
    if model.latency == ModelLatency::Fast && protocol != ProviderType::Anthropic {
        defaults["service_tier"] = json!("fast");
    }
    merge_extra_params(body, &defaults)?;
    merge_extra_params(body, &model.extra_params)?;
    if matches!(
        protocol,
        ProviderType::OpenAiChat | ProviderType::OpenAiResponses
    ) && model.model_id.to_ascii_lowercase().contains("gpt")
    {
        merge_extra_params(body, &json!({"prompt_cache_key":conversation_id}))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_history_and_tool_overrides_before_mutating_the_request() {
        for field in [
            "model",
            "stream",
            "messages",
            "input",
            "tools",
            "system",
            "instructions",
            "previous_response_id",
            "conversation",
        ] {
            let mut body = json!({"input":[{"type":"reasoning","encrypted_content":"signed"}]});
            let original = body.clone();
            assert!(merge_extra_params(&mut body, &json!({field:[]})).is_err());
            assert_eq!(body, original);
        }
    }

    #[test]
    fn all_protocols_preserve_explicit_limits_effort_and_native_history() {
        let mut model = ModelSpec::new("gpt-test");
        model.max_output_tokens = Some(32000);
        model.reasoning.effort = Some("high".into());
        model.extra_params = json!({"temperature":0.7,"prompt_cache_key":"conversation-one"});
        for (protocol, mut body, limit, effort) in [
            (
                ProviderType::OpenAiChat,
                json!({"messages":[{"role":"user","content":"hello"}],"max_tokens":100,"reasoning_effort":"low"}),
                "max_tokens",
                "/reasoning_effort",
            ),
            (
                ProviderType::OpenAiResponses,
                json!({"input":[{"type":"reasoning","encrypted_content":"signed"}],"max_output_tokens":100,"reasoning":{"effort":"low"}}),
                "max_output_tokens",
                "/reasoning/effort",
            ),
            (
                ProviderType::Anthropic,
                json!({"messages":[{"role":"user","content":"hello"}],"max_tokens":100,"output_config":{"effort":"low"}}),
                "max_tokens",
                "/output_config/effort",
            ),
        ] {
            let original = body.clone();
            apply(protocol, &mut body, &model, None, "conversation-one").unwrap();
            assert_eq!(body[limit], 100);
            assert_eq!(body.pointer(effort).unwrap(), "low");
            assert_eq!(body["messages"], original["messages"]);
            assert_eq!(body["input"], original["input"]);
            assert_eq!(body["prompt_cache_key"], "conversation-one");
            assert_eq!(body["temperature"], 0.7);
        }
    }
}
