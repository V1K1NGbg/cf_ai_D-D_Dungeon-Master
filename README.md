# 🏰 D&D AI Server (Text-Only, Multiplayer)

## 📖 Overview

This project is a **Cloudflare Workers AI application** that hosts a multiplayer, text-only Dungeons & Dragons campaign.  
An AI Dungeon Master (DM) powered by **Llama 3.3 on Workers AI** narrates adventures, resolves dice rolls, and manages combat.  
Players join sessions via a simple **chat interface (Cloudflare Pages)**, and the game state is persisted using **Durable Objects**.

---

## ⚙️ Architecture

### Components

- **Workers AI (LLM)**  
  - Model: `@cf/meta/llama-3.3-70b-instruct-fp8-fast`  
  - Role: Acts as Dungeon Master (storytelling, rules, dice rolls).

- **Durable Objects (SessionCoordinator)**  
  - Manages multiplayer sessions.  
  - Tracks players, stats, inventories, combat state, and chat history.  
  - Persists state across turns and sessions.

- **Cloudflare Workers (API Layer)**  
  - Routes:  
    - `/api/session/join` → Register player.  
    - `/api/session/action` → Player submits action.  
    - `/api/session/state` → Retrieve session state.  
    - `/api/sessions` → List all sessions.  
    - `/api/sessions/clear` → Clear all sessions (admin).  

- **Cloudflare Pages (Frontend)**  
  - Text-only chat UI.  
  - Players type actions and see DM responses.  
  - Supports multiple players in the same session.

---

## 🧠 Memory & State

- **Player State**: HP, inventory, name, ID.  
- **Combat State**: Active flag, enemies, turn order, current turn index.  
- **Messages**: Log of player actions and DM responses.  
- **Persistence**: Durable Object storage ensures continuity across sessions.

---

## 🎲 Game Flow

1. **Player joins session** → Registered in Durable Object.  
2. **Player submits action** → Sent to Worker API.  
3. **Worker calls Llama 3.3** → Generates DM narration.  
4. **Durable Object updates state** → HP, combat, logs.  
5. **Response broadcast** → All players see updated story in chat.

---

## 📝 API Specs

### `POST /api/session/join`

Registers a new player in a session.

**Request Body**:

```json
{
  "sessionId": "string",
  "playerId": "string",
  "name": "string"
}
```

**Response**:

```json
{
  "messages": [ ... ],
  "players": [ ... ]
}
```

### `POST /api/session/action`

Submits a player action to the session.
**Request Body**:

```json
{
  "sessionId": "string",
  "playerId": "string",
  "playerAction": "string"
}
```

**Response**:

```json
{
  "result": "string",
  "thinking": "string",
  "reset": false,
  "state": { ... }
}
```

### `GET /api/sessions`

Lists all active sessions.

**Response**:

```json
{
  "sessions": [ "session1", "session2", ... ]
}
```

### `POST /api/sessions/clear`

Clears all sessions (admin action).

**Response**:

```json
{
  "ok": true
}
```

## Getting started with wrangler

```bash
npm install
npm run dev
wrangler publish
```

### Testing

Run the test suite with:

```bash
npx vitest run
```

## Additional Documentation

For more detailed technical specifications, see `specifications/project-overview.md`.
