//! The model-independent, extracted Cursor built-in tool contract.
use crate::{model::ToolDefinition, Error, Result};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize)]
pub(super) struct NativeProtocol {
    format_version: u32,
    source: Source,
    pub instructions: String,
    pub tools: Vec<ToolDefinition>,
}

#[derive(Deserialize)]
struct Source {
    cursor_version: String,
    cursor_commit: String,
    bundle_sha256: String,
}

impl NativeProtocol {
    pub fn parse(json: &str) -> Result<Self> {
        let protocol: Self = serde_json::from_str(json)?;
        if protocol.format_version != 1
            || protocol.source.cursor_version.is_empty()
            || protocol.source.cursor_commit.is_empty()
            || protocol.source.bundle_sha256.len() != 64
            || !protocol
                .source
                .bundle_sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || protocol.instructions.trim().is_empty()
            || protocol.instructions.contains("{{")
        {
            return Err(Error::Config(
                "invalid Cursor protocol metadata or instructions".into(),
            ));
        }
        let supported = [
            "AskQuestion",
            "CreatePlan",
            "Delete",
            "EditNotebook",
            "GenerateImage",
            "Glob",
            "Grep",
            "Read",
            "ReadLints",
            "Shell",
            "StrReplace",
            "SwitchMode",
            "Task",
            "TodoWrite",
            "WebFetch",
            "WebSearch",
            "Write",
        ]
        .into_iter()
        .collect::<HashSet<_>>();
        let mut seen = HashSet::new();
        for tool in &protocol.tools {
            if !supported.contains(tool.name.as_str()) || !seen.insert(tool.name.as_str()) {
                return Err(Error::Config(format!(
                    "unsupported or duplicate Cursor tool: {}",
                    tool.name
                )));
            }
            if tool.description.trim().is_empty() || tool.parameters["type"] != "object" {
                return Err(Error::Config(format!(
                    "invalid Cursor tool schema: {}",
                    tool.name
                )));
            }
        }
        if seen != supported {
            return Err(Error::Config(
                "Cursor protocol is missing required built-in tools".into(),
            ));
        }
        Ok(protocol)
    }
}
