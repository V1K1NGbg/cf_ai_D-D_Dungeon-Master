export interface ActionPayload {
  sessionId: string;
  playerId: string;
  playerAction: string;
}

export interface JoinPayload {
  sessionId: string;
  playerId: string;
  name: string;
}
