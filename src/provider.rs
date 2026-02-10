use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

/// Wraps duroxide's SqliteProvider for use from JavaScript.
#[napi]
pub struct JsSqliteProvider {
    pub(crate) inner: Arc<duroxide::providers::sqlite::SqliteProvider>,
}

#[napi]
impl JsSqliteProvider {
    /// Open a SQLite database at the given file path.
    /// Path should be a sqlite: URL, e.g. "sqlite:./data.db" or "sqlite:/tmp/test.db".
    /// The file will be created if it does not exist.
    #[napi(factory)]
    pub async fn open(path: String) -> Result<Self> {
        // Ensure the file exists — sqlx won't create it by default
        let file_path = path.strip_prefix("sqlite:").unwrap_or(&path);
        if !file_path.contains(":memory:") {
            if let Some(parent) = std::path::Path::new(file_path).parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .open(file_path)
                .map_err(|e| Error::from_reason(format!("Failed to create DB file: {e}")))?;
        }
        let url = if path.starts_with("sqlite:") {
            path
        } else {
            format!("sqlite:{path}")
        };
        let provider =
            duroxide::providers::sqlite::SqliteProvider::new(&url, None)
                .await
                .map_err(|e| Error::from_reason(format!("Failed to open SQLite: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }

    /// Create an in-memory SQLite database (useful for testing).
    #[napi(factory, js_name = "inMemory")]
    pub async fn in_memory() -> Result<Self> {
        let provider =
            duroxide::providers::sqlite::SqliteProvider::new_in_memory()
                .await
                .map_err(|e| Error::from_reason(format!("Failed to create in-memory SQLite: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }
}
