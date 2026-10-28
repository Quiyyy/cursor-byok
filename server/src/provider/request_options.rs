//! Request values > configured extra parameters > form defaults > transport defaults.
use crate::{
    model::{validate_extra_params, ModelConfig, ModelLatency, ModelSpec, ProviderType},
    Error, Result,
};
use serde_json::{json, Value};

/// Project caller options before merging target-specific saved configuration.
pub(crate) fn project_request_options(protocol: ProviderType, options: &mut Value) -> Result<()> {
    validate_extra_params(options)?;
    let options = options.as_object_mut().expect("validated request options");
    if let Some(stop) = options.get("stop") {
        if !(stop.is_null()
            || stop.is_string()
            || stop
                .as_array()
                .is_some_and(|values| values.iter().all(Value::is_string)))
        {
            return Err(Error::Protocol(
                "stop must be a string, an array of strings, or null".into(),
            ));
        }
    }
    if protocol == ProviderType::Anthropic {
        if let Some(stop) = options.remove("stop") {
            let sequences = match stop {
                Value::String(text) => json!([text]),
                Value::Null => json!([]),
                sequences => sequences,
            };
            options.insert("stop_sequences".into(), sequences);
        }
    }
    let unsupported: &[&str] = match protocol {
        ProviderType::Anthropic => &["seed", "prompt_cache_key", "service_tier"],
        ProviderType::OpenAiResponses => &["seed", "stop"],
        _ => &[],
    };
    for field in unsupported {
        if let Some(value) = options.remove(*field) {
            if !value.is_null()
                && !(*field == "stop" && value.as_array().is_some_and(Vec::is_empty))
            {
                return Err(Error::Protocol(format!(
                    "request parameter '{field}' is not supported by {}",
                    protocol.as_str()
                )));
            }
        }
    }
    Ok(())
}

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
        // Discriminated objects cannot borrow fields from a different mode.
        if let (Some(kind), Some(default_kind)) = (body.get("type"), defaults.get("type")) {
            if kind != default_kind {
                return;
            }
        }
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
        options["service_tier"] = json!("priority");
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

    #[test]
    fn explicit_thinking_mode_never_inherits_fields_from_another_mode() {
        let variants = [
            json!({"type":"disabled"}),
            json!({"type":"adaptive","display":"omitted"}),
            json!({"type":"enabled","budget_tokens":2048}),
        ];
        for explicit in &variants {
            for default in &variants {
                if explicit["type"] == default["type"] {
                    continue;
                }
                let mut body = json!({"thinking":explicit,"output_config":{"effort":"low"}});
                merge_extra_params(&mut body, &json!({
                    "thinking":default,"output_config":{"effort":"high","format":{"type":"json_schema"}}
                })).unwrap();
                assert_eq!(&body["thinking"], explicit);
                assert_eq!(body["output_config"]["effort"], "low");
                assert_eq!(body["output_config"]["format"]["type"], "json_schema");
            }
        }
        let mut body = json!({"thinking":{"type":"enabled","budget_tokens":2048}});
        merge_extra_params(
            &mut body,
            &json!({"thinking":{
                "type":"enabled","budget_tokens":4096,"display":"summarized"
            }}),
        )
        .unwrap();
        assert_eq!(
            body["thinking"],
            json!({"type":"enabled","budget_tokens":2048,"display":"summarized"})
        );
    }

    #[test]
    fn serialized_thinking_keeps_the_callers_mode_across_all_defaults() {
        let mut model = ModelSpec::new("claude-test");
        model.reasoning.enabled = true;
        model.extra_params = json!({"thinking":{"type":"enabled","budget_tokens":4096}});
        let mut body = json!({"thinking":{"type":"disabled"}});
        apply(
            ProviderType::Anthropic,
            &mut body,
            &model,
            Some(8192),
            "conversation",
        )
        .unwrap();
        assert_eq!(body["thinking"], json!({"type":"disabled"}));
        assert_eq!(body["max_tokens"], 8192);
    }

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
