//! Carries native text-input tools over providers that only accept JSON functions.
use super::{ModelEvent, ProviderStream};
use crate::{
    model::{ModelInvocation, ProjectedContent},
    Error,
};
use futures_util::StreamExt;
use serde_json::json;
use std::collections::{BTreeMap, HashSet};

pub(crate) fn json_request(mut invocation: ModelInvocation) -> (ModelInvocation, HashSet<String>) {
    let mut names = HashSet::new();
    for tool in &mut invocation.request.prompt.tools {
        if let Some(format) = tool.input_format.take() {
            names.insert(tool.name.clone());
            let description=match format {
                crate::model::ToolInputFormat::Text=>"The complete tool input, unchanged.".to_string(),
                crate::model::ToolInputFormat::Grammar{definition,syntax}=>format!("The complete tool input as text, matching this {syntax} grammar:\n{definition}"),
            };
            tool.parameters = json!({"type":"object","properties":{"input":{"type":"string","description":description}},"required":["input"],"additionalProperties":false});
        }
    }
    for message in &mut invocation.request.history {
        if let ProjectedContent::Assistant { calls, .. } = &mut message.content {
            for call in calls {
                if let Some(text) = call.arguments.as_str() {
                    call.arguments = json!({"input":text});
                }
            }
        }
    }
    (invocation, names)
}

pub(crate) fn json_response(mut stream: ProviderStream, names: HashSet<String>) -> ProviderStream {
    if names.is_empty() {
        return stream;
    }
    Box::pin(async_stream::try_stream! {
        let mut inputs=BTreeMap::<usize,String>::new();
        while let Some(event)=stream.next().await {
            let event=event?;
            match &event {
                ModelEvent::ToolCallStart{index,name,..} if names.contains(name)=>{
                    inputs.insert(*index,String::new());
                    let index=*index;yield event;yield ModelEvent::ToolCallRawInput{index};
                }
                ModelEvent::ToolCallArgumentsDelta{index,delta} if inputs.contains_key(index)=>{inputs.get_mut(index).unwrap().push_str(delta);}
                ModelEvent::ToolCallEnd{index} if inputs.contains_key(index)=>{
                    let input=inputs.remove(index).unwrap();
                    let parsed:serde_json::Value=serde_json::from_str(&input).map_err(|e|Error::Provider(format!("invalid text-tool JSON envelope: {e}")))?;
                    let raw=parsed.get("input").and_then(serde_json::Value::as_str).ok_or_else(||Error::Provider("text tool envelope is missing string input".into()))?;
                    yield ModelEvent::ToolCallArgumentsDelta{index:*index,delta:raw.into()};
                    yield event;
                }
                _=>yield event,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{ModelRequest, ModelSpec, PromptSpec, ToolDefinition, ToolInputFormat};
    #[tokio::test]
    async fn text_tool_json_transport_preserves_patch_and_original_request() {
        let invocation = ModelInvocation {
            call_id: "m".into(),
            run_id: "r".into(),
            conversation_id: "c".into(),
            request: ModelRequest {
                native_responses: None,
                model: ModelSpec::new("model"),
                history: vec![],
                prompt: PromptSpec {
                    instructions: "system".into(),
                    tools: vec![ToolDefinition {
                        name: "ApplyPatch".into(),
                        description: "patch".into(),
                        parameters: json!({"type":"string"}),
                        input_format: Some(ToolInputFormat::Text),
                    }],
                },
            },
        };
        let (wire, names) = json_request(invocation.clone());
        assert!(invocation.request.prompt.tools[0].input_format.is_some());
        assert_eq!(
            wire.request.prompt.tools[0].parameters["required"],
            json!(["input"])
        );
        let patch = "*** Begin Patch\n*** Add File: a\n+你好\n*** End Patch\n";
        let output = Box::pin(futures_util::stream::iter(vec![
            Ok(ModelEvent::ToolCallStart {
                index: 0,
                call_id: "c".into(),
                name: "ApplyPatch".into(),
            }),
            Ok(ModelEvent::ToolCallArgumentsDelta {
                index: 0,
                delta: json!({"input":patch}).to_string(),
            }),
            Ok(ModelEvent::ToolCallEnd { index: 0 }),
        ]));
        let events = json_response(output, names).collect::<Vec<_>>().await;
        assert_eq!(
            events[1].as_ref().unwrap(),
            &ModelEvent::ToolCallRawInput { index: 0 }
        );
        assert_eq!(
            events[2].as_ref().unwrap(),
            &ModelEvent::ToolCallArgumentsDelta {
                index: 0,
                delta: patch.into()
            }
        );
    }
}
