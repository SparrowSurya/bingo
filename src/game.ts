import type { GamePhase, Player, RoomStatePayload, ClientPlayerState } from './types';

const ROOM_DISCONNECT_TIMEOUT = parseInt(process.env.ROOM_DISCONNECT_TIMEOUT || '10000', 10);

/**
 * Validates that the grid is a 5x5 layout containing exactly the numbers 1 to 25.
 */
export function validateGrid(grid: number[] | null): boolean {
  if (!grid || grid.length !== 25) return false;
  const set = new Set(grid);
  if (set.size !== 25) return false;
  return grid.every(num => num >= 1 && num <= 25);
}

/**
 * Counts the number of completed lines (rows, columns, or diagonals).
 */
export function countCompletedLines(marked: boolean[]): number {
  let count = 0;

  // Check rows
  for (let r = 0; r < 5; r++) {
    let rowCompleted = true;
    for (let c = 0; c < 5; c++) {
      if (!marked[r * 5 + c]) {
        rowCompleted = false;
        break;
      }
    }
    if (rowCompleted) count++;
  }

  // Check columns
  for (let c = 0; c < 5; c++) {
    let colCompleted = true;
    for (let r = 0; r < 5; r++) {
      if (!marked[r * 5 + c]) {
        colCompleted = false;
        break;
      }
    }
    if (colCompleted) count++;
  }

  // Check main diagonal (top-left to bottom-right)
  let diag1Completed = true;
  for (let i = 0; i < 5; i++) {
    if (!marked[i * 5 + i]) {
      diag1Completed = false;
      break;
    }
  }
  if (diag1Completed) count++;

  // Check anti-diagonal (top-right to bottom-left)
  let diag2Completed = true;
  for (let i = 0; i < 5; i++) {
    if (!marked[i * 5 + (4 - i)]) {
      diag2Completed = false;
      break;
    }
  }
  if (diag2Completed) count++;

  return count;
}

/**
 * Checks if the player has won (completed at least 5 lines).
 */
export function checkWin(marked: boolean[]): boolean {
  return countCompletedLines(marked) >= 5;
}

export class BingoRoom {
  public code: string;
  public phase: GamePhase = 'waiting';
  public players: Map<string, Player> = new Map();
  public playerOrder: string[] = []; // [creatorId, opponentId]
  public turnIndex: number = 0;
  public letOpponentStart: boolean = false;
  public winnerPlayerId: string | 'draw' | null = null;
  public lastCalledNumber: number | null = null;
  public rematchStates: Record<string, 'requested' | 'accepted' | 'rejected' | null> = {};
  
  // Timeout references for reconnect grace period
  private reconnectTimeouts: Map<string, Timer> = new Map();
  
  // Callback when room is empty or should be destroyed
  private onDestroyCallback: () => void;
  // Callback to broadcast state to all room clients
  private onBroadcastCallback: () => void;
  // Callback to send toast to specific player
  private onToastCallback: (playerId: string, message: string, type: 'success' | 'error' | 'info') => void;
  // Callback to kick a specific player from the room
  private onKickCallback: (playerId: string, message: string) => void;

  constructor(
    code: string,
    onDestroy: () => void,
    onBroadcast: () => void,
    onToast: (playerId: string, message: string, type: 'success' | 'error' | 'info') => void,
    onKick: (playerId: string, message: string) => void
  ) {
    this.code = code;
    this.onDestroyCallback = onDestroy;
    this.onBroadcastCallback = onBroadcast;
    this.onToastCallback = onToast;
    this.onKickCallback = onKick;
  }

  /**
   * Gets the creator player ID.
   */
  public get creatorId(): string {
    return this.playerOrder[0] || '';
  }

  /**
   * Gets the opponent player ID (null if not joined yet).
   */
  public get opponentId(): string | null {
    return this.playerOrder[1] || null;
  }

  /**
   * Adds or reconnects a player to the room.
   */
  public addPlayer(id: string, username: string): boolean {
    // Reconnection case
    if (this.players.has(id)) {
      const player = this.players.get(id)!;
      player.connected = true;
      player.disconnectTime = null;
      
      const timeout = this.reconnectTimeouts.get(id);
      if (timeout) {
        clearTimeout(timeout);
        this.reconnectTimeouts.delete(id);
      }
      
      this.onToastCallback(id, 'Reconnected successfully!', 'success');
      // Toast to the other player
      const otherId = this.playerOrder.find(pid => pid !== id);
      if (otherId) {
        this.onToastCallback(otherId, `${username} has reconnected.`, 'info');
      }
      
      this.onBroadcastCallback();
      return true;
    }

    // New connection check
    if (this.players.size >= 2) {
      return false;
    }

    if (this.phase !== 'waiting') {
      return false;
    }

    // Setup new player
    const newPlayer: Player = {
      id,
      username,
      grid: null,
      marked: Array(25).fill(false),
      ready: false,
      connected: true,
      disconnectTime: null
    };

    this.players.set(id, newPlayer);
    this.playerOrder.push(id);
    this.rematchStates[id] = null;

    if (this.players.size === 2) {
      this.phase = 'setup';
    }

    this.onBroadcastCallback();
    return true;
  }

  /**
   * Handles player disconnection (starts the grace period).
   */
  public handleDisconnect(playerId: string) {
    const player = this.players.get(playerId);
    if (!player) return;

    player.connected = false;
    player.disconnectTime = Date.now();

    // Broadcast disconnected state immediately
    this.onBroadcastCallback();

    // Alert the other player about disconnection
    const otherId = this.playerOrder.find(pid => pid !== playerId);
    if (otherId) {
      const timeoutSecs = Math.ceil(ROOM_DISCONNECT_TIMEOUT / 1000);
      this.onToastCallback(otherId, `${player.username} disconnected. Waiting ${timeoutSecs}s to reconnect...`, 'info');
    }

    // Start grace period timeout
    const timeout = setTimeout(() => {
      this.reconnectTimeouts.delete(playerId);
      this.finalizePlayerExit(playerId);
    }, ROOM_DISCONNECT_TIMEOUT);

    this.reconnectTimeouts.set(playerId, timeout);
  }

  /**
   * Explicitly exit or kick players if the reconnect grace period expires.
   */
  public finalizePlayerExit(playerId: string, reason?: string) {
    const player = this.players.get(playerId);
    if (!player) return;

    // Clear any pending reconnect timeouts
    const timeout = this.reconnectTimeouts.get(playerId);
    if (timeout) {
      clearTimeout(timeout);
      this.reconnectTimeouts.delete(playerId);
    }

    const wasCreator = playerId === this.creatorId;

    // Remove leaving player
    this.players.delete(playerId);
    this.playerOrder = this.playerOrder.filter(pid => pid !== playerId);
    delete this.rematchStates[playerId];

    if (this.players.size === 0) {
      this.destroy();
      return;
    }

    // Reset room state to waiting for player
    this.phase = 'waiting';
    this.winnerPlayerId = null;
    this.lastCalledNumber = null;
    this.turnIndex = 0;
    this.letOpponentStart = false;

    // Reset remaining player's board/ready status
    for (const p of this.players.values()) {
      p.grid = null;
      p.marked = Array(25).fill(false);
      p.ready = false;
      this.rematchStates[p.id] = null;
    }

    // Notify the remaining player that the opponent left
    const remainingId = this.playerOrder[0];
    if (remainingId) {
      let msg = reason;
      if (!msg) {
        const hostSuffix = wasCreator ? " You are now the host." : "";
        msg = `${player.username} left the match. Room is open for a new player.${hostSuffix}`;
      }
      this.onToastCallback(remainingId, msg, 'info');
    }

    this.onBroadcastCallback();
  }

  /**
   * Sets the creator preference on who takes the first turn.
   */
  public setStartPreference(playerId: string, letOpponentStart: boolean) {
    if (playerId !== this.creatorId) {
      this.onToastCallback(playerId, 'Only the room creator can change turn preferences.', 'error');
      return;
    }
    if (this.phase !== 'waiting' && this.phase !== 'setup') {
      this.onToastCallback(playerId, 'Cannot change start preference once match starts.', 'error');
      return;
    }
    this.letOpponentStart = letOpponentStart;
    this.onBroadcastCallback();
  }

  /**
   * Sets the grid layout for a player.
   */
  public setGrid(playerId: string, grid: number[]) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (this.phase !== 'setup') {
      this.onToastCallback(playerId, 'Grid layout can only be modified during setup phase.', 'error');
      return;
    }

    if (player.ready) {
      this.onToastCallback(playerId, 'Cannot edit grid after marking ready.', 'error');
      return;
    }

    player.grid = grid;
    this.onBroadcastCallback();
  }

  /**
   * Marks a player as ready. Transitions to match phase if both are ready.
   */
  public setReady(playerId: string, ready: boolean) {
    const player = this.players.get(playerId);
    if (!player) return;

    if (this.phase !== 'setup') {
      return;
    }

    if (player.ready) {
      return; // Once ready, cannot un-ready
    }

    if (!validateGrid(player.grid)) {
      this.onToastCallback(playerId, 'Please fill your grid with numbers 1-25 exactly once before readying up.', 'error');
      return;
    }

    player.ready = true;

    // Check if both ready
    const allReady = Array.from(this.players.values()).every(p => p.ready);
    if (allReady && this.players.size === 2) {
      this.phase = 'match';
      this.lastCalledNumber = null;
      this.winnerPlayerId = null;
      // Creator index is 0, Opponent index is 1
      this.turnIndex = this.letOpponentStart ? 1 : 0;
    }

    this.onBroadcastCallback();
  }

  /**
   * Calls a number. Crosses it out on both grids and validates win conditions.
   */
  public callNumber(playerId: string, num: number) {
    if (this.phase !== 'match') {
      this.onToastCallback(playerId, 'No active match running.', 'error');
      return;
    }

    const currentTurnPlayerId = this.playerOrder[this.turnIndex];
    if (playerId !== currentTurnPlayerId) {
      this.onToastCallback(playerId, "It's not your turn!", 'error');
      return;
    }

    if (num < 1 || num > 25) {
      this.onToastCallback(playerId, 'Invalid number. Must be between 1 and 25.', 'error');
      return;
    }

    // Cross it out on BOTH players' grids
    let numberCalledAlready = false;
    for (const player of this.players.values()) {
      if (!player.grid) continue;
      const idx = player.grid.indexOf(num);
      if (idx !== -1) {
        if (player.marked[idx]) {
          numberCalledAlready = true;
        }
        player.marked[idx] = true;
      }
    }

    if (numberCalledAlready) {
      this.onToastCallback(playerId, `Number ${num} has already been called.`, 'error');
      return;
    }

    this.lastCalledNumber = num;

    // Check win conditions
    const p1Id = this.playerOrder[0];
    const p2Id = this.playerOrder[1];
    const p1 = this.players.get(p1Id)!;
    const p2 = this.players.get(p2Id)!;

    const p1Won = checkWin(p1.marked);
    const p2Won = checkWin(p2.marked);

    if (p1Won && p2Won) {
      this.phase = 'match_end';
      this.winnerPlayerId = 'draw';
    } else if (p1Won) {
      this.phase = 'match_end';
      this.winnerPlayerId = p1Id;
    } else if (p2Won) {
      this.phase = 'match_end';
      this.winnerPlayerId = p2Id;
    } else {
      // Toggle turn
      this.turnIndex = 1 - this.turnIndex;
    }

    this.onBroadcastCallback();
  }

  /**
   * Request rematch.
   */
  public requestRematch(playerId: string) {
    if (this.phase !== 'match_end') return;

    this.rematchStates[playerId] = 'requested';

    const opponentId = this.playerOrder.find(id => id !== playerId)!;
    const opponentState = this.rematchStates[opponentId];

    if (opponentState === 'requested') {
      // Both requested rematch! Auto accept.
      this.acceptRematch(playerId);
    } else {
      this.onBroadcastCallback();
    }
  }

  /**
   * Accept rematch. Resets grids and starts a new setup phase.
   */
  public acceptRematch(playerId: string) {
    if (this.phase !== 'match_end') return;

    this.rematchStates[playerId] = 'accepted';

    // Verify if both accepted or requested
    const allRematch = this.playerOrder.every(
      id => this.rematchStates[id] === 'requested' || this.rematchStates[id] === 'accepted'
    );

    if (allRematch) {
      // Reset game to setup phase
      this.phase = 'setup';
      this.winnerPlayerId = null;
      this.lastCalledNumber = null;

      for (const player of this.players.values()) {
        player.grid = null;
        player.marked = Array(25).fill(false);
        player.ready = false;
        this.rematchStates[player.id] = null;
      }
    }

    this.onBroadcastCallback();
  }

  /**
   * Reject rematch. Removes the rejecting player and resets the room back to waiting phase.
   */
  public rejectRematch(playerId: string) {
    if (this.phase !== 'match_end') return;

    const player = this.players.get(playerId);
    if (!player) return;

    this.rematchStates[playerId] = 'rejected';
    this.onBroadcastCallback();

    const wasCreator = playerId === this.creatorId;

    // Inform the rejecting player and kick them back to landing page
    this.onKickCallback(playerId, 'Rematch declined.');

    // Finalize player exit, notifying remaining player of rematch decline
    const hostSuffix = wasCreator ? ' You are now the host.' : '';
    this.finalizePlayerExit(
      playerId,
      `${player.username} declined the rematch. Room is open for a new player.${hostSuffix}`
    );
  }

  /**
   * Destroys the room, clearing all grace timeouts.
   */
  public destroy() {
    for (const timeout of this.reconnectTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.reconnectTimeouts.clear();
    this.onDestroyCallback();
  }

  /**
   * Generates the obfuscated/client-safe room state.
   */
  public getClientPayload(recipientPlayerId: string): RoomStatePayload {
    const clientPlayers: ClientPlayerState[] = this.playerOrder.map(pid => {
      const p = this.players.get(pid)!;
      const isMe = pid === recipientPlayerId;
      
      // Hide opponent's grid sequence if not in match_end phase
      const hideGrid = !isMe && this.phase !== 'match_end';

      return {
        id: p.id,
        username: p.username,
        isMe,
        isCreator: pid === this.creatorId,
        grid: hideGrid ? null : p.grid,
        marked: p.marked,
        ready: p.ready,
        connected: p.connected
      };
    });

    return {
      phase: this.phase,
      roomCode: this.code,
      creatorId: this.creatorId,
      players: clientPlayers,
      turnPlayerId: this.phase === 'match' ? this.playerOrder[this.turnIndex] : null,
      letOpponentStart: this.letOpponentStart,
      winnerPlayerId: this.winnerPlayerId,
      lastCalledNumber: this.lastCalledNumber,
      rematchStates: this.rematchStates
    };
  }
}
