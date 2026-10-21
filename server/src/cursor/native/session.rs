//! A native Run lease and its callbacks into the existing Cursor transport.
use super::{process::Worker, NativeRuntime};
use crate::{
    cursor::{protocol::proto::agent::v1 as pb, tools::runtime::ExecContext},
    model::{ToolCall, ToolDefinition, ToolRoundId},
    Error, Result,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use prost::Message;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

pub(super) struct Lease {
    pub worker: Arc<Worker>,
    pub id: String,
}
impl Lease {
    pub fn notify(&self, method: &str, mut params: Value) -> Result<()> {
        params["session_id"] = self.id.clone().into();
        self.worker.notify(method, params)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let _ = self.notify("close", json!({}));
        self.worker.unsubscribe(&self.id);
    }
}

#[derive(Clone)]
pub(crate) struct NativeCallback {
    pub(super) lease: Arc<Lease>,
    pub(super) job_id: String,
    pub(super) reply_to: Option<u64>,
    pub(super) cancellation: CancellationToken,
    pub is_task: bool,
}
impl NativeCallback {
    pub fn exec(&self, message: &pb::ExecClientMessage) -> Result<()> {
        self.lease.notify(
            "exec_data",
            json!({"id":message.id,"bytes":STANDARD.encode(message.encode_to_vec())}),
        )
    }
    pub fn closed(&self, id: u32, error: Option<&str>) -> Result<()> {
        self.lease
            .notify("exec_closed", json!({"id":id,"error":error}))
    }
    pub fn interaction(&self, response: &pb::InteractionResponse) -> Result<()> {
        self.lease.worker.send(json!({"reply_to":self.reply_to.ok_or_else(||Error::Protocol("native interaction is not bound".into()))?,"result":STANDARD.encode(response.encode_to_vec())}))
    }
    pub fn cancel(&self) {
        self.cancellation.cancel();
        let _ = self.lease.notify("cancel", json!({"call_id":self.job_id}));
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct NativeProfile {
    pub instructions: String,
    pub tools: Vec<ToolDefinition>,
    pub metadata: Value,
    #[serde(default)]
    pub semantics: HashMap<String, String>,
}

pub(super) struct CallState {
    pub call: ToolCall,
    pub round: Option<ToolRoundId>,
    pub cancellation: CancellationToken,
    pub last_exec: Option<u32>,
}
#[derive(Clone)]
pub struct NativeRun {
    pub(super) lease: Arc<Lease>,
    pub profile: Arc<NativeProfile>,
    pub(super) calls: Arc<parking_lot::Mutex<HashMap<String, CallState>>>,
    pub(super) events: Arc<Mutex<Option<mpsc::UnboundedReceiver<Value>>>>,
    pub(super) round: Arc<parking_lot::Mutex<Option<ToolRoundId>>>,
}

impl NativeRuntime {
    pub async fn open(
        &self,
        model: &str,
        mode: i32,
        context: &pb::RequestContext,
        subagent: bool,
    ) -> Result<NativeRun> {
        let worker = self.worker().await?;
        let id = uuid::Uuid::new_v4().to_string();
        let events = worker.subscribe(id.clone());
        let lease = Arc::new(Lease { worker, id });
        let profile=lease.worker.request("open",json!({"session_id":lease.id,"model":model,"mode":mode,
            "request_context":STANDARD.encode(context.encode_to_vec()),"is_subagent":subagent,"supports_image_generation":false})).await?;
        Ok(NativeRun {
            lease,
            profile: Arc::new(serde_json::from_value(profile)?),
            calls: Arc::default(),
            events: Arc::new(Mutex::new(Some(events))),
            round: Arc::default(),
        })
    }
}

impl NativeRun {
    pub fn supports(&self, name: &str) -> bool {
        self.profile.tools.iter().any(|tool| tool.name == name)
    }
    pub async fn restore(&self, state: Value) -> Result<()> {
        self.lease
            .worker
            .request("restore", json!({"session_id":self.lease.id,"state":state}))
            .await?;
        Ok(())
    }
    pub fn is_task(&self, name: &str) -> bool {
        self.profile
            .semantics
            .get(name)
            .is_some_and(|id| id == "TASK")
    }
    pub fn set_round(&self, round: &ToolRoundId) {
        *self.round.lock() = Some(round.clone());
    }
    pub async fn begin(&self, call: &ToolCall) -> Result<()> {
        let key = job_key(call);
        if self.calls.lock().contains_key(&key) {
            return Err(Error::Protocol("duplicate native call".into()));
        }
        self.calls.lock().insert(
            key.clone(),
            CallState {
                call: call.clone(),
                round: None,
                cancellation: CancellationToken::new(),
                last_exec: None,
            },
        );
        let mut data = serde_json::to_value(call)?;
        data["job_id"] = key.into();
        if let Err(error) = self
            .lease
            .worker
            .request("begin", json!({"session_id":self.lease.id,"call":data}))
            .await
        {
            self.calls.lock().remove(&job_key(call));
            return Err(error);
        }
        Ok(())
    }
    pub fn append(&self, call: &ToolCall, delta: &str) -> Result<()> {
        self.lease
            .notify("append", json!({"call_id":job_key(call),"delta":delta}))
    }
    pub fn end_arguments(&self, call: &ToolCall) -> Result<()> {
        self.lease
            .notify("end_arguments", json!({"call_id":job_key(call)}))
    }
    pub async fn execute(&self, call: &ToolCall) -> Result<()> {
        let key = job_key(call);
        if !self.calls.lock().contains_key(&key) {
            self.begin(call).await?;
            let input = call
                .arguments
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| call.arguments.to_string());
            self.append(call, &input)?;
            self.end_arguments(call)?;
        }
        if let Some(state) = self.calls.lock().get_mut(&key) {
            state.call = call.clone();
            state.round = self.round.lock().clone();
        }
        self.lease.notify("activate", json!({"call_id":key}))
    }
    pub fn cancel(&self, keep_tasks: bool) {
        for state in self.calls.lock().values() {
            if keep_tasks && state.round.is_some() && self.is_task(&state.call.name) {
                continue;
            }
            state.cancellation.cancel();
            let _ = self
                .lease
                .notify("cancel", json!({"call_id":job_key(&state.call)}));
        }
    }
    pub fn cancel_previews(&self) {
        for state in self
            .calls
            .lock()
            .values()
            .filter(|state| state.round.is_none())
        {
            state.cancellation.cancel();
            let _ = self
                .lease
                .notify("cancel", json!({"call_id":job_key(&state.call)}));
        }
    }
    pub fn configure(&self, context: &ExecContext) -> Result<()> {
        let task_model = match &context.subagent_model {
            Some(crate::cursor::tools::runtime::SubagentModel::Model(model)) => model,
            _ => &context.default_subagent_model,
        };
        self.lease.notify("configure",json!({"context":{"conversation_id":context.conversation_id,"root_conversation_id":context.root_conversation_id,
            "cursor_model":task_model,"admin_command_denylist":context.admin_command_denylist}}))
    }
}

fn job_key(call: &ToolCall) -> String {
    format!("{}:{}", call.model_call_id, call.call_id)
}

pub(super) fn bytes(value: &Value, key: &str) -> Result<Vec<u8>> {
    STANDARD
        .decode(
            value[key]
                .as_str()
                .ok_or_else(|| Error::Protocol(format!("native message missing {key}")))?,
        )
        .map_err(|e| Error::Protocol(format!("invalid native binary frame: {e}")))
}
