//! Selects executable built-in and project-extension tools for each Cursor mode.
use crate::{model::ToolDefinition, Error, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize)]
struct Manifest {
    tools: Vec<String>,
}

pub(crate) struct ToolRegistry {
    tools: HashMap<String, ToolDefinition>,
}

impl ToolRegistry {
    pub(crate) fn new(tools: Vec<ToolDefinition>) -> Result<Self> {
        let mut catalog = HashMap::new();
        for tool in tools {
            if catalog.insert(tool.name.clone(), tool).is_some() {
                return Err(Error::Config("duplicate tool in Cursor catalog".into()));
            }
        }
        Ok(Self { tools: catalog })
    }

    pub(crate) fn select_json(&self, manifest: &str) -> Result<Vec<ToolDefinition>> {
        let manifest: Manifest = serde_json::from_str(manifest)?;
        let mut seen = HashSet::new();
        manifest
            .tools
            .iter()
            .map(|name| {
                if !seen.insert(name) {
                    return Err(Error::Config(format!("duplicate tool in mode: {name}")));
                }
                self.tools.get(name).cloned().ok_or_else(|| {
                    Error::Config(format!("tool manifest references unknown schema: {name}"))
                })
            })
            .collect()
    }
}
