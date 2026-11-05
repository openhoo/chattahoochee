# Preview verification

Verified on November 5, 2026 for the Chattahoochee 0.1.0 local preview.

## Skypeforhoo 0.2.1 upgrade

The current SDK integration is published in commit [`917729f933804448f9942ce95e9e91b075d5ba7e`](https://github.com/openhoo/chattahoochee/commit/917729f933804448f9942ce95e9e91b075d5ba7e). The application and npm lockfile pin the official [Skypeforhoo v0.2.1 release](https://github.com/openhoo/skypeforhoo/releases/tag/v0.2.1), published on November 4, 2026. The downloaded package matches the release checksum, and its SHA-512 matches the npm lockfile integrity field.

Package SHA-256: `3703f1f897fa037b3eee5c52143c7593bf115890e6c298269845dd30bbd9eb51`.

The upgrade includes authentication challenge parsing and session lifecycle fixes. A new application integration regression passes a quoted Bearer realm containing misleading `MsRtcOAuth` text through the real store, connector, SDK and native Fetch bridge fixture. It verifies that no password request or application registration occurs, errors remain sanitized, native requests finish, and the account scope is removed exactly once.

| Check | Result | Scope and evidence |
| --- | --- | --- |
| Local TypeScript check, tests and production build | Passed | 189 tests, zero failures, skips or cancellations; `artifacts/skypeforhoo-v0.2.1/app-check-final.log` |
| Core coverage, local and hosted | Passed | 97.14% lines, 88.13% branches and 94.02% functions; matching Node 26 local and Node 24 hosted results; the existing 95% / 85% / 90% gates remain enforced |
| Browser E2E | Passed | [Run 41976778599](https://github.com/openhoo/chattahoochee/actions/runs/41976778599): 385 passed, zero failures, skips or errors; 77 passes in each of the five browser/layout projects |
| Desktop builds | Passed | [Run 41976778547](https://github.com/openhoo/chattahoochee/actions/runs/41976778547): 189 TypeScript tests and 21 Rust tests on each OS, zero failures or skips; macOS app and Windows NSIS preview installer |
| CodeQL | Completed successfully | [Run 41976777494](https://github.com/openhoo/chattahoochee/actions/runs/41976777494): JavaScript/TypeScript, Rust, Actions and Python analysis jobs |
| Local macOS bundle and native smoke | Passed | Rebuilt unsigned Apple Silicon app, packaged frontend, both account setup forms, cancellation focus and local Enter-to-send with updated inbox preview |
| Local production browser preview | Passed | New production bundle loaded the synthetic workspace without console errors or warnings |

The desktop workflow uploaded `Chattahoochee-macOS-preview` and `Chattahoochee-Windows-preview`; both contain unsigned preview builds. The current local package and smoke evidence are retained under `artifacts/skypeforhoo-v0.2.1/`: `Chattahoochee.app`, `Chattahoochee-0.1.0-macos-arm64.zip`, `desktop-build.log`, `native-smoke.png` and `app-update-verification.json`. The ZIP SHA-256 is `8c65cc2a0c959f27825f79ab7e49cf4567fd8d5a6ad0c28676df4fdff51be3b9`. Hosted logs, JUnit, coverage and run/artifact metadata are collected separately under `artifacts/ci-evidence/917729f/`.

The smoke checks use local synthetic data. Live enterprise authentication, actual provider delivery, native audio/video/screen transmission and interactive Windows runtime remain unverified.

## Previous UI verification

The previous hosted matrix covers implementation `9ce57c4864bce9201b68867c47e0d8b824505c38`, including the UI review, drawer and unread-badge repairs, and the requested bubble-padding reduction. The counts, native smoke evidence and local ZIP digest in this historical section are tied to that implementation with Skypeforhoo 0.2.0.

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript | Passed | Application, SDK, connectors and tests |
| TypeScript tests | 188 passed | 77 Teamwire SDK/connector outcomes, 41 Skype connector/normalization outcomes, 30 native bridge, 40 store; counts include named subtests; passed on hosted macOS and Windows |
| Core TypeScript coverage | Passed | 97.14% lines, 88.13% branches, 94.02% functions; matching local Node 26.13.0 and hosted Node 24 results |
| Coverage gates | Passed | At least 95% lines, 85% branches and 90% functions for the combined instrumented scope |
| Browser E2E matrix | 385 passed | 77 scenarios across five configurations; zero failures, skips or retries |
| Frontend production build | Passed | Vite production output |
| Rust formatting | Passed | Native project |
| Rust tests | 21 passed per OS | Broker validation, request lifecycle and real synthetic loopback HTTP boundaries; passed on hosted macOS and Windows |
| Rust native check | Passed | macOS host |
| Embedded frontend check | Passed | Packaged custom protocol |
| macOS release bundle | Passed | Unsigned Apple Silicon app |
| Windows release bundle | Passed | Unsigned NSIS installer built by hosted CI; interactive runtime not tested |

### Published implementation and CI evidence

The final hosted verification covers commit [`9ce57c4864bce9201b68867c47e0d8b824505c38`](https://github.com/openhoo/chattahoochee/commit/9ce57c4864bce9201b68867c47e0d8b824505c38). These completed runs target that exact revision:

| Workflow | Result | Evidence |
| --- | --- | --- |
| Browser E2E | Passed | [Run 41929070879](https://github.com/openhoo/chattahoochee/actions/runs/41929070879): 188 TypeScript tests, coverage gates and all 385 browser checks passed |
| Desktop builds | Passed | [Run 41929070749](https://github.com/openhoo/chattahoochee/actions/runs/41929070749): 188 TypeScript tests and 21 Rust tests on each OS, frontend builds, formatting and preview artifacts for macOS and Windows |
| CodeQL | Completed successfully | [Run 41929070125](https://github.com/openhoo/chattahoochee/actions/runs/41929070125): Actions, JavaScript/TypeScript, Python and Rust analysis jobs |

The desktop workflow uploaded `Chattahoochee-macOS-preview` containing the app ZIP and `Chattahoochee-Windows-preview` containing the x64 NSIS installer. Both are unsigned preview builds. The earlier protocol implementation, [`4b683106a84980962f83202986bda7231975b0a8`](https://github.com/openhoo/chattahoochee/commit/4b683106a84980962f83202986bda7231975b0a8), passed its original 265-check matrix in [run 41914876012](https://github.com/openhoo/chattahoochee/actions/runs/41914876012).

### Follow-up publication record

The unread-badge fix was published as [`5783fa7aaec74498d9a7cc56e51acec65efd6069`](https://github.com/openhoo/chattahoochee/commit/5783fa7aaec74498d9a7cc56e51acec65efd6069). It gives the pill explicit line height and room for its text and adds text-bound checks to the existing readability scenario. Manual React-state checks covered unread totals of 1, 12 and 123 at 1360px, 980px and 700px. The displayed count remains capped at `9+`, with the complete count in the accessible name.

The user also requested a modest reduction in the existing message bubbles, published as [`9ce57c4864bce9201b68867c47e0d8b824505c38`](https://github.com/openhoo/chattahoochee/commit/9ce57c4864bce9201b68867c47e0d8b824505c38): padding changes from 11px / 14px to 9px / 12px normally, from 13px / 16px to 11px / 14px at widths of at least 1600px, and from 10px / 12px to 8px / 10px at widths up to 760px. Text size, line height and corner radii retain their existing values. See the [UI review](ui-ux-review.md#requested-message-spacing) for the request and layout table.

All three workflows above completed successfully for this implementation. Browser JUnit confirms 385 passed / 0 failed / 0 skipped / 0 errors, with 77 passes in each project. CodeQL success means all analysis jobs completed; it does not establish that there are zero findings. Local packaged-app smoke checks also passed for the same implementation.

| Local native evidence | Result |
| --- | --- |
| Packaged macOS smoke | Passed: packaged frontend, account setup/cancel focus, unread badge, local Enter-to-send, current-account new chat, contact focus and emoji Escape; `artifacts/ui-ux-native-verification.json` and `artifacts/ui-ux-native-padding-smoke.png` |
| Rebuilt unsigned macOS ZIP | `artifacts/Chattahoochee-0.1.0-macos-arm64.zip` |
| ZIP SHA-256 | `ddaca38b8507b229057d796c120a1540030699edee10678b687897061586a24a` |

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

The protocol implementation's hosted run passed all 265 checks in 3.5 minutes, with no failures, skipped checks or retries. The UI review adds 24 scenarios to the permanent suite, for 77 scenarios / 385 checks across the same five projects.

The first expanded run at `e4933d3e161698a57c4d530b13ce9fd988499886`, [41923061152](https://github.com/openhoo/chattahoochee/actions/runs/41923061152), passed 376 checks and failed nine checks across three details scenarios. Production CSS optimization dropped the individual `translate: none` reset, leaving the dialog's centering translation active and placing half the drawer above the viewport. Revision `77656a7f2b517eb4f2537d4b4e15f4b446dc0309` resets translation through the Tailwind utilities; its minimum-layout scenario also checks the drawer and Close/Pin bounds before clicking. All 385 checks then passed in run [41925864319](https://github.com/openhoo/chattahoochee/actions/runs/41925864319).

The same drawer-repair revision passed its desktop build and CodeQL workflows in runs [41925864760](https://github.com/openhoo/chattahoochee/actions/runs/41925864760) and [41925862863](https://github.com/openhoo/chattahoochee/actions/runs/41925862863). The badge revision `5783fa7` also passed all 385 checks in [run 41927555974](https://github.com/openhoo/chattahoochee/actions/runs/41927555974), desktop builds in [41927555889](https://github.com/openhoo/chattahoochee/actions/runs/41927555889), and CodeQL in [41927555250](https://github.com/openhoo/chattahoochee/actions/runs/41927555250).

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
- Contextual search/provider/unread empty states explain the active filter; clearing search and filters restores focus to the search field.
- Each conversation's unsent draft is identified in its inbox preview without altering the transcript or another conversation's draft.
- Emoji insertion uses the cursor and restores the typing position; Escape and outside clicks dismiss the picker.
- About, New conversation and details restore their opener. The minimum-width details drawer traps focus, and handoffs to account settings restore a visible workspace control.
- New conversation selects the active conversation's account, scopes contacts by account and supports Arrow keys and Enter.
- At 700×800, Back and the search shortcut reveal and focus the inbox; selecting or starting a conversation reveals and focuses its composer.

The README's 1360×900 light/dark workspace and New conversation images show the production preview with synthetic contacts and messages. All three were visually inspected. The [UI review](ui-ux-review.md) records the screen-by-screen changes, contrast measurements and additional synthetic delivery/error/origin-approval states.

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

The earlier UI implementation at `e4933d3e161698a57c4d530b13ce9fd988499886` was rebuilt and launched again through its packaged frontend. Focused native smoke checks passed for the scrolling Skype/Teamwire forms and fixed action footer, cancellation focus, Enter-to-send, the active Teamwire account default in New conversation, contact-to-composer focus and emoji Escape dismissal. That earlier smoke record is retained as `artifacts/ui-ux-native-verification-e4933d3.json` and `artifacts/ui-ux-native-smoke.png`; its recorded `Chattahoochee-0.1.0-macos-arm64.zip` SHA-256 was `f0e27122f3b89c71df6470399c87d5717919584853c683ba93cfbda249cc1610`. The padding-adjusted implementation at `9ce57c4864bce9201b68867c47e0d8b824505c38` was then rebuilt and launched through its packaged frontend. Focused checks passed for Skype/Teamwire setup, cancellation focus, the visible Inbox unread badge, Enter-to-send with an updated inbox preview, the current Teamwire account default in New conversation, contact-to-composer focus and emoji Escape dismissal. Its UI smoke record remains `artifacts/ui-ux-native-verification.json`, with screenshot `artifacts/ui-ux-native-padding-smoke.png`; its ZIP digest is recorded in the previous UI verification section.

## Remaining qualification

- No live enterprise authentication, real messages or provider interoperability were tested.
- The macOS and Windows CI desktop jobs completed successfully for the SDK upgrade at `917729f933804448f9942ce95e9e91b075d5ba7e`. Windows interactive runtime remains unverified.
- Compatible audio, video, screen sharing and attachment-transfer backends remain unimplemented.
- The macOS preview is unsigned and has not gone through public distribution signing or notarization.
- Account state, credentials, messages and drafts are in memory; reopening the application requires reconnecting.
- A GLib advisory remains unresolved in the cross-platform lockfile. See the [dependency audit](dependency-audit.md) for the affected Linux graph, macOS target check and Windows manifest evidence. It has not been suppressed or claimed fixed.

See the README for additional provider-specific preview limits.
