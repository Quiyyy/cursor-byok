//! Resume an existing Cursor checkpoint with new instructions and unchanged history.
#[path = "support/fake_provider.rs"]
mod fake_provider;
#[path = "support/fixtures.rs"]
mod fixtures;
use cursor_server::{
    cursor::{
        prompting::PromptCompiler,
        protocol::{connect, proto::agent::v1 as pb},
        TransportCommand, TransportRegistry,
    },
    provider::{FinishReason, ModelEvent},
};
use prost::Message;
use std::{collections::HashMap, sync::Arc};

#[tokio::test]
async fn existing_checkpoint_uses_latest_protocol_without_rewriting_messages() {
    let (directory, store) = fixtures::temp_store().await;
    let path = directory.path().join("protocol.json");
    let mut assets: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/cursor/protocol.json")).unwrap();
    std::fs::write(&path, serde_json::to_vec(&assets).unwrap()).unwrap();
    let provider = fake_provider::FakeProvider::default();
    for index in 0..2 {
        provider.push(vec![
            ModelEvent::Start {
                model_call_id: format!("call-{index}"),
            },
            ModelEvent::TextStart,
            ModelEvent::TextDelta(format!("answer-{index}")),
            ModelEvent::TextEnd,
            ModelEvent::Done(FinishReason::Stop),
        ]);
    }
    let registry = TransportRegistry::new(
        store,
        Arc::new(provider.clone()),
        PromptCompiler::from_fixture_file(path.clone()).unwrap(),
    );
    let mut blobs = HashMap::new();
    let first = drive(&registry, "first", None, &mut blobs).await;
    assets["instructions"] = "Updated unified instructions for the existing conversation".into();
    std::fs::write(&path, serde_json::to_vec(&assets).unwrap()).unwrap();
    let second = drive(&registry, "second", Some(first.clone()), &mut blobs).await;
    let requests = provider.requests();
    assert_eq!(requests.len(), 2);
    assert_ne!(
        requests[0].prompt.instructions,
        requests[1].prompt.instructions
    );
    assert_eq!(
        requests[1].prompt.instructions,
        assets["instructions"].as_str().unwrap()
    );
    assert_eq!(requests[0].prompt.tools, requests[1].prompt.tools);
    assert_eq!(
        requests[0].history,
        requests[1].history[..requests[0].history.len()]
    );
    assert_ne!(
        first.root_prompt_messages_json[0],
        second.root_prompt_messages_json[0]
    );
    assert_eq!(
        first.root_prompt_messages_json[1..],
        second.root_prompt_messages_json[1..first.root_prompt_messages_json.len()]
    );
    registry.shutdown().await;
}

async fn drive(
    registry: &TransportRegistry,
    id: &str,
    state: Option<pb::ConversationStateStructure>,
    blobs: &mut HashMap<Vec<u8>, Vec<u8>>,
) -> pb::ConversationStateStructure {
    let handle = registry.get_or_create(id).await.unwrap();
    let mut output = handle.subscribe();
    let request = pb::AgentRunRequest {
        conversation_id: Some("existing-conversation".into()),
        run_id: Some(id.into()),
        conversation_state: state,
        pre_fetched_blobs: blobs
            .iter()
            .map(|(id, value)| pb::PreFetchedBlob {
                id: id.clone(),
                value: value.clone(),
            })
            .collect(),
        requested_model: Some(pb::RequestedModel {
            model_id: "model".into(),
            ..Default::default()
        }),
        action: Some(pb::ConversationAction {
            action: Some(pb::conversation_action::Action::UserMessageAction(
                pb::UserMessageAction {
                    user_message: Some(pb::UserMessage {
                        text: format!("question-{id}"),
                        message_id: format!("user-{id}"),
                        mode: pb::AgentMode::Agent as i32,
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
    handle
        .command(TransportCommand::Append {
            seqno: 0,
            message: Box::new(pb::AgentClientMessage {
                message: Some(pb::agent_client_message::Message::RunRequest(request)),
            }),
        })
        .await
        .unwrap();
    let mut seqno = 1;
    let mut checkpoint = None;
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), output.recv())
            .await
            .unwrap()
            .unwrap();
        let (flags, payload) = connect::decode_frames(&frame).unwrap().pop().unwrap();
        if flags & connect::END_STREAM_FLAG != 0 {
            break;
        }
        let message = pb::AgentServerMessage::decode(payload).unwrap();
        match message.message {
            Some(pb::agent_server_message::Message::KvServerMessage(kv)) => {
                let response = match kv.message.unwrap() {
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
                handle
                    .command(TransportCommand::Append {
                        seqno,
                        message: Box::new(pb::AgentClientMessage {
                            message: Some(pb::agent_client_message::Message::KvClientMessage(
                                pb::KvClientMessage {
                                    id: kv.id,
                                    message: Some(response),
                                },
                            )),
                        }),
                    })
                    .await
                    .unwrap();
                seqno += 1;
            }
            Some(pb::agent_server_message::Message::ConversationCheckpointUpdate(state)) => {
                checkpoint = Some(state)
            }
            _ => {}
        }
    }
    checkpoint.expect("completed checkpoint")
}
