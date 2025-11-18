import { Env } from "./index";
import { ActionPayload, JoinPayload } from "./api-types";
import { isActionPayload, isJoinPayload } from "./api-validation";

// Constants
const JSON_HEADERS = { "Content-Type": "application/json" } as const;
const SESSION_IDLE_TIMEOUT_MS = 1000 * 60 * 30; // 30 minutes
const DM_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast" as const;
const FALLBACK_DM_TEXT = "Sorry, the AI service is unavailable. Please try again later." as const;
const IS_LOCAL_DEV = typeof (globalThis as any).MINIFLARE !== "undefined";

// Interfaces
interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

export interface Player {
  id: string;
  name: string;
  hp: number;
  inventory: string[];
}

export interface Message {
  actor: string;
  content: string;
  ts: number;
}

export interface CombatState {
  active: boolean;
  turnOrder: string[];
  currentTurnIndex: number;
  enemies: { name: string; hp: number }[];
}

export interface SessionSnapshot {
  players: [string, Player][];
  messages: Message[];
  combat: CombatState;
  lastActivity: number;
  sessionId?: string;
}

interface SessionContext {
  players: Player[];
  messages: Message[];
  combat: CombatState;
}

interface DungeonMasterOptions {
  maxAttempts?: number;
  backoffMs?: number;
}

interface NarrationResult {
  text: string;
  thinking: string;
  degraded: boolean;
}

// Utility functions
/**
 * Provide a pristine combat template so resets never mutate shared references.
 */
const defaultCombatState = (): CombatState => ({
  active: false,
  turnOrder: [],
  currentTurnIndex: 0,
  enemies: [],
});

/**
 * Thin wrapper over Durable Object storage that hides serialization details.
 */
export class StorageManager {
  constructor(private readonly storage: Storage) {}

  async loadSessions(): Promise<Set<string>> {
    const stored = await this.storage.get<string[]>("sessions");
    return stored ? new Set(stored) : new Set();
  }

  async saveSessions(sessions: Set<string>): Promise<void> {
    await this.storage.put("sessions", Array.from(sessions));
  }

  async loadSession(): Promise<SessionSnapshot | undefined> {
    return await this.storage.get<SessionSnapshot>("session");
  }

  async saveSession(data: SessionSnapshot): Promise<void> {
    await this.storage.put("session", data);
  }
}

/**
 * Fire-and-forget helper used by SessionCoordinator to keep the registry in sync.
 */
class RegistryClient {
  constructor(private readonly namespace: DurableObjectNamespace) {}

  async add(sessionId: string): Promise<void> {
    await this.safeCall("add", sessionId);
  }

  async remove(sessionId: string): Promise<void> {
    await this.safeCall("remove", sessionId);
  }

  private async safeCall(path: string, sessionId: string): Promise<void> {
    try {
      const id = this.namespace.idFromName("global");
      const stub = this.namespace.get(id);
      await stub.fetch(`http://internal/${path}`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId }),
      });
    } catch (error) {
      console.error(`Registry ${path} failed`, error);
    }
  }
}

/**
 * Encapsulates the AI Dungeon Master calls, including retries and prompt curation.
 */
export class DungeonMasterService {
  private readonly maxAttempts: number;
  private readonly backoffMs: number;

  constructor(private readonly ai: Ai, options: DungeonMasterOptions = {}) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 2);
    this.backoffMs = Math.max(0, options.backoffMs ?? 250);
  }

  async narrate(context: SessionContext, player: Player, playerAction: string): Promise<NarrationResult> {
    // Retry transient failures a limited number of times before falling back.
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const attemptNumber = attempt + 1;
      this.logAiAttempt("request", attemptNumber, {
        model: DM_MODEL,
        playerId: player.id,
        playerName: player.name,
        actionPreview: playerAction.slice(0, 160),
        playerCount: context.players.length,
        messageCount: context.messages.length,
        enemyCount: context.combat.enemies.length,
      });

      const startedAt = Date.now();
      try {
        const ai = await this.ai.run(DM_MODEL as any, {
          messages: [
            { role: "system", content: this.systemPrompt() },
            { role: "assistant", content: this.summarize(context) },
            { role: "user", content: `${player.name} (${player.id}) acts: ${playerAction}` },
          ],
          max_tokens: 1000,
        });
        this.logAiAttempt("response", attemptNumber, {
          durationMs: Date.now() - startedAt,
          textPreview: (ai.response ?? "").slice(0, 200),
        });
        const { text, thinking } = this.extractThinking(ai.response ?? "The DM is silent.");
        return { text, thinking, degraded: false };
      } catch (error) {
        const retryable = this.isRetryableError(error);
        const attemptLabel = `${attempt + 1}/${this.maxAttempts}`;
        console.warn(`AI call failed (attempt ${attemptLabel})`, error);
        this.logAiAttempt("error", attemptNumber, {
          retryable,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { message: String(error) },
        });
        if (!retryable || attempt === this.maxAttempts - 1) {
          console.error("AI call failed", error);
          break;
        }
        await this.backoff(attempt);
      }
    }

    return { text: FALLBACK_DM_TEXT, thinking: "", degraded: true };
  }

  private summarize(context: SessionContext): string {
    // Collapse recent state into a compact primer for the AI model.
    const recent = context.messages.map(m => `${m.actor === "DM" ? "DM" : m.actor}: ${m.content}`).join("\n");
    const roster = context.players.map(p => `${p.name}(HP:${p.hp})`).join(", ");
    const enemies = context.combat.enemies.map(e => `${e.name}(HP:${e.hp})`).join(", ");
    return `Recent:\n${recent}\nPlayers: ${roster || "None"}\nEnemies: ${enemies || "None"}\nCombat active: ${context.combat.active}`;
  }

  private systemPrompt(): string {
    return [
      "You are the Dungeon Master for a Dungeons & Dragons game.",
      "Use official D&D 5e rules as guidance (Player’s Handbook, Dungeon Master’s Guide, Monster Manual).",
      "Narrate vividly but concisely, respecting turn order and mechanics. Keep it short, no more than 5 paragraphs.",
      "Simulate dice rolls using standard notation (d20, 2d6+3).",
      "Show reasoning and rolls inside <thinking> ... </thinking>.",
      "Final response must include clear outcomes: hit/miss, damage, conditions, or consequences. Give all stats in brackets",
      "Do not alter player stats directly; only describe narrative outcomes.",
      "Encourage creativity and roleplay while keeping rules consistent with D&D 5e.",
      "Respond in markdown format for rich text rendering.",
      "Avoid using <thinking> tags if there is no internal reasoning to show.",
    ].join(" ");
  }

  private isRetryableError(error: unknown): boolean {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return /timeout|timed out|network|503|504/i.test(message);
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = this.backoffMs * (attempt + 1);
    if (delay <= 0) return;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  private logAiAttempt(stage: "request" | "response" | "error", attempt: number, data: Record<string, unknown>) {
    if (!IS_LOCAL_DEV) return;
    const label = `[AI ${stage}] attempt ${attempt}/${this.maxAttempts}`;
    console.debug(label, data);
  }

  private cleanThinkingTags(text: string): string {
    return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  }

  private extractThinking(rawText: string): { text: string; thinking: string } {
    const match = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/i);
    const thinking = match ? match[1].trim() : "";
    const text = rawText.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    return { text, thinking };
  }
}

/**
 * Parses the DM narration looking for lightweight damage cues to keep HP values fresh.
 */
export class EffectResolver {
  apply(dmText: string, players: Map<string, Player>, combat: CombatState) {
    this.applyEnemyDamage(dmText, combat);
    this.applyPlayerDamage(dmText, players);
  }

  private applyEnemyDamage(text: string, combat: CombatState) {
    // Match phrases like "deals 5 damage to Goblin" and clamp HP at zero.
    const dmgMatches = text.matchAll(/deals\s+(\d+)\s+damage\s+to\s+([A-Za-z ']+)/gi);
    for (const match of dmgMatches) {
      const dmg = parseInt(match[1], 10);
      const enemyName = match[2]?.trim().toLowerCase();
      const enemy = combat.enemies.find(e => e.name.toLowerCase() === enemyName);
      if (enemy && Number.isFinite(dmg)) {
        enemy.hp = Math.max(0, enemy.hp - dmg);
      }
    }
  }

  private applyPlayerDamage(text: string, players: Map<string, Player>) {
    // Match phrases like "Thia takes 3 damage" and apply to the mapped player.
    const matches = text.matchAll(/([A-Za-z ']+)\s+takes\s+(\d+)\s+damage/gi);
    for (const match of matches) {
      const name = match[1]?.trim().toLowerCase();
      const dmg = parseInt(match[2], 10);
      const player = Array.from(players.values()).find(p => p.name.toLowerCase() === name);
      if (player && Number.isFinite(dmg)) {
        player.hp = Math.max(0, player.hp - dmg);
      }
    }
  }
}

/**
 * Global listing Durable Object that keeps track of the lobby's known sessions.
 */
export class SessionRegistry {
  private readonly storageManager: StorageManager;
  private sessions: Set<string> = new Set();

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.storageManager = new StorageManager(this.state.storage);
    this.state.blockConcurrencyWhile(async () => {
      this.sessions = await this.storageManager.loadSessions();
    });
  }

  private async persist() {
    await this.storageManager.saveSessions(this.sessions);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/list")) {
      return new Response(JSON.stringify({ sessions: Array.from(this.sessions) }), { headers: JSON_HEADERS });
    }

    if (url.pathname.endsWith("/add") && request.method === "POST") {
      const { sessionId } = await request.json() as { sessionId: string };
      this.sessions.add(sessionId);
      await this.persist();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (url.pathname.endsWith("/remove") && request.method === "POST") {
      const { sessionId } = await request.json() as { sessionId: string };
      this.sessions.delete(sessionId);
      await this.persist();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (url.pathname.endsWith("/clear") && request.method === "POST") {
      this.sessions.clear();
      await this.persist();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    return new Response("Not found", { status: 404 });
  }
}

/**
 * Owns all mutable state for a single session and serializes every change through one Durable Object.
 */
export class SessionCoordinator {
  private readonly storageManager: StorageManager;
  private readonly registry: RegistryClient;
  private readonly dm: DungeonMasterService;
  private readonly effects: EffectResolver;

  private players: Map<string, Player> = new Map();
  private messages: Message[] = [];
  private combat: CombatState = defaultCombatState();
  private lastActivity = Date.now();
  private sessionId?: string;

  constructor(private readonly state: DurableObjectState, private readonly env: Env) {
    this.storageManager = new StorageManager(this.state.storage);
    this.registry = new RegistryClient(env.SESSION_REGISTRY);
    this.dm = new DungeonMasterService(env.AI);
    this.effects = new EffectResolver();

    // Replay the latest snapshot so freshly spawned coordinators pick up prior state.
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.storageManager.loadSession();
      if (stored) {
        this.players = new Map(stored.players);
        this.messages = stored.messages || [];
        this.combat = stored.combat || defaultCombatState();
        this.lastActivity = stored.lastActivity ?? Date.now();
        this.sessionId = stored.sessionId;
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.cleanupIfIdle();

    const url = new URL(request.url);
    if (url.pathname.endsWith("/join") && request.method === "POST") {
      return this.handleJoin(request);
    }

    if (url.pathname.endsWith("/state")) {
      return this.handleState();
    }

    if (url.pathname.endsWith("/action") && request.method === "POST") {
      return this.handleAction(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleJoin(request: Request): Promise<Response> {
    const payload = await this.parseBody<JoinPayload>(request, isJoinPayload);
    if (!payload) {
      return new Response(JSON.stringify({ error: "Invalid join payload" }), { status: 400, headers: JSON_HEADERS });
    }

    const { sessionId, playerId, name } = payload;
    this.sessionId = this.sessionId ?? sessionId;
    const wasEmpty = this.players.size === 0;

    if (!this.players.has(playerId)) {
      // First time we see the player: seed stats and announce their arrival.
      this.players.set(playerId, { id: playerId, name, hp: 20, inventory: [] });
      this.messages.push({ actor: "DM", content: `${name} enters the campaign.`, ts: Date.now() });
    } else {
      const existing = this.players.get(playerId)!;
      if (existing.name !== name) {
        this.messages.push({ actor: "DM", content: `${existing.name} is now known as ${name}.`, ts: Date.now() });
        existing.name = name;
      }
    }

    this.touch();
    await this.persist();

    if (wasEmpty) {
      // Register with the global lobby so other clients can discover the session.
      await this.registry.add(sessionId);
    }

    return new Response(JSON.stringify({ ok: true, players: this.getPlayers(), messages: this.getRecentMessages() }), { headers: JSON_HEADERS });
  }

  private async handleState(): Promise<Response> {
    this.touch();
    await this.persist();
    return new Response(JSON.stringify({
      players: this.getPlayers(),
      messages: this.getRecentMessages(),
      combat: this.combat,
    }), { headers: JSON_HEADERS });
  }

  private async handleAction(request: Request): Promise<Response> {
    const payload = await this.parseBody<ActionPayload>(request, isActionPayload);
    if (!payload) {
      if (IS_LOCAL_DEV) {
        console.warn("[SessionCoordinator] Invalid action payload", { sessionId: this.sessionId, payload });
      }
      return new Response(JSON.stringify({ error: "Invalid action payload" }), { status: 400, headers: JSON_HEADERS });
    }

    const { sessionId, playerId, playerAction } = payload;
    this.sessionId = this.sessionId ?? sessionId;
    const player = this.players.get(playerId);
    if (!player) {
      if (IS_LOCAL_DEV) {
        console.warn("[SessionCoordinator] Player not joined", {
          sessionId: this.sessionId,
          requestedPlayerId: playerId,
          knownPlayers: Array.from(this.players.keys()),
        });
      }
      return new Response(JSON.stringify({ error: "Player not joined." }), { status: 400, headers: JSON_HEADERS });
    }

    if (this.isEndCommand(playerAction)) {
      // Explicit end command wipes local state immediately instead of waiting for idle cleanup.
      const dmText = "The game has ended. Thank you for playing!";
      this.messages.push({ actor: player.name, content: playerAction, ts: Date.now() });
      this.messages.push({ actor: "DM", content: dmText, ts: Date.now() });
      await this.registry.remove(sessionId);
      this.resetState();
      await this.persist();
      return new Response(
        JSON.stringify({ result: dmText, reset: true, state: { players: [], combat: this.combat } }),
        { headers: JSON_HEADERS },
      );
    }

    const context: SessionContext = {
      players: this.getPlayers(),
      messages: this.getRecentMessages(),
      combat: this.combat,
    };

    const narration = await this.dm.narrate(context, player, playerAction);
    if (!narration.degraded) {
      // Only mutate HP totals if the AI response is trustworthy.
      this.effects.apply(narration.text, this.players, this.combat);
    }

    this.messages.push({ actor: player.name, content: playerAction, ts: Date.now() });
    this.messages.push({ actor: "DM", content: narration.text, ts: Date.now() });

    this.touch();
    await this.persist();

    return new Response(
      JSON.stringify({
        result: narration.text,
        thinking: narration.thinking,
        degraded: narration.degraded,
        reset: false,
        state: { players: this.getPlayers(), combat: this.combat },
      }),
      { headers: JSON_HEADERS },
    );
  }

  private async parseBody<T>(request: Request, guard: (body: unknown) => body is T): Promise<T | null> {
    try {
      const body = await request.json();
      return guard(body) ? body : null;
    } catch {
      return null;
    }
  }

  /**
   * Tear the session down after sustained inactivity so storage stays lean.
   */
  private async cleanupIfIdle() {
    if (!this.sessionId) return;
    if (this.players.size === 0) return;
    const idle = Date.now() - this.lastActivity;
    if (idle < SESSION_IDLE_TIMEOUT_MS) return;

    console.log(`Session ${this.sessionId} expired after ${idle}ms of inactivity.`);
    await this.registry.remove(this.sessionId);
    this.resetState();
    await this.persist();
  }

  private isEndCommand(action: string): boolean {
    return /^(end|finish|close|stop)\s*(game|session)?$/i.test(action.trim());
  }

  private getPlayers(): Player[] {
    return Array.from(this.players.values());
  }

  private getRecentMessages(): Message[] {
    return this.messages.slice(-50);
  }

  /**
   * Forget every local data structure while keeping the coordinator alive for reuse.
   */
  private resetState() {
    this.players.clear();
    this.messages = [];
    this.combat = defaultCombatState();
    this.touch();
  }

  private touch() {
    this.lastActivity = Date.now();
  }

  /**
   * Persist a snapshot that can be replayed if the Durable Object is rehydrated elsewhere.
   */
  private async persist() {
    await this.storageManager.saveSession({
      players: Array.from(this.players.entries()),
      messages: this.messages,
      combat: this.combat,
      lastActivity: this.lastActivity,
      sessionId: this.sessionId,
    });
  }

  // Helpers to expose combat controls for future features
  startCombat(enemies: { name: string; hp: number }[], turnOrder: string[]) {
    this.combat = { active: true, enemies, currentTurnIndex: 0, turnOrder };
  }

  nextTurn() {
    if (!this.combat.active) return;
    this.combat.currentTurnIndex = (this.combat.currentTurnIndex + 1) % this.combat.turnOrder.length;
  }
}
