//! Request values > configured extra parameters > form defaults > transport defaults.
use crate::{
    model::{validate_extra_params, ModelConfig, ModelLatency, ModelSpec, ProviderType},
    Error, Result,
};
use serde_json::{json, Value};

/// Merge one lower-priority layer without replacing explicit values or token-limit aliases.
pub(crate) fn merge_extra_params(body: &mut Value, extra: &Value) -> Result<()> {
    validate_extra_params(extra)?;
    let body = body
        .as_object_mut()
        .ok_or_else(|| Error::Protocol("request body must be an object".into()))?;
    let has_chat_limit =
        body.contains_key("max_tokens") || body.contains_key("max_completion_tokens");
    for (name, value) in extra.as_object().expect("validated extra parameters") {
        if has_chat_limit && matches!(name.as_str(), "max_tokens" | "max_completion_tokens") {
            continue;
        }
        match body.entry(name.clone()) {
            serde_json::map::Entry::Vacant(entry) => {
                entry.insert(value.clone());
            }
            serde_json::map::Entry::Occupied(mut entry) => fill_missing(entry.get_mut(), value),
        }
    }
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

/// Only saved configuration is templated; caller values remain literal.
pub(crate) fn configured_options(model: &ModelConfig, conversation_id: &str) -> Result<Value> {
    let mut configured = super::render_json_strings(model.extra_params(), conversation_id);
    let mut defaults = ModelSpec::new(&model.model_id);
    model.configure(&mut defaults);
    merge_extra_params(
        &mut configured,
        &model_options(model.provider_type(), &defaults)?,
    )?;
    Ok(configured)
}

/// Raw forwarding retains its established Chat max_tokens default.
pub(crate) fn apply_configured(
    body: &mut Value,
    model: &ModelConfig,
    conversation_id: &str,
) -> Result<()> {
    merge_extra_params(body, &configured_options(model, conversation_id)?)?;
    fill_limit(
        body,
        model.provider_type(),
        model.max_output_tokens(),
        "max_tokens",
    )?;
    fill_cache_key(
        body,
        model.provider_type(),
        &model.model_id,
        conversation_id,
    )
}

/// Serialized requests retain their established Chat max_completion_tokens default.
pub(crate) fn apply(
    protocol: ProviderType,
    body: &mut Value,
    model: &ModelSpec,
    route_max_output_tokens: Option<u64>,
    conversation_id: &str,
) -> Result<()> {
    merge_extra_params(body, &model_options(protocol, model)?)?;
    merge_extra_params(body, &model.extra_params)?;
    fill_limit(
        body,
        protocol,
        route_max_output_tokens,
        "max_completion_tokens",
    )?;
    fill_cache_key(body, protocol, &model.model_id, conversation_id)
}

fn model_options(protocol: ProviderType, model: &ModelSpec) -> Result<Value> {
    let mut options = json!({});
    fill_limit(
        &mut options,
        protocol,
        model.max_output_tokens,
        "max_completion_tokens",
    )?;
    match protocol {
        ProviderType::OpenAiChat => {
            if let Some(effort) = &model.reasoning.effort {
                options["reasoning_effort"] = json!(effort);
            }
        }
        ProviderType::OpenAiResponses
            if model.reasoning.enabled || model.reasoning.effort.is_some() =>
        {
            options["reasoning"] = json!({"summary":"auto"});
            if let Some(effort) = &model.reasoning.effort {
                options["reasoning"]["effort"] = json!(effort);
            }
        }
        ProviderType::Anthropic => {
            if model.reasoning.enabled {
                options["thinking"] = json!({"type":"adaptive","display":"summarized"});
            }
            if let Some(effort) = &model.reasoning.effort {
                options["output_config"] = json!({"effort":effort});
            }
        }
        _ => {}
    }
    if model.latency == ModelLatency::Fast && protocol != ProviderType::Anthropic {
        options["service_tier"] = json!("fast");
    }
    Ok(options)
}

fn fill_limit(
    body: &mut Value,
    protocol: ProviderType,
    limit: Option<u64>,
    chat_field: &str,
) -> Result<()> {
    if let Some(limit) = limit {
        let field = match protocol {
            ProviderType::OpenAiChat => chat_field,
            ProviderType::OpenAiResponses => "max_output_tokens",
            ProviderType::Anthropic => "max_tokens",
            ProviderType::Plugin => {
                return Err(Error::Config(
                    "plugin protocol options belong to its provider".into(),
                ))
            }
        };
        merge_extra_params(body, &json!({field:limit}))?;
    }
    Ok(())
}

fn fill_cache_key(
    body: &mut Value,
    protocol: ProviderType,
    model_id: &str,
    conversation_id: &str,
) -> Result<()> {
    if matches!(
        protocol,
        ProviderType::OpenAiChat | ProviderType::OpenAiResponses
    ) && model_id.to_ascii_lowercase().contains("gpt")
    {
        merge_extra_params(body, &json!({"prompt_cache_key":conversation_id}))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn configured_extras_outrank_form_defaults_in_every_protocol() {
        let directory = tempfile::tempdir().unwrap();
        let store = crate::store::Store::connect(&format!(
            "sqlite://{}",
            directory.path().join("options.db").display()
        ))
        .await
        .unwrap();
        for (kind, endpoint, protocol, limit_field, effort_path, extra) in [
            (
                "openai",
                "/v1/chat/completions",
                ProviderType::OpenAiChat,
                "max_tokens",
                "/reasoning_effort",
                json!({"max_tokens":600,"reasoning_effort":"medium"}),
            ),
            (
                "openai",
                "/v1/responses",
                ProviderType::OpenAiResponses,
                "max_output_tokens",
                "/reasoning/effort",
                json!({"max_output_tokens":600,"reasoning":{"effort":"medium"}}),
            ),
            (
                "anthropic",
                "",
                ProviderType::Anthropic,
                "max_tokens",
                "/output_config/effort",
                json!({"max_tokens":600,"output_config":{"effort":"medium"}}),
            ),
        ] {
            let input = serde_json::from_value(json!({
                "display_name":"options", "tooltip_data":"fixture", "type":kind,
                "base_url":"https://example.invalid", "api_key":"fixture", "model_id":format!("model-{protocol:?}"),
                "openai_endpoint":endpoint, "reasoning_effort":"high", "anthropic_thinking_effort":"high",
                "max_completion_tokens":32000, "anthropic_max_tokens":32000,
                "openai_extra_params_enabled":true, "anthropic_extra_params_enabled":true,
                "openai_extra_params":extra, "anthropic_extra_params":extra,
            })).unwrap();
            let configured = store.create_model(&input).await.unwrap();
            let mut raw = json!({});
            apply_configured(&mut raw, &configured, "conversation").unwrap();
            assert_eq!(raw[limit_field], 600, "{protocol:?}");
            assert_eq!(raw.pointer(effort_path).unwrap(), "medium", "{protocol:?}");

            let mut request = ModelSpec::new(&configured.model_id);
            request.extra_params = configured_options(&configured, "conversation").unwrap();
            let mut serialized = json!({});
            apply(
                protocol,
                &mut serialized,
                &request,
                configured.max_output_tokens(),
                "conversation",
            )
            .unwrap();
            assert_eq!(serialized[limit_field], 600, "{protocol:?}");
            assert_eq!(
                serialized.pointer(effort_path).unwrap(),
                "medium",
                "{protocol:?}"
            );

            request.max_output_tokens = Some(100);
            request.reasoning.effort = Some("low".into());
            let mut explicit = json!({});
            apply(
                protocol,
                &mut explicit,
                &request,
                configured.max_output_tokens(),
                "conversation",
            )
            .unwrap();
            let explicit_limit = if protocol == ProviderType::OpenAiChat {
                "max_completion_tokens"
            } else {
                limit_field
            };
            assert_eq!(explicit[explicit_limit], 100, "{protocol:?}");
            assert_eq!(
                explicit.pointer(effort_path).unwrap(),
                "low",
                "{protocol:?}"
            );
            if protocol == ProviderType::OpenAiChat {
                assert!(explicit.get("max_tokens").is_none());
            }
        }
    }

    #[test]
    fn token_aliases_do_not_override_a_higher_priority_value_or_null() {
        for (field, alias) in [
            ("max_tokens", "max_completion_tokens"),
            ("max_completion_tokens", "max_tokens"),
        ] {
            for value in [json!(100), Value::Null] {
                let mut body = json!({field:value});
                merge_extra_params(&mut body, &json!({alias:600})).unwrap();
                assert_eq!(body[field], value);
                assert!(body.get(alias).is_none());
            }
        }
    }

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
