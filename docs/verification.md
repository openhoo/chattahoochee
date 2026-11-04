# Preview verification

Verified on November 4, 2026 for the Chattahoochee 0.1.0 local preview.

## Automated checks

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript | Passed | Application, SDK, connectors and tests |
| TypeScript tests | 188 passed | 77 Teamwire SDK/connector outcomes, 41 Skype connector/normalization outcomes, 30 native bridge, 40 store; counts include named subtests |
| Core TypeScript coverage | Passed | 97.14% lines, 88.13% branches, 94.02% functions; matching local Node 26.13.0 and hosted Node 24 results |
| Coverage gates | Passed | At least 95% lines, 85% branches and 90% functions for the combined instrumented scope |
| Browser E2E matrix | 265 passed | 53 scenarios across five configurations; zero failures, skips or retries |
| Frontend production build | Passed | Vite production output |
| Rust formatting | Passed | Native project |
| Rust tests | 21 passed | Broker validation, request lifecycle and real synthetic loopback HTTP boundaries |
| Rust native check | Passed | macOS host |
| Embedded frontend check | Passed | Packaged custom protocol |
| macOS release bundle | Passed | Unsigned Apple Silicon app |
| Windows release bundle | Passed | Unsigned NSIS installer built by hosted CI; interactive runtime not tested |

### Published implementation and CI evidence

These completed runs all tested implementation commit [`4b683106a84980962f83202986bda7231975b0a8`](https://github.com/openhoo/chattahoochee/commit/4b683106a84980962f83202986bda7231975b0a8):

| Workflow | Result | Evidence |
| --- | --- | --- |
| Browser E2E | Passed | [Run 41914876012](https://github.com/openhoo/chattahoochee/actions/runs/41914876012): 188 TypeScript tests, coverage gates and 265 E2E checks |
| Desktop builds | Passed | [Run 41914876096](https://github.com/openhoo/chattahoochee/actions/runs/41914876096): native tests and preview artifacts for macOS and Windows |
| CodeQL | Completed successfully | [Run 41914875562](https://github.com/openhoo/chattahoochee/actions/runs/41914875562): Actions, JavaScript/TypeScript, Python and Rust analysis jobs |

Protocol integration tests use encrypted synthetic fixtures and the real SDK, connector, store and native Fetch bridge code. They establish behavior under those fixtures; they do not establish compatibility with a live enterprise deployment.

The coverage scope is `src/model/**`, `src/connectors/**`, `src/lib/native-transport.ts` and `packages/teamwire-sdk/src/**`. React views and Rust are outside this percentage. The app's external `skypeforhoo` dependency is exercised by integration fixtures but is not included in this repository's instrumented source coverage. `npm run test:coverage` writes `artifacts/coverage/lcov.info` and `summary.json` and fails if any combined threshold is missed.

## Expanded regression coverage

- Skype discovery fallback, separate advanced login username, approved service origins, OAuth failure redaction, malformed resources, incoming invitations and cancellation.
- Skype and Teamwire operation IDs, native receipt aliases and early echoes stay bound to the correct account and conversation. Incoming messages cannot inherit outgoing receipt aliases.
- Confirmed recipient delivery/read proof survives message reconciliation. Replays and canonical message replacements do not increase unread counts twice.
- Deleted or left conversations stop accepting sends/typing. Isolated Skype invitation failures preserve the existing live account; terminal synchronization failures disable writes and settle unconfirmed messages.
- Teamwire requires a human owner identity, isolates cached permissions from returned objects, stages subscription batches atomically, redacts key fields and rejects invalid cursors, timestamps and cross-thread history.
- Logout cancels active setup, polls, history and sends. Delayed completion/errors cannot recreate live data or notices in a later demo workspace. Concurrent cleanup runs once.
- Unsafe service URLs are rejected before account state or native transport is created, preventing embedded URL credentials from reaching account snapshots.
- Native Fetch aborts reject promptly even if cancellation acknowledgements or IPC completion are delayed. Body buffering is bounded, source streams are cancelled, and request bytes survive reused producer buffers.
- Real loopback HTTP tests cover redirect credential containment, binary requests/responses, duplicate authentication challenges, exact 10 MiB/20 MiB boundaries, deadlines and native account/request/header limits.

## Browser verification

Permanent production-frontend E2E projects:

| Project | Viewport |
| --- | --- |
| Chromium | 1360×900 |
| Firefox | 1360×900 |
| WebKit | 1360×900 |
| Chromium minimum | 980×640 |
| WebKit minimum | 980×640 |

The first full matrix run found 35 failures across seven repeated scenarios: demo state reset, provider form isolation, two cancellation paths, OS theme label updates, settings focus restoration, and a test locator for the account selector. It passed 230 checks. The six product regressions were reproduced and fixed; the selector now targets the correctly named accessible combobox. The tests were retained.

The final hosted run passed all 265 checks in 3.5 minutes, with no failures, skipped checks or retries.

Each test receives a clean browser context. The common fixture blocks and fails any request outside the local preview origin, and checks browser console errors and uncaught exceptions. Failure screenshots, videos, traces, HTML reports, JUnit and coverage reports are uploaded by the Browser E2E workflow. New contexts created explicitly by the context-isolation scenario also load only the local preview.

The production preview was exercised with synthetic data:

- Conversation switching clears the previous transcript and preserves separate drafts.
- Enter sends, Shift+Enter inserts a newline, and emoji insertion works.
- Provider, unread, pinned and search filters work.
- Contacts, account-scoped new chat, conversation details and file tabs work.
- Leaving the demo removes its sample accounts and conversations.
- Reopening the demo also clears drafts, search and filters from the previous demo.
- Provider switch, cancel and close clear account form values and restore hidden-password mode.
- Settings traps keyboard focus and restores focus to the control that opened it.
- System appearance updates both document colors and the theme toggle's label.
- A browser preview rejects live account connections with a desktop-app requirement.
- The 980×760 layout uses a dismissible details drawer, with no horizontal overflow or obscured Send control.
- The 1227×900 layout keeps details beside the transcript, with no horizontal overflow or Send overlap.

The README's 1280×720 light and dark images show the production preview with synthetic contacts and messages. Both were visually inspected after jumping to the latest message.

## Packaged macOS verification

The actual release bundle was launched and inspected through the native interface:

- The packaged `tauri://localhost` frontend opened successfully.
- The welcome screen showed an empty live workspace.
- Skype setup exposed the sign-in address, separate advanced login username, password and server settings.
- Teamwire setup exposed the explicit HTTPS server field.
- Switching providers cleared transient server, advanced username and password values and restored hidden-password mode.
- Cancelling and reopening account setup left an empty, hidden password field.
- Escape closed settings and restored keyboard focus to **Workspace settings**.
- The demo displayed both providers and the conversation details panel.
- Sending local demo messages with Send and Enter rendered them in the timeline and updated the inbox preview.
- Leaving and reopening the demo cleared a previous draft.
- Audio, video, screen sharing and file-transfer controls remained disabled.

Local screenshots and the unsigned app/ZIP are retained in the ignored `artifacts/` directory. They are not part of the source publication.

These checks were repeated on the rebuilt app after the expanded regressions and fixes, following the macOS unlock. Setup used disposable synthetic strings without submitting a login. The updated production browser UI was separately exercised for sending a local demo message and clearing a draft across demo exit/reopen.

## Remaining qualification

- No live enterprise authentication, real messages or provider interoperability were tested.
- The macOS and Windows CI desktop jobs completed successfully for the implementation commit linked above. Windows interactive runtime remains unverified.
- Compatible audio, video, screen sharing and attachment-transfer backends remain unimplemented.
- The macOS preview is unsigned and has not gone through public distribution signing or notarization.
- Account state, credentials, messages and drafts are in memory; reopening the application requires reconnecting.
- A GLib advisory remains unresolved in the cross-platform lockfile. See the [dependency audit](dependency-audit.md) for the affected Linux graph, macOS target check and Windows manifest evidence. It has not been suppressed or claimed fixed.

See the README for additional provider-specific preview limits.
