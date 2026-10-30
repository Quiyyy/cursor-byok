//! Owns account operations and durable credential preparation.
use super::*;

impl PluginRegistry {
    pub async fn import_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
        files: serde_json::Value,
    ) -> Result<ImportResponse> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if resource.import.is_none() {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support import"
            )));
        }
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "import.parse",
                serde_json::json!({ "resourceType": resource_type, "files": files }),
                CancellationToken::new(),
            )
            .await?;
        let parsed: ImportParseResult = serde_json::from_value(value)?;
        if parsed.resources.is_empty() {
            return Err(Error::Config(
                parsed
                    .warnings
                    .first()
                    .cloned()
                    .unwrap_or_else(|| "import produced no resources".into()),
            ));
        }
        if parsed.resources.len() > MAX_IMPORT_DRAFTS {
            return Err(Error::Config(format!(
                "import produced more than {MAX_IMPORT_DRAFTS} resources"
            )));
        }
        let outcome = self
            .inner
            .state
            .upsert_resources(plugin_id, resource_type, parsed.resources)
            .await?;
        let model_sync_error = self
            .sync_provider_models_for_resource(&entry, &executable, resource_type)
            .await;
        Ok(ImportResponse {
            added: outcome.added,
            updated: outcome.updated,
            warnings: parsed.warnings,
            model_sync_error,
        })
    }

    /// 导出某资源类型的全部私有数据,供备份或迁移;格式与批量导入兼容。
    pub async fn export_resources(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        find_resource(&entry, resource_type)?;
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        Ok(serde_json::json!({
            "accounts": records
                .iter()
                .map(|record| record.private_data.clone())
                .collect::<Vec<_>>(),
        }))
    }

    pub async fn refresh_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        if !resource.can_refresh {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource '{resource_type}' does not support refresh"
            )));
        }
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        self.prepare_resource(&entry, &executable, resource_type, record, None)
            .await?;
        let lock = self
            .preparation_lock(plugin_id, resource_type, resource_id)
            .await;
        let _guard = lock.lock().await;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.refresh",
                serde_json::json!({
                    "resourceType": resource_type,
                    "resource": record.snapshot(resource_type),
                }),
                CancellationToken::new(),
            )
            .await?;
        let patch: ResourcePatch = serde_json::from_value(value)?;
        self.inner
            .state
            .apply_patch_if_current(plugin_id, resource_type, &record, patch)
            .await
            .map(|_| ())
    }

    pub async fn resource_action(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
        action_id: &str,
        input: serde_json::Value,
    ) -> Result<serde_json::Value> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let action = resource
            .actions
            .iter()
            .find(|action| action.id == action_id)
            .ok_or_else(|| {
                Error::Config(format!(
                    "plugin '{plugin_id}' resource '{resource_type}' does not define action '{action_id}'"
                ))
            })?;
        if !matches!(action.target.as_str(), "resource" | "card") {
            return Err(Error::Config(format!(
                "plugin '{plugin_id}' resource action '{action_id}' has an invalid target"
            )));
        }
        let lock = self
            .preparation_lock(plugin_id, resource_type, resource_id)
            .await;
        let _guard = lock.lock().await;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        let value = self
            .worker(&entry, &executable)
            .await
            .invoke(
                "resource.action",
                serde_json::json!({
                    "resourceType": resource_type,
                    "actionId": action_id,
                    "resource": record.snapshot(resource_type),
                    "input": input,
                }),
                CancellationToken::new(),
            )
            .await?;
        let result: ResourceActionResult = serde_json::from_value(value)?;
        if let Some(patch) = result.patch.clone() {
            self.inner
                .state
                .apply_patch_if_current(plugin_id, resource_type, &record, patch)
                .await?;
        }
        Ok(serde_json::to_value(ResourceActionResponse::from(result))?)
    }

    pub async fn delete_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<()> {
        let executable = self.executable()?;
        let entry = self.find_entry(&executable, plugin_id).await?;
        let resource = find_resource(&entry, resource_type)?;
        let lock = self
            .preparation_lock(plugin_id, resource_type, resource_id)
            .await;
        let _guard = lock.lock().await;
        let record = self
            .find_record(plugin_id, resource_type, resource_id)
            .await?;
        if resource.can_remove {
            // 上游撤销失败不阻塞本地删除:用户必须能移除已失效的资源。
            if let Err(error) = self
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.remove",
                    serde_json::json!({
                        "resourceType": resource_type,
                        "resource": record.snapshot(resource_type),
                    }),
                    CancellationToken::new(),
                )
                .await
            {
                tracing::warn!(plugin = %plugin_id, %error, "plugin resource remove hook failed");
            }
        }
        self.inner
            .state
            .remove_resource(plugin_id, resource_type, resource_id)
            .await?;
        Ok(())
    }

    pub(super) async fn select_resource(
        &self,
        plugin_id: &str,
        resource_type: &str,
    ) -> Result<ResourceRecord> {
        let records = self.inner.state.resources(plugin_id, resource_type).await?;
        if let Some(selected) = self
            .inner
            .state
            .selected_resource(plugin_id, resource_type)
            .await?
        {
            return records
                .into_iter()
                .find(|record| record.id == selected)
                .ok_or_else(|| {
                    Error::Config("Selected account was removed; sign in to another account".into())
                });
        }
        if records.is_empty() {
            return Err(Error::Provider(format!(
                "plugin '{plugin_id}' has no '{resource_type}' resource; add one first"
            )));
        }
        let now = now_ms();
        records
            .iter()
            .find(|record| record.state.is_ready(now))
            .or_else(|| records.first())
            .cloned()
            .ok_or_else(|| Error::Provider("no plugin resource is available".into()))
    }

    pub(super) async fn find_record(
        &self,
        plugin_id: &str,
        resource_type: &str,
        resource_id: &str,
    ) -> Result<ResourceRecord> {
        self.inner
            .state
            .resources(plugin_id, resource_type)
            .await?
            .into_iter()
            .find(|record| record.id == resource_id)
            .ok_or_else(|| Error::RunNotFound(format!("plugin resource {resource_id}")))
    }

    pub(super) async fn preparation_lock(
        &self,
        plugin: &str,
        kind: &str,
        id: &str,
    ) -> Arc<Mutex<()>> {
        self.inner
            .preparation_locks
            .lock()
            .await
            .entry(format!("{plugin}/{kind}/{id}"))
            .or_default()
            .clone()
    }

    /// Once a refresh is issued, commit rotated credentials even if the model request is cancelled.
    pub(super) async fn prepare_resource(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        kind: &str,
        record: ResourceRecord,
        rejected: Option<ResourceRecord>,
    ) -> Result<ResourceRecord> {
        if !find_resource(entry, kind)?.can_prepare {
            return Ok(record);
        }
        let registry = self.clone();
        let entry = entry.clone();
        let executable = executable.to_path_buf();
        let kind = kind.to_owned();
        tokio::spawn(async move {
            let plugin = &entry.manifest.id;
            let key = format!("{plugin}/{kind}/{}", record.id);
            let lock = registry.preparation_lock(plugin, &kind, &record.id).await;
            let _guard = lock.lock().await;
            // Retry failed persistence before ever exchanging another refresh token.
            let pending = registry
                .inner
                .pending_preparations
                .lock()
                .await
                .get(&key)
                .cloned();
            if let Some((snapshot, value)) = pending {
                registry
                    .inner
                    .state
                    .apply_patch_if_current(
                        plugin,
                        &kind,
                        &snapshot,
                        serde_json::from_value(value)?,
                    )
                    .await?;
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .remove(&key);
            }
            let current = registry.find_record(plugin, &kind, &record.id).await?;
            let value = registry
                .worker(&entry, &executable)
                .await
                .invoke(
                    "resource.prepare",
                    serde_json::json!({"resourceType": kind, "resource": current.snapshot(&kind),
                    "rejectedResource": rejected.as_ref().map(|item| item.snapshot(&kind))}),
                    CancellationToken::new(),
                )
                .await?;
            let had_patch = !value.is_null();
            if had_patch {
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .insert(key.clone(), (current.clone(), value.clone()));
                registry
                    .inner
                    .state
                    .apply_patch_if_current(plugin, &kind, &current, serde_json::from_value(value)?)
                    .await?;
                registry
                    .inner
                    .pending_preparations
                    .lock()
                    .await
                    .remove(&key);
            }
            let prepared = registry.find_record(plugin, &kind, &record.id).await?;
            if had_patch && !prepared.state.is_ready(now_ms()) {
                let message = match &prepared.state {
                    crate::plugin::state::ResourceState::Invalid { message }
                    | crate::plugin::state::ResourceState::Cooling { message, .. } => {
                        message.clone()
                    }
                    _ => None,
                }
                .unwrap_or_else(|| "plugin account is not ready".into());
                return Err(Error::Provider(message));
            }
            Ok(prepared)
        })
        .await
        .map_err(|error| Error::Provider(format!("credential preparation task failed: {error}")))?
    }
}
