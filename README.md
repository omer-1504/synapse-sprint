# Synapse Sprint

**Synapse Sprint** is a real-time, competitive multiplayer math grid game designed to test players' mental arithmetic speed and hand-eye coordination. Players join a shared room, select a faction color, and race to claim a sequence of 100 math tiles (evaluating to numbers 1 through 100) in ascending order. 

The game combines immediate client-side reactivity with real-time database persistence and WebSocket broadcasting, creating a seamless competitive environment.

---

## 🎮 How It Works

1. **The Game Board**:
   - The interface renders a grid of 100 tiles containing generated mathematical expressions (e.g., `15 + 4`, `24 - 5`).
   - Every expression evaluates to a unique integer between `1` and `100`.
   - The tiles are shuffled randomly across the grid, meaning they are not in sequential order.

2. **Sequential Target Tracking**:
   - The game tracks a global target value (`current_target`) starting at `1`.
   - Players must quickly scan the grid, find the math expression that evaluates to the current target, and click it.

3. **Real-time Claims & Scoring**:
   - **Correct Selection**: Clicking the correct tile immediately claims it for the player's faction (assigning their name and color), increments the global target by 1, and awards 10 points.
   - **Incorrect Selection**: Clicking an incorrect tile triggers a localized shake animation and an error flash, penalizing the player by slowing down their response time.
   - The game concludes once the target reaches `101` (all 100 tiles claimed). The player/faction with the most claims is declared the winner via a modal overlay.

4. **Bi-directional Synchronization**:
   - **Supabase PostgreSQL & Realtime**: Initial board configuration and current game target are loaded from the database (`brain_tiles` and `brain_game` tables). When a tile is claimed, the change is written back to the database. Simultaneously, the event is broadcast using Supabase Realtime Channels to all other active players.
   - **Tab-to-Tab Sync**: A local `BroadcastChannel` fallback syncs state across multiple browser tabs locally without creating duplicate WebSocket traffic.
   - **WebSocket Console**: A built-in terminal console in the UI visualizes incoming (`RECV`) and outgoing (`SEND`) real-time WebSocket payloads (`tile-selected`, `sync-request`, `sync-response`, `new-game`) for developer and user transparency.

---

## 🛠️ Technology Stack & Decisions

### 1. Next.js 16 & React 19
- **Why**: React's component-driven paradigm fits interactive board games perfectly. Next.js provides standard project scaffolding, fast routing, and efficient compilation.
- **Benefits**: React 19's performance improvements and modern hook patterns ensure low latency during fast-paced user interactions.

### 2. Supabase (PostgreSQL & Realtime Channels)
- **Why**: Building and hosting a dedicated WebSocket server (e.g., using Node.js/Go and Socket.io) introduces deployment, scaling, and maintenance complexity. Supabase provides a managed, robust PostgreSQL database alongside Realtime Broadcast features.
- **Benefits**: We can store the game state persistently while broadcasting user events over high-performance WebSockets out of the box with minimal configuration.

### 3. Tailwind CSS v4
- **Why**: Tailwind CSS v4 provides modernized styling utilities and extreme flexibility for layouts.
- **Benefits**: Custom colors, custom grid gaps, and interactive hover scales are written directly in the class lists, facilitating rapid UI updates and keeping styles unified with the project design language.

### 4. Framer Motion
- **Why**: Enhances user experience (UX) with hardware-accelerated animations.
- **Benefits**: Handles the satisfying tile expansion on hover, the custom shake animation for wrong answers, and the smooth transitions of the leaderboard bars and victory overlay.

---

## ⚖️ Trade-offs & Architecture Decisions

### 1. Optimistic Updates vs. Transactional Integrity (Race Conditions)
* **Trade-off**: To maximize responsiveness, tile claims are processed optimistically on the client before completing the database transaction. If two players click the same correct tile within milliseconds of each other:
  - Both might briefly see the tile change to their color.
  - The final claim is resolved by whichever event propagates through the WebSocket broadcast and Supabase updates first.
* **Alternative**: Implementing server-side transactional locking (e.g., database procedures with locks) would guarantee strict consistency but introduce significant latency, degrading the speed-oriented feel of the game.

### 2. Room Scalability (Single-Room Design)
* **Trade-off**: The database schema is designed for a single global game session (`id = 1` in `brain_game` and a static list in `brain_tiles`). 
* **Alternative**: Scaling this to a SaaS or production multi-room environment would require refactoring the database schema to support `rooms` and relational foreign keys on `tiles`, separating game instances.

### 3. Client-driven Sync and Setup
* **Trade-off**: When a new player joins, they broadcast a `sync-request`. Existing active tabs answer with a `sync-response` payload containing the current board. If no active tabs are present, the app pulls from the database or generates a fresh local state.
* **Alternative**: Having the server fully compute and serialize the game board reduces trust on the client but increases server computation. The current approach prioritizes lower server load and rapid local play.

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+
- A Supabase project with the schema from `supabase_schema.sql` applied.

### Environment Setup
Create a `.env.local` file in the root directory:
```env
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Installation & Run
1. Install dependencies:
   ```bash
   npm install
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Open [http://localhost:3000](http://localhost:3000) in your browser. Open multiple tabs to test the real-time syncing!
