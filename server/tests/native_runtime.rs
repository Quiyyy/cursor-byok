//! End-to-end native tool execution through real worker IPC and Cursor protobuf callbacks.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;
use cursor_server::{
    cursor::{
        native::NativeRuntime,
        prompting::PromptCompiler,
        protocol::{connect, proto::agent::v1 as pb},
        TransportCommand, TransportRegistry,
    },
    provider::{FinishReason, ModelEvent},
};
use prost::Message;
use serde_json::json;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Duration};

fn tool_events(index: usize, name: &str, input: String, raw: bool) -> Vec<ModelEvent> {
    let mut events = vec![
        ModelEvent::Start {
            model_call_id: format!("model-{index}"),
        },
        ModelEvent::ToolCallStart {
            index: 0,
            call_id: format!("tool-{index}"),
            name: name.into(),
        },
    ];
    if raw {
        events.push(ModelEvent::ToolCallRawInput { index: 0 });
    }
    events.extend([
        ModelEvent::ToolCallArgumentsDelta {
            index: 0,
            delta: input,
        },
        ModelEvent::ToolCallEnd { index: 0 },
        ModelEvent::Done(FinishReason::ToolUse),
    ]);
    events
}

#[tokio::test]
#[ignore = "requires the installed Cursor runtime"]
async fn native_tools_complete_through_the_real_cursor_protocol() {
    for model in ["grok-4.6", "gpt-5.4"] {
        let (directory, store) = fixtures::temp_store().await;
        let app = PathBuf::from(std::env::var("CURSOR_APP_DIR").expect("set CURSOR_APP_DIR"));
        let node = std::env::var_os("CURSOR_NODE_EXECUTABLE")
            .map(PathBuf::from)
            .unwrap_or_else(|| app.join("../../Cursor.exe"));
        let native =
            NativeRuntime::in_directory(app, node, directory.path().join("runtime")).unwrap();
        let provider = fake_provider::FakeProvider::default();
        if model == "grok-4.6" {
            provider.push(tool_events(
                0,
                "ReadLints",
                json!({"paths":["/fixture/a.ts","/fixture/b.ts"]}).to_string(),
                false,
            ));
            provider.push(tool_events(1,"StrReplace",json!({"path":"/fixture/code.ts","old_string":"    return a+b;","new_string":"  return a + b;"}).to_string(),false));
            provider.push(tool_events(
                2,
                "Read",
                json!({"path":"/fixture/code.ts"}).to_string(),
                false,
            ));
            provider.push(tool_events(3,"TodoWrite",json!({"merge":false,"todos":[{"id":"one","content":"First item","status":"pending"},{"id":"two","content":"Second item","status":"pending"}]}).to_string(),false));
            provider.push(tool_events(
                4,
                "TodoWrite",
                json!({"merge":true,"todos":[{"id":"one","status":"completed"}]}).to_string(),
                false,
            ));
        } else {
            provider.push(tool_events(0,"ApplyPatch","*** Begin Patch\n*** Update File: /fixture/code.ts\n@@\n-  return a+b;\n+  return a + b;\n*** End Patch\n".into(),true));
        }
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: "final".into(),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta("verified".into()),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
        let registry = TransportRegistry::new(
            store,
            Arc::new(provider.clone()),
            PromptCompiler::native(native).unwrap(),
        );
        let handle = registry.get_or_create("native-check").await.unwrap();
        let mut output = handle.subscribe();
        let mut seqno = 0;
        let request = pb::AgentRunRequest {
            conversation_id: Some("native-conversation".into()),
            run_id: Some("native-run".into()),
            requested_model: Some(pb::RequestedModel {
                model_id: model.into(),
                ..Default::default()
            }),
            action: Some(pb::ConversationAction {
                action: Some(pb::conversation_action::Action::UserMessageAction(
                    pb::UserMessageAction {
                        user_message: Some(pb::UserMessage {
                            text: "validate fixture".into(),
                            message_id: "user".into(),
                            mode: 1,
                            ..Default::default()
                        }),
                        request_context: Some(pb::RequestContext::default()),
                        ..Default::default()
                    },
                )),
                ..Default::default()
            }),
            ..Default::default()
        };
        append(
            &handle,
            &mut seqno,
            pb::agent_client_message::Message::RunRequest(request),
        )
        .await;
        let mut content = "function add(a, b) {\n  return a+b;\n}\n".to_string();
        let mut diagnostics = Vec::new();
        let mut blobs = HashMap::new();
        let mut completed = 0;
        let mut checkpoint = pb::ConversationStateStructure::default();
        loop {
            let frame = tokio::time::timeout(Duration::from_secs(45), output.recv())
                .await
                .expect("native run timed out")
                .expect("transport closed");
            let (flags, bytes) = connect::decode_frames(&frame).unwrap().pop().unwrap();
            if flags & connect::END_STREAM_FLAG != 0 {
                let end: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                assert!(end.get("error").is_none(), "{end}");
                break;
            }
            let message = pb::AgentServerMessage::decode(bytes).unwrap();
            match message.message {
                Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                    let result = match kv.message.unwrap() {
                        pb::kv_server_message::Message::SetBlobArgs(set) => {
                            blobs.insert(set.blob_id, set.blob_data);
                            pb::kv_client_message::Message::SetBlobResult(pb::SetBlobResult {
                                error: None,
                            })
                        }
                        pb::kv_server_message::Message::GetBlobArgs(get) => {
                            pb::kv_client_message::Message::GetBlobResult(pb::GetBlobResult {
                                blob_data: Some(blobs[&get.blob_id].clone()),
                                error: None,
                            })
                        }
                    };
                    append(
                        &handle,
                        &mut seqno,
                        pb::agent_client_message::Message::KvClientMessage(pb::KvClientMessage {
                            id: kv.id,
                            message: Some(result),
                        }),
                    )
                    .await;
                }
                Some(pb::agent_server_message::Message::ExecServerMessage(exec)) => {
                    let result = match exec.message.unwrap() {
                        pb::exec_server_message::Message::ReadArgs(args) => {
                            pb::exec_client_message::Message::ReadResult(pb::ReadResult {
                                result: Some(pb::read_result::Result::Success(pb::ReadSuccess {
                                    path: args.path,
                                    file_size: content.len() as i64,
                                    total_lines: 3,
                                    output: Some(pb::read_success::Output::Content(
                                        content.clone(),
                                    )),
                                    ..Default::default()
                                })),
                            })
                        }
                        pb::exec_server_message::Message::WriteArgs(args) => {
                            content = args.file_text;
                            pb::exec_client_message::Message::WriteResult(pb::WriteResult {
                                result: Some(pb::write_result::Result::Success(pb::WriteSuccess {
                                    path: args.path,
                                    file_size: content.len() as i32,
                                    ..Default::default()
                                })),
                            })
                        }
                        pb::exec_server_message::Message::DiagnosticsArgs(args) => {
                            diagnostics.push(args.path.clone());
                            pb::exec_client_message::Message::DiagnosticsResult(
                                pb::DiagnosticsResult {
                                    result: Some(pb::diagnostics_result::Result::Success(
                                        pb::DiagnosticsSuccess {
                                            path: args.path,
                                            ..Default::default()
                                        },
                                    )),
                                },
                            )
                        }
                        other => panic!("unexpected native exec: {other:?}"),
                    };
                    append(
                        &handle,
                        &mut seqno,
                        pb::agent_client_message::Message::ExecClientMessage(
                            pb::ExecClientMessage {
                                id: exec.id,
                                message: Some(result),
                                ..Default::default()
                            },
                        ),
                    )
                    .await;
                    append(
                        &handle,
                        &mut seqno,
                        pb::agent_client_message::Message::ExecClientControlMessage(
                            pb::ExecClientControlMessage {
                                message: Some(
                                    pb::exec_client_control_message::Message::StreamClose(
                                        pb::ExecClientStreamClose { id: exec.id },
                                    ),
                                ),
                            },
                        ),
                    )
                    .await;
                }
                Some(pb::agent_server_message::Message::InteractionUpdate(update)) => {
                    if matches!(
                        update.message,
                        Some(pb::interaction_update::Message::ToolCallCompleted(_))
                    ) {
                        completed += 1;
                    }
                }
                Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                    checkpoint = state
                }
                _ => {}
            }
        }
        assert!(content.contains("return a + b;"), "{model}: {content}");
        assert!(completed > 0);
        if model == "grok-4.6" {
            assert_eq!(diagnostics, ["/fixture/a.ts", "/fixture/b.ts"]);
            assert_eq!(completed, 5);
            assert!(checkpoint.read_paths.contains(&"/fixture/code.ts".into()));
            let todos = checkpoint
                .todos
                .iter()
                .map(|id| pb::TodoItem::decode(blobs[id].as_slice()).unwrap())
                .collect::<Vec<_>>();
            assert_eq!(todos.len(), 2);
            let first = todos.iter().find(|todo| todo.id == "one").unwrap();
            assert_eq!(first.status, pb::TodoStatus::Completed as i32);
            assert_eq!(first.content, "First item");
        }
        let requests = provider.requests();
        assert!(requests.len() >= 2);
        for pair in requests.windows(2) {
            assert_eq!(pair[0].prompt, pair[1].prompt);
            assert_eq!(pair[0].history, pair[1].history[..pair[0].history.len()]);
        }
        registry.shutdown().await;
    }
}
async fn append(
    handle: &cursor_server::cursor::TransportHandle,
    seqno: &mut i64,
    message: pb::agent_client_message::Message,
) {
    handle
        .command(TransportCommand::Append {
            seqno: *seqno,
            message: Box::new(pb::AgentClientMessage {
                message: Some(message),
            }),
        })
        .await
        .unwrap();
    *seqno += 1;
}
