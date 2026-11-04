//! An in-memory account transport. It stores scopes and cancellation tokens, never credentials.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue},
    Client, Method,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;
use url::Url;

const MAX_REQUEST_BYTES: usize = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 20 * 1024 * 1024;
const MAX_ORIGINS: usize = 64;
const MAX_ACCOUNTS: usize = 32;
const MAX_PENDING_REQUESTS: usize = 256;
const MAX_HEADERS: usize = 128;
const MAX_HEADER_BYTES: usize = 64 * 1024;
const MAX_PRE_CANCELLED: usize = 1024;
const PRE_CANCEL_LIFETIME: Duration = Duration::from_secs(60);

#[derive(Debug, Serialize)]
pub struct BrokerError {
    code: &'static str,
    message: &'static str,
}

impl BrokerError {
    pub(crate) fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
    fn cancelled() -> Self {
        Self::new("request_cancelled", "The account request was cancelled.")
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BodyEncoding {
    #[default]
    Utf8,
    Base64,
}

pub struct BrokerRequest {
    pub account_id: String,
    pub request_id: String,
    pub url: String,
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub body_encoding: BodyEncoding,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountHttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub url: String,
    pub body: String,
    pub body_encoding: &'static str,
}

type RequestKey = (String, String);

struct ActiveRequest {
    ticket: u64,
    cancellation: CancellationToken,
}

#[derive(Default)]
struct Registry {
    accounts: HashMap<String, HashSet<String>>,
    requests: HashMap<RequestKey, ActiveRequest>,
    pre_cancelled: HashMap<RequestKey, Instant>,
    next_ticket: u64,
}

pub struct AccountHttpBroker {
    client: Client,
    registry: Arc<Mutex<Registry>>,
}

struct RequestGuard {
    registry: Arc<Mutex<Registry>>,
    key: RequestKey,
    ticket: u64,
    cancellation: CancellationToken,
}

impl Drop for RequestGuard {
    fn drop(&mut self) {
        if let Ok(mut registry) = self.registry.lock() {
            if registry
                .requests
                .get(&self.key)
                .is_some_and(|request| request.ticket == self.ticket)
            {
                registry.requests.remove(&self.key);
            }
        }
    }
}

fn validate_id(value: &str) -> Result<(), BrokerError> {
    if value.trim().is_empty() || value.len() > 256 || value.chars().any(char::is_control) {
        return Err(BrokerError::new(
            "invalid_identifier",
            "Account and request identifiers must be nonempty and at most 256 bytes.",
        ));
    }
    Ok(())
}

fn https_url(value: &str) -> Result<Url, BrokerError> {
    let url = Url::parse(value)
        .map_err(|_| BrokerError::new("invalid_url", "A valid HTTPS URL is required."))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(BrokerError::new(
            "invalid_url",
            "Account URLs must use HTTPS without embedded credentials or fragments.",
        ));
    }
    Ok(url)
}

fn exact_origin(value: &str) -> Result<String, BrokerError> {
    let url = https_url(value)?;
    if url.path() != "/"
        || url.query().is_some()
        || url.host_str().is_some_and(|host| host.contains('*'))
    {
        return Err(BrokerError::new(
            "invalid_origin",
            "Configure exact HTTPS origins without paths, queries or wildcards.",
        ));
    }
    Ok(url.origin().ascii_serialization())
}

fn request_method(value: &str) -> Result<Method, BrokerError> {
    match value {
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" => {
            Method::from_bytes(value.as_bytes())
                .map_err(|_| BrokerError::new("invalid_method", "Unsupported HTTP method."))
        }
        _ => Err(BrokerError::new(
            "invalid_method",
            "Unsupported HTTP method.",
        )),
    }
}

fn request_headers(values: Vec<(String, String)>) -> Result<HeaderMap, BrokerError> {
    if values.len() > MAX_HEADERS
        || values
            .iter()
            .map(|(name, value)| name.len() + value.len())
            .sum::<usize>()
            > MAX_HEADER_BYTES
    {
        return Err(BrokerError::new(
            "headers_too_large",
            "The request exceeds the header limit.",
        ));
    }
    let mut headers = HeaderMap::new();
    for (name, value) in values {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| BrokerError::new("invalid_header", "An HTTP header name is invalid."))?;
        if matches!(
            name.as_str(),
            "cookie"
                | "cookie2"
                | "proxy-authorization"
                | "host"
                | "content-length"
                | "connection"
                | "proxy-connection"
                | "keep-alive"
                | "transfer-encoding"
                | "upgrade"
                | "trailer"
                | "te"
                | "expect"
        ) {
            return Err(BrokerError::new(
                "forbidden_header",
                "Caller-supplied cookies, proxy credentials and transport headers are not allowed.",
            ));
        }
        let bytes: Result<Vec<u8>, _> = value
            .chars()
            .map(|character| u8::try_from(u32::from(character)))
            .collect();
        let bytes = bytes.map_err(|_| {
            BrokerError::new(
                "invalid_header",
                "An HTTP header value is not a byte string.",
            )
        })?;
        let mut value = HeaderValue::from_bytes(&bytes)
            .map_err(|_| BrokerError::new("invalid_header", "An HTTP header value is invalid."))?;
        if name == reqwest::header::AUTHORIZATION {
            value.set_sensitive(true);
        }
        headers.append(name, value);
    }
    Ok(headers)
}

fn response_headers(headers: &HeaderMap) -> Vec<(String, String)> {
    let mut values = Vec::new();
    // get_all preserves multiple authentication challenges instead of dropping all but one.
    for name in headers.keys() {
        for value in headers.get_all(name).iter() {
            values.push((
                name.as_str().to_owned(),
                value.as_bytes().iter().copied().map(char::from).collect(),
            ));
        }
    }
    values
}

fn request_body(
    body: Option<String>,
    encoding: BodyEncoding,
) -> Result<Option<Vec<u8>>, BrokerError> {
    let Some(body) = body else {
        return Ok(None);
    };
    let bytes = match encoding {
        BodyEncoding::Utf8 => {
            if body.len() > MAX_REQUEST_BYTES {
                return Err(BrokerError::new(
                    "request_too_large",
                    "Request bodies are limited to 10 MiB.",
                ));
            }
            body.into_bytes()
        }
        BodyEncoding::Base64 => {
            if body.len() > MAX_REQUEST_BYTES.div_ceil(3) * 4 {
                return Err(BrokerError::new(
                    "request_too_large",
                    "Request bodies are limited to 10 MiB.",
                ));
            }
            BASE64.decode(body).map_err(|_| {
                BrokerError::new("invalid_body", "The request body is not valid base64.")
            })?
        }
    };
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err(BrokerError::new(
            "request_too_large",
            "Request bodies are limited to 10 MiB.",
        ));
    }
    Ok(Some(bytes))
}

fn network_error(error: reqwest::Error) -> BrokerError {
    if error.is_timeout() {
        BrokerError::new("request_timeout", "The account request timed out.")
    } else if error.is_connect() {
        BrokerError::new("connection_failed", "The account connection could not be established. Check connectivity and the system certificate trust.")
    } else {
        BrokerError::new(
            "request_failed",
            "The account request could not be completed.",
        )
    }
}

impl AccountHttpBroker {
    pub fn new() -> Result<Self, BrokerError> {
        let client = Client::builder()
            .use_native_tls()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .referer(false)
            .connect_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(210))
            .build()
            .map_err(|_| {
                BrokerError::new(
                    "transport_unavailable",
                    "The system TLS transport could not be initialized.",
                )
            })?;
        Ok(Self {
            client,
            registry: Arc::new(Mutex::new(Registry::default())),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Registry>, BrokerError> {
        self.registry.lock().map_err(|_| {
            BrokerError::new(
                "transport_unavailable",
                "The account transport state is unavailable.",
            )
        })
    }

    pub fn configure(&self, account_id: &str, origins: Vec<String>) -> Result<(), BrokerError> {
        validate_id(account_id)?;
        if origins.is_empty() || origins.len() > MAX_ORIGINS {
            return Err(BrokerError::new(
                "invalid_origins",
                "Configure between 1 and 64 exact HTTPS origins.",
            ));
        }
        let origins = origins
            .iter()
            .map(|value| exact_origin(value))
            .collect::<Result<HashSet<_>, _>>()?;
        let mut registry = self.lock()?;
        if !registry.accounts.contains_key(account_id) && registry.accounts.len() >= MAX_ACCOUNTS {
            return Err(BrokerError::new(
                "account_limit",
                "The account transport limit has been reached.",
            ));
        }
        registry.accounts.insert(account_id.to_owned(), origins);
        Ok(())
    }

    fn begin(
        &self,
        account_id: &str,
        request_id: &str,
        url: &Url,
    ) -> Result<RequestGuard, BrokerError> {
        validate_id(account_id)?;
        validate_id(request_id)?;
        let mut registry = self.lock()?;
        let origins = registry.accounts.get(account_id).ok_or_else(|| {
            BrokerError::new(
                "account_not_configured",
                "Configure this account transport before making requests.",
            )
        })?;
        if !origins.contains(&url.origin().ascii_serialization()) {
            return Err(BrokerError::new(
                "origin_not_allowed",
                "The requested HTTPS origin has not been approved for this account.",
            ));
        }
        let key = (account_id.to_owned(), request_id.to_owned());
        registry
            .pre_cancelled
            .retain(|_, cancelled_at| cancelled_at.elapsed() < PRE_CANCEL_LIFETIME);
        if registry.pre_cancelled.remove(&key).is_some() {
            return Err(BrokerError::cancelled());
        }
        if registry.requests.contains_key(&key) {
            return Err(BrokerError::new(
                "duplicate_request",
                "This account request identifier is already active.",
            ));
        }
        if registry.requests.len() >= MAX_PENDING_REQUESTS {
            return Err(BrokerError::new(
                "request_limit",
                "The native request limit has been reached.",
            ));
        }
        registry.next_ticket = registry.next_ticket.wrapping_add(1);
        let ticket = registry.next_ticket;
        let cancellation = CancellationToken::new();
        registry.requests.insert(
            key.clone(),
            ActiveRequest {
                ticket,
                cancellation: cancellation.clone(),
            },
        );
        Ok(RequestGuard {
            registry: Arc::clone(&self.registry),
            key,
            ticket,
            cancellation,
        })
    }

    pub fn cancel(&self, account_id: &str, request_id: &str) -> Result<(), BrokerError> {
        validate_id(account_id)?;
        validate_id(request_id)?;
        let mut registry = self.lock()?;
        let key = (account_id.to_owned(), request_id.to_owned());
        if let Some(request) = registry.requests.get(&key) {
            request.cancellation.cancel();
        } else if registry.accounts.contains_key(account_id) {
            registry
                .pre_cancelled
                .retain(|_, cancelled_at| cancelled_at.elapsed() < PRE_CANCEL_LIFETIME);
            if registry.pre_cancelled.len() >= MAX_PRE_CANCELLED
                && !registry.pre_cancelled.contains_key(&key)
            {
                return Err(BrokerError::new(
                    "request_limit",
                    "The cancellation request limit has been reached.",
                ));
            }
            registry.pre_cancelled.insert(key, Instant::now());
        }
        Ok(())
    }

    pub fn remove(&self, account_id: &str) -> Result<(), BrokerError> {
        validate_id(account_id)?;
        let mut registry = self.lock()?;
        registry.accounts.remove(account_id);
        registry.requests.retain(|(account, _), request| {
            if account == account_id {
                request.cancellation.cancel();
                false
            } else {
                true
            }
        });
        registry
            .pre_cancelled
            .retain(|(account, _), _| account != account_id);
        Ok(())
    }

    pub fn cancel_all(&self) {
        if let Ok(mut registry) = self.registry.lock() {
            for request in registry.requests.values() {
                request.cancellation.cancel();
            }
            registry.requests.clear();
            registry.pre_cancelled.clear();
            registry.accounts.clear();
        }
    }

    pub async fn request(
        &self,
        request: BrokerRequest,
    ) -> Result<AccountHttpResponse, BrokerError> {
        let url = https_url(&request.url)?;
        let method = request_method(&request.method)?;
        let headers = request_headers(request.headers)?;
        let body = request_body(request.body, request.body_encoding)?;
        let guard = self.begin(&request.account_id, &request.request_id, &url)?;
        tokio::select! {
            biased;
            _ = guard.cancellation.cancelled() => Err(BrokerError::cancelled()),
            result = self.execute(url, method, headers, body) => result,
        }
    }

    async fn execute(
        &self,
        url: Url,
        method: Method,
        headers: HeaderMap,
        body: Option<Vec<u8>>,
    ) -> Result<AccountHttpResponse, BrokerError> {
        let mut request = self.client.request(method, url).headers(headers);
        if let Some(body) = body {
            request = request.body(body);
        }
        let mut response = request.send().await.map_err(network_error)?;
        let status = response.status().as_u16();
        let headers = response_headers(response.headers());
        let url = response.url().as_str().to_owned();
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
        {
            return Err(BrokerError::new(
                "response_too_large",
                "Responses are limited to 20 MiB.",
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(network_error)? {
            if bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
                return Err(BrokerError::new(
                    "response_too_large",
                    "Responses are limited to 20 MiB.",
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(AccountHttpResponse {
            status,
            headers,
            url,
            body: BASE64.encode(bytes),
            body_encoding: "base64",
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> AccountHttpBroker {
        let broker = AccountHttpBroker::new().unwrap();
        broker
            .configure("first", vec!["https://pool.example.com".into()])
            .unwrap();
        broker
    }

    #[test]
    fn scope_requires_exact_https_origins() {
        assert_eq!(
            exact_origin("https://POOL.example.com:443/").unwrap(),
            "https://pool.example.com"
        );
        for invalid in [
            "http://pool.example.com",
            "https://pool.example.com/path",
            "https://pool.example.com?x=1",
            "https://user:secret@pool.example.com",
            "https://pool.example.com#fragment",
            "https://*.example.com",
        ] {
            assert!(exact_origin(invalid).is_err());
        }
        let broker = broker();
        for denied in [
            "https://pool.example.com.evil.test",
            "https://pool.example.com:444",
            "https://other.example.com",
        ] {
            assert_eq!(
                broker
                    .begin("first", "r1", &https_url(denied).unwrap())
                    .err()
                    .unwrap()
                    .code,
                "origin_not_allowed"
            );
        }
        assert!(broker
            .begin(
                "first",
                "r1",
                &https_url("https://pool.example.com/user?sipuri=sip%3Auser%40example.com")
                    .unwrap()
            )
            .is_ok());
        assert!(broker
            .begin(
                "second",
                "r1",
                &https_url("https://pool.example.com").unwrap()
            )
            .is_err());
    }

    #[test]
    fn headers_keep_authentication_challenges_without_accepting_cookies_or_transport_overrides() {
        let mut headers = HeaderMap::new();
        headers.append(
            "www-authenticate",
            HeaderValue::from_static("Bearer realm=\"one\""),
        );
        headers.append(
            "www-authenticate",
            HeaderValue::from_static("MsRtcOAuth grant_type=\"password\""),
        );
        let values = response_headers(&headers);
        assert_eq!(values.len(), 2);
        assert_eq!(
            values[0],
            ("www-authenticate".into(), "Bearer realm=\"one\"".into())
        );
        assert_eq!(
            values[1],
            (
                "www-authenticate".into(),
                "MsRtcOAuth grant_type=\"password\"".into()
            )
        );
        let accepted = request_headers(vec![(
            "Authorization".into(),
            "Bearer synthetic-token".into(),
        )])
        .unwrap();
        assert_eq!(
            accepted.get("authorization").unwrap(),
            "Bearer synthetic-token"
        );
        for forbidden in [
            "Cookie",
            "cOoKiE2",
            "PROXY-AUTHORIZATION",
            "Host",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
        ] {
            assert_eq!(
                request_headers(vec![(forbidden.into(), "synthetic".into())])
                    .unwrap_err()
                    .code,
                "forbidden_header"
            );
        }
        assert!(
            request_headers(vec![("X-Test".into(), "value\r\nCookie: synthetic".into())]).is_err()
        );
    }

    #[test]
    fn request_bodies_are_binary_safe_and_bounded() {
        let binary = vec![0, 128, 255, 10];
        assert_eq!(
            request_body(Some(BASE64.encode(&binary)), BodyEncoding::Base64).unwrap(),
            Some(binary)
        );
        assert_eq!(
            request_body(Some("Grüße".into()), BodyEncoding::Utf8).unwrap(),
            Some("Grüße".as_bytes().to_vec())
        );
        assert!(request_body(Some("invalid!?".into()), BodyEncoding::Base64).is_err());
        assert_eq!(
            request_body(Some("x".repeat(MAX_REQUEST_BYTES + 1)), BodyEncoding::Utf8)
                .unwrap_err()
                .code,
            "request_too_large"
        );
        assert_eq!(
            request_body(
                Some(BASE64.encode(vec![0; MAX_REQUEST_BYTES + 1])),
                BodyEncoding::Base64
            )
            .unwrap_err()
            .code,
            "request_too_large"
        );
    }

    #[test]
    fn account_reconfiguration_retains_pending_requests_and_remove_cancels_only_that_account() {
        let broker = broker();
        broker
            .configure("second", vec!["https://other.example.com".into()])
            .unwrap();
        let first = broker
            .begin(
                "first",
                "r1",
                &https_url("https://pool.example.com").unwrap(),
            )
            .unwrap();
        let second = broker
            .begin(
                "second",
                "r2",
                &https_url("https://other.example.com").unwrap(),
            )
            .unwrap();
        broker
            .configure("first", vec!["https://new.example.com".into()])
            .unwrap();
        assert!(!first.cancellation.is_cancelled());
        assert!(broker
            .begin(
                "first",
                "r3",
                &https_url("https://pool.example.com").unwrap()
            )
            .is_err());
        broker.remove("first").unwrap();
        assert!(first.cancellation.is_cancelled());
        assert!(!second.cancellation.is_cancelled());
    }

    #[test]
    fn cancellation_handles_races_duplicates_and_old_registration_cleanup() {
        let broker = broker();
        let url = https_url("https://pool.example.com").unwrap();
        broker.cancel("first", "early").unwrap();
        assert_eq!(
            broker.begin("first", "early", &url).err().unwrap().code,
            "request_cancelled"
        );
        let old = broker.begin("first", "same", &url).unwrap();
        assert_eq!(
            broker.begin("first", "same", &url).err().unwrap().code,
            "duplicate_request"
        );
        broker.remove("first").unwrap();
        broker
            .configure("first", vec!["https://pool.example.com".into()])
            .unwrap();
        let current = broker.begin("first", "same", &url).unwrap();
        drop(old);
        broker.cancel("first", "same").unwrap();
        assert!(current.cancellation.is_cancelled());
    }

    #[test]
    fn errors_and_response_shape_do_not_include_request_secrets() {
        let error = https_url("https://user:synthetic-secret@pool.example.com").unwrap_err();
        let encoded = serde_json::to_string(&error).unwrap();
        assert!(!encoded.contains("synthetic-secret"));
        let response = AccountHttpResponse {
            status: 401,
            headers: vec![("www-authenticate".into(), "Bearer".into())],
            url: "https://pool.example.com".into(),
            body: BASE64.encode([0, 255]),
            body_encoding: "base64",
        };
        assert_eq!(
            serde_json::to_value(response).unwrap()["bodyEncoding"],
            "base64"
        );
    }
}
