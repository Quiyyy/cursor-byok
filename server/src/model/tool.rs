//! Provider tool schemas and image references; execution belongs to Cursor.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn normalize_tool_name(name: &str) -> String {
    let normalized = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '_' | '-') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if normalized.is_empty() {
        "_".into()
    } else {
        normalized
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_format: Option<ToolInputFormat>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToolInputFormat {
    Text,
    Grammar { definition: String, syntax: String },
}
