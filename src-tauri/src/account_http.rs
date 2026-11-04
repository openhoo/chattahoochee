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

fn account_client() -> reqwest::ClientBuilder {
    Client::builder()
        .use_native_tls()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .referer(false)
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(210))
}

impl AccountHttpBroker {
    pub fn new() -> Result<Self, BrokerError> {
        let client = account_client().build().map_err(|_| {
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
    use std::{
        io::{Read, Write},
        net::{TcpListener, TcpStream},
        sync::atomic::{AtomicBool, Ordering},
        thread::{self, JoinHandle},
    };

    fn loopback(
        handler: impl FnOnce(TcpStream) + Send + 'static,
    ) -> (Url, Arc<AtomicBool>, JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = Url::parse(&format!(
            "http://{}/resource",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let accepted = Arc::new(AtomicBool::new(false));
        let ready = Arc::clone(&accepted);
        let task = thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        ready.store(true, Ordering::SeqCst);
                        handler(stream);
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "loopback fixture received no request"
                        );
                        thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("loopback fixture failed: {error}"),
                }
            }
        });
        (url, accepted, task)
    }

    fn read_request(stream: &mut TcpStream) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 8192];
        loop {
            let size = stream.read(&mut chunk).unwrap();
            assert!(size > 0, "request ended before its headers");
            bytes.extend_from_slice(&chunk[..size]);
            if let Some(boundary) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let content_length = String::from_utf8_lossy(&bytes[..boundary])
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map_or(0, |(_, value)| value.trim().parse::<usize>().unwrap());
                if bytes.len() >= boundary + 4 + content_length {
                    return bytes;
                }
            }
        }
    }

    // Only this test client permits plaintext loopback. The shared builder still supplies the
    // production redirect/retry policies; the public broker request path remains HTTPS-only.
    fn loopback_broker(timeout: Duration) -> AccountHttpBroker {
        AccountHttpBroker {
            client: account_client()
                .https_only(false)
                .no_proxy()
                .timeout(timeout)
                .build()
                .unwrap(),
            registry: Arc::new(Mutex::new(Registry::default())),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn redirects_are_returned_without_following_or_forwarding_authorization() {
        let target = TcpListener::bind("127.0.0.1:0").unwrap();
        target.set_nonblocking(true).unwrap();
        let location = format!("http://{}/redirect-target", target.local_addr().unwrap());
        let expected_location = location.clone();
        let (url, _, server) = loopback(move |mut stream| {
            let request = read_request(&mut stream);
            assert!(
                String::from_utf8_lossy(&request).contains("authorization: Bearer synthetic-token")
            );
            write!(stream, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let broker = loopback_broker(Duration::from_secs(2));
        let response = broker
            .execute(
                url.clone(),
                Method::GET,
                request_headers(vec![(
                    "Authorization".into(),
                    "Bearer synthetic-token".into(),
                )])
                .unwrap(),
                None,
            )
            .await
            .unwrap();
        assert_eq!(response.status, 302);
        assert_eq!(response.url, url.as_str());
        assert!(response
            .headers
            .contains(&("location".into(), expected_location)));
        assert_eq!(
            target.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        server.join().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wire_round_trip_preserves_binary_bodies_and_duplicate_authentication_challenges() {
        let (url, _, server) = loopback(|mut stream| {
            let request = read_request(&mut stream);
            assert!(request.starts_with(b"POST /resource HTTP/1.1\r\n"));
            assert!(request.ends_with(&[0, 128, 255, 10]));
            stream.write_all(b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer realm=\"one\"\r\nWWW-Authenticate: MsRtcOAuth grant_type=\"password\"\r\nContent-Type: application/octet-stream\r\nContent-Length: 6\r\nConnection: close\r\n\r\n").unwrap();
            stream.write_all(&[255, 0, 128, 1, 254, 10]).unwrap();
        });
        let broker = loopback_broker(Duration::from_secs(2));
        let response = broker
            .execute(
                url,
                Method::POST,
                HeaderMap::new(),
                Some(vec![0, 128, 255, 10]),
            )
            .await
            .unwrap();
        assert_eq!(response.status, 401);
        assert_eq!(
            BASE64.decode(&response.body).unwrap(),
            vec![255, 0, 128, 1, 254, 10]
        );
        assert_eq!(
            response
                .headers
                .iter()
                .filter(|(name, _)| name == "www-authenticate")
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>(),
            vec!["Bearer realm=\"one\"", "MsRtcOAuth grant_type=\"password\""]
        );
        server.join().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn deadlines_cover_both_waiting_for_headers_and_reading_a_stalled_response_body() {
        for send_headers in [false, true] {
            let (url, _, server) = loopback(move |mut stream| {
                read_request(&mut stream);
                if send_headers {
                    stream
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nx",
                        )
                        .unwrap();
                }
                thread::sleep(Duration::from_millis(250));
            });
            let broker = loopback_broker(Duration::from_millis(80));
            let result = broker
                .execute(url, Method::GET, HeaderMap::new(), None)
                .await;
            assert_eq!(result.err().unwrap().code, "request_timeout");
            server.join().unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn advertised_response_size_is_rejected_before_a_body_arrives() {
        let (url, _, server) = loopback(|mut stream| {
            read_request(&mut stream);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            )
            .unwrap();
        });
        let broker = loopback_broker(Duration::from_secs(2));
        assert_eq!(
            broker
                .execute(url, Method::GET, HeaderMap::new(), None)
                .await
                .err()
                .unwrap()
                .code,
            "response_too_large"
        );
        server.join().unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn streamed_response_size_accepts_the_boundary_and_rejects_the_next_byte() {
        for total in [MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES + 1] {
            let (url, _, server) = loopback(move |mut stream| {
                read_request(&mut stream);
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n")
                    .unwrap();
                let chunk = [0xa5; 64 * 1024];
                let mut remaining = total;
                while remaining > 0 {
                    let size = remaining.min(chunk.len());
                    if stream.write_all(&chunk[..size]).is_err() {
                        break;
                    }
                    remaining -= size;
                }
            });
            let broker = loopback_broker(Duration::from_secs(2));
            let result = broker
                .execute(url, Method::GET, HeaderMap::new(), None)
                .await;
            if total == MAX_RESPONSE_BYTES {
                let response = result.unwrap();
                let bytes = BASE64.decode(response.body).unwrap();
                assert_eq!(bytes.len(), total);
                assert!(bytes.iter().all(|byte| *byte == 0xa5));
            } else {
                assert_eq!(result.err().unwrap().code, "response_too_large");
            }
            server.join().unwrap();
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_before_dispatch_never_opens_a_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let origin = format!("https://{}", listener.local_addr().unwrap());
        let broker = loopback_broker(Duration::from_secs(1));
        broker.configure("first", vec![origin.clone()]).unwrap();
        broker.cancel("first", "early").unwrap();
        let result = broker
            .request(BrokerRequest {
                account_id: "first".into(),
                request_id: "early".into(),
                url: format!("{origin}/messages"),
                method: "POST".into(),
                headers: vec![],
                body: Some("synthetic message".into()),
                body_encoding: BodyEncoding::Utf8,
            })
            .await;
        assert_eq!(result.err().unwrap().code, "request_cancelled");
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancelling_an_active_connection_releases_its_request_identifier() {
        let (release, hold) = std::sync::mpsc::channel();
        let (mut url, accepted, server) = loopback(move |_stream| {
            let _ = hold.recv_timeout(Duration::from_secs(3));
        });
        url.set_scheme("https").unwrap();
        let broker = loopback_broker(Duration::from_secs(2));
        broker
            .configure("first", vec![url.origin().ascii_serialization()])
            .unwrap();
        let cancellation = async {
            tokio::time::timeout(Duration::from_secs(1), async {
                while !accepted.load(Ordering::SeqCst) {
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            })
            .await
            .unwrap();
            broker.cancel("first", "active").unwrap();
        };
        let (result, ()) = tokio::join!(
            broker.request(BrokerRequest {
                account_id: "first".into(),
                request_id: "active".into(),
                url: url.to_string(),
                method: "GET".into(),
                headers: vec![],
                body: None,
                body_encoding: BodyEncoding::Utf8,
            }),
            cancellation
        );
        assert_eq!(result.err().unwrap().code, "request_cancelled");
        assert!(broker.begin("first", "active", &url).is_ok());
        release.send(()).unwrap();
        server.join().unwrap();
    }

    fn broker() -> AccountHttpBroker {
        let broker = AccountHttpBroker::new().unwrap();
        broker
            .configure("first", vec!["https://pool.example.com".into()])
            .unwrap();
        broker
    }

    #[test]
    fn identifier_limits_count_bytes_and_reject_blank_or_control_characters() {
        for invalid in [
            String::new(),
            " \t ".into(),
            "request\nsecond".into(),
            "x".repeat(257),
            format!("{}a", "ä".repeat(128)),
        ] {
            assert_eq!(
                validate_id(&invalid).unwrap_err().code,
                "invalid_identifier"
            );
        }
        assert!(validate_id(&"x".repeat(256)).is_ok());
        assert!(validate_id(&"ä".repeat(128)).is_ok());
    }

    #[test]
    fn header_limits_and_byte_string_validation_apply_at_the_exact_boundary() {
        assert!(request_headers(vec![("x".into(), "a".repeat(MAX_HEADER_BYTES - 1))]).is_ok());
        assert_eq!(
            request_headers(vec![("x".into(), "a".repeat(MAX_HEADER_BYTES))])
                .unwrap_err()
                .code,
            "headers_too_large"
        );
        assert!(request_headers(
            (0..MAX_HEADERS)
                .map(|index| (format!("x-{index}"), "value".into()))
                .collect()
        )
        .is_ok());
        assert_eq!(
            request_headers(
                (0..=MAX_HEADERS)
                    .map(|index| (format!("x-{index}"), "value".into()))
                    .collect()
            )
            .unwrap_err()
            .code,
            "headers_too_large"
        );
        assert_eq!(
            request_headers(vec![("invalid header".into(), "value".into())])
                .unwrap_err()
                .code,
            "invalid_header"
        );
        assert_eq!(
            request_headers(vec![("x-test".into(), "€".into())])
                .unwrap_err()
                .code,
            "invalid_header"
        );
        let headers = request_headers(vec![("x-test".into(), "Grüße".into())]).unwrap();
        assert!(response_headers(&headers).contains(&("x-test".into(), "Grüße".into())));
    }

    #[test]
    fn account_and_origin_limits_allow_reconfiguration_without_replacing_valid_scope_on_error() {
        let broker = broker();
        for index in 1..MAX_ACCOUNTS {
            broker
                .configure(
                    &format!("account-{index}"),
                    vec!["https://pool.example.com".into()],
                )
                .unwrap();
        }
        assert_eq!(
            broker
                .configure("overflow", vec!["https://pool.example.com".into()])
                .unwrap_err()
                .code,
            "account_limit"
        );
        assert_eq!(
            broker.configure("first", vec![]).unwrap_err().code,
            "invalid_origins"
        );
        assert_eq!(
            broker
                .configure(
                    "first",
                    vec!["https://pool.example.com".into(); MAX_ORIGINS + 1]
                )
                .unwrap_err()
                .code,
            "invalid_origins"
        );
        assert_eq!(
            broker
                .configure(
                    "first",
                    vec!["https://pool.example.com/private/path".into()]
                )
                .unwrap_err()
                .code,
            "invalid_origin"
        );
        assert!(broker
            .begin(
                "first",
                "original-scope",
                &https_url("https://pool.example.com").unwrap()
            )
            .is_ok());
        broker
            .configure(
                "first",
                (0..MAX_ORIGINS)
                    .map(|index| format!("https://pool-{index}.example.com"))
                    .collect(),
            )
            .unwrap();
        assert!(broker
            .begin(
                "first",
                "new-scope",
                &https_url("https://pool-63.example.com").unwrap()
            )
            .is_ok());
        broker.remove("account-1").unwrap();
        broker
            .configure("overflow", vec!["https://pool.example.com".into()])
            .unwrap();
    }

    #[test]
    fn pending_request_limit_is_released_when_a_request_finishes() {
        let broker = broker();
        let url = https_url("https://pool.example.com").unwrap();
        let mut pending: Vec<_> = (0..MAX_PENDING_REQUESTS)
            .map(|index| {
                broker
                    .begin("first", &format!("request-{index}"), &url)
                    .unwrap()
            })
            .collect();
        assert_eq!(
            broker.begin("first", "overflow", &url).err().unwrap().code,
            "request_limit"
        );
        assert_eq!(
            broker.begin("first", "request-0", &url).err().unwrap().code,
            "duplicate_request"
        );
        pending.pop();
        assert!(broker.begin("first", "overflow", &url).is_ok());
    }

    #[test]
    fn early_cancellation_limits_are_bounded_and_consumed_entries_release_capacity() {
        let broker = broker();
        for index in 0..MAX_PRE_CANCELLED {
            broker.cancel("first", &format!("early-{index}")).unwrap();
        }
        assert_eq!(
            broker.cancel("first", "overflow").unwrap_err().code,
            "request_limit"
        );
        broker.cancel("first", "early-0").unwrap();
        assert_eq!(
            broker
                .begin(
                    "first",
                    "early-0",
                    &https_url("https://pool.example.com").unwrap()
                )
                .err()
                .unwrap()
                .code,
            "request_cancelled"
        );
        broker.cancel("first", "overflow").unwrap();
        broker.remove("first").unwrap();
        broker
            .configure("first", vec!["https://pool.example.com".into()])
            .unwrap();
        assert!(broker
            .begin(
                "first",
                "overflow",
                &https_url("https://pool.example.com").unwrap()
            )
            .is_ok());
    }

    #[test]
    fn application_exit_cancels_all_requests_and_removes_account_and_early_cancel_scopes() {
        let broker = broker();
        let url = https_url("https://pool.example.com").unwrap();
        broker
            .configure("second", vec![url.origin().ascii_serialization()])
            .unwrap();
        let first = broker.begin("first", "active", &url).unwrap();
        let second = broker.begin("second", "active", &url).unwrap();
        broker.cancel("first", "early").unwrap();
        broker.cancel_all();
        assert!(first.cancellation.is_cancelled());
        assert!(second.cancellation.is_cancelled());
        for account in ["first", "second"] {
            assert_eq!(
                broker.begin(account, "next", &url).err().unwrap().code,
                "account_not_configured"
            );
        }
        broker
            .configure("first", vec![url.origin().ascii_serialization()])
            .unwrap();
        assert!(broker.begin("first", "early", &url).is_ok());
    }

    #[test]
    fn utf8_and_base64_request_limits_accept_exactly_ten_mebibytes() {
        let utf8 = "ö".repeat(MAX_REQUEST_BYTES / 2);
        assert_eq!(
            request_body(Some(utf8.clone()), BodyEncoding::Utf8)
                .unwrap()
                .unwrap()
                .len(),
            MAX_REQUEST_BYTES
        );
        assert_eq!(
            request_body(Some(format!("{utf8}ö")), BodyEncoding::Utf8)
                .unwrap_err()
                .code,
            "request_too_large"
        );
        let bytes = vec![0xff; MAX_REQUEST_BYTES];
        assert_eq!(
            request_body(Some(BASE64.encode(&bytes)), BodyEncoding::Base64)
                .unwrap()
                .unwrap(),
            bytes
        );
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
