use async_trait::async_trait;
use domain::{ForestError, ForestRepository, Topic, TopicId, TopicSummary};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::RwLock;

#[derive(Clone, Default)]
pub struct InMemoryForestRepository {
  topics: Arc<RwLock<HashMap<TopicId, Topic>>>,
}

#[async_trait]
impl ForestRepository for InMemoryForestRepository {
  async fn list_topics(&self) -> Result<Vec<TopicSummary>, ForestError> {
    let guard = self.topics.read().await;
    Ok(guard
      .values()
      .map(|topic| TopicSummary {
        id: topic.id.clone(),
        title: topic.title.clone(),
      })
      .collect())
  }

  async fn fetch_topic(&self, id: &TopicId) -> Result<Option<Topic>, ForestError> {
    let guard = self.topics.read().await;
    Ok(guard.get(id).cloned())
  }

  async fn save_topic(&self, topic: Topic) -> Result<(), ForestError> {
    let mut guard = self.topics.write().await;
    guard.insert(topic.id.clone(), topic);
    Ok(())
  }
}
