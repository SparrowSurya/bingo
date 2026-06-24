# 🎱 Bingo

A modern, real-time, two-player web-based Bingo game played on a 5×5 grid. Built with **TypeScript**, **BunJS**, and **WebSockets**.

Designed with the **Catppuccin Mocha** dark theme palette and styled with a flat, premium visual aesthetic using the **Space Grotesk** typography.

---

## 🚀 Tech Stack

* **Language:** TypeScript (Server & Client)
* **Backend Runtime:** BunJS
* **Frontend:** Vanilla HTML/CSS (No framework/build split, served directly by Bun)
* **Real-time Sync:** WebSockets (native Bun WebSocket server)
* **In-memory State:** All room and game states live in server memory (no database required)

---

## ✨ Features

* **Real-time Synchronization:** Multi-user sessions synced immediately via native WebSockets.
* **Server-Authoritative Game Loop:** All moves, turn transitions, grids, ready states, and win resolutions are strictly validated on the server.
* **Reconnection Grace Period (~10s):** If a player temporarily disconnects or refreshes the page, they are silently reconnected to their seat, grid, and turn status without ending the match.
* **Triple Grid Setup Modes:**
  1. **Shuffle Grid:** Instantly generates a randomized sequence of 1–25.
  2. **Sequential Click-Fill:** Clicking an empty cell places the next unused number (1, 2, 3...).
  3. **Manual Typing:** Click a filled cell to input or change a specific number manually (automatic swapping occurs if the number is already on the board).
* **Rematch flow:** Accept/decline prompts allow players to immediately transition back to the setup phase with empty boards.
* **Theme customizer:** Select your preferred color accent (Mauve, Blue, Teal, etc.) from the persistent header, stored in the browser's `localStorage`.
* **Responsive Layout:** Playable on both desktop monitors and mobile touchscreens.

---

## 🛠️ Project Structure

```
├── public/
│   ├── index.html        # SPA views, dialogue components, and toast containers
│   └── style.css         # Catppuccin theme styling, layout styles, and animations
├── src/
│   ├── client.ts         # Frontend logic, WebSocket handlers, and grid renderers
│   ├── game.ts           # Authoritative BingoRoom state machine & win checks
│   ├── server.ts         # Bun server serving static files, bundling JS, and WS upgrade
│   └── types.ts          # Shared TypeScript type definitions
├── tsconfig.json         # TypeScript configuration
├── package.json          # Dependency and runner script metadata
└── PLAN.md               # Original project roadmap and requirements
```

---

## 💻 Getting Started

### Prerequisites
Make sure you have [Bun](https://bun.sh) installed.

### 1. Clone the project and install dependencies
```bash
bun install
```

### 2. Run the server
For development (with automatic reloading on file changes):
```bash
bun run dev
```

For production:
```bash
bun run start
```

### 3. Open the app
Navigate to [http://localhost:3000](http://localhost:3000) in your web browsers. Open two windows side-by-side to play the game!

---

## 🎮 How to Play

1. **Enter Username:** Set a username on the home page.
2. **Create or Join a Room:**
   * Click **Create New Room** to initialize a new session and get a 4-digit code. Share this code with a friend.
   * Or, paste your friend's code into the input field and click **Join Room**.
3. **Setup Phase:**
   * Fill your 5×5 grid with numbers 1 to 25.
   * You can type numbers, click empty spaces, or shuffle.
   * If you are the creator, you can choose if you want your opponent to take the first turn.
   * Press **Mark Ready**. Once ready, your grid will lock.
4. **Match Phase:**
   * Take turns calling out numbers. On your turn, **double-click** a number on your board.
   * That number gets crossed out on **both** players' boards.
5. **Winning:**
   * The first player to get 5 crossed-out cells in an unbroken straight line (horizontal, vertical, or diagonal) wins the match.
   * If a single move completes a line on both players' grids simultaneously, the match ends in a **Draw**.
6. **Rematch:**
   * At the end of the match, either player can request a rematch. If accepted, both players return to the setup phase.
