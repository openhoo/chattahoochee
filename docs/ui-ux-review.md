# UI and interaction review

Reviewed on November 4–5, 2026. The review used the actual React workspace in development and production previews, with synthetic data. It covered visual hierarchy, readability, keyboard navigation, dialog behavior, scrolling and responsive layouts.

## Screens and changes

| Screen or state | Improvements and verification |
| --- | --- |
| Welcome and empty live workspace | Clear account setup and demo entry points; larger secondary text; removed the workspace label’s inactive dropdown indicator. |
| Inbox | Readable 14px conversation titles, visible navigation labels, result counts, clearer dates, separate draft previews and more room in search and filters. The rail unread badge sizes to its text and sits clear of the Inbox icon. |
| Search, provider and unread filters | Whitespace is trimmed; empty states explain the active filter; clearing search or filters restores search focus. |
| Pinned conversations | Counts reflect pinned items; empty copy explains how to pin a conversation. |
| People | Readable names and addresses; pending contact actions prevent duplicate starts; successful navigation focuses the composer. |
| Direct and group conversations | 14px message text, improved muted colors, wrapping for long content, explicit delivery labels and clear session-history wording. A subsequent user request modestly reduces bubble padding. |
| Composer and emoji picker | Cursor-aware emoji insertion; Escape and outside dismissal; keyboard focus restoration; a 10,000-character limit; accurate disconnected/unsupported placeholders. |
| Conversation details | Full participant lists; wrapping names and account addresses; tabs reset for a different conversation; View all moves focus into Files. |
| Files, populated and empty | Clear empty states and file metadata; demo files explain that downloads are unavailable. |
| New conversation | Active conversation’s account selected initially; provider/address identify each account; account-scoped counts and empty states; Arrow keys and Enter; readable pending/error states. |
| Account list and demo accounts | Provider, address, connection status and sync counts identify each account; demo accounts remain clearly labeled. |
| Skype setup | Separate advanced login username, automatic discovery guidance, HTTPS discovery validation, readable fields and helpers. |
| Teamwire setup | Server-first setup, explicit HTTPS origin validation and explanation of existing-conversation and authentication limitations. |
| Account setup at limited height | Fields scroll independently; Connect and Cancel remain visible; cancellation clears transient values and restores focus. Browser-only limits are explained before credentials. |
| Appearance | Readable choices, immediate selected-state feedback, light/dark/system behavior and improved contrast. |
| About | Product-oriented copy, preview limitations, keyboard shortcuts, scrolling at limited height and opener restoration. |
| Connection errors and offline accounts | Visible connection guidance and account action; disabled composer communicates why messaging is unavailable. |
| Sign-in service approval | Full HTTPS origin wraps without clipping; copy explains which service receives requests; Cancel receives initial focus and both actions fit the minimum window. |
| Narrow navigation | Back and search shortcuts reveal and focus the inbox; selecting or starting a conversation reveals and focuses its composer. |
| Narrow details and modal handoffs | Full-height 340px drawer; focus trapping and Escape; account-settings handoffs restore a visible workspace control. |

The primary production views were visually reviewed at the normal desktop size and at 980×640. Navigation and modal handoffs were also exercised at 700×800, below the native window’s minimum width. Light and dark themes were checked. No claim of a complete accessibility conformance audit is made.

## Regression checks

The new `tests/e2e/ux.spec.ts` adds 24 scenarios, executed across the five permanent browser projects. The complete suite now defines 77 scenarios / 385 checks. It covers contextual empty states, isolated draft previews, trimmed searches, emoji cursor/dismissal behavior, readable text sizes, opener restoration, details focus trapping and tab reset, contact navigation and narrow-window handoffs.

The final local `npm run check` passed typecheck, 188 TypeScript tests and the production build. The padding-adjusted implementation also passed all 385 hosted browser checks in [run 41929070879](https://github.com/openhoo/chattahoochee/actions/runs/41929070879). [Verification](verification.md) ties the completed browser, desktop-build and CodeQL workflows, plus the final native smoke evidence, to implementation `9ce57c4`. Previous native and protocol tests remain in the same workflows.

The first expanded production matrix passed 376 checks and found nine failures across three details-drawer scenarios. Production CSS optimization had removed the drawer's individual `translate: none` reset while retaining the centered dialog's translation, placing half the panel above the viewport. Resetting the translation through the existing Tailwind utilities fixed the production layout. The retained minimum-layout test now checks drawer bounds and the Close/Pin controls before clicking. Implementation `77656a7f2b517eb4f2537d4b4e15f4b446dc0309` then passed all 385 checks in [run 41925864319](https://github.com/openhoo/chattahoochee/actions/runs/41925864319).

A user browser comment also identified a clipped unread number. Its 15px fixed badge had only 11px of space inside the borders, while its inherited line height was 16.5px. Published fix [`5783fa7aaec74498d9a7cc56e51acec65efd6069`](https://github.com/openhoo/chattahoochee/commit/5783fa7aaec74498d9a7cc56e51acec65efd6069) gives the badge explicit line height, content padding and a 20px minimum. The existing readability test now verifies actual text bounds, rail containment and clearance from the icon. Manual React-state checks covered unread totals of 1, 12 and 123 at 1360px, 980px and 700px; the rail intentionally displays `9+` for totals above nine, and its accessible name retains the full count. The badge revision then passed all 385 browser checks in [run 41927555974](https://github.com/openhoo/chattahoochee/actions/runs/41927555974).

Read and failed-delivery labels have theme-specific text colors. Calculated contrast against the transcript background is 5.00:1 and 5.19:1 in light mode, and 8.47:1 and 8.25:1 in dark mode. This verifies those foreground/background pairs, not every color in the application.

## Requested message spacing

The user confirmed that the bubbles had already looked this way before the review and requested a modest reduction in padding. The follow-up reduces each padding edge by 2px:

| Layout | Previous vertical / horizontal padding | Requested vertical / horizontal padding |
| --- | --- | --- |
| Normal, 761–1599px wide | 11px / 14px | 9px / 12px |
| Large, at least 1600px wide | 13px / 16px | 11px / 14px |
| Narrow, up to 760px wide | 10px / 12px | 8px / 10px |

Message text remains 14px with the existing line height and corner radii. This spacing adjustment is published as [`9ce57c4864bce9201b68867c47e0d8b824505c38`](https://github.com/openhoo/chattahoochee/commit/9ce57c4864bce9201b68867c47e0d8b824505c38). Its hosted results and rebuilt native ZIP are recorded in [verification](verification.md#follow-up-publication-record).

Production measurements checked incoming, outgoing, multiline and attachment bubbles at 700px, 980px, 1360px and 1600px across light and dark themes. The padding matched the requested values, with no horizontal overflow in the measured bubbles or page. The normal single-line bubble is about 43px high, 4px shorter than before. The measurements are retained in `artifacts/ui-ux-bubble-padding-measurements.json`.

## Additional manual states

An ignored local harness rendered the actual `AppShell` with synthetic callbacks, without a transport connection. It verified all five delivery labels in light/dark themes, error and offline banners, disabled composing, and the sign-in service approval at 1360×900 and 980×640. A synthetic account completed connecting while New conversation remained open; the dialog selected the newly connected account and displayed its contact without reopening. This check also confirmed the account reconciliation fix without making an enterprise request. The harness and its screenshots remain under `artifacts/` and are not shipped in the production app.

An earlier unsigned macOS bundle at `e4933d3e161698a57c4d530b13ce9fd988499886` was rebuilt and launched through its packaged `tauri://localhost` frontend. Focused native checks passed for Skype/Teamwire setup, cancellation focus, Enter-to-send in the local demo, the current-account default in New conversation, contact-to-composer focus and emoji Escape dismissal. The same focused checks passed again on the padding-adjusted `9ce57c4` native app; the visible unread badge and demo-send preview were also checked. The current native verification and ZIP are recorded separately in [verification](verification.md#follow-up-publication-record).

## Screenshots

The README images were refreshed from the production preview at 1360×900. They contain synthetic contacts and messages only.

![Light conversation workspace](images/chat-light.jpg)

![Dark conversation workspace](images/chat-dark.jpg)

![Account-scoped new conversation](images/new-conversation.jpg)

## Limits

The review did not authenticate to an enterprise service or send real provider messages. Browser demo tests cannot establish live interoperability. Audio, video, screen sharing and file transfers still require compatible backends. Windows interactive runtime and assistive-technology acceptance require separate verification. Account state and drafts remain in memory for the current session.
