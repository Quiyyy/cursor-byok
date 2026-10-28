//! Implements provider call inspection endpoints.
use axum::{
    extract::{Path, Query, State},
    Json,
};
use serde::Deserialize;

use crate::Result;

use super::ControlState;
use crate::{
    model::{LlmCallRequest, LlmCallResponseChunk, LlmCallSummary},
    Error,
};
use serde::Serialize;

#[derive(Deserialize)]
pub struct CallQuery {
    #[serde(default = "default_limit")]
    limit: i64,
}

pub async fn list(
    State(service): State<ControlState>,
    Query(query): Query<CallQuery>,
) -> Result<Json<Vec<CallSummary>>> {
    Ok(Json(service.calls(query.limit).await?))
}

pub async fn detail(
    State(service): State<ControlState>,
    Path(call_id): Path<String>,
) -> Result<Json<CallDetail>> {
    Ok(Json(service.call(&call_id).await?))
}

fn default_limit() -> i64 {
    100
}
#[derive(Clone, Debug, Serialize)]
pub struct CallDetail {
    pub call: CallSummary,
    pub request: Option<LlmCallRequest>,
    pub response_chunks: Vec<LlmCallResponseChunk>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallSummary {
    #[serde(flatten)]
    pub call: LlmCallSummary,
    pub source: CallSource,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CallSource {
    NativeAgent,
    ExternalApi,
    Commit,
    ModelTest,
}

impl From<LlmCallSummary> for CallSummary {
    fn from(call: LlmCallSummary) -> Self {
        let source = if call.call_id.starts_with("external-api:") {
            CallSource::ExternalApi
        } else if call.call_id.starts_with("commit-message-") {
            CallSource::Commit
        } else if call.call_id.starts_with("model-test-") {
            CallSource::ModelTest
        } else {
            CallSource::NativeAgent
        };
        Self { call, source }
    }
}

impl ControlState {
    pub async fn calls(&self, limit: i64) -> Result<Vec<CallSummary>> {
        Ok(self
            .store
            .llm_calls(limit)
            .await?
            .into_iter()
            .map(CallSummary::from)
            .collect())
    }

    pub async fn call(&self, call_id: &str) -> Result<CallDetail> {
        let call = self
            .store
            .llm_call(call_id)
            .await?
            .ok_or_else(|| Error::RunNotFound(format!("call {call_id}")))?;
        Ok(CallDetail {
            call: call.into(),
            request: self.store.llm_call_request(call_id).await?,
            response_chunks: self.store.llm_call_chunks(call_id).await?,
        })
    }
}
