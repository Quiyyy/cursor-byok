//! Hydrates native tool state and persists only completed native tool cards.
use super::{CheckpointBuilder, PendingSteps};
use crate::{cursor::protocol::proto::agent::v1 as pb, store::BlobId, Error, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use prost::Message;
use serde_json::{json, Value};

impl CheckpointBuilder {
    pub(crate) fn use_native_tools(&mut self) {
        self.native_tools = true;
    }

    pub(crate) async fn native_tool_state(&self) -> Result<Value> {
        let mut todos = Vec::new();
        for id in &self.base.todos {
            todos.push(self.native_blob(id).await?);
        }
        let plan = match &self.base.plan {
            Some(id) => Some(self.native_blob(id).await?),
            None => None,
        };
        let date = self
            .base
            .conversation_started_timestamp_ms
            .and_then(|timestamp| chrono::DateTime::from_timestamp_millis(timestamp as i64))
            .map(|date| date.format("%Y-%m-%d").to_string());
        let plans = self
            .base
            .plans
            .values()
            .map(|plan| json!({"id": plan.id, "path": plan.path}))
            .collect::<Vec<_>>();
        let mut subagents = self
            .base
            .subagent_states
            .iter()
            .map(|(id, state)| (id.clone(), STANDARD.encode(state.encode_to_vec())))
            .collect::<std::collections::BTreeMap<_, _>>();
        for (id, blob) in &self.base.subagent_state_refs {
            subagents.insert(id.clone(), self.native_blob(blob).await?);
        }
        Ok(
            json!({"todos": todos, "plan": plan, "read_paths": self.base.read_paths, "plans": plans, "date": date, "subagents":subagents}),
        )
    }

    async fn native_blob(&self, raw: &[u8]) -> Result<String> {
        let id = BlobId::from_bytes(raw)?;
        let bytes = self.sync.get(&id).await?.ok_or_else(|| {
            Error::Protocol(format!("native state blob is missing: {}", id.to_base64()))
        })?;
        Ok(STANDARD.encode(bytes))
    }

    pub(super) async fn record_native_state(&mut self, presentation: &PendingSteps) -> Result<()> {
        for step in &presentation.steps {
            let Some(pb::conversation_step::Message::ToolCall(card)) = &step.message else {
                continue;
            };
            let todos = match &card.tool {
                Some(pb::tool_call::Tool::UpdateTodosToolCall(tool)) => {
                    match tool.result.as_ref().and_then(|r| r.result.as_ref()) {
                        Some(pb::update_todos_result::Result::Success(success)) => {
                            Some(&success.todos)
                        }
                        _ => None,
                    }
                }
                Some(pb::tool_call::Tool::CreatePlanToolCall(tool)) => {
                    if matches!(
                        tool.result.as_ref().and_then(|r| r.result.as_ref()),
                        Some(pb::create_plan_result::Result::Success(_))
                    ) {
                        if let Some(args) = &tool.args {
                            let plan = pb::ConversationPlan {
                                plan: args.plan.clone(),
                            };
                            self.base.plan = Some(
                                self.sync
                                    .persist(&plan.encode_to_vec(), &[])
                                    .await?
                                    .as_bytes()
                                    .to_vec(),
                            );
                            let uri = tool
                                .result
                                .as_ref()
                                .map(|r| r.plan_uri.as_str())
                                .unwrap_or_default();
                            if !uri.is_empty() {
                                let path = url::Url::parse(uri)
                                    .ok()
                                    .and_then(|url| url.to_file_path().ok())
                                    .map(|path| path.to_string_lossy().into_owned())
                                    .unwrap_or_else(|| uri.into());
                                let id = std::path::Path::new(&path)
                                    .file_stem()
                                    .and_then(|s| s.to_str())
                                    .unwrap_or(uri)
                                    .to_string();
                                self.base
                                    .plans
                                    .insert(id.clone(), pb::PlanRegistryEntry { id, path });
                            }
                            (!args.todos.is_empty()).then_some(&args.todos)
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                }
                _ => None,
            };
            if let Some(todos) = todos {
                let mut ids = Vec::with_capacity(todos.len());
                for todo in todos {
                    ids.push(
                        self.sync
                            .persist(&todo.encode_to_vec(), &[])
                            .await?
                            .as_bytes()
                            .to_vec(),
                    );
                }
                self.base.todos = ids;
            }
        }
        Ok(())
    }
}
