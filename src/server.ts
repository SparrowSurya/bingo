import { BingoRoom } from './game';

const rooms = new Map<string, BingoRoom>();
const playerSockets = new Map<string, any>(); // maps playerId -> ServerWebSocket

interface RateLimiter {
  tokens: number;
  lastRefill: number;
}

const rateLimiters = new Map<string, RateLimiter>();

// Read chat constants from environment variables
const CHAT_LIMIT = parseInt(process.env.CHAT_LIMIT || '5', 10);
const CHAT_REFILL_RATE = parseInt(process.env.CHAT_REFILL_RATE || '1000', 10);
const CHAT_MAX_LENGTH = parseInt(process.env.CHAT_MAX_LENGTH || '200', 10);

function checkRateLimit(playerId: string): boolean {
  const LIMIT = CHAT_LIMIT; // max tokens
  const REFILL_RATE = CHAT_REFILL_RATE; // refill duration in ms
  
  let limiter = rateLimiters.get(playerId);
  const now = Date.now();
  
  if (!limiter) {
    limiter = { tokens: LIMIT, lastRefill: now };
    rateLimiters.set(playerId, limiter);
    return true;
  }
  
  const elapsed = now - limiter.lastRefill;
  const refill = Math.floor(elapsed / REFILL_RATE);
  if (refill > 0) {
    limiter.tokens = Math.min(LIMIT, limiter.tokens + refill);
    limiter.lastRefill = now;
  }
  
  if (limiter.tokens > 0) {
    limiter.tokens--;
    return true;
  }
  
  return false;
}

function escapeHTML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// In-memory bundled client js
let clientJsText = '';

/**
 * Bundles client.ts into JS in memory using Bun.build.
 */
async function bundleClient() {
  try {
    const res = await Bun.build({
      entrypoints: ['./src/client.ts'],
      minify: true,
      define: {
        'process.env.CHAT_MAX_LENGTH': JSON.stringify(process.env.CHAT_MAX_LENGTH || '200')
      }
    });
    if (res.success && res.outputs.length > 0) {
      clientJsText = await res.outputs[0].text();
      console.log('Client JavaScript bundled successfully!');
    } else {
      console.error('Client JavaScript bundle failed:', res.logs);
    }
  } catch (error) {
    console.error('Error bundling client:', error);
  }
}

await bundleClient();

/**
 * Generates a unique room code.
 * Rules:
 * - Start at 4 characters.
 * - Retry up to 10 times.
 * - If still colliding, increment length by 1 and retry.
 */
function generateRoomCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed easy-to-confuse characters (I, O, 0, 1)
  let length = 4;
  let attempts = 0;

  while (true) {
    let code = '';
    for (let i = 0; i < length; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    if (!rooms.has(code)) {
      return code;
    }

    attempts++;
    if (attempts >= 10) {
      length++;
      attempts = 0;
    }
  }
}

// Start Bun Serve
const HOSTNAME = process.env.HOSTNAME || '127.0.0.1';
const PORT = process.env.PORT || 3000;

interface WebSocketData {
  playerId: string;
  username: string;
  roomCode: string;
}

const server = Bun.serve<WebSocketData>({
  port: PORT,
  hostname: HOSTNAME,
  fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Serve HTML (Home / Landing and Room route fallback for SPA)
    if (path === '/' || path.startsWith('/room/')) {
      return new Response(Bun.file('./public/index.html'), {
        headers: {
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // Serve CSS
    if (path === '/style.css') {
      return new Response(Bun.file('./public/style.css'), {
        headers: {
          'Content-Type': 'text/css',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // Serve Bundled Client JS
    if (path === '/client.js') {
      return new Response(clientJsText, {
        headers: {
          'Content-Type': 'text/javascript',
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    }

    // API: Create Room
    if (path === '/api/create-room' && req.method === 'POST') {
      const code = generateRoomCode();

      const room = new BingoRoom(
        code,
        // onDestroy
        () => {
          const roomObj = rooms.get(code);
          if (roomObj) {
            for (const pid of roomObj.playerOrder) {
              const ws = playerSockets.get(pid);
              if (ws) {
                ws.send(JSON.stringify({
                  type: 'KICK',
                  payload: { message: 'Lobby closed. A player left the room.' }
                }));
              }
            }
          }
          rooms.delete(code);
          console.log(`Room ${code} cleaned up.`);
        },
        // onBroadcast
        () => {
          for (const pid of room.playerOrder) {
            const ws = playerSockets.get(pid);
            if (ws) {
              ws.send(JSON.stringify({
                type: 'ROOM_STATE',
                payload: room.getClientPayload(pid)
              }));
            }
          }
        },
        // onToast
        (pid, message, type) => {
          const ws = playerSockets.get(pid);
          if (ws) {
            ws.send(JSON.stringify({
              type: 'TOAST',
              payload: { message, type }
            }));
          }
        }
      );

      rooms.set(code, room);
      console.log(`Room ${code} created.`);
      return Response.json({ success: true, roomCode: code });
    }

    // WebSocket Upgrade route
    if (path === '/ws') {
      const playerId = url.searchParams.get('playerId');
      const username = url.searchParams.get('username');
      const code = url.searchParams.get('roomCode');

      if (!playerId || !username || !code) {
        return new Response('Missing parameters', { status: 400 });
      }

      const upgraded = server.upgrade(req, {
        data: { playerId, username, roomCode: code.toUpperCase() }
      });

      if (upgraded) return undefined;
      return new Response('Upgrade failed', { status: 400 });
    }

    return new Response('Not Found', { status: 404 });
  },

  websocket: {
    open(ws) {
      const { playerId, username, roomCode } = ws.data;

      console.log(`Socket open: Player ${username} (${playerId}) connecting to Room ${roomCode}`);

      const room = rooms.get(roomCode);
      if (!room) {
        ws.send(JSON.stringify({
          type: 'KICK',
          payload: { message: `Room ${roomCode} does not exist.` }
        }));
        ws.close();
        return;
      }

      playerSockets.set(playerId, ws);

      const joined = room.addPlayer(playerId, username);
      if (!joined) {
        ws.send(JSON.stringify({
          type: 'KICK',
          payload: { message: 'Cannot join room. Game is full or in-progress.' }
        }));
        playerSockets.delete(playerId);
        ws.close();
      } else {
        // Broadcast JOIN system chat message
        const joinMsg = {
          type: 'CHAT_MSG',
          payload: {
            senderId: 'server',
            senderName: 'Server',
            text: `${username} joined the room.`,
            timestamp: Date.now()
          }
        };
        for (const pid of room.playerOrder) {
          playerSockets.get(pid)?.send(JSON.stringify(joinMsg));
        }
      }
    },

    message(ws, message) {
      const { playerId, roomCode } = ws.data;
      const room = rooms.get(roomCode);
      if (!room) return;

      try {
        const parsed = JSON.parse(message as string);

        switch (parsed.type) {
          case 'SET_GRID':
            room.setGrid(playerId, parsed.payload.grid);
            break;
          case 'SET_READY':
            room.setReady(playerId, parsed.payload.ready);
            break;
          case 'SET_START_PREFERENCE':
            room.setStartPreference(playerId, parsed.payload.letOpponentStart);
            break;
          case 'CALL_NUMBER':
            room.callNumber(playerId, parsed.payload.num);
            break;
          case 'EXIT_ROOM':
            room.finalizePlayerExit(playerId);
            break;
          case 'REQUEST_REMATCH':
            room.requestRematch(playerId);
            break;
          case 'ACCEPT_REMATCH':
            room.acceptRematch(playerId);
            break;
          case 'REJECT_REMATCH':
            room.rejectRematch(playerId);
            break;
          case 'SEND_CHAT': {
            const text = parsed.payload.text?.trim();
            if (!text || text.length === 0 || text.length > CHAT_MAX_LENGTH) {
              break;
            }
            if (!checkRateLimit(playerId)) {
              ws.send(JSON.stringify({
                type: 'TOAST',
                payload: {
                  message: 'You are sending messages too fast. Please wait a moment.',
                  type: 'error'
                }
              }));
              break;
            }
            const sanitizedText = escapeHTML(text);
            const chatMsg = {
              type: 'CHAT_MSG',
              payload: {
                senderId: playerId,
                senderName: ws.data.username,
                text: sanitizedText,
                timestamp: Date.now()
              }
            };
            for (const pid of room.playerOrder) {
              playerSockets.get(pid)?.send(JSON.stringify(chatMsg));
            }
            break;
          }
          case 'SET_TYPING': {
            const typing = !!parsed.payload.typing;
            const opponentId = room.playerOrder.find(id => id !== playerId);
            if (opponentId) {
              playerSockets.get(opponentId)?.send(JSON.stringify({
                type: 'OPPONENT_TYPING',
                payload: { typing }
              }));
            }
            break;
          }
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
      }
    },

    close(ws) {
      const { playerId, username, roomCode } = ws.data;
      console.log(`Socket close: Player ${username} (${playerId}) disconnected from Room ${roomCode}`);

      playerSockets.delete(playerId);

      const room = rooms.get(roomCode);
      if (room) {
        room.handleDisconnect(playerId);
        
        // Broadcast LEAVE system chat message
        const leaveMsg = {
          type: 'CHAT_MSG',
          payload: {
            senderId: 'server',
            senderName: 'Server',
            text: `${username} disconnected.`,
            timestamp: Date.now()
          }
        };
        for (const pid of room.playerOrder) {
          playerSockets.get(pid)?.send(JSON.stringify(leaveMsg));
        }
      }
    }
  }
});

console.log(`Bingo server is running on http://${server.hostname}:${server.port}`);
