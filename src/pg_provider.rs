use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::Arc;
use std::time::Duration;

/// Options for Microsoft Entra ID authentication with Azure Database for PostgreSQL.
///
/// All fields are optional and fall back to sensible Azure public-cloud defaults.
#[napi(object)]
#[derive(Default)]
pub struct JsPostgresEntraOptions {
    /// Token audience/scope override. Required for sovereign clouds.
    /// Defaults to `https://ossrdbms-aad.database.windows.net/.default`.
    pub audience: Option<String>,
    /// Maximum number of connections in the pool. Defaults to 10 (or
    /// `$DUROXIDE_PG_POOL_MAX` if set).
    pub max_connections: Option<u32>,
    /// How long to wait for a connection from the pool, in milliseconds.
    /// Defaults to 30 000 ms (30 s).
    pub acquire_timeout_ms: Option<u32>,
    /// How far in advance of expiry the background task should refresh the
    /// token, in milliseconds. Defaults to 300 000 ms (5 min).
    pub refresh_interval_ms: Option<u32>,
}

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
        let config = duroxide_pg::ProviderConfig::url(database_url);
        let provider = duroxide_pg::PostgresProvider::new_with_config(config)
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
        let mut config = duroxide_pg::ProviderConfig::url(database_url);
        config.schema_name = Some(schema);
        let provider = duroxide_pg::PostgresProvider::new_with_config(config)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to connect to PostgreSQL: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }

    /// Connect to Azure Database for PostgreSQL using Microsoft Entra ID authentication.
    /// Uses the default "public" schema.
    ///
    /// Credentials are resolved via the default chain:
    /// WorkloadIdentityCredential → ManagedIdentityCredential → DeveloperToolsCredential.
    /// A background task refreshes the token before expiry.
    #[napi(factory, js_name = "connectWithEntra")]
    pub async fn connect_with_entra(
        host: String,
        port: u32,
        database: String,
        user: String,
        options: Option<JsPostgresEntraOptions>,
    ) -> Result<Self> {
        let opts = build_entra_options(options);
        let config = duroxide_pg::ProviderConfig::entra(host, port as u16, database, user, opts);
        let provider = duroxide_pg::PostgresProvider::new_with_config(config)
            .await
            .map_err(|e| Error::from_reason(format!("Failed to connect with Entra: {e}")))?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }

    /// Connect to Azure Database for PostgreSQL using Microsoft Entra ID authentication,
    /// with a custom schema for tenant isolation.
    #[napi(factory, js_name = "connectWithSchemaAndEntra")]
    pub async fn connect_with_schema_and_entra(
        host: String,
        port: u32,
        database: String,
        user: String,
        schema: String,
        options: Option<JsPostgresEntraOptions>,
    ) -> Result<Self> {
        let opts = build_entra_options(options);
        let mut config = duroxide_pg::ProviderConfig::entra(host, port as u16, database, user, opts);
        config.schema_name = Some(schema);
        let provider = duroxide_pg::PostgresProvider::new_with_config(config)
            .await
            .map_err(|e| {
                Error::from_reason(format!("Failed to connect with schema and Entra: {e}"))
            })?;
        Ok(Self {
            inner: Arc::new(provider),
        })
    }
}

/// Convert JS options object into the Rust [`EntraAuthOptions`] builder type.
fn build_entra_options(options: Option<JsPostgresEntraOptions>) -> duroxide_pg::EntraAuthOptions {
    let mut opts = duroxide_pg::EntraAuthOptions::new();
    if let Some(js) = options {
        if let Some(audience) = js.audience {
            opts = opts.audience(audience);
        }
        if let Some(max_conn) = js.max_connections {
            opts = opts.max_connections(max_conn);
        }
        if let Some(ms) = js.acquire_timeout_ms {
            opts = opts.acquire_timeout(Duration::from_millis(ms as u64));
        }
        if let Some(ms) = js.refresh_interval_ms {
            opts = opts.refresh_interval(Duration::from_millis(ms as u64));
        }
    }
    opts
}
