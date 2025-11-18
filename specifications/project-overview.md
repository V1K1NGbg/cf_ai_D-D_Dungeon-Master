# Project Overview

The D&D AI Server is a Cloudflare Workers deployment that pairs a durable multiplayer session backend with a lightweight Pages-hosted chat UI. Players join text-only adventures that are narrated in real time by Workers AI running Llama 3.3. Durable Objects keep every table-top session isolated and persistent, while a global registry tracks discoverable sessions for the lobby UI.

## High-Level Architecture

| Layer | Responsibility | Key Files |
| --- | --- | --- |
| Cloudflare Worker (API) | Validates HTTP payloads, proxies to Durable Objects, serves static assets | `src/index.ts` |
| Durable Object: `SessionCoordinator` | Owns a single session's state: players, combat, transcript, AI calls | `src/session.ts` |
| Durable Object: `SessionRegistry` | Tracks the set of active session IDs, supports list and administrative actions | `src/session.ts` |
| Workers AI (Llama 3.3) | Generates DM narration with retry/backoff and graceful degradation | `src/session.ts` |
| Cloudflare Pages Frontend | Minimal chat UI that drives the API routes | `src/public/*` |

### Request Flow

1. Browser calls an `/api/...` route from the UI.
2. The Worker validates the payload (`src/api-validation.ts`), looks up the correct Durable Object, and forwards an internal request.
3. The `SessionCoordinator` Durable Object loads state from storage, applies the mutation (join/action/state), possibly invokes Workers AI, then persists the new snapshot.
4. Updates propagate back to the client, which hydrates the UI.

### Durable Object Interactions

- `SessionCoordinator` ensures only one instance per `sessionId` by naming the Durable Object using `SESSION_COORDINATOR.idFromName(sessionId)`.
- The coordinator lazily registers itself with the `SessionRegistry` when the first player joins and removes itself after idle cleanup.
- `SessionRegistry` stores a serialized `Set<string>` for quick lobby listing and provides `list`, `add`, `remove`, and `clear` operations for admin hotkeys.

## Session Lifecycle

1. **Join**: Creates or updates a player entry, records lobby messages, and registers the session globally.
2. **Action**: Builds a `SessionContext`, calls `DungeonMasterService.narrate`, applies inferred damage via `EffectResolver`, updates combat state, then returns the enriched transcript and players.
3. **State Polling**: Returns a trimmed snapshot for rendering player dropdowns and historical log.
4. **Idle Cleanup**: If no activity occurs for 30 minutes, the Durable Object flushes state, unregisters, and frees storage until the next request.

## AI Dungeon Master Strategy

- Uses `DungeonMasterService` with configurable `maxAttempts` and `backoffMs` to absorb transient AI failures (timeouts, 5xx, network issues).
- Combines a system prompt rooted in D&D 5e guidance with a structured summary built by `summarize()` to provide the model with combat state and roster.
- If all retries fail, returns a friendly fallback line and marks the response as `degraded` so the UI could surface a banner.

## Frontend Hooks

- `src/public/index.html` drives lobby selection, per-session player rosters, chat history rendering, and admin actions such as "Clear Sessions".
- The UI hydrates messages with `hydrateMessages`, toggles between lobby/chat experiences, and integrates DM reasoning markup by parsing `<thinking>` blocks.
- Basic optimistic UI is used for player actions: messages show immediately while the Worker request is in-flight; errors trigger DM-style notifications.

## Testing and Tooling

- Unit and integration coverage lives in `test/index.spec.ts`, powered by `vitest` and `cloudflare:test` helpers for Durable Object bindings.
- Tests mock Workers AI, Durable Objects, and ensure failure modes (invalid payloads, simulated outages) respond with well-defined status codes.
- Run `npx vitest run` locally to execute the full suite.

## Operational Considerations

- **Observability**: `safeFetch` logs Durable Object invocation errors; additional instrumentation can be layered via `ctx.waitUntil` if needed.
- **Backpressure**: The AI retries include linear backoff (`backoffMs`) to reduce pressure during partial outages.
- **Extensibility**: `SessionCoordinator` exposes helpers `startCombat` and `nextTurn` for future UI enhancements without modifying persistence primitives.

Use this document as the canonical system design reference when onboarding contributors, planning feature work, or assessing impact of architectural changes.
