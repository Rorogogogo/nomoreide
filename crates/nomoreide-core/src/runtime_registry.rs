use crate::filesystem::{atomic_write_async, AtomicWriteOptions};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

const RUNTIME_REGISTRY_VERSION: u32 = 1;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRegistryDocument {
    version: u32,
    records: HashMap<String, RuntimeRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeRecord {
    pub name: String,
    pub generation: u64,
    pub pid: u32,
    pub pgid: u32,
    pub uid: Option<u32>,
    /// Human-readable label for whoever reads this file. Ownership is proven by
    /// `pid` plus `start_token`, never by this string, so it must never carry
    /// environment values.
    pub command: String,
    /// The kernel's process-creation token, stamped at fork and unchanged by
    /// `exec`, so it is stable across the whole launch handshake.
    pub start_token: String,
    pub owner_pid: u32,
    pub owner_start_token: String,
}

#[derive(Clone)]
/// Private native ownership journal. This must use a dedicated native path;
/// it is intentionally not the TypeScript `~/.nomoreide/runtime.json` format.
pub struct RuntimeRegistry {
    path: PathBuf,
    mutation: Arc<Mutex<()>>,
}

impl RuntimeRegistry {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            mutation: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) async fn records(&self) -> Result<Vec<RuntimeRecord>> {
        let _guard = self.mutation.lock().await;
        Ok(self.read().await?.into_values().collect())
    }

    /// Only platforms that recover through this journal ever write to it — see
    /// `RUNTIME_JOURNAL_SUPPORTED` in `process_manager`.
    #[cfg_attr(not(unix), allow(dead_code))]
    pub(crate) async fn record(&self, record: RuntimeRecord) -> Result<()> {
        let _guard = self.mutation.lock().await;
        let mut records = self.read().await?;
        records.insert(record.name.clone(), record);
        self.write(&records).await
    }

    pub(crate) async fn remove_matching(&self, name: &str, generation: u64) -> Result<()> {
        let _guard = self.mutation.lock().await;
        let mut records = self.read().await?;
        let matches = records
            .get(name)
            .map(|record| record.generation == generation)
            .unwrap_or(false);
        if matches {
            records.remove(name);
            self.write(&records).await?;
        }
        Ok(())
    }

    async fn read(&self) -> Result<HashMap<String, RuntimeRecord>> {
        let content = match tokio::fs::read(&self.path).await {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(error) => return Err(error.into()),
        };
        let document = serde_json::from_slice::<RuntimeRegistryDocument>(&content)
            .with_context(|| format!("invalid native runtime registry: {}", self.path.display()))?;
        if document.version != RUNTIME_REGISTRY_VERSION {
            anyhow::bail!(
                "unsupported native runtime registry version {}",
                document.version
            );
        }
        Ok(document.records)
    }

    async fn write(&self, records: &HashMap<String, RuntimeRecord>) -> Result<()> {
        let content = serde_json::to_vec_pretty(&RuntimeRegistryDocument {
            version: RUNTIME_REGISTRY_VERSION,
            records: records.clone(),
        })?;
        atomic_write_async(&self.path, content, AtomicWriteOptions::private()).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn record(generation: u64) -> RuntimeRecord {
        RuntimeRecord {
            name: "api".into(),
            generation,
            pid: 20,
            pgid: 20,
            uid: Some(501),
            command: "node api.js".into(),
            start_token: "service-start".into(),
            owner_pid: 10,
            owner_start_token: "owner-start".into(),
        }
    }

    #[tokio::test]
    async fn old_generation_cannot_remove_replacement_record() {
        let dir = std::env::temp_dir().join(format!("nomoreide-registry-{}", Uuid::new_v4()));
        let registry = RuntimeRegistry::new(dir.join("runtime.json"));
        registry.record(record(1)).await.unwrap();
        registry.record(record(2)).await.unwrap();

        registry.remove_matching("api", 1).await.unwrap();

        assert_eq!(registry.records().await.unwrap(), vec![record(2)]);
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    #[tokio::test]
    async fn corrupt_registry_fails_closed() {
        let dir = std::env::temp_dir().join(format!("nomoreide-registry-{}", Uuid::new_v4()));
        let path = dir.join("runtime.json");
        tokio::fs::create_dir_all(&dir).await.unwrap();
        tokio::fs::write(&path, b"not-json").await.unwrap();
        let registry = RuntimeRegistry::new(path);

        assert!(registry.records().await.is_err());
        assert!(registry.record(record(1)).await.is_err());
        let _ = tokio::fs::remove_dir_all(dir).await;
    }
}
