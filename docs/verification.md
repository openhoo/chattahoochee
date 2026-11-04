# Preview verification

Verified on November 4, 2026 for the Chattahoochee 0.1.0 local preview.

## Automated checks

| Check | Result | Scope |
| --- | --- | --- |
| TypeScript | Passed | Application, SDK, connectors and tests |
| TypeScript tests | 71 passed | 19 Teamwire SDK, 18 native bridge, 15 Teamwire connector, 6 Skype connector, 10 store, 3 Skype normalization |
| Frontend production build | Passed | Vite production output |
| Rust formatting | Passed | Native project |
| Rust tests | 7 passed | Native broker validation and request lifecycle |
| Rust native check | Passed | macOS host |
| Embedded frontend check | Passed | Packaged custom protocol |
| macOS release bundle | Passed | Unsigned Apple Silicon app |

Protocol integration tests use encrypted synthetic fixtures and the real SDK, connector, store and native Fetch bridge code. They establish behavior under those fixtures; they do not establish compatibility with a live enterprise deployment.

## Browser verification

The production preview was exercised with synthetic data:

- Conversation switching clears the previous transcript and preserves separate drafts.
- Enter sends, Shift+Enter inserts a newline, and emoji insertion works.
- Provider, unread, pinned and search filters work.
- Contacts, account-scoped new chat, conversation details and file tabs work.
- Leaving the demo removes its sample accounts and conversations.
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
- The demo displayed both providers and the conversation details panel.
- Sending a local demo message rendered it in the timeline and updated the inbox preview.
- Audio, video, screen sharing and file-transfer controls remained disabled.

Local screenshots and the unsigned app/ZIP are retained in the ignored `artifacts/` directory. They are not part of the source publication.

## Remaining qualification

- No live enterprise authentication, real messages or provider interoperability were tested.
- The Windows workflow is prepared; no Windows build or runtime result is claimed.
- Compatible audio, video, screen sharing and attachment-transfer backends remain unimplemented.
- The macOS preview is unsigned and has not gone through public distribution signing or notarization.
- Account state, credentials, messages and drafts are in memory; reopening the application requires reconnecting.

See the README for additional provider-specific preview limits.
