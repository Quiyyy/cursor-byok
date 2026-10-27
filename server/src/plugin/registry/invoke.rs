//! Runs one provider request with bounded authentication retry.
use super::*;

impl PluginRegistry {
    pub fn stream_model(
        &self,
        invocation: ModelInvocation,
        cancellation: CancellationToken,
        recorder: CallRecorder,
    ) -> ProviderStream {
        let registry = self.clone();
        Box::pin(try_stream! {
            let model_id = invocation.request.model.model_id.clone();
            let (plugin_id, provider_id, upstream_id) = parse_model_id(&model_id)
                .map(|(plugin, provider, model)| (plugin.to_owned(), provider.to_owned(), model.to_owned()))
                .ok_or_else(|| Error::Provider(format!("invalid plugin model ID: {model_id}")))?;
            let executable = registry.executable()?;
            let entry = registry.find_entry(&executable, &plugin_id).await?;
            let provider = find_provider(&entry, &provider_id)?.clone();
            if invocation.request.native_responses.is_some() && !provider.native_responses {
                Err(Error::Protocol("this account provider does not support native Responses tools".into()))?;
            }
            let stored = registry.inner.state.models(&plugin_id, &provider_id).await?
                .into_iter()
                .find(|model| model.id == upstream_id)
                .ok_or_else(|| Error::RunNotFound(format!("plugin model {model_id}")))?;
            let mut resource = match &provider.resource_type {
                Some(resource_type) => {
                    let record = registry.select_resource(&plugin_id, resource_type).await?;
                    Some((resource_type.clone(), registry.prepare_resource(&entry, &executable, resource_type, record, None).await?))
                }
                None => None,
            };
            let request = wire::llm_request(&invocation)?;
            let worker = registry.worker(&entry, &executable).await;
            yield ModelEvent::Start { model_call_id: invocation.call_id.clone() };
            for attempt in 0..2 {
                if cancellation.is_cancelled() { Err(Error::Cancelled)?; }
                let params = serde_json::json!({
                    "providerId": provider_id,
                    "model": stored.snapshot(),
                    "resource": resource.as_ref().map(|(kind, record)| record.snapshot(kind)),
                    "request": request,
                });
                let mut items = worker.invoke_streaming("provider.invoke", params, cancellation.clone(), Some(recorder.clone())).await?;
                let mut emitted = false;
                let mut retry = false;
                while let Some(item) = items.recv().await {
                    match item {
                        WorkerStreamItem::Event(event) => {
                            emitted = true;
                            yield wire::model_event(&event)?;
                        }
                        WorkerStreamItem::Result(result) => {
                            let value = result?;
                            let status = value.get("status").and_then(serde_json::Value::as_str).unwrap_or_default();
                            if should_retry_auth(status, attempt, emitted) {
                                if let Some((kind, record)) = resource.as_ref() {
                                    if find_resource(&entry, kind)?.can_prepare {
                                        let prepared = registry.prepare_resource(&entry, &executable, kind, record.clone(), Some(record.clone())).await?;
                                        resource = Some((kind.clone(), prepared));
                                        retry = true;
                                        break;
                                    }
                                }
                            }
                            let patch = value.get("patch").filter(|patch| !patch.is_null())
                                .map(|patch| serde_json::from_value::<ResourcePatch>(patch.clone())).transpose()?;
                            if let (Some(patch), Some((kind, record))) = (patch, resource.as_ref()) {
                                registry.inner.state.apply_patch_if_current(&plugin_id, kind, record, patch).await?;
                            }
                            match status {
                                "completed" => return,
                                "auth-error" | "resource-error" | "request-error" => {
                                    let message = value.get("message").and_then(serde_json::Value::as_str).unwrap_or("plugin provider call failed");
                                    Err(Error::Provider(message.to_owned()))?;
                                }
                                status => Err(Error::Protocol(format!("unknown plugin provider result: {status}")))?,
                            }
                        }
                    }
                }
                if !retry { Err(Error::Provider(format!("plugin '{plugin_id}' worker stopped mid-stream")))?; }
            }
            Err(Error::Provider("plugin authentication retry exhausted".into()))?;
        })
    }
}
