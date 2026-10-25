//! Validates the native WebSearch auxiliary response and exposes citation URLs.
use crate::{Error, Result};
use axum::{
    body::to_bytes,
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

pub(super) fn prepare(body: &mut Value) -> bool {
    let search = body["input"].is_string()
        && body["stream"] != true
        && body["tools"].as_array().is_some_and(|tools| {
            !tools.is_empty()
                && tools.iter().all(|tool| {
                    matches!(
                        tool["type"].as_str(),
                        Some("web_search" | "web_search_preview")
                    )
                })
        });
    if search && body.get("tool_choice").is_none() {
        body["tool_choice"] = json!("required");
    }
    search
}

pub(super) async fn finish(response: Response) -> Response {
    if !response.status().is_success() {
        return response;
    }
    let result = async {
        let bytes = to_bytes(response.into_body(), 64 * 1024 * 1024)
            .await
            .map_err(|error| Error::Provider(format!("cannot read search response: {error}")))?;
        validate(serde_json::from_slice(&bytes)?)
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => super::api_error(StatusCode::BAD_GATEWAY, error),
    }
}

fn validate(mut response: Value) -> Result<Value> {
    let output = response["output"]
        .as_array()
        .ok_or_else(|| Error::Provider("WebSearch provider returned no output items".into()))?;
    if response["status"] != "completed"
        || !output
            .iter()
            .any(|item| item["type"] == "web_search_call" && item["status"] == "completed")
    {
        return Err(Error::Provider("WebSearch provider did not complete a web_search_call; this connection must support Responses built-in web search".into()));
    }
    let parts = output
        .iter()
        .filter_map(|item| item["content"].as_array())
        .flatten()
        .collect::<Vec<_>>();
    let mut text = response["output_text"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        });
    if text.trim().is_empty() {
        return Err(Error::Provider(
            "WebSearch provider completed without an answer".into(),
        ));
    }
    // Cursor's native renderer uses answer text instead of document references
    // when both exist. Keep the provider output intact and enrich output_text.
    let mut seen = std::collections::HashSet::new();
    for citation in parts
        .iter()
        .filter_map(|part| part["annotations"].as_array())
        .flatten()
    {
        if citation["type"] != "url_citation" {
            continue;
        }
        let Some(url) = citation["url"].as_str() else {
            continue;
        };
        if !reqwest::Url::parse(url).is_ok_and(|value| matches!(value.scheme(), "https" | "http"))
            || !seen.insert(url)
            || text.contains(url)
        {
            continue;
        }
        let title = citation["title"]
            .as_str()
            .unwrap_or("Source")
            .replace(['\r', '\n'], " ");
        text.push_str(&format!("\n\n{title}: {url}"));
    }
    response["output_text"] = json!(text);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn forces_search_only_for_native_auxiliary_requests() {
        let mut request = json!({"model":"gpt","input":"query","tools":[{"type":"web_search"}]});
        assert!(prepare(&mut request));
        assert_eq!(request["tool_choice"], "required");
        request["tool_choice"] = json!({"type":"web_search"});
        assert!(prepare(&mut request));
        assert_eq!(request["tool_choice"], json!({"type":"web_search"}));
        for request in [
            json!({"input":"query","stream":true,"tools":[{"type":"web_search"}]}),
            json!({"input":[],"tools":[{"type":"function","name":"WebSearch"}]}),
            json!({"input":"query","tools":[]}),
        ] {
            let mut body = request.clone();
            assert!(!prepare(&mut body));
            assert_eq!(body, request);
        }
    }

    #[test]
    fn rejects_placeholder_answers_and_preserves_annotation_only_sources() {
        let message = json!({"type":"message","content":[{"type":"output_text","text":"Found it.","annotations":[{"type":"url_citation","url":"https://example.com/source","title":"Source"}]}]});
        assert!(validate(json!({"status":"completed","output":[message.clone()]})).is_err());
        let original = json!({"status":"completed","output":[{"type":"web_search_call","status":"completed","action":{"type":"search"}},message]});
        let result = validate(original.clone()).unwrap();
        assert_eq!(result["output"], original["output"]);
        assert!(result["output_text"]
            .as_str()
            .unwrap()
            .contains("https://example.com/source"));
        assert!(validate(json!({"status":"incomplete","output":original["output"]})).is_err());
        assert!(validate(json!({"status":"completed","output":[{"type":"web_search_call","status":"failed"},original["output"][1]]})).is_err());
    }

    #[test]
    fn accepts_completed_search_with_no_matches_but_rejects_empty_answers() {
        let mut value = json!({"status":"completed","output":[{"type":"web_search_call","status":"completed"},{"type":"message","content":[{"type":"output_text","text":"No matching results."}]}]});
        assert!(validate(value.clone()).is_ok());
        value["output"][1]["content"][0]["text"] = json!("");
        assert!(validate(value).is_err());
    }
}
