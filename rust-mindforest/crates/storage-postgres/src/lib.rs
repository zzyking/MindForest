use async_trait::async_trait;
use domain::{ForestError, ForestRepository, ForestResult, Topic, TopicId, TopicSummary};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};

#[derive(Clone)]
pub struct SqlxForestRepository {
  pool: PgPool,
}

impl SqlxForestRepository {
  pub fn new(pool: PgPool) -> Self {
    Self { pool }
  }

  pub async fn connect(database_url: &str) -> ForestResult<Self> {
    let pool = PgPoolOptions::new()
      .max_connections(5)
      .connect(database_url)
      .await
      .map_err(map_db_err)?;
    Ok(Self { pool })
  }

  pub fn pool(&self) -> &PgPool {
    &self.pool
  }
}

#[async_trait]
impl ForestRepository for SqlxForestRepository {
  async fn list_topics(&self) -> ForestResult<Vec<TopicSummary>> {
    let rows = sqlx::query("SELECT id, title FROM topics ORDER BY title")
      .fetch_all(&self.pool)
      .await
      .map_err(map_db_err)?;

    Ok(rows
      .into_iter()
      .map(|row| TopicSummary {
        id: row.get("id"),
        title: row.get("title"),
      })
      .collect())
  }

  async fn fetch_topic(&self, id: &TopicId) -> ForestResult<Option<Topic>> {
    let row = sqlx::query("SELECT data FROM topics WHERE id = $1")
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(map_db_err)?;

    match row {
      None => Ok(None),
      Some(row) => {
        // Allow JSONB or TEXT storage by decoding as Value first
        let value: Value = row.try_get("data").map_err(map_db_err)?;
        let topic: Topic =
          serde_json::from_value(value).map_err(|e| ForestError::Storage(e.to_string()))?;
        Ok(Some(topic))
      }
    }
  }

  async fn save_topic(&self, topic: Topic) -> ForestResult<()> {
    let data = serde_json::to_value(&topic).map_err(|e| ForestError::Storage(e.to_string()))?;

    sqlx::query(
      r#"
      INSERT INTO topics (id, title, data)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE
      SET title = EXCLUDED.title, data = EXCLUDED.data, updated_at = NOW()
      "#,
    )
    .bind(&topic.id)
    .bind(&topic.title)
    .bind(data)
    .execute(&self.pool)
    .await
    .map_err(map_db_err)?;

    Ok(())
  }
}

fn map_db_err(err: sqlx::Error) -> ForestError {
  ForestError::Storage(err.to_string())
}
