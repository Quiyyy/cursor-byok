//! Adds configured routes using the installed Cursor's own model picker factory.
use crate::{
    api::cursor::proxy::{self, CursorProxy},
    cursor::services::CursorServices,
    Error, Result,
};
use axum::{
    body::{Body, Bytes},
    extract::{Extension, State},
    http::{header, HeaderValue, Request, Response, StatusCode},
};
use bytes::{BufMut, BytesMut};
use prost::Message;
use serde_json::json;

#[derive(Clone, PartialEq, Message)]
struct AvailableModelsAddition {
    #[prost(string, repeated, tag = "1")]
    model_names: Vec<String>,
    // Message and bytes both use wire type 2. Preserve the native AvailableModel verbatim.
    #[prost(bytes = "vec", repeated, tag = "2")]
    models: Vec<Vec<u8>>,
}
#[derive(Clone, PartialEq, Message)]
struct UsableModelsAddition {
    #[prost(bytes = "vec", repeated, tag = "1")]
    models: Vec<Vec<u8>>,
}

async fn configured_models(services: &CursorServices) -> Result<Vec<serde_json::Value>> {
    let mut models: Vec<_> = crate::configured_models::list(services.store(), services.plugins()).await?.into_iter().map(|model| {
        json!({"cursorId":format!("byok:{}",model.id),"id":model.model_id,"displayName":model.display_name,
            "source":model.source,"contextLength":model.context,"maxOutputTokens":model.max_output_tokens,
            "supportsVision":model.images,"extendedCapabilitiesDetected":true,
            "reasoningEfforts":model.reasoning_efforts,"defaultReasoningEffort":model.default_reasoning_effort,"supportsFast":model.supports_fast})
    }).collect();
    // Native optional fields use undefined, not null, for absent metadata.
    for model in &mut models {
        model
            .as_object_mut()
            .unwrap()
            .retain(|_, value| !value.is_null());
    }
    Ok(models)
}

pub async fn available_models(
    State(services): State<CursorServices>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let models = configured_models(&services).await?;
    let names = models
        .iter()
        .map(|model| model["cursorId"].as_str().unwrap().to_owned())
        .collect();
    let native = if models.is_empty() {
        Vec::new()
    } else {
        services
            .native()?
            .picker_models(json!(models))
            .await?
            .available
    };
    merge_catalog(
        &proxy,
        request,
        AvailableModelsAddition {
            model_names: names,
            models: native,
        }
        .encode_to_vec(),
    )
    .await
}

pub async fn usable_models(
    State(services): State<CursorServices>,
    Extension(proxy): Extension<CursorProxy>,
    request: Request<Body>,
) -> Result<Response<Body>> {
    let configured = configured_models(&services).await?;
    let models = if configured.is_empty() {
        Vec::new()
    } else {
        services
            .native()?
            .picker_models(json!(configured))
            .await?
            .usable
    };
    merge_catalog(
        &proxy,
        request,
        UsableModelsAddition { models }.encode_to_vec(),
    )
    .await
}
async fn merge_catalog(
    proxy: &CursorProxy,
    request: Request<Body>,
    local: Vec<u8>,
) -> Result<Response<Body>> {
    match proxy::forward_buffered(proxy, request).await {
        Ok(upstream) => merge_response(upstream, local),
        Err(error) => {
            tracing::warn!(%error,"Cursor model catalog upstream unavailable");
            Ok(local_response(local))
        }
    }
}
fn merge_response(upstream: proxy::BufferedResponse, extra: Vec<u8>) -> Result<Response<Body>> {
    if !upstream.status.is_success() {
        tracing::warn!(status = %upstream.status, "Cursor model catalog upstream rejected request; using local catalog");
        return Ok(local_response(extra));
    }
    let (framed, payload) = unary_payload(&upstream.body)?;
    let body = if framed {
        let mut merged = BytesMut::with_capacity(5 + payload.len() + extra.len());
        merged.put_u8(0);
        merged.put_u32((payload.len() + extra.len()) as u32);
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    } else {
        let mut merged = BytesMut::with_capacity(payload.len() + extra.len());
        merged.extend_from_slice(payload);
        merged.extend_from_slice(&extra);
        merged.freeze()
    };
    Ok(upstream.with_body(body))
}

fn local_response(body: Vec<u8>) -> Response<Body> {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/proto"),
    );
    response
}

fn unary_payload(body: &Bytes) -> Result<(bool, &[u8])> {
    if body.len() < 5 {
        return Ok((false, body));
    }
    let flags = body[0];
    let length = u32::from_be_bytes([body[1], body[2], body[3], body[4]]) as usize;
    if length != body.len() - 5 {
        return Ok((false, body));
    }
    if flags != 0 {
        return Err(Error::Protocol(format!(
            "cannot merge compressed or terminal model catalog frame: flags={flags}"
        )));
    }
    Ok((true, &body[5..]))
}
