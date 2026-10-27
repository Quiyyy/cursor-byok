//! Implements control dashboard overview endpoints.
//! HTTP handler for the desktop overview aggregates.

use axum::{
    extract::{Query, State},
    Json,
};
use serde::Deserialize;

use crate::{model::Overview, Result};

use super::ControlState;

#[derive(Debug, Default, Deserialize)]
pub struct OverviewRange {
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    model_hashes: Option<String>,
    bucket_ms: Option<i64>,
}

pub async fn get(
    State(service): State<ControlState>,
    Query(range): Query<OverviewRange>,
) -> Result<Json<Overview>> {
    Ok(Json(
        service
            .overview(
                range.start_ms,
                range.end_ms,
                range.model_hashes.as_deref(),
                range.bucket_ms,
            )
            .await?,
    ))
}

impl ControlState {
    pub async fn overview(
        &self,
        start_ms: Option<i64>,
        end_ms: Option<i64>,
        model_hashes: Option<&str>,
        bucket_ms: Option<i64>,
    ) -> Result<Overview> {
        self.store
            .overview(start_ms, end_ms, model_hashes, bucket_ms)
            .await
    }
}
