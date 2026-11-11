# Oddword

A browser party game: everyone gets the same secret word, except one player who gets a different (related) one and doesn't know it. Write hints, chat, vote the odd one out.

## Run it
```
npm install
npm start
```
Open http://localhost:3000. For friends on the same Wi-Fi, share `http://<your-computer-ip>:3000`. To play over the internet, deploy to any Node host (Render, Railway, Fly.io) — it only needs `npm start`.

## Rules
- Enter a name (nothing is stored), create a lobby, share the 6-character code. 3–12 players.
- Host starts the game. Each round: **hint** (everyone writes one) → **discuss** (chat) → **vote**.
- Most votes is eliminated. If most people skip, or the vote is tied, nobody goes out and the next round starts.
- Group wins by voting out the odd player (+100 each, +25 for everyone who voted for them).
- Odd player wins (+200) if only 2 players remain or they survive 6 rounds.
- Scores live in server memory until the host closes the lobby. "Play again" keeps them.

## Files
- `server.js` – Express + Socket.IO game server (all state in memory)
- `words.js` – word pairs, add your own
- `public/` – the browser client (`index.html`, `style.css`, `app.js`)
