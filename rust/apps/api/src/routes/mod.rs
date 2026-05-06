//! Route assembly. `v1()` returns the `/v1`-nested router; `health` is
//! mounted at the top level and intentionally outside the version prefix
//! so dev-tooling probes don't have to track API versions.

use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;

use crate::AppState;

pub mod agent;
pub mod embed_admin;
pub mod index_admin;
pub mod nodes;
pub mod search;
pub mod topics;

pub async fn health() -> Json<serde_json::Value> {
  Json(json!({ "ok": true }))
}

pub fn v1() -> Router<AppState> {
  Router::new()
    .route("/topics", get(topics::list).post(topics::create))
    .route("/topics/:id", get(topics::get).delete(topics::delete))
    .route("/nodes", post(nodes::create))
    .route(
      "/nodes/:id",
      get(nodes::get).patch(nodes::update).delete(nodes::delete),
    )
    .route("/search", get(search::search))
    .route("/index/status", get(index_admin::status))
    .route("/index/rebuild", post(index_admin::rebuild))
    .route("/embed/model/status", get(embed_admin::status))
    .route("/embed/model/download", post(embed_admin::download))
    .route("/agent/status", get(agent::status))
    .route("/agent/propose", post(agent::propose))
}
