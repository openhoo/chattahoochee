# @openhoo/teamwire-sdk

An independently authored, experimental TypeScript client for **Teamwire human accounts**. It is not affiliated with Teamwire and is not the official Teamwire bot SDK.

This package implements an observed version 20 client protocol. Protocol compatibility has been checked with synthetic fixtures and independent native cryptographic primitives. A real account login, real conversation history and message delivery have **not** been verified.

## Usage

The current workspace package exports TypeScript source. Use a TypeScript-aware bundler such as Vite, or a runtime such as `tsx`. Node requires version 20.19 or later. Browser/desktop environments must provide Fetch, Web Crypto, `atob` and `btoa`.

```ts
import { TeamwireClient } from '@openhoo/teamwire-sdk';

const client = new TeamwireClient({
  origin: 'https://chat.example.org',
  // Supply a Fetch-compatible native transport in a Tauri application.
  // fetch: nativeFetch,
});

const session = await client.loginPassword({ email, password });
const contacts = await session.getContacts();
const conversations = await session.getConversations();
const messages = await session.getHistory(conversations[0]!.id, { days: 30 });

// This operation sends a real message when connected to a real server.
const receipt = await session.sendText(conversations[0]!.id, 'Hello');
console.log(receipt.delivery); // 'accepted'; recipient delivery is not established.

await session.logout();
```

`getSupportedApiVersions()` performs an unauthenticated version read. The server origin must be configured explicitly: this SDK does not assume email-domain discovery, silently switch origins, or follow authentication redirects. The supplied transport must enforce `redirect: 'error'` before forwarding credentials. The SDK also checks response URL/redirect metadata, but a check after a transport has followed a redirect cannot undo a credential disclosure.

The configured server must support the observed password exchange and return a separate human `owner_id`; the transport's `from_id` is not used as a substitute sender identity. Interactive SSO, MFA, account registration, PIN registration, password-reset workflows and device enrollment are not implemented. An incompatible challenge/login response raises `UnsupportedAuthError`. HTTP authentication failures remain `TeamwireHttpError` instances with a status code. Errors do not contain response bodies, passwords or decrypted messages.

## Supported operations

| Method | Behavior |
| --- | --- |
| `client.getSupportedApiVersions(options?)` | Read supported server API versions. |
| `client.loginPassword(credentials, options?)` | Establish an encrypted session using an email and password. |
| `session.getContacts(options?)` | Load the human-account contact directory. |
| `session.getPreferences(options?)` | Read favorite, unread, muted and archived conversation IDs. |
| `session.getConversations({ since?, signal? })` | Load subscriptions and keep conversation keys privately in memory. |
| `session.getHistory(threadId, { since?, days?, signal? })` | Read history and decrypt text with the conversation key. Default history window: 90 days. |
| `session.sendText(threadId, text, options?)` | Encrypt and send one text message. Optional `clientMessageId`, `replyTo` and `signal`. |
| `session.getFeed({ since?, signal? })` | Poll messages, system events and read cursors. |
| `session.watchFeed({ since?, intervalMs?, signal? })` | An optional async generator around feed polling; default interval: 15 seconds. |
| `session.markRead(threadId, { messageId, timestamp? }, options?)` | Submit a read marker; timestamp is the time of reading and defaults to now. |
| `session.close()` | Cancel pending session requests and polling waits, then clear local keys without a server request. |
| `session.logout(options?)` | Ask the server to end the session and clear local keys even if that request fails. |

All request options support `AbortSignal`. The SDK never automatically retries a write. A failed/aborted send may have reached the server; preserve the client message ID and reconcile history before deciding whether to send again. Reusing the ID is not a documented guarantee of server-side deduplication.

Message timestamps are ISO strings rounded to milliseconds. Feed cursors preserve the server's original precision and should be passed back unchanged. A 304 response returns an empty feed and preserves the old cursor when the server supplies no replacement ETag.

`getConversations({ since })` returns updates, not a full cached snapshot. An explicit leave event blocks sending and read markers until an explicit join refreshes that conversation; a stale subscription response cannot reopen it. Group and role memberships remain separate ID lists; this SDK does not expand every directory group into its individual users. Conversation keys are absent from public `raw` records, including nested system events, contacts, preferences and send receipts.

## Message and event limits

Text messages expose a `decryption` state. A missing, corrupt or unsupported conversation key produces an empty `text` and an explicit `missing-key`, `failed` or `unsupported` state. Applications should render an encrypted-message placeholder instead of ciphertext. Some system events have no message/conversation ID and appear only in `feed.events`. System records that do have a normal identity also appear with `isSystem: true`; this package does not render their specialized content.

The observed legacy conversation format is supported when `chat_v` is absent or at most zero. Newer conversation versions are visible with `canSend: false` and are not treated as successfully decrypted. Unknown conversation types and closed conversations cannot be sent to. Server permissions can still change between polling and a send; HTTP acceptance is the authority for that request.

Attachments, reactions, polls, new-conversation creation, presence, typing indicators, calls, notifications registration and the authenticated WebSocket channel are outside this implementation. Event updates use the HTTP feed, which works with a native Fetch broker without opening an additional WebSocket transport.

## Cryptography and transport

The password exchange uses secp256k1 ECDH through the maintained `@noble/curves` package. Session and conversation envelopes use Web Crypto AES-CBC and SHA-256 according to the observed wire format. The SHA-256 bytes beside the IV are an **unkeyed digest, not a MAC**. This protocol must not be described as authenticated encryption or independently verified end-to-end encryption. TLS remains required.

Credentials and keys are held only for the current call/session. The SDK has no persistent storage, credential manager, logging, real-account fixture or tenant-specific default. An application that needs persistent credentials must supply its own deliberate secure-storage workflow. Cookies and ambient browser credentials are omitted from requests. This may limit compatibility if a deployment additionally requires a cookie-based gateway.

## Verification

From the repository root:

```sh
npm install
node --import tsx --test packages/teamwire-sdk/test/*.test.ts
```

Fixtures use Node's native secp256k1 and AES implementations independently of the SDK code. They cover the ECDH contract, encrypted login and owner identity, nested message encryption, decrypted history, calendar and cursor validation, secret redaction, redirect refusal, active cancellation, session isolation, membership changes, immutable permission decisions, unsupported auth/conversations, write errors without retries and accepted-versus-delivered semantics. They do not establish compatibility with a live deployment.

This package contains independently written protocol client code and synthetic data. It does not contain extracted application code or vendor binaries.
