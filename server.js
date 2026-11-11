const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const WORD_PAIRS = require('./words');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- constants ---------- */
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid mix-ups
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 12;
const MAX_ROUNDS = 6;          // if the odd player survives this long, they win
const REVEAL_MS = 7000;
const RESULT_MS = 10000;
const GRACE_LOBBY_MS = 15000;  // disconnect grace period
const GRACE_GAME_MS = 45000;
const EMPTY_ROOM_MS = 120000;
const SCORE = { civilianWin: 100, oddWin: 200, correctVote: 25 };

const rooms = new Map(); // code -> room (lives only in memory)

/* ---------- helpers ---------- */
const rid = (n = 8) => crypto.randomBytes(n).toString('hex');
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 14);

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () => pick(CODE_CHARS)).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const room = {
    code: makeCode(),
    hostId: null,
    players: new Map(),
    phase: 'lobby', // lobby | reveal | hints | chat | vote | result | end
    round: 0,
    settings: { hintSec: 45, chatSec: 90, voteSec: 30 },
    hints: [],
    chat: [],
    result: null,
    final: null,
    secret: null,
    timer: null,
    timerEnd: 0,
    timerTotal: 0,
    emptyTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function newPlayer(name, socketId) {
  return {
    id: rid(), name, socketId, connected: true, left: false, score: 0, alive: true,
    role: 'civilian', word: null, hintDone: false, ready: false, voted: false, vote: null,
    lastChat: 0, dcTimer: null,
  };
}

const inGame = (room) => ['reveal', 'hints', 'chat', 'vote', 'result'].includes(room.phase);
const activePlayers = (room) => [...room.players.values()].filter((p) => p.alive && !p.left);
const connectedActive = (room) => activePlayers(room).filter((p) => p.connected);

function sysMsg(room, text) {
  room.chat.push({ id: rid(3), sys: true, text });
}

/* ---------- per-player view (never leaks other people's words/roles) ---------- */
function view(room, me) {
  const ph = room.phase;
  const players = [...room.players.values()].map((p) => ({
    id: p.id, name: p.name, score: p.score, alive: p.alive, connected: p.connected, left: p.left,
    host: p.id === room.hostId,
    done: ph === 'hints' ? p.hintDone : ph === 'chat' ? p.ready : ph === 'vote' ? p.voted : false,
  }));
  const hints = room.hints
    .filter((h) => ph !== 'hints' || h.round < room.round || h.pid === me.id)
    .map((h) => ({ round: h.round, pid: h.pid, name: room.players.get(h.pid)?.name || '?', text: h.text }));
  return {
    code: room.code, phase: ph, round: room.round, maxRounds: MAX_ROUNDS, hostId: room.hostId,
    serverNow: Date.now(), timerEnd: room.timerEnd, timerTotal: room.timerTotal,
    settings: room.settings, minPlayers: MIN_PLAYERS,
    players, hints, chat: room.chat.slice(-150),
    result: ph === 'result' ? room.result : null,
    final: (ph === 'result' && room.final) || ph === 'end' ? room.final : null,
    me: {
      id: me.id, alive: me.alive, host: me.id === room.hostId,
      word: inGame(room) || ph === 'end' ? me.word : null,
      voted: me.voted, vote: me.vote, ready: me.ready, hintDone: me.hintDone,
    },
  };
}

function broadcast(room) {
  for (const p of room.players.values()) {
    if (p.connected && p.socketId) io.to(p.socketId).emit('state', view(room, p));
  }
}

function setPhase(room, phase, ms, onEnd) {
  clearTimeout(room.timer);
  room.phase = phase;
  if (ms) {
    room.timerTotal = ms;
    room.timerEnd = Date.now() + ms;
    room.timer = setTimeout(() => {
      if (rooms.get(room.code) === room) onEnd();
    }, ms);
  } else {
    room.timerTotal = 0;
    room.timerEnd = 0;
  }
  broadcast(room);
}

function destroyRoom(room, notify = true) {
  clearTimeout(room.timer);
  clearTimeout(room.emptyTimer);
  for (const p of room.players.values()) {
    clearTimeout(p.dcTimer);
    if (notify && p.connected && p.socketId) io.to(p.socketId).emit('closed');
  }
  rooms.delete(room.code);
}

/* ---------- game flow ---------- */
function startGame(room) {
  // drop anyone who is gone
  for (const [id, p] of room.players) if (!p.connected || p.left) room.players.delete(id);
  const list = [...room.players.values()];
  if (list.length < MIN_PLAYERS) return false;

  const [a, b] = pick(WORD_PAIRS);
  const flip = Math.random() < 0.5;
  room.secret = { civ: flip ? b : a, odd: flip ? a : b };
  const odd = pick(list);
  for (const p of list) {
    p.alive = true;
    p.role = p === odd ? 'odd' : 'civilian';
    p.word = p === odd ? room.secret.odd : room.secret.civ;
    p.hintDone = p.ready = p.voted = false;
    p.vote = null;
  }
  room.round = 1;
  room.hints = [];
  room.chat = [];
  room.result = null;
  room.final = null;
  setPhase(room, 'reveal', REVEAL_MS, () => startHints(room));
  return true;
}

function startHints(room) {
  for (const p of room.players.values()) { p.hintDone = false; p.ready = false; p.voted = false; p.vote = null; }
  setPhase(room, 'hints', room.settings.hintSec * 1000, () => endHints(room));
}

function endHints(room) {
  if (room.phase !== 'hints') return;
  for (const p of activePlayers(room)) {
    if (!p.hintDone) {
      room.hints.push({ round: room.round, pid: p.id, text: '…' });
      p.hintDone = true;
    }
  }
  sysMsg(room, `Round ${room.round}: hints are in. Talk it out, then vote.`);
  setPhase(room, 'chat', room.settings.chatSec * 1000, () => startVote(room));
}

function startVote(room) {
  if (room.phase !== 'chat') return;
  for (const p of room.players.values()) { p.voted = false; p.vote = null; }
  sysMsg(room, 'Voting is open.');
  setPhase(room, 'vote', room.settings.voteSec * 1000, () => resolveVote(room));
}

function resolveVote(room) {
  if (room.phase !== 'vote') return;
  const active = activePlayers(room);
  const tally = {};
  const votes = [];
  let skips = 0;
  for (const p of active) {
    const target = p.voted && p.vote ? room.players.get(p.vote) : null;
    if (target) {
      tally[target.id] = (tally[target.id] || 0) + 1;
      votes.push({ voter: p.name, target: target.name, voterId: p.id, targetId: target.id });
    } else {
      skips++;
      votes.push({ voter: p.name, target: null, voterId: p.id, targetId: null });
    }
  }

  let top = [], max = 0;
  for (const [id, n] of Object.entries(tally)) {
    if (n > max) { max = n; top = [id]; } else if (n === max) top.push(id);
  }

  let eliminated = null, reason = null;
  if (skips * 2 > active.length) reason = 'skip';
  else if (top.length !== 1) reason = 'tie';
  else eliminated = room.players.get(top[0]);

  let bonusNames = [];
  if (eliminated) {
    eliminated.alive = false;
    if (eliminated.role === 'odd') {
      for (const v of votes) {
        if (v.targetId === eliminated.id) {
          const vp = room.players.get(v.voterId);
          if (vp) { vp.score += SCORE.correctVote; bonusNames.push(vp.name); }
        }
      }
    }
  }

  // win checks
  let winner = null, endReason = null;
  const odd = [...room.players.values()].find((p) => p.role === 'odd');
  if (eliminated && eliminated.role === 'odd') { winner = 'civilians'; endReason = 'caught'; }
  else if (activePlayers(room).length <= 2) { winner = 'odd'; endReason = 'outnumbered'; }
  else if (room.round >= MAX_ROUNDS) { winner = 'odd'; endReason = 'survived'; }
  else if (odd && (odd.left || !odd.alive)) { winner = 'civilians'; endReason = 'caught'; }

  room.result = {
    round: room.round,
    eliminatedId: eliminated ? eliminated.id : null,
    eliminatedName: eliminated ? eliminated.name : null,
    wasOdd: eliminated ? eliminated.role === 'odd' : false,
    reason, skips, tally, votes, bonusNames,
    gameOver: !!winner, winner,
  };
  if (winner) finalize(room, winner, endReason);
  else sysMsg(room, eliminated ? `${eliminated.name} was voted out.` : 'Nobody was voted out.');

  setPhase(room, 'result', RESULT_MS, () => {
    if (room.result.gameOver) setPhase(room, 'end', 0);
    else { room.round++; startHints(room); }
  });
}

function finalize(room, winner, reason) {
  const odd = [...room.players.values()].find((p) => p.role === 'odd');
  room.final = {
    winner, reason,
    civWord: room.secret.civ, oddWord: room.secret.odd,
    oddId: odd ? odd.id : null, oddName: odd ? odd.name : '?',
  };
  for (const p of room.players.values()) {
    if (p.left) continue;
    if (winner === 'civilians' && p.role === 'civilian') p.score += SCORE.civilianWin;
    if (winner === 'odd' && p.role === 'odd') p.score += SCORE.oddWin;
  }
}

function checkProgress(room) {
  const need = connectedActive(room);
  if (!need.length) return;
  if (room.phase === 'hints' && need.every((p) => p.hintDone)) endHints(room);
  else if (room.phase === 'chat' && need.filter((p) => p.ready).length * 2 > need.length) startVote(room);
  else if (room.phase === 'vote' && need.every((p) => p.voted)) resolveVote(room);
}

function reassignHost(room) {
  const next = [...room.players.values()].find((p) => p.connected && !p.left);
  room.hostId = next ? next.id : null;
}

function removePlayer(room, id) {
  const p = room.players.get(id);
  if (!p) return;
  clearTimeout(p.dcTimer);

  if (!inGame(room)) {
    room.players.delete(id);
  } else {
    p.left = true; p.alive = false; p.connected = false; p.socketId = null;
  }
  if (room.hostId === id) reassignHost(room);

  const stillHere = [...room.players.values()].some((x) => x.connected && !x.left);
  if (!stillHere) return destroyRoom(room, false);

  if (inGame(room) && room.phase !== 'result') {
    const odd = [...room.players.values()].find((x) => x.role === 'odd');
    if (odd && (odd.left || !odd.alive)) {
      sysMsg(room, 'The odd player left. Civilians win.');
      finalize(room, 'civilians', 'caught');
      return setPhase(room, 'end', 0);
    }
    if (activePlayers(room).length <= 2) {
      finalize(room, 'odd', 'outnumbered');
      return setPhase(room, 'end', 0);
    }
    sysMsg(room, `${p.name} left the game.`);
    checkProgress(room);
  }
  broadcast(room);
}

/* ---------- sockets ---------- */
function attach(socket, room, p) {
  clearTimeout(p.dcTimer);
  clearTimeout(room.emptyTimer);
  p.connected = true;
  p.socketId = socket.id;
  socket.data.code = room.code;
  socket.data.pid = p.id;
}

io.on('connection', (socket) => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const p = room && room.players.get(socket.data.pid);
    return room && p ? { room, p } : null;
  };

  socket.on('create', ({ name } = {}, cb = () => {}) => {
    name = cleanName(name);
    if (!name) return cb({ ok: false, error: 'Enter a name first.' });
    const room = createRoom();
    const p = newPlayer(name, socket.id);
    room.players.set(p.id, p);
    room.hostId = p.id;
    attach(socket, room, p);
    cb({ ok: true, code: room.code, pid: p.id, name });
    broadcast(room);
  });

  socket.on('join', ({ name, code, pid } = {}, cb = () => {}) => {
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'No lobby found with that code.' });

    // reconnect with saved identity
    const existing = pid && room.players.get(pid);
    if (existing && !existing.left) {
      attach(socket, room, existing);
      cb({ ok: true, code, pid: existing.id, name: existing.name });
      return broadcast(room);
    }

    name = cleanName(name);
    if (!name) return cb({ ok: false, error: 'Enter a name first.' });
    if (!['lobby', 'end'].includes(room.phase)) return cb({ ok: false, error: 'That game has already started.' });
    if (room.players.size >= MAX_PLAYERS) return cb({ ok: false, error: 'That lobby is full.' });
    const taken = [...room.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
    if (taken) return cb({ ok: false, error: 'Someone in that lobby already has this name.' });

    const p = newPlayer(name, socket.id);
    room.players.set(p.id, p);
    attach(socket, room, p);
    cb({ ok: true, code, pid: p.id, name });
    broadcast(room);
  });

  socket.on('settings', (s = {}) => {
    const c = ctx(); if (!c || c.room.hostId !== c.p.id || c.room.phase !== 'lobby') return;
    const clamp = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.min(hi, Math.max(lo, Math.round(+v))) : d);
    const st = c.room.settings;
    st.hintSec = clamp(s.hintSec, 15, 120, st.hintSec);
    st.chatSec = clamp(s.chatSec, 30, 300, st.chatSec);
    st.voteSec = clamp(s.voteSec, 15, 90, st.voteSec);
    broadcast(c.room);
  });

  socket.on('start', (_, cb = () => {}) => {
    const c = ctx(); if (!c || c.room.hostId !== c.p.id) return;
    if (!['lobby', 'end'].includes(c.room.phase)) return;
    if (!startGame(c.room)) cb({ ok: false, error: `Need at least ${MIN_PLAYERS} players.` });
  });

  socket.on('hint', (text, cb = () => {}) => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (room.phase !== 'hints' || !p.alive || p.hintDone) return;
    text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!text) return cb({ ok: false, error: 'Write a hint first.' });
    if (text.toLowerCase() === String(p.word).toLowerCase()) return cb({ ok: false, error: 'Don’t use your word as the hint.' });
    room.hints.push({ round: room.round, pid: p.id, text });
    p.hintDone = true;
    cb({ ok: true });
    checkProgress(room);
    broadcast(room);
  });

  socket.on('chat', (text) => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (!['chat', 'vote'].includes(room.phase) || !p.alive) return;
    text = String(text || '').trim().slice(0, 200);
    const now = Date.now();
    if (!text || now - p.lastChat < 400) return;
    p.lastChat = now;
    room.chat.push({ id: rid(3), pid: p.id, name: p.name, text });
    if (room.chat.length > 300) room.chat.shift();
    broadcast(room);
  });

  socket.on('ready', () => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (room.phase !== 'chat' || !p.alive) return;
    p.ready = !p.ready;
    checkProgress(room);
    if (room.phase === 'chat') broadcast(room);
  });

  socket.on('vote', (target) => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (room.phase !== 'vote' || !p.alive || p.voted) return;
    if (target) {
      const t = room.players.get(target);
      if (!t || !t.alive || t.left || t.id === p.id) return;
      p.vote = t.id;
    } else p.vote = null;
    p.voted = true;
    checkProgress(room);
    if (room.phase === 'vote') broadcast(room);
  });

  socket.on('again', () => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (room.hostId !== p.id || room.phase !== 'end') return;
    for (const [id, x] of room.players) if (x.left || !x.connected) room.players.delete(id);
    for (const x of room.players.values()) {
      x.alive = true; x.role = 'civilian'; x.word = null;
      x.hintDone = x.ready = x.voted = false; x.vote = null;
    }
    room.round = 0; room.hints = []; room.chat = []; room.result = null; room.final = null; room.secret = null;
    setPhase(room, 'lobby', 0);
  });

  socket.on('leave', () => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    socket.data.code = null;
    removePlayer(room, p.id);
  });

  socket.on('close', () => {
    const c = ctx(); if (!c || c.room.hostId !== c.p.id) return;
    destroyRoom(c.room, true);
  });

  socket.on('disconnect', () => {
    const c = ctx(); if (!c) return;
    const { room, p } = c;
    if (p.socketId !== socket.id) return; // already re-attached from another socket
    p.connected = false;
    p.socketId = null;
    clearTimeout(p.dcTimer);
    p.dcTimer = setTimeout(() => {
      if (rooms.get(room.code) === room && !p.connected) removePlayer(room, p.id);
    }, inGame(room) ? GRACE_GAME_MS : GRACE_LOBBY_MS);

    if (![...room.players.values()].some((x) => x.connected)) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = setTimeout(() => destroyRoom(room, false), EMPTY_ROOM_MS);
    } else {
      if (inGame(room)) checkProgress(room);
      broadcast(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Oddword is running → http://localhost:${PORT}`));
