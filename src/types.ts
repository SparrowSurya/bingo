export type GamePhase = 'waiting' | 'setup' | 'match' | 'match_end';

export interface Player {
  id: string;
  username: string;
  grid: number[] | null;       // 25 numbers (1-25)
  marked: boolean[];          // 25 booleans
  ready: boolean;
  connected: boolean;
  disconnectTime: number | null;
}

export interface ClientPlayerState {
  id: string;
  username: string;
  isMe: boolean;
  isCreator: boolean;
  grid: number[] | null;       // Hidden for opponent during setup
  marked: boolean[];
  ready: boolean;
  connected: boolean;
}

export interface RoomStatePayload {
  phase: GamePhase;
  roomCode: string;
  creatorId: string;
  players: ClientPlayerState[];
  turnPlayerId: string | null;
  letOpponentStart: boolean;
  winnerPlayerId: string | 'draw' | null;
  lastCalledNumber: number | null;
  rematchStates: Record<string, 'requested' | 'accepted' | 'rejected' | null>;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'JOIN'; payload: { username: string; playerId: string } }
  | { type: 'SET_GRID'; payload: { grid: number[] } }
  | { type: 'SET_READY'; payload: { ready: boolean } }
  | { type: 'SET_START_PREFERENCE'; payload: { letOpponentStart: boolean } }
  | { type: 'CALL_NUMBER'; payload: { num: number } }
  | { type: 'EXIT_ROOM' }
  | { type: 'REQUEST_REMATCH' }
  | { type: 'ACCEPT_REMATCH' }
  | { type: 'REJECT_REMATCH' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'ROOM_STATE'; payload: RoomStatePayload }
  | { type: 'TOAST'; payload: { message: string; type: 'success' | 'error' | 'info' } }
  | { type: 'KICK'; payload: { message: string } };
