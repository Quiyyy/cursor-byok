use std::collections::HashSet;

use serde_json::{json, Value};

use crate::{plugin::PluginRegistry, store::Store, Result};

#[derive(Clone)]
pub(super) struct ListedModel {
    pub public_id: String,
    pub internal_id: String,
    pub display_name: String,
}

pub(super) async fn list(store: &Store, plugins: &PluginRegistry) -> Result<Vec<ListedModel>> {
    let mut models = Vec::new();
    let mut ids = HashSet::new();
    for model in crate::configured_models::list(store, Some(plugins)).await? {
        if ids.insert(model.external_id.clone()) {
            models.push(ListedModel {
                public_id: model.external_id,
                internal_id: model.id,
                display_name: model.display_name,
            });
        }
    }
    Ok(models)
}

pub(super) fn response(models: &[ListedModel]) -> Value {
    json!({"object":"list","data":models.iter().map(|model| json!({
        "id":model.public_id,"object":"model","created":0,"owned_by":"cursor-byok",
        "name":model.display_name
    })).collect::<Vec<_>>()})
}
