//! Every exported built-in must reach an executable Cursor route with its native arguments.
use cursor_server::{
    cursor::{
        protocol::proto::agent::v1 as pb,
        tools::{
            runtime::{CursorToolRuntime, ExecContext},
            ToolBatchState, ToolDispatcher,
        },
    },
    model::{ToolCall, ToolDefinition},
};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

fn arguments(name: &str) -> Value {
    match name {
        "AskQuestion" => {
            json!({"questions":[{"id":"q","prompt":"Choose fixture","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}]})
        }
        "CreatePlan" => json!({"plan":"Read fixture and verify it"}),
        "Delete" | "Read" => json!({"path":"/fixture/input.txt"}),
        "Write" => json!({"path":"/fixture/output.txt","contents":"new"}),
        "StrReplace" => json!({"path":"/fixture/input.txt","old_string":"old","new_string":"new"}),
        "EditNotebook" => {
            json!({"target_notebook":"/fixture/test.ipynb","cell_idx":0.0,"is_new_cell":true,"cell_language":"python","old_string":"","new_string":"x = 1"})
        }
        "GenerateImage" => json!({"description":"A fixture square"}),
        "Glob" => json!({"glob_pattern":"*.txt"}),
        "Grep" => json!({"pattern":"needle","-C":2.0,"head_limit":10.0}),
        "ReadLints" => json!({}),
        "Shell" => json!({"command":"echo fixture","block_until_ms":30000.0}),
        "SwitchMode" => json!({"target_mode_id":"plan"}),
        "Task" => json!({"description":"Check fixture","prompt":"Read fixture only"}),
        "TodoWrite" => {
            json!({"merge":false,"todos":[{"id":"a","content":"read","status":"pending"},{"id":"b","content":"verify","status":"pending"}]})
        }
        "WebFetch" => json!({"url":"https://example.com/"}),
        "WebSearch" => json!({"search_term":"fixture"}),
        other => panic!("missing execution contract for {other}"),
    }
}

#[tokio::test]
async fn every_native_tool_has_a_working_dispatch_contract() {
    let protocol: Value =
        serde_json::from_str(include_str!("../prompt/cursor/protocol.json")).unwrap();
    let tools: Vec<ToolDefinition> = serde_json::from_value(protocol["tools"].clone()).unwrap();
    let context = ExecContext {
        default_subagent_model: "fixture-model".into(),
        allow_subagents: true,
        ..Default::default()
    };
    for definition in tools {
        let args = arguments(&definition.name);
        for required in definition.parameters["required"]
            .as_array()
            .into_iter()
            .flatten()
        {
            assert!(
                args.get(required.as_str().unwrap()).is_some(),
                "fixture missing {required} for {}",
                definition.name
            );
        }
        let call = ToolCall {
            index: 0,
            call_id: "call".into(),
            model_call_id: "model".into(),
            name: definition.name.clone(),
            arguments_text: args.to_string(),
            arguments: args,
            argument_error: None,
        };
        let dispatcher = ToolDispatcher::new(CursorToolRuntime::default());
        let results = dispatcher
            .start_batch(
                &[call],
                ToolBatchState {
                    completed: &HashSet::new(),
                    started: &HashSet::new(),
                    response_text: "",
                    response_thinking: "",
                },
                &[],
                &BTreeMap::new(),
                &context,
            )
            .await
            .unwrap();
        let [result] = results.as_slice() else {
            panic!("expected one dispatch")
        };
        if let Some(completion) = &result.completion {
            assert!(
                !completion.result().is_error,
                "{}: {}",
                definition.name,
                completion.result().content
            );
        } else {
            assert!(
                result.messages.iter().any(|m| matches!(
                    m.message,
                    Some(pb::agent_server_message::Message::ExecServerMessage(_))
                        | Some(pb::agent_server_message::Message::InteractionQuery(_))
                )),
                "{} has no execution route",
                definition.name
            );
        }
        if definition.name == "Grep" {
            let args = result
                .messages
                .iter()
                .find_map(|m| match &m.message {
                    Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                        match &exec.message {
                            Some(pb::exec_server_message::Message::GrepArgs(args)) => Some(args),
                            _ => None,
                        }
                    }
                    _ => None,
                })
                .unwrap();
            assert_eq!(args.context, Some(2));
            assert_eq!(args.head_limit, Some(10));
        }
    }
}
