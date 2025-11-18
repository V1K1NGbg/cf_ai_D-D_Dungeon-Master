import { ActionPayload, JoinPayload } from "./api-types";

/**
 * Narrow an unknown body to ActionPayload without bringing in a validation library.
 */
export function isActionPayload(body: unknown): body is ActionPayload {
  return typeof body === "object" && body !== null
    && typeof (body as ActionPayload).sessionId === "string"
    && typeof (body as ActionPayload).playerId === "string"
    && typeof (body as ActionPayload).playerAction === "string";
}

/**
 * Narrow an unknown body to JoinPayload.
 */
export function isJoinPayload(body: unknown): body is JoinPayload {
  return typeof body === "object" && body !== null
    && typeof (body as JoinPayload).sessionId === "string"
    && typeof (body as JoinPayload).playerId === "string"
    && typeof (body as JoinPayload).name === "string";
}
