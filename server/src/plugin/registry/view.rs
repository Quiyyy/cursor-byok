//! Builds the management view of plugin capabilities and accounts.
use super::*;

impl PluginRegistry {
    pub async fn plugins(&self) -> Vec<PluginDescriptor> {
        let Some(executable) = self.inner.runtime.executable() else {
            return self
                .inner
                .catalog
                .manifests()
                .into_iter()
                .map(|(manifest, icon)| PluginDescriptor {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    author: manifest.author,
                    icon,
                    providers: Vec::new(),
                    resources: Vec::new(),
                })
                .collect();
        };
        let mut plugins = Vec::new();
        for entry in self.entries(&executable).await {
            plugins.push(self.descriptor(&entry, &executable).await);
        }
        plugins
    }

    pub(super) async fn descriptor(
        &self,
        entry: &PluginEntry,
        executable: &Path,
    ) -> PluginDescriptor {
        let plugin_id = &entry.manifest.id;
        let mut providers = Vec::new();
        for provider in &entry.definition.providers {
            let stored = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            let configured = self.provider_configured(entry, provider).await;
            providers.push(PluginProviderDescriptor {
                id: provider.id.clone(),
                plugin_id: plugin_id.clone(),
                display_name: provider.display_name.clone(),
                description: provider.description.clone(),
                provider_type: provider.provider_type.clone(),
                resource_type: provider.resource_type.clone(),
                has_models: provider.has_models,
                configured,
                models: stored
                    .iter()
                    .map(|model| {
                        PluginModelDescriptor::new(
                            plugin_id,
                            &entry.manifest.name,
                            &entry.icon,
                            provider,
                            model,
                        )
                    })
                    .collect(),
            });
        }
        let mut resources = Vec::new();
        for definition in &entry.definition.resources {
            let records = self
                .inner
                .state
                .resources(plugin_id, &definition.resource_type)
                .await
                .unwrap_or_default();
            let views = self
                .present_resources(entry, executable, definition, &records)
                .await;
            resources.push(PluginResourceDescriptor {
                resource_type: definition.resource_type.clone(),
                display_name: definition.display_name.clone(),
                add: definition.add.clone(),
                import: definition.import.clone(),
                actions: definition.actions.clone(),
                can_refresh: definition.can_refresh,
                can_remove: definition.can_remove,
                resources: views,
            });
        }
        PluginDescriptor {
            id: plugin_id.clone(),
            name: entry.manifest.name.clone(),
            version: entry.manifest.version.clone(),
            author: entry.manifest.author.clone(),
            icon: entry.icon.clone(),
            providers,
            resources,
        }
    }

    pub(super) async fn present_resources(
        &self,
        entry: &PluginEntry,
        executable: &Path,
        definition: &ResourceDefinition,
        records: &[ResourceRecord],
    ) -> Vec<PluginResourceView> {
        if records.is_empty() {
            return Vec::new();
        }
        let snapshots = records
            .iter()
            .map(|record| record.snapshot(&definition.resource_type))
            .collect::<Vec<_>>();
        let presented = self
            .worker(entry, executable)
            .await
            .invoke(
                "resource.present",
                serde_json::json!({
                    "resourceType": definition.resource_type,
                    "resources": snapshots,
                }),
                CancellationToken::new(),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<Vec<ResourcePresentation>>(value).map_err(Error::from)
            });
        match presented {
            Ok(views) if views.len() == records.len() => records
                .iter()
                .zip(views)
                .map(|(record, view)| PluginResourceView::from_record(record, view))
                .collect(),
            Ok(_) | Err(_) => records
                .iter()
                .map(|record| {
                    PluginResourceView::from_record(
                        record,
                        ResourcePresentation {
                            display_name: record.key.clone(),
                            description: serde_json::Value::Null,
                            metrics: Vec::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    pub(super) async fn provider_configured(
        &self,
        entry: &PluginEntry,
        provider: &ProviderDefinition,
    ) -> bool {
        let plugin_id = &entry.manifest.id;
        if provider.has_models {
            let models = self
                .inner
                .state
                .models(plugin_id, &provider.id)
                .await
                .unwrap_or_default();
            if models.is_empty() {
                return false;
            }
        }
        match &provider.resource_type {
            Some(resource_type) => !self
                .inner
                .state
                .resources(plugin_id, resource_type)
                .await
                .unwrap_or_default()
                .is_empty(),
            None => true,
        }
    }
}
