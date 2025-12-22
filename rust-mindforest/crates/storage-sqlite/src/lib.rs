use async_trait::async_trait;
use domain::{ForestError, ForestRepository, ForestResult, Topic, TopicId, TopicSummary};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};

#[derive(Clone)]
pub struct SqliteForestRepository {
  pool: SqlitePool,
}

impl SqliteForestRepository {
  pub fn new(pool: SqlitePool) -> Self {
    Self { pool }
  }

  pub async fn connect(database_url: &str) -> ForestResult<Self> {
    let pool = SqlitePoolOptions::new()
      .max_connections(5)
      .connect(database_url)
      .await
      .map_err(map_db_err)?;
    Ok(Self { pool })
  }

  pub fn pool(&self) -> &SqlitePool {
    &self.pool
  }
}

#[async_trait]
impl ForestRepository for SqliteForestRepository {
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
    let row = sqlx::query("SELECT data FROM topics WHERE id = ?")
      .bind(id)
      .fetch_optional(&self.pool)
      .await
      .map_err(map_db_err)?;

    match row {
      None => Ok(None),
      Some(row) => {
        let data_str: String = row.try_get("data").map_err(map_db_err)?;
        let topic: Topic =
          serde_json::from_str(&data_str).map_err(|e| ForestError::Storage(e.to_string()))?;
        Ok(Some(topic))
      }
    }
  }

  async fn save_topic(&self, topic: Topic) -> ForestResult<()> {
    let data = serde_json::to_string(&topic).map_err(|e| ForestError::Storage(e.to_string()))?;

    sqlx::query(
      r#"
      INSERT INTO topics (id, title, data)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, data=excluded.data, updated_at=CURRENT_TIMESTAMP
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
