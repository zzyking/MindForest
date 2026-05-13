//! End-to-end-ish HTTP tests over the axum router.
//!
//! Wires `ForestService` against an in-memory SQLite index + tempdir
//! vault so each test owns its world. Uses `tower::ServiceExt::oneshot`
//! to avoid binding sockets — the router itself is exercised, not the
//! transport layer.

use std::sync::Arc;

use api::router;
use agent::StubProposer;
use app_core::{
  AgentConfig, EmbedMode, ForestService, FsRepository, InMemoryStore, ModelDownloader, SecretStore,
  SqliteIndex, StubEmbedder, EMBED_DIM,
};
use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tempfile::TempDir;
use tower::ServiceExt;

async fn fixture() -> (TempDir, axum::Router) {
  let tmp = TempDir::new().unwrap();
  let repo = Arc::new(FsRepository::open(tmp.path()).await.unwrap());
  let index = Arc::new(SqliteIndex::open_in_memory().await.unwrap());
  let embedder = Arc::new(StubEmbedder::new(EMBED_DIM));
  let downloader = ModelDownloader::new(tmp.path().join("models"));
  let secret_store: Arc<dyn SecretStore> = Arc::new(InMemoryStore::new());
  let svc = Arc::new(ForestService::new(
    repo,
    index,
    embedder,
    EmbedMode::Stub,
    downloader,
    Arc::new(StubProposer::new()),
    AgentConfig::default(),
    None,
    secret_store,
  ));
  (tmp, router(svc))
}

async fn json_body(resp: axum::response::Response) -> Value {
  let bytes = resp.into_body().collect().await.unwrap().to_bytes();
  serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("not json: {e} ({:?})", bytes))
}

fn req_get(uri: &str) -> Request<Body> {
  Request::builder()
    .method("GET")
    .uri(uri)
    .body(Body::empty())
    .unwrap()
}

fn req_json(method: &str, uri: &str, body: Value) -> Request<Body> {
  Request::builder()
    .method(method)
    .uri(uri)
    .header("content-type", "application/json")
    .body(Body::from(body.to_string()))
    .unwrap()
}

#[tokio::test]
async fn health_returns_ok() {
  let (_tmp, app) = fixture().await;
  let resp = app.oneshot(req_get("/health")).await.unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  assert_eq!(json_body(resp).await, json!({"ok": true}));
}

#[tokio::test]
async fn topic_create_list_get_delete_roundtrip() {
  let (_tmp, app) = fixture().await;

  // Create
  let resp = app
    .clone()
    .oneshot(req_json(
      "POST",
      "/v1/topics",
      json!({"title": "Deep Learning"}),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::CREATED);
  let topic = json_body(resp).await;
  assert_eq!(topic["title"], "Deep Learning");
  assert_eq!(topic["id"], "deep-learning");
  let topic_id = topic["id"].as_str().unwrap().to_string();

  // List
  let resp = app
    .clone()
    .oneshot(req_get("/v1/topics"))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let list = json_body(resp).await;
  assert_eq!(list.as_array().unwrap().len(), 1);
  assert_eq!(list[0]["id"], topic_id);

  // Get detail
  let resp = app
    .clone()
    .oneshot(req_get(&format!("/v1/topics/{topic_id}")))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let detail = json_body(resp).await;
  assert_eq!(detail["id"], topic_id);
  // Root node is included as a node summary
  let nodes = detail["nodes"].as_array().unwrap();
  assert_eq!(nodes.len(), 1);
  assert_eq!(nodes[0]["title"], "Deep Learning");
  assert!(nodes[0].get("content").is_none(), "summary must omit content");

  // Delete
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("DELETE")
        .uri(format!("/v1/topics/{topic_id}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::NO_CONTENT);

  // Get-after-delete → 404
  let resp = app
    .oneshot(req_get(&format!("/v1/topics/{topic_id}")))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn node_crud_and_search() {
  let (_tmp, app) = fixture().await;

  // Create topic
  let topic = json_body(
    app
      .clone()
      .oneshot(req_json("POST", "/v1/topics", json!({"title": "Alpha"})))
      .await
      .unwrap(),
  )
  .await;
  let tid = topic["id"].as_str().unwrap().to_string();
  let root = topic["root_node_id"].as_str().unwrap().to_string();

  // Create node
  let resp = app
    .clone()
    .oneshot(req_json(
      "POST",
      "/v1/nodes",
      json!({
        "topic": tid,
        "parent": root,
        "title": "Backpropagation",
        "content": "Gradients flow backwards through the graph.",
        "node_type": "concept",
      }),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::CREATED);
  let node = json_body(resp).await;
  assert_eq!(node["title"], "Backpropagation");
  let nid = node["id"].as_str().unwrap().to_string();

  // GET node
  let resp = app
    .clone()
    .oneshot(req_get(&format!("/v1/nodes/{nid}")))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let got = json_body(resp).await;
  assert_eq!(got["content"], "Gradients flow backwards through the graph.");

  // PATCH node
  let resp = app
    .clone()
    .oneshot(req_json(
      "PATCH",
      &format!("/v1/nodes/{nid}"),
      json!({"content": "rewritten body with marker xyz123"}),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  assert_eq!(
    json_body(resp).await["content"],
    "rewritten body with marker xyz123"
  );

  // Search by FTS — both title and updated body should be findable.
  let resp = app
    .clone()
    .oneshot(req_get("/v1/search?q=xyz123"))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let hits = json_body(resp).await;
  let hits_arr = hits.as_array().unwrap();
  assert_eq!(hits_arr.len(), 1);
  assert_eq!(hits_arr[0]["id"], nid);

  // Old content is gone from FTS.
  let resp = app
    .clone()
    .oneshot(req_get("/v1/search?q=Gradients"))
    .await
    .unwrap();
  let hits = json_body(resp).await;
  assert_eq!(hits.as_array().unwrap().len(), 0);

  // DELETE node
  let resp = app
    .clone()
    .oneshot(
      Request::builder()
        .method("DELETE")
        .uri(format!("/v1/nodes/{nid}"))
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::NO_CONTENT);

  // GET-after-delete → 404
  let resp = app
    .oneshot(req_get(&format!("/v1/nodes/{nid}")))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn invalid_topic_slug_in_path_returns_400() {
  let (_tmp, app) = fixture().await;
  let resp = app
    .oneshot(req_get("/v1/topics/Has-Caps"))
    .await
    .unwrap();
  // Path<TopicId> Deserialize uses TopicId::new which rejects uppercase.
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn invalid_node_id_in_path_returns_400() {
  let (_tmp, app) = fixture().await;
  let resp = app
    .oneshot(req_get("/v1/nodes/not-a-ulid"))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn create_topic_duplicate_returns_409() {
  let (_tmp, app) = fixture().await;
  let _ = app
    .clone()
    .oneshot(req_json("POST", "/v1/topics", json!({"title": "Same"})))
    .await
    .unwrap();
  let resp = app
    .oneshot(req_json("POST", "/v1/topics", json!({"title": "Same"})))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::CONFLICT);
  assert_eq!(json_body(resp).await["error"], "conflict");
}

#[tokio::test]
async fn search_topic_filter_scopes_results() {
  let (_tmp, app) = fixture().await;

  // Two topics with the same body word in different docs.
  for slug_title in [("Alpha", "alpha"), ("Beta", "beta")] {
    let topic = json_body(
      app
        .clone()
        .oneshot(req_json(
          "POST",
          "/v1/topics",
          json!({"title": slug_title.0}),
        ))
        .await
        .unwrap(),
    )
    .await;
    let tid = topic["id"].as_str().unwrap().to_string();
    let root = topic["root_node_id"].as_str().unwrap().to_string();
    app
      .clone()
      .oneshot(req_json(
        "POST",
        "/v1/nodes",
        json!({
          "topic": tid,
          "parent": root,
          "title": format!("{}-leaf", slug_title.1),
          "content": "shared-marker overlap",
        }),
      ))
      .await
      .unwrap();
  }

  // No filter: 2 hits across both topics.
  let resp = app
    .clone()
    .oneshot(req_get("/v1/search?q=shared-marker"))
    .await
    .unwrap();
  let hits = json_body(resp).await;
  assert_eq!(hits.as_array().unwrap().len(), 2);

  // Topic-scoped: 1 hit.
  let resp = app
    .oneshot(req_get("/v1/search?q=shared-marker&topic=alpha"))
    .await
    .unwrap();
  let hits = json_body(resp).await;
  let arr = hits.as_array().unwrap();
  assert_eq!(arr.len(), 1);
  assert_eq!(arr[0]["topic"], "alpha");
}

#[tokio::test]
async fn index_status_and_rebuild() {
  let (_tmp, app) = fixture().await;

  // Status before any data.
  let resp = app.clone().oneshot(req_get("/v1/index/status")).await.unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let status = json_body(resp).await;
  assert!(status.get("embed_pending").is_some());
  assert!(status.get("embed_available").is_some());

  // Rebuild on empty vault should succeed.
  let resp = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/v1/index/rebuild")
        .body(Body::empty())
        .unwrap(),
    )
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn embed_model_status_reports_missing_initially() {
  let (_tmp, app) = fixture().await;
  let resp = app.oneshot(req_get("/v1/embed/model/status")).await.unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let body = json_body(resp).await;
  assert_eq!(body["embed_mode"], "stub");
  assert_eq!(body["present"], false);
  assert!(body["repo_id"].as_str().unwrap().contains("embeddinggemma"));
  assert!(body["files"].as_array().unwrap().len() >= 5);
}

#[tokio::test]
async fn malformed_json_body_returns_400() {
  let (_tmp, app) = fixture().await;
  let resp = app
    .oneshot(
      Request::builder()
        .method("POST")
        .uri("/v1/topics")
        .header("content-type", "application/json")
        .body(Body::from("not json"))
        .unwrap(),
    )
    .await
    .unwrap();
  // axum's Json extractor returns 400 for malformed bodies.
  assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn agent_status_returns_backend_label() {
  let (_tmp, app) = fixture().await;
  let resp = app.oneshot(req_get("/v1/agent/status")).await.unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let body = json_body(resp).await;
  assert_eq!(body["backend"], "stub");
}

#[tokio::test]
async fn agent_propose_streams_token_proposal_and_done_events() {
  let (_tmp, app) = fixture().await;

  // Create a topic so we can target it from the propose request.
  let resp = app
    .clone()
    .oneshot(req_json(
      "POST",
      "/v1/topics",
      json!({"title": "Agent Roundtrip"}),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::CREATED);
  let topic = json_body(resp).await;
  let topic_id = topic["id"].as_str().unwrap();

  let resp = app
    .oneshot(req_json(
      "POST",
      "/v1/agent/propose",
      json!({"topic_id": topic_id, "prompt": "summarize it"}),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let bytes = resp.into_body().collect().await.unwrap().to_bytes();
  let body = String::from_utf8(bytes.to_vec()).unwrap();

  // Sanity-check the SSE wire shape: at least one token event, exactly
  // one proposal event, and a terminating done event. We don't try to
  // be byte-precise — the StubProposer's text content can drift.
  assert!(body.contains("event: token"));
  assert!(body.contains("event: proposal"));
  assert!(body.contains("event: done"));
  assert!(
    body.matches("event: proposal").count() == 1,
    "expected exactly one proposal event, got body:\n{body}"
  );
}

#[tokio::test]
async fn agent_config_get_returns_masked_view_no_plaintext_key() {
  let (_tmp, app) = fixture().await;

  // Seed an OpenAI key + model via PUT first.
  let resp = app
    .clone()
    .oneshot(req_json(
      "PUT",
      "/v1/agent/config",
      json!({
        "provider": "openai",
        "openai": { "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini", "api_key": "sk-test-abcd1234" },
        "anthropic": {}
      }),
    ))
    .await
    .unwrap();
  assert_eq!(resp.status(), StatusCode::OK);

  let resp = app.oneshot(req_get("/v1/agent/config")).await.unwrap();
  assert_eq!(resp.status(), StatusCode::OK);
  let body = json_body(resp).await;
  // No plaintext `api_key` anywhere in the GET response — secret stays
  // in the keychain, hint is the fingerprint format.
  assert!(body["openai"].get("api_key").is_none());
  assert_eq!(body["openai"]["api_key_set"], true);
  assert_eq!(body["openai"]["api_key_hint"], "sk-…1234");
  assert_eq!(body["openai"]["model"], "gpt-4o-mini");
  assert_eq!(body["anthropic"]["api_key_set"], false);
  assert!(body["anthropic"]["api_key_hint"].is_null());
}

#[tokio::test]
async fn agent_config_put_triple_state_api_key() {
  let (_tmp, app) = fixture().await;

  // Seed.
  app
    .clone()
    .oneshot(req_json(
      "PUT",
      "/v1/agent/config",
      json!({
        "provider": "openai",
        "openai": { "base_url": "https://api.openai.com/v1", "model": "m1", "api_key": "sk-init-XXXX" },
        "anthropic": {}
      }),
    ))
    .await
    .unwrap();

  // 1. PUT without `api_key` field → keep current; only model changes.
  app
    .clone()
    .oneshot(req_json(
      "PUT",
      "/v1/agent/config",
      json!({
        "provider": "openai",
        "openai": { "base_url": "https://api.openai.com/v1", "model": "m2" },
        "anthropic": {}
      }),
    ))
    .await
    .unwrap();
  let body = json_body(
    app
      .clone()
      .oneshot(req_get("/v1/agent/config"))
      .await
      .unwrap(),
  )
  .await;
  assert_eq!(body["openai"]["api_key_set"], true);
  assert_eq!(body["openai"]["model"], "m2");

  // 2. PUT api_key=null → clear.
  app
    .clone()
    .oneshot(req_json(
      "PUT",
      "/v1/agent/config",
      json!({
        "provider": "openai",
        "openai": { "model": "m2", "api_key": null },
        "anthropic": {}
      }),
    ))
    .await
    .unwrap();
  let body = json_body(
    app
      .clone()
      .oneshot(req_get("/v1/agent/config"))
      .await
      .unwrap(),
  )
  .await;
  assert_eq!(body["openai"]["api_key_set"], false);

  // 3. PUT api_key="sk-fresh" → set.
  app
    .clone()
    .oneshot(req_json(
      "PUT",
      "/v1/agent/config",
      json!({
        "provider": "openai",
        "openai": { "model": "m2", "api_key": "sk-fresh-1234" },
        "anthropic": {}
      }),
    ))
    .await
    .unwrap();
  let body = json_body(app.oneshot(req_get("/v1/agent/config")).await.unwrap()).await;
  assert_eq!(body["openai"]["api_key_set"], true);
  assert_eq!(body["openai"]["api_key_hint"], "sk-…1234");
}
