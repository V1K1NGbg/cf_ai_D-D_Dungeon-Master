import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import worker from '../src/index';
import { StorageManager, EffectResolver, CombatState, Player, DungeonMasterService } from '../src/session';
import { Env } from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

const getRequestUrl = (request: RequestInfo | URL): string => {
	if (typeof request === 'string') return request;
	if (request instanceof URL) return request.toString();
	if (request instanceof Request) return request.url;
	return String(request);
};

describe.sequential('D&D AI worker', () => {
	let coordinatorFetchMock: ReturnType<typeof vi.fn>;
	let registryFetchMock: ReturnType<typeof vi.fn>;

	const defaultCoordinatorResponse = async (request: RequestInfo | URL) => {
		const url = getRequestUrl(request);
		if (url.includes('/join')) {
			return new Response(JSON.stringify({ ok: true, players: [], messages: [] }), { headers: { 'Content-Type': 'application/json' } });
		}
		if (url.includes('/action')) {
			return new Response(JSON.stringify({ result: 'ok', state: { players: [], combat: { active: false, turnOrder: [], currentTurnIndex: 0, enemies: [] } } }), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({ players: [], messages: [], combat: { active: false, turnOrder: [], currentTurnIndex: 0, enemies: [] } }), { headers: { 'Content-Type': 'application/json' } });
	};

	const defaultRegistryResponse = async (request: RequestInfo | URL) => {
		const url = getRequestUrl(request);
		if (url.includes('/list')) {
			return new Response(JSON.stringify({ sessions: [] }), { headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
	};

	beforeAll(() => {
		// Mock the AI binding to avoid real calls
		(env as any).AI = {
			run: vi.fn().mockResolvedValue({
				response: 'Mock DM response: You look around and see a forest.'
			})
		};
		coordinatorFetchMock = vi.fn(defaultCoordinatorResponse);
		registryFetchMock = vi.fn(defaultRegistryResponse);
		// Mock other bindings
		(env as any).SESSION_COORDINATOR = {
			idFromName: vi.fn(() => ({})),
			get: vi.fn(() => ({
				fetch: coordinatorFetchMock
			}))
		};
		(env as any).SESSION_REGISTRY = {
			idFromName: vi.fn(() => ({})),
			get: vi.fn(() => ({
				fetch: registryFetchMock
			}))
		};
		(env as any).ASSETS = {
			fetch: vi.fn().mockResolvedValue(new Response('D&D AI'))
		};
	});

	beforeEach(() => {
		coordinatorFetchMock.mockReset();
		coordinatorFetchMock.mockImplementation(defaultCoordinatorResponse);
		registryFetchMock.mockReset();
		registryFetchMock.mockImplementation(defaultRegistryResponse);
	});
	it('responds with Hello World! (unit style)', async () => {
		const request = new IncomingRequest('http://example.com');
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, (env as any) as Env);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toContain("D&D AI");
	});

	it('responds with Hello World! (integration style)', async () => {
		const response = await SELF.fetch('https://example.com');
		expect(await response.text()).toContain("D&D AI");
	});

	it('lists sessions', async () => {
		const response = await SELF.fetch('https://example.com/api/sessions');
		expect(response.status).toBe(200);
		const data = await response.json() as { sessions: string[] };
		expect(data).toHaveProperty('sessions');
		expect(Array.isArray(data.sessions)).toBe(true);
	});

	it('rejects session state calls without sessionId', async () => {
		const response = await SELF.fetch('https://example.com/api/session/state');
		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).toContain('Missing sessionId');
	});

	it('joins a session', async () => {
		const response = await SELF.fetch('https://example.com/api/session/join', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: 'test-session', playerId: 'test-player', name: 'Test' }),
		});
		expect(response.status).toBe(200);
		const data = await response.json() as { ok: boolean };
		expect(data.ok).toBe(true);
	});

	it('rejects invalid action payloads', async () => {
		const response = await SELF.fetch('https://example.com/api/session/action', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ sessionId: 's1', playerId: 'p1' }),
		});
		expect(response.status).toBe(400);
		const payload = await response.text();
		expect(payload).toContain('Invalid request payload');
	});

	it('translates coordinator failures into 502s', async () => {
		coordinatorFetchMock.mockRejectedValueOnce(new Error('offline'));
		const request = new IncomingRequest('https://example.com/api/session/state?sessionId=demo');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, (env as any) as Env);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(502);
	});

	it('StorageManager loads and saves sessions', async () => {
		const mockStorage = {
			get: vi.fn(),
			put: vi.fn(),
		};
		const sm = new StorageManager(mockStorage);

		mockStorage.get.mockResolvedValue(['session1', 'session2']);
		const sessions = await sm.loadSessions();
		expect(sessions).toEqual(new Set(['session1', 'session2']));
		expect(mockStorage.get).toHaveBeenCalledWith('sessions');

		await sm.saveSessions(new Set(['a', 'b']));
		expect(mockStorage.put).toHaveBeenCalledWith('sessions', ['a', 'b']);
	});

	it('StorageManager loads and saves session data', async () => {
		const mockStorage = {
			get: vi.fn(),
			put: vi.fn(),
		};
		const sm = new StorageManager(mockStorage);

		const player: any = { id: 'p1', name: 'Alice', hp: 10, inventory: [] };
		const sessionData: any = {
			players: [['p1', player]],
			messages: [{ actor: 'DM', content: 'Welcome', ts: 123 }],
			combat: { active: false, turnOrder: [], currentTurnIndex: 0, enemies: [] },
			lastActivity: 456,
			sessionId: 'demo'
		};
		mockStorage.get.mockResolvedValue(sessionData);
		const loaded = await sm.loadSession();
		expect(loaded).toEqual(sessionData);

		await sm.saveSession(sessionData);
		expect(mockStorage.put).toHaveBeenCalledWith('session', sessionData);
	});
});

describe('EffectResolver', () => {
	it('applies damage to enemies and players based on narration', () => {
		const resolver = new EffectResolver();
		const players = new Map<string, Player>([['p1', { id: 'p1', name: 'Thia', hp: 20, inventory: [] }]]);
		const combat: CombatState = { active: true, turnOrder: [], currentTurnIndex: 0, enemies: [{ name: 'Goblin', hp: 12 }] };

		resolver.apply("Thia takes 5 damage. The hero deals 7 damage to Goblin.", players, combat);
		expect(players.get('p1')?.hp).toBe(15);
		expect(combat.enemies[0].hp).toBe(5);
	});

	it('does not reduce below zero', () => {
		const resolver = new EffectResolver();
		const players = new Map<string, Player>([['p1', { id: 'p1', name: 'Lia', hp: 3, inventory: [] }]]);
		const combat: CombatState = { active: true, turnOrder: [], currentTurnIndex: 0, enemies: [{ name: 'Ogre', hp: 4 }] };

		resolver.apply("Lia takes 10 damage. Knight deals 9 damage to Ogre.", players, combat);
		expect(players.get('p1')?.hp).toBe(0);
		expect(combat.enemies[0].hp).toBe(0);
	});
});

describe('DungeonMasterService', () => {
	const buildContext = () => ({
		players: [{ id: 'p1', name: 'Aelar', hp: 20, inventory: [] }],
		messages: [{ actor: 'DM', content: 'Welcome to the forest.', ts: Date.now() }],
		combat: { active: false, turnOrder: [], currentTurnIndex: 0, enemies: [] },
	});

	it('retries transient errors before succeeding', async () => {
		const run = vi.fn()
			.mockRejectedValueOnce(new Error('504 Gateway Time-out'))
			.mockResolvedValueOnce({ response: 'The DM returns.' });
		const service = new DungeonMasterService({ run } as any, { maxAttempts: 3, backoffMs: 0 });
		const context = buildContext();
		const result = await service.narrate(context, context.players[0], 'looks around');
		expect(run).toHaveBeenCalledTimes(2);
		expect(result.degraded).toBe(false);
		expect(result.text).toBe('The DM returns.');
	});

	it('returns fallback when retries are exhausted', async () => {
		const run = vi.fn().mockRejectedValue(new Error('InferenceUpstreamError: 504 Gateway Time-out'));
		const service = new DungeonMasterService({ run } as any, { maxAttempts: 2, backoffMs: 0 });
		const context = buildContext();
		const result = await service.narrate(context, context.players[0], 'waits patiently');
		expect(run).toHaveBeenCalledTimes(2);
		expect(result.degraded).toBe(true);
		expect(result.text).toContain('AI service is unavailable');
	});
});
