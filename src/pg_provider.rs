use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;

/// Wraps duroxide-pg's PostgresProvider for use from JavaScript.
#[napi]
pub struct JsPostgresProvider {
    pub(crate) inner: Arc<dyn duroxide::providers::Provider>,
}

#[napi]
impl JsPostgresProvider {
    /// Connect to a PostgreSQL database.
    /// Uses the default "public" schema.
    #[napi(factory)]
    pub async fn connect(database_url: String) -> Result<Self> {
        let provider = duroxide_pg::PostgresProvider::new(&database_url)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to connect to PostgreSQL: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }

    /// Connect to a PostgreSQL database with a custom schema.
    /// The schema will be created if it does not exist.
    #[napi(factory, js_name = "connectWithSchema")]
    pub async fn connect_with_schema(database_url: String, schema: String) -> Result<Self> {
        let provider =
            duroxide_pg::PostgresProvider::new_with_schema(&database_url, Some(&schema))
                .await
                .map_err(|e| Error::from_reason(format!("Failed to connect to PostgreSQL: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }
}
