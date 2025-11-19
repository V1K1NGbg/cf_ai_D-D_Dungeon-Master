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

interface CombatDetectionResult {
  combatDetected: boolean;
  enemies: { name: string; hp: number }[];
  triggers: string[];
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
    const aliveEnemies = context.combat.enemies.filter(e => e.hp > 0);
    const deadEnemies = context.combat.enemies.filter(e => e.hp <= 0);
    const enemies = aliveEnemies.map(e => `${e.name}(HP:${e.hp})`).join(", ");
    const defeated = deadEnemies.length > 0 ? ` | Defeated: ${deadEnemies.map(e => e.name).join(", ")}` : "";
    
    let combatStatus = `Combat active: ${context.combat.active}`;
    if (context.combat.active && context.combat.turnOrder.length > 0) {
      const currentActor = context.combat.turnOrder[context.combat.currentTurnIndex] || "Unknown";
      combatStatus += ` | Current turn: ${currentActor}`;
    }
    
    return `Recent:\n${recent}\nPlayers: ${roster || "None"}\nEnemies: ${enemies || "None"}${defeated}\n${combatStatus}`;
  }

  private systemPrompt(): string {
    return [
      "You are the Dungeon Master for a Dungeons & Dragons game.",
      "Use official D&D 5e rules as guidance (Player's Handbook, Dungeon Master's Guide, Monster Manual).",
      "Narrate vividly but concisely, respecting turn order and mechanics. Keep it short, no more than 5 paragraphs.",
      "Simulate dice rolls using standard notation (d20, 2d6+3).",
      "Show reasoning and rolls inside <thinking> ... </thinking>.",
      "CRITICAL: When introducing enemies in combat, specify them clearly: 'A Goblin (7 HP) appears' or 'Two Orcs emerge to attack'.",
      "CRITICAL: When a character takes damage, always use the exact phrase '[Character Name] takes [X] damage' or '[Character Name] suffers [X] damage' to ensure HP tracking works properly.",
      "CRITICAL: When enemies take damage, use clear phrases: 'deals [X] damage to the Goblin' or 'the Orc takes [X] damage'.",
      "CRITICAL: When a character heals, always use phrases like '[Character Name] heals [X] HP' or '[Character Name] recovers [X] health'.",
      "CRITICAL: When a character gains items, use phrases like '[Character Name] finds a sword' or '[Character Name] receives a potion' to track inventory.",
      "CRITICAL: When a character uses items, use phrases like '[Character Name] uses a potion' or '[Character Name] drinks a healing potion'.",
      "CRITICAL: When combat begins, mention 'roll initiative' or 'combat begins' to trigger the combat tracking system.",
      "Final response must include clear outcomes: hit/miss, damage, conditions, or consequences. Always specify exact damage numbers.",
      "Include item discoveries, loot, and inventory changes in your narration using the phrases above.",
      "Do not alter player stats directly; only describe narrative outcomes with precise damage amounts and item interactions.",
      "Encourage creativity and roleplay while keeping rules consistent with D&D 5e.",
      "Respond in markdown format for rich text rendering.",
      "Structure your responses with titles and subtitles using markdown headers (# Title, ## Subtitle) to organize your narration into clear sections.",
      "Use titles to indicate major scene changes, locations, or story beats. Use subtitles for specific actions, combat rounds, or character interactions.",
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
    // Detect and initialize combat scenarios
    this.detectCombatScenarios(dmText, players, combat);
    
    // Apply damage and effects
    this.applyEnemyDamage(dmText, combat);
    this.applyPlayerDamage(dmText, players);
    this.applyPlayerHealing(dmText, players);
    this.applyInventoryChanges(dmText, players);
    
    // Check if combat should end
    this.checkCombatEnd(combat);
  }

  private detectCombatScenarios(text: string, players: Map<string, Player>, combat: CombatState) {
    // Skip if combat is already active
    if (combat.active) {
      return;
    }

    // Look for combat initiation phrases
    const combatTriggers = [
      /(?:attack|combat|fight|battle|engage)(?:s|ing)?/i,
      /(?:enemy|enemies|monster|monsters|creature|creatures|foe|foes)\s+(?:appear|emerges?|attack|charge)/i,
      /(?:roll|make)\s+(?:initiative|an?\s+initiative)/i,
      /initiative\s+(?:roll|order)/i,
      /(?:a|the)\s+(?:goblin|orc|skeleton|dragon|wolf|spider|bandit|guard)(?:s)?\s+(?:attack|charge|leap|strike)/i
    ];

    const hasCombatTrigger = combatTriggers.some(pattern => pattern.test(text));
    if (!hasCombatTrigger) {
      return;
    }

    // Look for enemy mentions to initialize combat
    const enemyPatterns = [
      // Basic enemy types with optional HP mentions
      /(?:a|the|\d+)\s+(goblin|orc|skeleton|dragon|wolf|spider|bandit|guard|troll|ogre|zombie|ghoul|wraith|lich|demon|devil|giant|minotaur|basilisk|manticore|harpy|medusa|cyclops|hydra|griffin|pegasus|unicorn|phoenix|roc|kraken|leviathan|behemoth|colossus)(?:s)?(?:\s+\((\d+)\s+HP\))?/gi,
      // Generic enemy with HP
      /(?:a|the|\d+)\s+([A-Za-z][A-Za-z\s]*?)\s+\((\d+)\s+HP\)/gi,
      // Enemy appears/emerges patterns
      /(?:a|the|\d+)\s+([A-Za-z][A-Za-z\s]*?)\s+(?:appears?|emerges?|materializes?|attacks?)/gi
    ];

    const enemies: { name: string; hp: number }[] = [];
    const foundEnemies = new Set<string>();

    for (const pattern of enemyPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        let enemyName: string;
        let enemyHp: number;

        if (match[2] && !isNaN(parseInt(match[2], 10))) {
          // Pattern with explicit HP
          enemyName = match[1].trim();
          enemyHp = parseInt(match[2], 10);
        } else {
          // Pattern without explicit HP, use defaults
          enemyName = match[1].trim();
          enemyHp = this.getDefaultEnemyHp(enemyName);
        }

        // Clean up enemy name
        enemyName = enemyName.replace(/^(a|an|the)\s+/i, '');
        enemyName = enemyName.toLowerCase().split(' ').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');

        // Avoid duplicates
        const enemyKey = enemyName.toLowerCase();
        if (!foundEnemies.has(enemyKey) && enemyName.length > 1) {
          foundEnemies.add(enemyKey);
          enemies.push({ name: enemyName, hp: enemyHp });
        }
      }
    }

    // Initialize combat if enemies were found
    if (enemies.length > 0) {
      console.log('[Combat Detected] Initializing combat with enemies:', enemies);
      
      combat.active = true;
      combat.enemies = enemies;
      
      // Create turn order: players first, then enemies
      const playerNames = Array.from(players.values()).map(p => p.name);
      combat.turnOrder = [...playerNames, ...enemies.map(e => e.name)];
      combat.currentTurnIndex = 0;
      
      if (IS_LOCAL_DEV) {
        console.log('[Combat Started]', {
          enemies: combat.enemies,
          turnOrder: combat.turnOrder
        });
      }
    }
  }

  private getDefaultEnemyHp(enemyName: string): number {
    const name = enemyName.toLowerCase();
    
    // Basic enemy HP mapping
    const hpMap: Record<string, number> = {
      'goblin': 7,
      'orc': 15,
      'skeleton': 13,
      'zombie': 22,
      'wolf': 11,
      'spider': 4,
      'bandit': 11,
      'guard': 11,
      'troll': 84,
      'ogre': 59,
      'dragon': 200,
      'lich': 135,
      'demon': 85,
      'devil': 85,
      'giant': 138,
      'minotaur': 76,
      'basilisk': 52,
      'harpy': 38,
      'cyclops': 138,
      'hydra': 172
    };
    
    return hpMap[name] || 15; // Default HP for unknown enemies
  }

  private checkCombatEnd(combat: CombatState) {
    if (!combat.active) {
      return;
    }
    
    // End combat if all enemies are dead
    const aliveEnemies = combat.enemies.filter(e => e.hp > 0);
    if (aliveEnemies.length === 0) {
      console.log('[Combat Ended] All enemies defeated');
      combat.active = false;
      combat.enemies = [];
      combat.turnOrder = [];
      combat.currentTurnIndex = 0;
    }
  }

  private applyEnemyDamage(text: string, combat: CombatState) {
    if (!combat.active || combat.enemies.length === 0) {
      return;
    }

    // Enhanced damage patterns for enemies
    const damagePatterns = [
      // "deals 5 damage to Goblin"
      /deals\s+(\d+)\s+(?:points?\s+of\s+)?damage\s+to\s+(?:the\s+)?([A-Za-z][A-Za-z ']*)/gi,
      // "Goblin takes 5 damage"
      /(?:the\s+)?([A-Za-z][A-Za-z ']*?)\s+takes?\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
      // "5 damage to the Goblin"
      /(\d+)\s+(?:points?\s+of\s+)?damage\s+to\s+(?:the\s+)?([A-Za-z][A-Za-z ']*)/gi,
      // "Goblin suffers 5 damage"
      /(?:the\s+)?([A-Za-z][A-Za-z ']*?)\s+suffers?\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
      // "strikes the Goblin for 5 damage"
      /strikes?\s+(?:the\s+)?([A-Za-z][A-Za-z ']*?)\s+for\s+(\d+)\s+damage/gi
    ];

    for (const pattern of damagePatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        let enemyName: string, dmg: number;
        
        if (pattern.source.startsWith('(\\d+)') || pattern.source.includes('deals')) {
          // Patterns: "5 damage to Goblin" or "deals 5 damage to Goblin"
          dmg = parseInt(match[1], 10);
          enemyName = match[2]?.trim();
        } else {
          // Patterns: "Goblin takes 5 damage"
          enemyName = match[1]?.trim();
          dmg = parseInt(match[2], 10);
        }
        
        if (enemyName && Number.isFinite(dmg) && dmg > 0) {
          const enemy = this.findEnemyByName(combat.enemies, enemyName);
          if (enemy) {
            const oldHp = enemy.hp;
            enemy.hp = Math.max(0, enemy.hp - dmg);
            if (IS_LOCAL_DEV) {
              console.log(`[Enemy Damage] ${enemy.name}: ${oldHp} → ${enemy.hp} (took ${dmg} damage)`);
            }
          }
        }
      }
    }
  }

  private findEnemyByName(enemies: { name: string; hp: number }[], searchName: string): { name: string; hp: number } | undefined {
    const cleanSearchName = searchName.toLowerCase().replace(/^(the|a|an)\s+/, '').trim();
    
    // First try exact match
    let enemy = enemies.find(e => e.name.toLowerCase() === cleanSearchName);
    if (enemy) return enemy;
    
    // Then try partial match
    enemy = enemies.find(e => e.name.toLowerCase().includes(cleanSearchName));
    if (enemy) return enemy;
    
    // Finally try reverse partial match (search name contains enemy name)
    return enemies.find(e => cleanSearchName.includes(e.name.toLowerCase()));
  }

  private applyPlayerDamage(text: string, players: Map<string, Player>) {
    // Enhanced patterns to match various damage descriptions
    const damagePatterns = [
      // "Thia takes 3 damage"
      /([A-Za-z][A-Za-z ']*?)\s+takes?\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
      // "3 damage to Thia"
      /(\d+)\s+(?:points?\s+of\s+)?damage\s+to\s+([A-Za-z][A-Za-z ']*)/gi,
      // "Thia suffers 3 damage"
      /([A-Za-z][A-Za-z ']*?)\s+suffers?\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
      // "Thia loses 3 HP"
      /([A-Za-z][A-Za-z ']*?)\s+loses?\s+(\d+)\s+(?:hit\s+points?|hp)/gi,
    ];

    for (const pattern of damagePatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        let name: string, dmg: number;
        
        if (pattern.source.startsWith('(\\d+)')) {
          // Pattern: "3 damage to Thia"
          dmg = parseInt(match[1], 10);
          name = match[2]?.trim().toLowerCase();
        } else {
          // Pattern: "Thia takes 3 damage"
          name = match[1]?.trim().toLowerCase();
          dmg = parseInt(match[2], 10);
        }
        
        const player = Array.from(players.values()).find(p => p.name.toLowerCase() === name);
        if (player && Number.isFinite(dmg) && dmg > 0) {
          const oldHp = player.hp;
          player.hp = Math.max(0, player.hp - dmg);
          if (IS_LOCAL_DEV) {
            console.log(`[Damage Applied] ${player.name}: ${oldHp} → ${player.hp} (took ${dmg} damage)`);
          }
        }
      }
    }
  }

  private applyPlayerHealing(text: string, players: Map<string, Player>) {
    // Enhanced patterns to match various healing descriptions
    const healingPatterns = [
      // "Thia heals 3 HP"
      /([A-Za-z][A-Za-z ']*?)\s+heals?\s+(\d+)\s+(?:hit\s+points?|hp)/gi,
      // "Thia recovers 3 damage"
      /([A-Za-z][A-Za-z ']*?)\s+recovers?\s+(\d+)\s+(?:points?\s+of\s+)?(?:damage|health|hp)/gi,
      // "Thia gains 3 HP"
      /([A-Za-z][A-Za-z ']*?)\s+gains?\s+(\d+)\s+(?:hit\s+points?|hp|health)/gi,
      // "3 HP restored to Thia"
      /(\d+)\s+(?:hit\s+points?|hp|health)\s+(?:restored|healed)\s+to\s+([A-Za-z][A-Za-z ']*)/gi,
    ];

    for (const pattern of healingPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        let name: string, heal: number;
        
        if (pattern.source.startsWith('(\\d+)')) {
          // Pattern: "3 HP restored to Thia"
          heal = parseInt(match[1], 10);
          name = match[2]?.trim().toLowerCase();
        } else {
          // Pattern: "Thia heals 3 HP"
          name = match[1]?.trim().toLowerCase();
          heal = parseInt(match[2], 10);
        }
        
        const player = Array.from(players.values()).find(p => p.name.toLowerCase() === name);
        if (player && Number.isFinite(heal) && heal > 0) {
          const oldHp = player.hp;
          const maxHp = 20; // Default max HP
          player.hp = Math.min(maxHp, player.hp + heal);
          if (IS_LOCAL_DEV) {
            console.log(`[Healing Applied] ${player.name}: ${oldHp} → ${player.hp} (healed ${heal} HP)`);
          }
        }
      }
    }
  }

  private applyInventoryChanges(text: string, players: Map<string, Player>) {
    // Patterns to detect when players gain items
    const gainItemPatterns = [
      // "Thia finds a sword"
      /([A-Za-z][A-Za-z ']*?)\s+(?:finds?|discovers?|picks?\s+up|obtains?)\s+(?:a|an|the)\s+([A-Za-z][A-Za-z '\-]*)/gi,
      // "Thia receives a potion"
      /([A-Za-z][A-Za-z ']*?)\s+(?:receives?|gets?|gains?)\s+(?:a|an|the)\s+([A-Za-z][A-Za-z '\-]*)/gi,
      // "You give Thia a dagger"
      /(?:give|hand)\s+([A-Za-z][A-Za-z ']*?)\s+(?:a|an|the)\s+([A-Za-z][A-Za-z '\-]*)/gi,
      // "Thia loots a gem"
      /([A-Za-z][A-Za-z ']*?)\s+(?:loots?|takes?)\s+(?:a|an|the)\s+([A-Za-z][A-Za-z '\-]*)/gi,
    ];

    for (const pattern of gainItemPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const playerName = match[1]?.trim().toLowerCase();
        let itemName = match[2]?.trim();
        
        // Skip if item name looks like a place or action
        if (!itemName || itemName.length < 2 || /\b(room|door|way|path|area|place|time|chance)\b/i.test(itemName)) {
          continue;
        }
        
        const player = Array.from(players.values()).find(p => p.name.toLowerCase() === playerName);
        if (player && itemName) {
          // Clean up item name
          itemName = itemName.toLowerCase().replace(/[^a-z\s\-]/g, '').trim();
          
          // Don't add duplicate items
          if (!player.inventory.includes(itemName)) {
            player.inventory.push(itemName);
            if (IS_LOCAL_DEV) {
              console.log(`[Item Added] ${player.name} gained: ${itemName}`);
            }
          }
        }
      }
    }

    // Patterns to detect when players lose/use items
    const loseItemPatterns = [
      // "Thia uses a potion"
      /([A-Za-z][A-Za-z ']*?)\s+(?:uses?|consumes?|drinks?)\s+(?:a|an|the|their)\s+([A-Za-z][A-Za-z '\-]*)/gi,
      // "Thia drops the sword"
      /([A-Za-z][A-Za-z ']*?)\s+(?:drops?|loses?|discards?)\s+(?:a|an|the|their)\s+([A-Za-z][A-Za-z '\-]*)/gi,
    ];

    for (const pattern of loseItemPatterns) {
      const matches = text.matchAll(pattern);
      for (const match of matches) {
        const playerName = match[1]?.trim().toLowerCase();
        let itemName = match[2]?.trim().toLowerCase();
        
        if (itemName && playerName) {
          itemName = itemName.replace(/[^a-z\s\-]/g, '').trim();
          
          const player = Array.from(players.values()).find(p => p.name.toLowerCase() === playerName);
          if (player) {
            const itemIndex = player.inventory.findIndex(item => item.includes(itemName));
            if (itemIndex !== -1) {
              const removedItem = player.inventory.splice(itemIndex, 1)[0];
              if (IS_LOCAL_DEV) {
                console.log(`[Item Removed] ${player.name} lost: ${removedItem}`);
              }
            }
          }
        }
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
      const starterInventory = ['basic sword', 'leather armor', 'health potion'];
      this.players.set(playerId, { id: playerId, name, hp: 20, inventory: starterInventory });
      this.messages.push({ actor: "DM", content: `${name} enters the campaign with basic equipment.`, ts: Date.now() });
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
      // Log player states before damage application
      if (IS_LOCAL_DEV) {
        console.log('[Pre-effect] Player states:', this.getPlayers().map(p => `${p.name}: ${p.hp}HP`));
        console.log('[Pre-effect] Combat state:', this.combat);
        console.log('[DM Response]:', narration.text);
      }
      
      // Only mutate HP totals if the AI response is trustworthy.
      this.effects.apply(narration.text, this.players, this.combat);
      
      // Advance turn if in combat and this was a combat action
      if (this.combat.active && this.isPlayerTurn(player.id)) {
        this.nextTurn();
        if (IS_LOCAL_DEV) {
          console.log(`[Turn Advanced] Now: ${this.getCurrentTurn()}`);
        }
      }
      
      // Log states after effect application
      if (IS_LOCAL_DEV) {
        console.log('[Post-effect] Player states:', this.getPlayers().map(p => `${p.name}: ${p.hp}HP`));
        console.log('[Post-effect] Combat state:', this.combat);
      }
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

  getCurrentTurn(): string | null {
    if (!this.combat.active || this.combat.turnOrder.length === 0) {
      return null;
    }
    return this.combat.turnOrder[this.combat.currentTurnIndex] || null;
  }

  isPlayerTurn(playerId: string): boolean {
    const player = this.players.get(playerId);
    if (!player) return false;
    return this.getCurrentTurn() === player.name;
  }
}
