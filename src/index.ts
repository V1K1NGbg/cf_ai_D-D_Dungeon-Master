import { ActionPayload, JoinPayload } from "./api-types";
import { isActionPayload, isJoinPayload } from "./api-validation";

export interface Env {
  SESSION_COORDINATOR: DurableObjectNamespace;
  SESSION_REGISTRY: DurableObjectNamespace;
  AI: Ai;
  ASSETS: Fetcher;
}

export { SessionCoordinator, SessionRegistry } from "./session";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

const METHOD_NOT_ALLOWED = (methods: string[]) => new Response("Method Not Allowed", {
  status: 405,
  headers: { Allow: methods.join(", ") },
});

const BAD_REQUEST = (message: string) => new Response(message, { status: 400 });

const serviceUnavailable = () => new Response("Session service unavailable", { status: 502 });

/**
 * Safely parse JSON bodies while applying a type guard; returns an error response on failure.
 */
async function readJson<T>(request: Request, guard: (body: unknown) => body is T): Promise<[T | null, Response | null]> {
  try {
    const body = await request.json();
    if (!guard(body)) {
      return [null, BAD_REQUEST("Invalid request payload")];
    }
    return [body, null];
  } catch {
    return [null, BAD_REQUEST("Invalid JSON body")];
  }
}

/**
 * Resolve the per-session Durable Object stub so we can forward API traffic.
 */
function getCoordinator(env: Env, sessionId: string) {
  const id = env.SESSION_COORDINATOR.idFromName(sessionId);
  return env.SESSION_COORDINATOR.get(id);
}

/**
 * Registry lives under a single global Durable Object instance.
 */
function getRegistry(env: Env) {
  const id = env.SESSION_REGISTRY.idFromName("global");
  return env.SESSION_REGISTRY.get(id);
}

/**
 * Wrap every Durable Object call so networking failures surface as a consistent 502 to clients.
 */
async function safeFetch(stub: DurableObjectStub | Fetcher, input: RequestInfo, init?: RequestInit) {
  try {
    return await stub.fetch(input, init);
  } catch (error) {
    console.error("Durable Object fetch failed", error);
    return serviceUnavailable();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Routes are intentionally explicit to keep the Worker transparent and auditable.

    if (url.pathname === "/api/session/state") {
      if (request.method !== "GET") return METHOD_NOT_ALLOWED(["GET"]);
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) return new Response("Missing sessionId", { status: 400 });

      const session = getCoordinator(env, sessionId);
      return safeFetch(session, "http://internal/state");
    }

    if (url.pathname === "/api/session/action") {
      if (request.method !== "POST") return METHOD_NOT_ALLOWED(["POST"]);
      const [body, error] = await readJson<ActionPayload>(request, isActionPayload);
      if (error || !body) return error ?? BAD_REQUEST("Invalid request payload");
      const { sessionId, playerId, playerAction } = body;

      const session = getCoordinator(env, sessionId);
      return safeFetch(session, "http://internal/action", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId, playerId, playerAction }),
      });
    }

    if (url.pathname === "/api/session/join") {
      if (request.method !== "POST") return METHOD_NOT_ALLOWED(["POST"]);
      const [body, error] = await readJson<JoinPayload>(request, isJoinPayload);
      if (error || !body) return error ?? BAD_REQUEST("Invalid request payload");
      const { sessionId, playerId, name } = body;

      const session = getCoordinator(env, sessionId);
      return safeFetch(session, "http://internal/join", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ sessionId, playerId, name }),
      });
    }

    if (url.pathname === "/api/sessions") {
      if (request.method !== "GET") return METHOD_NOT_ALLOWED(["GET"]);
      const registry = getRegistry(env);
      return safeFetch(registry, "http://internal/list");
    }

    if (url.pathname === "/api/sessions/clear") {
      if (request.method !== "POST") return METHOD_NOT_ALLOWED(["POST"]);
      const registry = getRegistry(env);
      return safeFetch(registry, "http://internal/clear", {
        method: "POST",
        headers: JSON_HEADERS,
      });
    }

    // Fall back to static asset serving for everything else (Cloudflare Pages bundle).
    return env.ASSETS.fetch(request);
  },
};
