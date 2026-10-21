//! Provider-neutral message payloads for HTTP protocol translation.

use serde::{Deserialize, Serialize};

use super::{ContentPart, ProviderReplayState, Role, ToolCallContent, ToolResultContent};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum ProjectedContent {
    Parts(Vec<ContentPart>),
    Assistant {
        text: String,
        thinking: String,
        replay_state: Option<ProviderReplayState>,
        calls: Vec<ToolCallContent>,
    },
    ToolResult(ToolResultContent),
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ProjectedMessage {
    pub message_id: String,
    pub role: Role,
    pub content: ProjectedContent,
}
