//! Bridges native resources and interaction events to the owning Cursor transport.
use super::{
    session::{bytes, Lease},
    NativeCallback, NativeRun,
};
use crate::{
    cursor::{
        conversation::Tasks,
        protocol::proto::agent::v1 as pb,
        tools::{
            runtime::{CursorToolRuntime, ExecContext},
            tool_call_result::{ReadImage, ToolCompletion, ToolResultSender},
        },
        transport::TransportHandle,
    },
    search::{WebFetch, WebSearch},
    Error, Result,
};
use prost::Message;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Clone)]
pub(crate) struct Bridge {
    pub handle: TransportHandle,
    pub runtime: CursorToolRuntime,
    pub context: ExecContext,
    pub results: ToolResultSender,
    pub tasks: Tasks,
    pub search: WebSearch,
    pub fetch: WebFetch,
}
impl NativeRun {
    pub(crate) async fn bind(&self, bridge: Bridge) -> Result<()> {
        self.configure(&bridge.context)?;
        let Some(mut events) = self.events.lock().await.take() else {
            return Ok(());
        };
        let lease = Arc::downgrade(&self.lease);
        let calls = self.calls.clone();
        let profile = self.profile.clone();
        tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                let Some(lease) = lease.upgrade() else {
                    break;
                };
                let result = handle(&lease, &calls, &profile, &bridge, event).await;
                if let Err(error) = result {
                    bridge.results.send_error(error);
                }
            }
        });
        Ok(())
    }
}

type Calls = parking_lot::Mutex<std::collections::HashMap<String, super::session::CallState>>;
async fn handle(
    lease: &Arc<Lease>,
    calls: &Arc<Calls>,
    profile: &super::NativeProfile,
    bridge: &Bridge,
    event: Value,
) -> Result<()> {
    if event["kind"] == "failed" {
        return Err(Error::Protocol(
            event["error"]
                .as_str()
                .unwrap_or("native runtime failed")
                .into(),
        ));
    }
    if event["kind"] == "abort_exec" {
        let id = id(&event, "id")?;
        if bridge.runtime.native_exec(id).await.is_some() {
            bridge
                .handle
                .emit(&crate::cursor::tools::codec::abort(id))?;
        }
        return Ok(());
    }
    let job = event["job_id"]
        .as_str()
        .ok_or_else(|| Error::Protocol("native event has no job owner".into()))?;
    let Some((call, cancel, round, last_exec)) = calls.lock().get(job).map(|s| {
        (
            s.call.clone(),
            s.cancellation.clone(),
            s.round.clone(),
            s.last_exec,
        )
    }) else {
        return Ok(());
    };
    if cancel.is_cancelled() {
        if event["kind"] == "completion" || event["kind"] == "call_failed" {
            calls.lock().remove(job);
        }
        return Ok(());
    }
    let is_task = profile
        .semantics
        .get(&call.name)
        .is_some_and(|id| id == "TASK");
    match event["kind"].as_str() {
        Some("request") => {
            let request = event["request_id"]
                .as_u64()
                .ok_or_else(|| Error::Protocol("native request has no id".into()))?;
            let callback = NativeCallback {
                lease: lease.clone(),
                job_id: job.into(),
                reply_to: Some(request),
                cancellation: cancel.clone(),
                is_task,
            };
            let result: Result<Option<Value>> = match event["method"].as_str() {
                Some("reserve_exec") => bridge
                    .runtime
                    .reserve_native(&call, &bridge.context, callback)
                    .await
                    .map(|id| Some(json!({"id":id}))),
                Some("reserve_interaction") => bridge
                    .runtime
                    .reserve_interaction(&call)
                    .await
                    .map(|id| Some(json!({"id":id}))),
                Some("interaction") => {
                    let query =
                        pb::InteractionQuery::decode(bytes(&event["params"], "bytes")?.as_slice())?;
                    if query.query.is_none() {
                        return Err(Error::Protocol(
                            "installed Cursor requires an unsupported interaction protocol".into(),
                        ));
                    }
                    bridge
                        .runtime
                        .bind_native_interaction(query.id, callback)
                        .await?;
                    bridge.handle.emit(&pb::AgentServerMessage {
                        message: Some(pb::agent_server_message::Message::InteractionQuery(query)),
                        ..Default::default()
                    })?;
                    Ok(None)
                }
                Some("web_search" | "web_fetch") => {
                    let method = event["method"].as_str().unwrap().to_string();
                    let params = event["params"].clone();
                    let search = bridge.search.clone();
                    let fetch = bridge.fetch.clone();
                    let lease = lease.clone();
                    tokio::spawn(async move {
                        let result = tokio::select! {_ = cancel.cancelled()=>Err(Error::Cancelled),result=web_service(&method,&params,&search,&fetch)=>result};
                        let _ = reply(&lease, request, result);
                    });
                    Ok(None)
                }
                Some(method) => Err(Error::Protocol(format!(
                    "native service is unavailable: {method}"
                ))),
                None => Err(Error::Protocol("native service name is missing".into())),
            };
            match result {
                Ok(Some(value)) => reply(lease, request, Ok(value))?,
                Ok(None) => {}
                Err(error) => reply(lease, request, Err(error))?,
            }
        }
        Some("exec") => {
            let exec = pb::ExecServerMessage::decode(bytes(&event, "bytes")?.as_slice())?;
            if exec.message.is_none() {
                return Err(Error::Protocol(
                    "installed Cursor requires an unsupported executor protocol".into(),
                ));
            }
            let owner = bridge
                .runtime
                .exec_call(exec.id)
                .await
                .ok_or_else(|| Error::Protocol("unreserved native exec id".into()))?;
            if owner.call_id != call.call_id || owner.model_call_id != call.model_call_id {
                return Err(Error::Protocol("native exec owner mismatch".into()));
            }
            if let Some(state) = calls.lock().get_mut(job) {
                state.last_exec = Some(exec.id);
            }
            if is_task {
                if let Some(round) = round {
                    bridge.tasks.register(&round, vec![(exec.id, call)]);
                }
            }
            bridge.handle.emit(&pb::AgentServerMessage {
                message: Some(pb::agent_server_message::Message::ExecServerMessage(exec)),
                ..Default::default()
            })?;
        }
        Some("tool_event") => {
            let update = pb::InteractionUpdate::decode(bytes(&event, "bytes")?.as_slice())?;
            if update.message.is_none() {
                return Err(Error::Protocol(
                    "installed Cursor requires an unsupported tool event protocol".into(),
                ));
            }
            if matches!(
                update.message,
                Some(pb::interaction_update::Message::ToolCallCompleted(_))
            ) {
                return Err(Error::Protocol(
                    "native completion bypassed checkpoint barrier".into(),
                ));
            }
            bridge.handle.emit(&pb::AgentServerMessage {
                message: Some(pb::agent_server_message::Message::InteractionUpdate(update)),
                ..Default::default()
            })?;
        }
        Some("completion") => {
            calls.lock().remove(job);
            let card = pb::ToolCall::decode(bytes(&event, "tool_call")?.as_slice())?;
            let mut texts = Vec::new();
            let mut image = None;
            for part in event["content"]
                .as_array()
                .ok_or_else(|| Error::Protocol("native result has no content".into()))?
            {
                match part["type"].as_str() {
                    Some("text") => {
                        texts.push(part["text"].as_str().unwrap_or_default().to_string())
                    }
                    Some("image") if image.is_none() => {
                        image = Some(ReadImage {
                            data: bytes(part, "data")?,
                            mime_type: part["mimeType"]
                                .as_str()
                                .filter(|mime| mime.starts_with("image/"))
                                .ok_or_else(|| {
                                    Error::Protocol(
                                        "native image result has no image MIME type".into(),
                                    )
                                })?
                                .into(),
                            path: match &card.tool {
                                Some(pb::tool_call::Tool::ReadToolCall(read)) => read
                                    .args
                                    .as_ref()
                                    .map(|args| args.path.clone())
                                    .unwrap_or_default(),
                                _ => String::new(),
                            },
                        });
                    }
                    _ => return Err(Error::Protocol("unsupported native result content".into())),
                }
            }
            let mut completion = ToolCompletion::from_native(
                &call,
                card,
                texts.join("\n"),
                event["is_error"].as_bool().unwrap_or(false),
                image,
            )?;
            completion.exec_id = last_exec;
            bridge
                .tasks
                .receive(completion, &bridge.results, &bridge.handle);
        }
        Some("call_failed") => {
            calls.lock().remove(job);
            return Err(Error::Protocol(
                event["error"]
                    .as_str()
                    .unwrap_or("native tool failed")
                    .into(),
            ));
        }
        _ => return Err(Error::Protocol("unknown native event".into())),
    }
    Ok(())
}
fn reply(lease: &Lease, id: u64, result: Result<Value>) -> Result<()> {
    lease.worker.send(match result {
        Ok(value) => json!({"reply_to":id,"result":value}),
        Err(error) => json!({"reply_to":id,"error":error.to_string()}),
    })
}
fn id(value: &Value, key: &str) -> Result<u32> {
    value[key]
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .ok_or_else(|| Error::Protocol(format!("invalid native {key}")))
}
async fn web_service(
    method: &str,
    params: &Value,
    search: &WebSearch,
    fetch: &WebFetch,
) -> Result<Value> {
    if method == "web_search" {
        let query = params["search_term"]
            .as_str()
            .ok_or_else(|| Error::Protocol("missing native search query".into()))?;
        let hits = search
            .search(query)
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        Ok(
            json!({"documents":hits.into_iter().map(|h|json!({"title":h.title,"url":h.url,"text":h.chunk})).collect::<Vec<_>>()}),
        )
    } else {
        let url = params["url"]
            .as_str()
            .ok_or_else(|| Error::Protocol("missing native fetch URL".into()))?;
        let page = fetch
            .fetch(url)
            .await
            .map_err(|e| Error::Provider(e.to_string()))?;
        Ok(json!({"url":page.url,"content":page.markdown}))
    }
}
