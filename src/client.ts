import type { ClientMessage, ServerMessage, RoomStatePayload } from './types';

// Theme Accent Color Map
const ACCENT_COLORS: Record<string, string> = {
  mauve: '#cba6f7',
  lavender: '#b4befe',
  blue: '#89b4fa',
  teal: '#94e2d5',
  green: '#a6e3a1',
  peach: '#fab387',
  pink: '#f5c2e7',
  flamingo: '#f2cdcd'
};

// Global Client State
let socket: WebSocket | null = null;
let playerId = localStorage.getItem('bingo-player-id') || '';
let username = localStorage.getItem('bingo-username') || '';
let roomCode: string | null = null;
let currentRoomState: RoomStatePayload | null = null;
let localGrid: (number | null)[] = Array(25).fill(null);
let activeInputCellIndex: number | null = null;

// Reconnection state
let reconnectInterval: Timer | null = null;

// Generate UUID for unique player tracking if not exists
if (!playerId) {
  playerId = 'p_' + Math.random().toString(36).substring(2, 11) + Date.now().toString(36);
  localStorage.setItem('bingo-player-id', playerId);
}

// -------------------------------------------------------------
// DOM ELEMENTS
// -------------------------------------------------------------
const viewLanding = document.getElementById('viewLanding') as HTMLElement;
const viewRoom = document.getElementById('viewRoom') as HTMLElement;
const usernameInput = document.getElementById('usernameInput') as HTMLInputElement;
const btnCreateRoom = document.getElementById('btnCreateRoom') as HTMLButtonElement;
const joinCodeInput = document.getElementById('joinCodeInput') as HTMLInputElement;
const btnJoinRoom = document.getElementById('btnJoinRoom') as HTMLButtonElement;

// Room controls
const roomCodeDisplay = document.getElementById('roomCodeDisplay') as HTMLElement;
const btnCopyCode = document.getElementById('btnCopyCode') as HTMLButtonElement;
const creatorControls = document.getElementById('creatorControls') as HTMLElement;
const chkOpponentStart = document.getElementById('chkOpponentStart') as HTMLInputElement;
const btnExitRoom = document.getElementById('btnExitRoom') as HTMLButtonElement;

// Grids
const myUsername = document.getElementById('myUsername') as HTMLElement;
const myInstruction = document.getElementById('myInstruction') as HTMLElement;
const myStatusBadge = document.getElementById('myStatusBadge') as HTMLElement;
const myGrid = document.getElementById('myGrid') as HTMLElement;

const opponentUsername = document.getElementById('opponentUsername') as HTMLElement;
const opponentInstruction = document.getElementById('opponentInstruction') as HTMLElement;
const opponentStatusBadge = document.getElementById('opponentStatusBadge') as HTMLElement;
const opponentGrid = document.getElementById('opponentGrid') as HTMLElement;
const opponentGridOverlay = document.getElementById('opponentGridOverlay') as HTMLElement;
const blockerMessage = document.getElementById('blockerMessage') as HTMLElement;

// Controls
const setupControls = document.getElementById('setupControls') as HTMLElement;
const btnRandomizeGrid = document.getElementById('btnRandomizeGrid') as HTMLButtonElement;
const btnReadyGrid = document.getElementById('btnReadyGrid') as HTMLButtonElement;
const unusedNumbers = document.getElementById('unusedNumbers') as HTMLElement;

// Status & Rematch
const turnBanner = document.getElementById('turnBanner') as HTMLElement;
const turnBannerText = document.getElementById('turnBannerText') as HTMLElement;
const rematchControls = document.getElementById('rematchControls') as HTMLElement;
const matchOutcomeTitle = document.getElementById('matchOutcomeTitle') as HTMLElement;
const matchOutcomeSubtitle = document.getElementById('matchOutcomeSubtitle') as HTMLElement;
const btnRequestRematch = document.getElementById('btnRequestRematch') as HTMLButtonElement;
const rematchIncomingControls = document.getElementById('rematchIncomingControls') as HTMLElement;
const btnAcceptRematch = document.getElementById('btnAcceptRematch') as HTMLButtonElement;
const btnRejectRematch = document.getElementById('btnRejectRematch') as HTMLButtonElement;
const rematchStatusText = document.getElementById('rematchStatusText') as HTMLElement;

// Dialogs
const exitConfirmDialog = document.getElementById('exitConfirmDialog') as HTMLDialogElement;
const btnExitConfirmYes = document.getElementById('btnExitConfirmYes') as HTMLButtonElement;
const btnExitConfirmNo = document.getElementById('btnExitConfirmNo') as HTMLButtonElement;

// Toast Notification
const toastContainer = document.getElementById('toastContainer') as HTMLElement;

// -------------------------------------------------------------
// EVENT LISTENERS
// -------------------------------------------------------------

// Page Load initialization
window.addEventListener('DOMContentLoaded', () => {
  initAccentColor();
  loadSavedUser();
  checkRoute();
});

// Route change popstate
window.addEventListener('popstate', () => {
  checkRoute();
});

// Accent color selector click
document.getElementById('accentSelector')?.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('color-btn')) {
    const colorName = target.getAttribute('data-color') || 'mauve';
    setAccentColor(colorName);
  }
});

// Landing Inputs & Buttons
btnCreateRoom.addEventListener('click', handleCreateRoom);
btnJoinRoom.addEventListener('click', handleJoinRoom);

// Auto-join on enter key
joinCodeInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') handleJoinRoom();
});

// Copy code action
btnCopyCode.addEventListener('click', () => {
  if (roomCode) {
    navigator.clipboard.writeText(roomCode).then(() => {
      showToast('Room code copied to clipboard!', 'success');
    }).catch(() => {
      showToast('Failed to copy code.', 'error');
    });
  }
});

// Creator Start Preference
chkOpponentStart.addEventListener('change', () => {
  sendWSMessage({
    type: 'SET_START_PREFERENCE',
    payload: { letOpponentStart: chkOpponentStart.checked }
  });
});

// Exit Dialog triggers
btnExitRoom.addEventListener('click', () => {
  exitConfirmDialog.showModal();
});

btnExitConfirmNo.addEventListener('click', () => {
  exitConfirmDialog.close();
});

btnExitConfirmYes.addEventListener('click', () => {
  exitConfirmDialog.close();
  sendWSMessage({ type: 'EXIT_ROOM' });
  disconnectSocket();
  cleanupRoomState();
  navigateTo('/');
});

// Grid setup tools
btnRandomizeGrid.addEventListener('click', randomizeLocalGrid);
btnReadyGrid.addEventListener('click', submitReadyState);

// Rematch requests
btnRequestRematch.addEventListener('click', () => {
  sendWSMessage({ type: 'REQUEST_REMATCH' });
  btnRequestRematch.disabled = true;
  rematchStatusText.textContent = 'Waiting for opponent...';
});

btnAcceptRematch.addEventListener('click', () => {
  sendWSMessage({ type: 'ACCEPT_REMATCH' });
});

btnRejectRematch.addEventListener('click', () => {
  sendWSMessage({ type: 'REJECT_REMATCH' });
});

// -------------------------------------------------------------
// NAVIGATION & ROUTING
// -------------------------------------------------------------

function navigateTo(path: string) {
  window.history.pushState(null, '', path);
  checkRoute();
}

function checkRoute() {
  const path = window.location.pathname;
  if (path.startsWith('/room/')) {
    const code = path.split('/')[2];
    if (code && code.trim().length >= 4) {
      roomCode = code.trim().toUpperCase();
      joinGameRoom();
    } else {
      navigateTo('/');
    }
  } else {
    // Show Landing View
    disconnectSocket();
    cleanupRoomState();
    switchView('landing');
  }
}

function switchView(viewName: 'landing' | 'room') {
  if (viewName === 'landing') {
    viewLanding.classList.add('active');
    viewRoom.classList.remove('active');
  } else {
    viewLanding.classList.remove('active');
    viewRoom.classList.add('active');
  }
}

function loadSavedUser() {
  if (username) {
    usernameInput.value = username;
  }
}

function cleanupRoomState() {
  roomCode = null;
  currentRoomState = null;
  localGrid = Array(25).fill(null);
  activeInputCellIndex = null;
  btnRequestRematch.disabled = false;
  rematchStatusText.textContent = '';
  chkOpponentStart.checked = false;
}

// -------------------------------------------------------------
// WEBSOCKET LOGIC
// -------------------------------------------------------------

function connectWebSocket() {
  if (socket) return;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws?playerId=${encodeURIComponent(playerId)}&username=${encodeURIComponent(username)}&roomCode=${encodeURIComponent(roomCode || '')}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
  };

  socket.onmessage = (event) => {
    try {
      const message: ServerMessage = JSON.parse(event.data);
      handleServerMessage(message);
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };

  socket.onclose = (event) => {
    socket = null;
    if (roomCode) {
      showToast('Connection to server lost. Retrying...', 'error');
      // Retry connection every 2s
      if (!reconnectInterval) {
        reconnectInterval = setInterval(connectWebSocket, 2000);
      }
    }
  };

  socket.onerror = (err) => {
    console.error('WebSocket Error:', err);
  };
}

function disconnectSocket() {
  if (reconnectInterval) {
    clearInterval(reconnectInterval);
    reconnectInterval = null;
  }
  if (socket) {
    socket.close();
    socket = null;
  }
}

function sendWSMessage(msg: ClientMessage) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
  } else {
    showToast('Cannot send message. Disconnected.', 'error');
  }
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'ROOM_STATE':
      updateRoomUI(msg.payload);
      break;
    case 'TOAST':
      showToast(msg.payload.message, msg.payload.type);
      break;
    case 'KICK':
      showToast(msg.payload.message, 'error');
      disconnectSocket();
      cleanupRoomState();
      navigateTo('/');
      break;
  }
}

// -------------------------------------------------------------
// ROOM / GAME ACTIONS
// -------------------------------------------------------------

function handleCreateRoom() {
  const enteredUsername = usernameInput.value.trim();
  if (!enteredUsername) {
    showToast('Please enter a username first.', 'error');
    return;
  }
  
  username = enteredUsername;
  localStorage.setItem('bingo-username', username);

  // Send request to server to allocate a room. We do this by hitting a REST API
  // or opening a WS with a blank room code, but the server handles REST room creation nicely.
  fetch('/api/create-room', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, playerId })
  })
  .then(res => res.json())
  .then(data => {
    if (data.success && data.roomCode) {
      roomCode = data.roomCode;
      navigateTo(`/room/${roomCode}`);
    } else {
      showToast(data.message || 'Failed to create room.', 'error');
    }
  })
  .catch(err => {
    showToast('Network error while creating room.', 'error');
  });
}

function handleJoinRoom() {
  const enteredUsername = usernameInput.value.trim();
  const enteredCode = joinCodeInput.value.trim().toUpperCase();

  if (!enteredUsername) {
    showToast('Please enter a username first.', 'error');
    return;
  }
  if (!enteredCode || enteredCode.length < 4) {
    showToast('Please enter a valid 4-digit room code.', 'error');
    return;
  }

  username = enteredUsername;
  localStorage.setItem('bingo-username', username);
  roomCode = enteredCode;

  navigateTo(`/room/${roomCode}`);
}

function joinGameRoom() {
  if (!username) {
    // If username is not set, we must prompt the user
    // We render the username prompt inline in the landing view
    switchView('landing');
    showToast('Please enter your username to join the room.', 'info');
    return;
  }
  
  switchView('room');
  roomCodeDisplay.textContent = roomCode;
  connectWebSocket();
}

// -------------------------------------------------------------
// RENDER & UI UPDATES
// -------------------------------------------------------------

function updateRoomUI(state: RoomStatePayload) {
  currentRoomState = state;
  roomCode = state.roomCode;
  roomCodeDisplay.textContent = state.roomCode;
  
  // Make sure current URL is updated to match room code (useful for popstates/initial creators)
  if (window.location.pathname !== `/room/${state.roomCode}`) {
    window.history.replaceState(null, '', `/room/${state.roomCode}`);
  }

  const me = state.players.find(p => p.id === playerId);
  const opponent = state.players.find(p => p.id !== playerId);

  // Render "Me" section
  if (me) {
    myUsername.textContent = `${me.username} (You)`;
    myStatusBadge.textContent = me.ready ? 'READY' : 'SETUP';
    if (me.ready) {
      myStatusBadge.classList.add('ready');
    } else {
      myStatusBadge.classList.remove('ready');
    }

    // Creator settings
    if (me.isCreator) {
      creatorControls.classList.remove('hidden');
      // Creator can toggle let opponent start in setup or waiting phase
      if (state.phase === 'setup' || state.phase === 'waiting') {
        chkOpponentStart.disabled = false;
        chkOpponentStart.checked = state.letOpponentStart;
      } else {
        chkOpponentStart.disabled = true;
      }
    } else {
      creatorControls.classList.add('hidden');
    }
  }

  // Render "Opponent" section
  if (opponent) {
    opponentUsername.textContent = opponent.username;
    opponentStatusBadge.textContent = opponent.ready ? 'READY' : 'SETUP';
    if (opponent.ready) {
      opponentStatusBadge.classList.add('ready');
    } else {
      opponentStatusBadge.classList.remove('ready');
    }

    if (!opponent.connected) {
      opponentStatusBadge.textContent = 'DISCONNECTED';
      opponentStatusBadge.classList.remove('ready');
    }
  } else {
    opponentUsername.textContent = 'Waiting for opponent...';
    opponentStatusBadge.textContent = 'NOT IN ROOM';
    opponentStatusBadge.classList.remove('ready');
  }

  // Render state according to phases
  renderPhaseView(state, me, opponent);
}

function renderPhaseView(state: RoomStatePayload, me?: any, opponent?: any) {
  // Hide all dynamic elements by default
  opponentGridOverlay.classList.add('hidden');
  setupControls.classList.add('hidden');
  turnBanner.classList.add('hidden');
  rematchControls.classList.add('hidden');

  myGrid.classList.remove('editing', 'match-active');
  opponentGrid.classList.remove('match-active');

  // Hide/Show instructions
  myInstruction.classList.add('hidden');
  opponentInstruction.classList.add('hidden');

  // Hide opponent board container during setup, waiting, or active match phases
  const opponentBoard = document.querySelector('.opponent-board') as HTMLElement;
  if (opponentBoard) {
    if (state.phase === 'waiting' || state.phase === 'setup' || state.phase === 'match') {
      opponentBoard.classList.add('hidden');
    } else {
      opponentBoard.classList.remove('hidden');
    }
  }

  // Sync server grid to localGrid if server has grid and user is ready or in match
  if (me && me.grid && (me.ready || state.phase === 'match' || state.phase === 'match_end')) {
    localGrid = [...me.grid];
  }

  // Render My Grid
  renderMyGrid(state, me);

  if (state.phase === 'waiting') {
    // Waiting for opponent to join
    opponentGridOverlay.classList.remove('hidden');
    blockerMessage.textContent = 'Share the Room Code to invite a friend...';
    renderOpponentEmptyGrid();
  } 
  else if (state.phase === 'setup') {
    // Both players present, setting up boards
    renderOpponentEmptyGrid();
    
    myInstruction.classList.remove('hidden');
    if (me && me.ready) {
      // Creator or Joiner is ready, wait for opponent
      myInstruction.textContent = 'Waiting for opponent to ready up...';
      opponentGridOverlay.classList.remove('hidden');
      blockerMessage.textContent = 'Waiting for opponent to ready up...';
    } else {
      // Editing Mode
      myInstruction.textContent = 'Select a cell & type 1-25. Use Enter/Tab to advance, or click Shuffle.';
      setupControls.classList.remove('hidden');
      myGrid.classList.add('editing');
      renderUnusedNumbers();
    }
  } 
  else if (state.phase === 'match') {
    // Match running
    myGrid.classList.add('match-active');
    
    // Render opponent grid
    renderOpponentGrid(state, opponent);
    
    // Enable instructions and turn indicator text at top of boards
    myInstruction.classList.remove('hidden');
    opponentInstruction.classList.remove('hidden');

    // Removed 3rd set of header (turnBanner) in active match
    
    if (state.turnPlayerId === playerId) {
      myInstruction.innerHTML = `<span style="color: var(--accent); font-weight: 700;">YOUR TURN</span> — Double-click a tile to call!`;
      myStatusBadge.textContent = 'YOUR TURN';
      myStatusBadge.className = 'status-badge ready';
      
      const oppName = opponent ? opponent.username : 'Opponent';
      opponentInstruction.textContent = 'Waiting for you...';
      opponentStatusBadge.textContent = 'WAITING';
      opponentStatusBadge.className = 'status-badge';
    } else {
      const oppName = opponent ? opponent.username : 'Opponent';
      myInstruction.textContent = `Waiting for ${oppName} to call...`;
      myStatusBadge.textContent = 'WAITING';
      myStatusBadge.className = 'status-badge';
      
      opponentInstruction.innerHTML = `<span style="color: var(--accent); font-weight: 700;">THEIR TURN</span>`;
      opponentStatusBadge.textContent = 'THEIR TURN';
      opponentStatusBadge.className = 'status-badge ready';
    }
  } 
  else if (state.phase === 'match_end') {
    // Match ended
    renderOpponentGrid(state, opponent);
    
    myInstruction.classList.remove('hidden');
    opponentInstruction.classList.remove('hidden');

    // Removed 3rd set of header (turnBanner) in match end

    if (state.winnerPlayerId === 'draw') {
      myInstruction.textContent = "IT'S A DRAW!";
      opponentInstruction.textContent = "IT'S A DRAW!";
      myStatusBadge.textContent = 'DRAW';
      myStatusBadge.className = 'status-badge';
      opponentStatusBadge.textContent = 'DRAW';
      opponentStatusBadge.className = 'status-badge';
    } else if (state.winnerPlayerId === playerId) {
      myInstruction.innerHTML = `<span style="color: var(--green); font-weight: 700;">BINGO! YOU WON! 🎉</span>`;
      myStatusBadge.textContent = 'WINNER';
      myStatusBadge.className = 'status-badge ready';
      
      opponentInstruction.textContent = 'Defeated';
      opponentStatusBadge.textContent = 'DEFEATED';
      opponentStatusBadge.className = 'status-badge';
    } else {
      myInstruction.textContent = 'Defeated';
      myStatusBadge.textContent = 'DEFEATED';
      myStatusBadge.className = 'status-badge';
      
      opponentInstruction.innerHTML = `<span style="color: var(--green); font-weight: 700;">WINNER 🎉</span>`;
      opponentStatusBadge.textContent = 'WINNER';
      opponentStatusBadge.className = 'status-badge ready';
    }

    // Rematch panel outcome styling and title updates
    const outcomeTitle = document.getElementById('matchOutcomeTitle') as HTMLElement;
    const outcomeSubtitle = document.getElementById('matchOutcomeSubtitle') as HTMLElement;

    rematchControls.classList.remove('hidden', 'outcome-win', 'outcome-lose', 'outcome-draw');
    btnRequestRematch.classList.remove('hidden');
    rematchIncomingControls.classList.add('hidden');

    if (state.winnerPlayerId === 'draw') {
      outcomeTitle.textContent = "DRAW";
      outcomeTitle.style.color = 'var(--subtext)';
      outcomeSubtitle.textContent = "It's a draw! Would you like a rematch?";
      rematchControls.classList.add('outcome-draw');
    } else if (state.winnerPlayerId === playerId) {
      outcomeTitle.textContent = "VICTORY! 🎉";
      outcomeTitle.style.color = 'var(--green)';
      outcomeSubtitle.textContent = "You won the match! Would you like a rematch?";
      rematchControls.classList.add('outcome-win');
    } else {
      outcomeTitle.textContent = "DEFEAT";
      outcomeTitle.style.color = 'var(--red)';
      outcomeSubtitle.textContent = "You lost the match. Would you like a rematch?";
      rematchControls.classList.add('outcome-lose');
    }

    const myRematch = state.rematchStates[playerId];
    const oppRematch = opponent ? state.rematchStates[opponent.id] : null;

    if (myRematch === 'requested') {
      btnRequestRematch.classList.add('hidden');
      rematchStatusText.textContent = 'Rematch requested. Waiting for opponent...';
    } else if (oppRematch === 'requested') {
      btnRequestRematch.classList.add('hidden');
      rematchIncomingControls.classList.remove('hidden');
      rematchStatusText.textContent = `${opponent.username} requested a rematch!`;
    } else {
      btnRequestRematch.disabled = false;
      rematchStatusText.textContent = '';
    }
  }
}

// -------------------------------------------------------------
// GRID RENDERING
// -------------------------------------------------------------

function renderMyGrid(state: RoomStatePayload, me: any) {
  myGrid.innerHTML = '';
  
  // Helper to save the value currently in the input box to the active cell
  const saveActiveInput = (index: number) => {
    const input = myGrid.querySelector('input');
    if (!input) return;

    const rawVal = input.value.trim();
    if (rawVal === '') {
      localGrid[index] = null;
    } else {
      const num = parseInt(rawVal, 10);
      if (isNaN(num) || num < 1 || num > 25) {
        localGrid[index] = null;
      } else {
        // Auto-swap check if value is present elsewhere on board
        const existingIdx = localGrid.indexOf(num);
        if (existingIdx !== -1 && existingIdx !== index) {
          localGrid[existingIdx] = localGrid[index];
        }
        localGrid[index] = num;
      }
    }
    sendGridToServer();
    renderUnusedNumbers();
  };

  for (let i = 0; i < 25; i++) {
    const val = localGrid[i];
    const isMarked = me ? me.marked[i] : false;
    
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    if (isMarked) cell.classList.add('marked');
    if (val !== null && state.lastCalledNumber !== null && val === state.lastCalledNumber) {
      cell.classList.add('last-called');
    }
    
    // In setup mode & editable, add manual editing input hooks
    if (state.phase === 'setup' && (!me || !me.ready)) {
      if (activeInputCellIndex === i) {
        cell.classList.add('active-input');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = '25';
        
        // Suggest the next sequential unused number if cell is currently blank
        let startVal = val;
        if (startVal === null) {
          startVal = findSmallestUnused();
        }
        input.value = startVal ? startVal.toString() : '';
        cell.appendChild(input);

        // Auto focus and select suggestion text immediately for instant overwrite
        setTimeout(() => {
          input.focus();
          input.select();
        }, 0);

        // Advance on Enter or Tab
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault();
            saveActiveInput(i);
            
            // Set next cell index
            activeInputCellIndex = (i + 1) % 25;
            renderMyGrid(state, me);

            // Trigger auto-focus and auto-select on next cell's input
            setTimeout(() => {
              const nextInput = myGrid.querySelector('input');
              if (nextInput) {
                nextInput.focus();
                nextInput.select();
              }
            }, 0);
          }
        });

        // Save and exit cell edit on blur (e.g. clicking outside)
        input.addEventListener('blur', () => {
          // Delay briefly to allow click transitions to set state first
          setTimeout(() => {
            if (activeInputCellIndex === i) {
              saveActiveInput(i);
              activeInputCellIndex = null;
              renderMyGrid(state, me);
            }
          }, 150);
        });

      } else {
        cell.textContent = val ? val.toString() : '';
        cell.addEventListener('click', () => {
          // If another cell was currently being edited, save its value first
          if (activeInputCellIndex !== null) {
            saveActiveInput(activeInputCellIndex);
          }
          activeInputCellIndex = i;
          renderMyGrid(state, me);
        });
      }
    } else {
      // Normal display mode
      cell.textContent = val ? val.toString() : '';
      
      // Match phase click logic
      if (state.phase === 'match' && state.turnPlayerId === playerId && !isMarked && val) {
        cell.addEventListener('dblclick', () => {
          sendWSMessage({
            type: 'CALL_NUMBER',
            payload: { num: val }
          });
        });
      }
    }

    myGrid.appendChild(cell);
  }
}

function renderOpponentGrid(state: RoomStatePayload, opponent: any) {
  opponentGrid.innerHTML = '';
  
  if (!opponent || !opponent.grid) {
    renderOpponentEmptyGrid();
    return;
  }

  for (let i = 0; i < 25; i++) {
    const val = opponent.grid[i];
    const isMarked = opponent.marked[i];
    
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    cell.textContent = val ? val.toString() : '';
    if (isMarked) cell.classList.add('marked');
    if (val !== null && state.lastCalledNumber !== null && val === state.lastCalledNumber) {
      cell.classList.add('last-called');
    }

    opponentGrid.appendChild(cell);
  }
}

function renderOpponentEmptyGrid() {
  opponentGrid.innerHTML = '';
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement('div');
    cell.className = 'bingo-cell';
    opponentGrid.appendChild(cell);
  }
}

function renderUnusedNumbers() {
  unusedNumbers.innerHTML = '';
  for (let i = 1; i <= 25; i++) {
    const isUsed = localGrid.includes(i);
    const badge = document.createElement('div');
    badge.className = 'unused-badge';
    badge.textContent = i.toString();
    if (isUsed) {
      badge.classList.add('used');
    }
    unusedNumbers.appendChild(badge);
  }
}

function findSmallestUnused(): number | null {
  for (let i = 1; i <= 25; i++) {
    if (!localGrid.includes(i)) return i;
  }
  return null;
}

function randomizeLocalGrid() {
  const nums = Array.from({ length: 25 }, (_, i) => i + 1);
  // Fisher-Yates Shuffle
  for (let i = nums.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nums[i], nums[j]] = [nums[j], nums[i]];
  }
  localGrid = nums;
  sendGridToServer();
  
  if (currentRoomState) {
    const me = currentRoomState.players.find(p => p.id === playerId);
    renderMyGrid(currentRoomState, me);
  }
  renderUnusedNumbers();
}

function sendGridToServer() {
  // Convert any nulls to 0 (the server will validate and reject anyway, but keeps formatting stable)
  const gridToSend = localGrid.map(v => v || 0);
  sendWSMessage({
    type: 'SET_GRID',
    payload: { grid: gridToSend }
  });
}

function submitReadyState() {
  // Validate locally first
  const set = new Set(localGrid.filter(v => v !== null));
  if (set.size !== 25) {
    showToast('Please fill all 25 grid cells before marking ready!', 'error');
    return;
  }

  sendWSMessage({
    type: 'SET_READY',
    payload: { ready: true }
  });
}

// -------------------------------------------------------------
// THEME & ACCENT COLOR
// -------------------------------------------------------------

function initAccentColor() {
  const savedAccent = localStorage.getItem('bingo-accent') || 'mauve';
  setAccentColor(savedAccent);
}

function setAccentColor(colorName: string) {
  const hex = ACCENT_COLORS[colorName];
  if (!hex) return;

  // Set CSS Property
  document.documentElement.style.setProperty('--accent', hex);
  
  // Set RGB property for glass-morphic highlights
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  document.documentElement.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.15)`);

  localStorage.setItem('bingo-accent', colorName);

  // Update active color button ring
  const buttons = document.querySelectorAll('.color-btn');
  buttons.forEach(btn => {
    if (btn.getAttribute('data-color') === colorName) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
}

// -------------------------------------------------------------
// TOAST NOTIFICATIONS SYSTEM
// -------------------------------------------------------------

function showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  toastContainer.appendChild(toast);

  // Remove toast after 3.5s
  setTimeout(() => {
    toast.classList.add('toast-fadeout');
    toast.addEventListener('animationend', () => {
      toast.remove();
    });
  }, 3500);
}

// Helper to escape HTML to prevent XSS injection
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
