use std::net::SocketAddr;
use std::path::PathBuf;

use axum::{
  extract::{Path, State},
  http::StatusCode,
  response::{IntoResponse, Response},
  routing::{get, patch, post},
  serve, Json, Router,
};
use domain::{
  CreateNodeRequest, CreateTopicRequest, ForestError, ForestService, NodeId, Topic, TopicId,
  TopicSummary, UpdateNodeRequest,
};
use sqlx::migrate;
use storage_memory::InMemoryForestRepository;
use storage_postgres::SqlxForestRepository;
use storage_sqlite::SqliteForestRepository;
use tokio::net::TcpListener;
use tower_http::{
  cors::{Any, CorsLayer},
  services::ServeDir,
};

#[derive(Clone)]
pub struct ApiConfig {
  pub addr: SocketAddr,
  pub database_url: Option<String>,
  pub static_dir: Option<PathBuf>,
}

impl Default for ApiConfig {
  fn default() -> Self {
    Self {
      addr: SocketAddr::from(([127, 0, 0, 1], 8787)),
      database_url: std::env::var("DATABASE_URL").ok(),
      static_dir: std::env::var("STATIC_DIR").ok().map(PathBuf::from),
    }
  }
}

#[derive(Clone)]
struct AppState {
  service: ForestService,
}

pub async fn run(config: ApiConfig) -> Result<(), Box<dyn std::error::Error>> {
  let service = build_service(config.database_url.as_deref()).await?;
  let state = AppState { service };

  let cors = CorsLayer::new()
    .allow_origin(Any)
    .allow_methods(Any)
    .allow_headers(Any);

  let api_routes = Router::new()
    .route("/health", get(health))
    .route("/topics", get(list_topics).post(create_topic))
    .route("/topics/:id", get(get_topic))
    .route("/topics/:id/nodes", post(add_node))
    .route(
      "/topics/:id/nodes/:node_id",
      patch(update_node).delete(delete_node),
    )
    .with_state(state);

  let app = if let Some(static_app) = static_router(config.static_dir.clone()) {
    api_routes.merge(static_app).layer(cors)
  } else {
    api_routes.layer(cors)
  };

  let listener = TcpListener::bind(config.addr).await?;
  let addr = listener.local_addr()?;
  tracing::info!("Rust API listening on http://{}", addr);

  serve(listener, app).await?;
  Ok(())
}

fn static_router(static_dir: Option<PathBuf>) -> Option<Router> {
  static_dir.map(|dir| Router::new().nest_service("/app", ServeDir::new(dir)))
}

async fn build_service(database_url: Option<&str>) -> Result<ForestService, Box<dyn std::error::Error>> {
  if let Some(url) = database_url {
    if url.starts_with("sqlite:") {
      let repo = SqliteForestRepository::connect(url).await?;
      migrate!("./migrations_sqlite").run(repo.pool()).await?;
      tracing::info!("Using SQLite storage (DATABASE_URL set)");
      Ok(ForestService::new(repo))
    } else {
      let repo = SqlxForestRepository::connect(url).await?;
      migrate!("./migrations_postgres").run(repo.pool()).await?;
      tracing::info!("Using Postgres storage (DATABASE_URL set)");
      Ok(ForestService::new(repo))
    }
  } else {
    tracing::info!("Using in-memory storage (DATABASE_URL not set)");
    Ok(ForestService::new(InMemoryForestRepository::default()))
  }
}

async fn health() -> impl IntoResponse {
  Json(serde_json::json!({ "ok": true }))
}

async fn list_topics(State(state): State<AppState>) -> AppResult<Json<Vec<TopicSummary>>> {
  let topics = state.service.list_topics().await?;
  Ok(Json(topics))
}

async fn create_topic(
  State(state): State<AppState>,
  Json(payload): Json<CreateTopicRequest>,
) -> AppResult<Json<Topic>> {
  let topic = state.service.create_topic(payload).await?;
  Ok(Json(topic))
}

async fn get_topic(
  State(state): State<AppState>,
  Path(id): Path<TopicId>,
) -> AppResult<Json<Topic>> {
  let topic = state.service.get_topic(&id).await?;
  Ok(Json(topic))
}

async fn add_node(
  State(state): State<AppState>,
  Path(id): Path<TopicId>,
  Json(payload): Json<CreateNodeRequest>,
) -> AppResult<Json<Topic>> {
  let topic = state.service.add_node(&id, payload).await?;
  Ok(Json(topic))
}

async fn update_node(
  State(state): State<AppState>,
  Path((id, node_id)): Path<(TopicId, NodeId)>,
  Json(payload): Json<UpdateNodeRequest>,
) -> AppResult<Json<Topic>> {
  let topic = state
    .service
    .update_node(&id, &node_id, payload)
    .await?;
  Ok(Json(topic))
}

async fn delete_node(
  State(state): State<AppState>,
  Path((id, node_id)): Path<(TopicId, NodeId)>,
) -> AppResult<Json<Topic>> {
  let topic = state.service.delete_node(&id, &node_id).await?;
  Ok(Json(topic))
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug)]
enum AppError {
  Domain(ForestError),
}

impl From<ForestError> for AppError {
  fn from(value: ForestError) -> Self {
    AppError::Domain(value)
  }
}

impl IntoResponse for AppError {
  fn into_response(self) -> Response {
    match self {
      AppError::Domain(ForestError::TopicNotFound) => {
        (StatusCode::NOT_FOUND, "topic not found").into_response()
      }
      AppError::Domain(ForestError::NodeNotFound) => {
        (StatusCode::NOT_FOUND, "node not found").into_response()
      }
      AppError::Domain(ForestError::InvalidInput(message)) => {
        (StatusCode::BAD_REQUEST, message).into_response()
      }
      AppError::Domain(ForestError::Storage(message)) => {
        (StatusCode::INTERNAL_SERVER_ERROR, message).into_response()
      }
    }
  }
}
