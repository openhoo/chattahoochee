# Native desktop host

This Tauri v2 host provides an in-memory HTTP broker for the TypeScript Skype for Business and Teamwire SDKs. The application identifier is `ai.openhoo.chattahoochee`.

## Account transport IPC

All JavaScript invoke arguments are flat objects with camelCase keys. Commands return a rejected promise with `{ code, message }` on failure. Error messages are fixed strings and do not include request URLs, headers, bodies, credentials, or server error payloads.

| Command | Arguments | Result |
| --- | --- | --- |
| `configure_account_transport` | `{ accountId, origins: string[] }` | `void` |
| `account_http` | `{ accountId, requestId, url, method, headers: [string, string][], body?: string, bodyEncoding?: "utf8" \| "base64" }` | `{ status, headers: [string, string][], url, body, bodyEncoding: "base64" }` |
| `cancel_account_http` | `{ accountId, requestId }` | `void` |
| `remove_account_transport` | `{ accountId }` | `void` |

`bodyEncoding` defaults to `utf8` for requests. Every response body uses base64, including empty and textual responses. Duplicate response headers are preserved as separate tuples so the SDK can read every authentication challenge. HTTP errors, including 401, return normal HTTP responses to the SDK. Redirects and automatic retries are disabled.

Configuration replaces an account's exact HTTPS origin set and retains requests already in flight. Account removal cancels its requests. A cancellation that arrives before request registration is retained for up to 60 seconds. Cancellation rejects with `code: "request_cancelled"`; the frontend converts it to `AbortError`.

## Boundaries

- Only the packaged main window can invoke the four account commands. Generated command permissions have no default grant. Remote navigation and new windows are denied.
- Every request must match an origin explicitly configured for that account. Credentials in URLs, non-HTTPS URLs, fragments, wildcard scopes, and origin scopes with paths or queries are rejected.
- The broker uses system TLS trust and the system proxy configuration. It does not disable certificate verification.
- Caller cookies, proxy authorization, Host, Content-Length, and hop-by-hop transport headers are rejected. Authorization supplied explicitly by the SDK is allowed and marked sensitive. The HTTP client has no cookie store.
- Account configuration, SDK credentials, tokens, and cancellation state are not persisted by the native host. Request bodies are held in memory for transmission.
- Gzip, Brotli, and deflate responses are decoded before the response size limit is applied. Request bodies are limited to 10 MiB; decoded response bodies to 20 MiB. The timeout is 210 seconds to accommodate long event polls, with a 30 second connection timeout.
- Resource bounds are 32 accounts, 64 origins per account, 256 active requests, and 128 request headers totaling at most 64 KiB.

The broker does not implement provider authentication itself. The TypeScript SDK owns discovery, authentication, approved origin decisions, event polling, and provider behavior.

## Checks

From this directory:

```sh
cargo fmt --all -- --check
cargo test --locked
cargo check --locked
```

The unit tests exercise origin boundaries, request encoding and limits, authentication header preservation, cancellation ordering and cleanup, account isolation, navigation rules, and sanitized error serialization. These checks do not authenticate an enterprise account or prove interoperability with a live server. macOS and Windows installer builds require their respective native build environments.
