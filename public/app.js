/* Oddword client – plain JS, no build step */
const socket = io();
const app = document.getElementById('app');
const $ = (s, r = document) => r.querySelector(s);

let S = null;                 // latest state from server
let session = load();         // { code, pid, name } kept in sessionStorage so a refresh rejoins
let clockOffset = 0;
let stageKey = '';
let seenMsgs = new Set();

function load() { try { return JSON.parse(sessionStorage.getItem('oddword')); } catch { return null; } }
function save() { session ? sessionStorage.setItem('oddword', JSON.stringify(session)) : sessionStorage.removeItem('oddword'); }
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

/* ---------- doodle avatars, drawn from the player's name ---------- */
const COLORS = ['#ff5d73', '#ffd23f', '#25d9a0', '#4cc3ff', '#ff9f43', '#b18cff', '#ff8ad8', '#8be04e'];
function hash(s) { let h = 7; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
function avatar(name, size = 36) {
  const h = hash(name);
  const col = COLORS[h % COLORS.length];
  const mouths = [
    '<path d="M16 29q8 7 16 0" />',
    '<path d="M17 30h14" />',
    '<ellipse cx="24" cy="31" rx="4" ry="3" fill="#22174f"/>',
    '<path d="M16 28q4 6 8 0q4 6 8 0" />',
  ];
  const eyes = [
    '<circle cx="17" cy="20" r="3" fill="#22174f"/><circle cx="31" cy="20" r="3" fill="#22174f"/>',
    '<path d="M14 21q3-5 6 0M28 21q3-5 6 0"/>',
    '<circle cx="17" cy="20" r="4" fill="#fff"/><circle cx="31" cy="20" r="4" fill="#fff"/><circle cx="18" cy="21" r="2" fill="#22174f"/><circle cx="32" cy="21" r="2" fill="#22174f"/>',
  ];
  const shapes = [
    '<circle cx="24" cy="24" r="21"/>',
    '<rect x="4" y="4" width="40" height="40" rx="14"/>',
    '<path d="M24 3c14 0 21 10 21 21s-8 21-21 21S3 36 3 24 10 3 24 3z"/>',
  ];
  return `<svg class="avatar" width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" stroke="#22174f" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g fill="${col}">${shapes[(h >> 3) % shapes.length]}</g>${eyes[(h >> 5) % eyes.length]}${mouths[(h >> 7) % mouths.length]}</svg>`;
}

/* ---------- home ---------- */
function renderHome() {
  S = null; stageKey = '';
  const urlCode = (new URLSearchParams(location.search).get('code') || '').toUpperCase();
  app.innerHTML = `
    <div class="home"><div class="home-inner">
      <div class="logo">Oddword</div>
      <p class="tagline">Everyone gets the same secret word. Except one of you. Find the odd one out.</p>
      <form class="card stack" id="homeForm" autocomplete="off">
        <input class="input" id="name" maxlength="14" placeholder="Your name" value="${esc(localStorage.getItem('oddword-name') || '')}" aria-label="Your name">
        <button class="btn mint" type="button" id="create">Create a lobby</button>
        <div class="or">or join with a code</div>
        <div class="row">
          <input class="input code-input" id="code" maxlength="6" placeholder="ABC123" value="${esc(urlCode)}" aria-label="Lobby code">
          <button class="btn" type="submit" id="join">Join</button>
        </div>
      </form>
      <p class="how">Write hints, chat, then vote out the player you think has a different word. No accounts, nothing saved.</p>
    </div></div>`;

  const nameEl = $('#name');
  const getName = () => {
    const n = nameEl.value.trim();
    if (!n) { toast('Enter a name first.'); nameEl.focus(); return null; }
    localStorage.setItem('oddword-name', n);
    return n;
  };
  const enter = (res) => {
    if (!res.ok) return toast(res.error);
    session = { code: res.code, pid: res.pid, name: res.name };
    save();
  };
  $('#create').onclick = () => { const name = getName(); if (name) socket.emit('create', { name }, enter); };
  $('#homeForm').onsubmit = (e) => {
    e.preventDefault();
    const name = getName(); if (!name) return;
    const code = $('#code').value.trim();
    if (code.length < 6) return toast('Lobby codes have 6 characters.');
    socket.emit('join', { name, code }, enter);
  };
  (urlCode ? $('#name') : nameEl).focus();
}

/* ---------- room frame ---------- */
const PHASE_LABEL = {
  lobby: () => 'Lobby', reveal: () => `Round ${S.round} · Get ready`, hints: () => `Round ${S.round} · Write a hint`,
  chat: () => `Round ${S.round} · Discuss`, vote: () => `Round ${S.round} · Vote`, result: () => `Round ${S.round} · Result`, end: () => 'Game over',
};

function mountRoom() {
  if ($('.room')) return;
  app.innerHTML = `
    <div class="room">
      <header class="bar">
        <div class="mini-logo">Oddword</div>
        <button class="chip" id="codeChip" title="Copy invite link">Code <b id="codeTxt"></b></button>
        <span class="phase-label" id="phaseLabel"></span>
        <span class="clock" id="clock">–</span>
      </header>
      <div class="timerbar"><i id="tbar"></i></div>
      <main class="layout">
        <aside class="card players"><h3>Players</h3><ul class="plist" id="plist"></ul></aside>
        <section id="stage"></section>
      </main>
    </div>`;
  $('#codeChip').onclick = copyInvite;
}

function copyInvite() {
  const url = `${location.origin}/?code=${S.code}`;
  (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
    .then(() => toast('Invite link copied.'), () => toast(`Share this code: ${S.code}`));
}

function updateFrame() {
  $('#codeTxt').textContent = S.code;
  $('#phaseLabel').textContent = PHASE_LABEL[S.phase]();
  const inGame = ['reveal', 'hints', 'chat', 'vote', 'result'].includes(S.phase);
  $('#plist').innerHTML = S.players.map((p) => {
    const out = inGame && !p.alive;
    const off = !p.connected && !p.left;
    let tag = '';
    if (p.left) tag = '<span class="tag out">left</span>';
    else if (off) tag = '<span class="tag off">offline</span>';
    else if (out) tag = '<span class="tag out">out</span>';
    else if (p.done) tag = '<span class="tag">✓</span>';
    return `<li class="${p.id === S.me.id ? 'me' : ''} ${out || p.left ? 'out' : ''} ${off ? 'off' : ''}">
      ${avatar(p.name, 34)}
      <span class="nm">${esc(p.name)}${p.host ? ' 👑' : ''}${p.id === S.me.id ? ' <small>(you)</small>' : ''}</span>
      ${tag}<span class="pts">${p.score}</span></li>`;
  }).join('');
}

setInterval(() => {
  if (!S || !$('#clock')) return;
  const bar = $('#tbar');
  if (!S.timerEnd) { $('#clock').textContent = '–'; bar.style.width = '0'; return; }
  const left = Math.max(0, S.timerEnd - (Date.now() + clockOffset));
  $('#clock').textContent = Math.ceil(left / 1000) + 's';
  bar.style.width = (left / S.timerTotal * 100) + '%';
  bar.classList.toggle('low', left < 8000);
}, 250);

/* ---------- reusable bits ---------- */
function hintsBoard() {
  if (!S.hints.length) return '';
  const rounds = [...new Set(S.hints.map((h) => h.round))];
  return `<div class="board">${rounds.map((r) => `
    <div><div class="round-title">Round ${r} hints</div>
    <div class="notes">${S.hints.filter((h) => h.round === r).map((h) =>
      `<div class="note"><small>${esc(h.name)}</small><span>${esc(h.text)}</span></div>`).join('')}</div></div>`).join('')}</div>`;
}
const alivePlayers = () => S.players.filter((p) => p.alive && !p.left);
const spectatorBanner = () => (!S.me.alive ? '<div class="banner">You’re out of this game. You can watch, but not hint, chat or vote.</div>' : '');

/* ---------- stages ---------- */
const stages = {};

stages.lobby = {
  key: () => 'lobby',
  build() {
    const host = S.me.host;
    const sel = (id, label, opts, val) => host
      ? `<label>${label}<select id="${id}">${opts.map((o) => `<option value="${o}" ${o === val ? 'selected' : ''}>${o} seconds</option>`).join('')}</select></label>`
      : `<label>${label}<div class="ro" id="${id}">${val} seconds</div></label>`;
    $('#stage').innerHTML = `
      <div class="card stage-card">
        <h2>Waiting for players</h2>
        <div><p class="muted">Share this code, or tap it to copy an invite link.</p></div>
        <button class="big-code" id="bigCode" title="Copy invite link">${S.code}</button>
        <div class="settings">
          ${sel('hintSec', 'Hint time', [20, 30, 45, 60, 90], S.settings.hintSec)}
          ${sel('chatSec', 'Discussion time', [45, 60, 90, 120, 180], S.settings.chatSec)}
          ${sel('voteSec', 'Voting time', [20, 30, 45, 60], S.settings.voteSec)}
        </div>
        <ol class="how-list">
          <li>Everyone gets a secret word. One player gets a different but related one, and doesn’t know it.</li>
          <li>Each round, everyone writes a hint. Then you chat and vote.</li>
          <li>Most votes goes out. If most people skip or votes tie, a new round starts.</li>
        </ol>
        <div class="row" style="flex-wrap:wrap">
          ${host ? '<button class="btn mint" id="start">Start game</button><button class="btn coral" id="close">Close lobby</button>'
                 : '<button class="btn plain" id="leave">Leave lobby</button><span class="muted">Waiting for the host to start…</span>'}
          <span class="muted" id="needMore"></span>
        </div>
      </div>`;
    $('#bigCode').onclick = copyInvite;
    if (host) {
      for (const id of ['hintSec', 'chatSec', 'voteSec']) {
        $('#' + id).onchange = () => socket.emit('settings', {
          hintSec: +$('#hintSec').value, chatSec: +$('#chatSec').value, voteSec: +$('#voteSec').value,
        });
      }
      $('#start').onclick = () => socket.emit('start', null, (r) => r && !r.ok && toast(r.error));
      $('#close').onclick = () => confirm('Close the lobby for everyone? Scores will be lost.') && socket.emit('close');
    } else $('#leave').onclick = leave;
  },
  update() {
    const connected = S.players.filter((p) => p.connected).length;
    const start = $('#start');
    if (start) { start.disabled = connected < S.minPlayers; }
    $('#needMore').textContent = connected < S.minPlayers ? `Need ${S.minPlayers - connected} more to start` : '';
    for (const id of ['hintSec', 'chatSec', 'voteSec']) {
      const el = $('#' + id);
      if (!el || document.activeElement === el) continue;
      if (el.tagName === 'SELECT') el.value = S.settings[id]; else el.textContent = S.settings[id] + ' seconds';
    }
  },
};

stages.reveal = {
  key: () => 'reveal:' + S.round,
  build() {
    $('#stage').innerHTML = `
      <div class="card stage-card word-card">
        <p class="muted">Your secret word is</p>
        <div class="word-big">${esc(S.me.word)}</div>
        <p>Remember it. In a moment you’ll write a hint that fits it.<br>
        <span class="muted">One player has a different word. It might be you.</span></p>
      </div>`;
  },
  update() {},
};

stages.hints = {
  key: () => 'hints:' + S.round,
  build() {
    $('#stage').innerHTML = `
      <div class="card stage-card">
        <div class="row" style="justify-content:space-between;flex-wrap:wrap">
          <h2>Write a hint</h2><span>Your word: <span class="word-pill">${esc(S.me.word)}</span></span>
        </div>
        ${spectatorBanner()}
        <form class="hint-form" id="hintForm" autocomplete="off">
          <input class="input" id="hintInput" maxlength="40" placeholder="A short hint, not the word itself">
          <button class="btn mint" id="hintBtn">Send</button>
        </form>
        <div class="muted" id="hintMsg"></div>
        <div class="status-chips" id="chips"></div>
        <div id="board"></div>
      </div>`;
    $('#hintForm').onsubmit = (e) => {
      e.preventDefault();
      const text = $('#hintInput').value.trim();
      if (!text) return;
      socket.emit('hint', text, (r) => r && !r.ok && toast(r.error));
    };
    if (S.me.alive && !S.me.hintDone) $('#hintInput').focus();
  },
  update() {
    const done = S.me.hintDone || !S.me.alive;
    if (S.me.alive) {
      $('#hintInput').disabled = done; $('#hintBtn').disabled = done;
      $('#hintMsg').textContent = S.me.hintDone ? 'Hint sent. Waiting for everyone else…' : '';
    } else { $('#hintForm').style.display = 'none'; }
    $('#chips').innerHTML = alivePlayers().map((p) => `<span class="${p.done ? 'done' : ''}">${esc(p.name)} ${p.done ? '✓' : '…'}</span>`).join('');
    $('#board').innerHTML = hintsBoard();
  },
};

// chat + vote share one stage so the chat never resets
stages.discuss = {
  key: () => 'discuss:' + S.round,
  build() {
    seenMsgs = new Set();
    $('#stage').innerHTML = `
      <div class="stage-card">
        ${spectatorBanner()}
        <div class="discuss">
          <div class="stack">
            <div class="card panel" id="panel"></div>
            <div class="card" id="board"></div>
          </div>
          <div class="card chatbox">
            <div class="msgs" id="msgs"></div>
            <form id="chatForm" autocomplete="off">
              <input class="input" id="chatInput" maxlength="200" placeholder="${S.me.alive ? 'Say something…' : 'Spectators can’t chat'}" ${S.me.alive ? '' : 'disabled'}>
              <button class="btn small" ${S.me.alive ? '' : 'disabled'}>Send</button>
            </form>
          </div>
        </div>
      </div>`;
    $('#chatForm').onsubmit = (e) => {
      e.preventDefault();
      const el = $('#chatInput'); const t = el.value.trim();
      if (t) { socket.emit('chat', t); el.value = ''; }
    };
  },
  update() {
    $('#board').innerHTML = hintsBoard();

    // chat: append only new messages
    const box = $('#msgs');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    for (const m of S.chat) {
      if (seenMsgs.has(m.id)) continue;
      seenMsgs.add(m.id);
      const d = document.createElement('div');
      d.className = 'msg' + (m.sys ? ' sys' : '');
      d.innerHTML = m.sys ? esc(m.text) : `<b>${esc(m.name)}:</b> ${esc(m.text)}`;
      box.appendChild(d);
    }
    if (nearBottom) box.scrollTop = box.scrollHeight;

    // action panel
    const panel = $('#panel');
    const alive = alivePlayers();
    if (S.phase === 'chat') {
      const readyN = alive.filter((p) => p.done).length;
      panel.innerHTML = `
        <h2>Who’s the odd one?</h2>
        <p class="muted">Compare the hints. Whose doesn’t quite fit? Chat, then move on to voting.</p>
        <button class="btn mint" id="readyBtn" ${S.me.alive ? '' : 'disabled'}>${S.me.ready ? 'Not ready yet' : 'Ready to vote'}</button>
        <p class="muted">${readyN} of ${alive.length} ready. Voting also opens when the timer ends.</p>`;
      const b = $('#readyBtn'); if (b) b.onclick = () => socket.emit('ready');
    } else {
      const votedN = alive.filter((p) => p.done).length;
      const others = alive.filter((p) => p.id !== S.me.id);
      panel.innerHTML = `
        <h2>Vote someone out</h2>
        <div class="vote-grid">${others.map((p) => `
          <button class="vote-btn ${S.me.voted && S.me.vote === p.id ? 'picked' : ''}" data-id="${p.id}" ${S.me.voted || !S.me.alive ? 'disabled' : ''}>
            ${avatar(p.name, 46)}<span>${esc(p.name)}</span></button>`).join('')}</div>
        <button class="btn plain ${S.me.voted && !S.me.vote ? 'picked' : ''}" id="skipBtn" ${S.me.voted || !S.me.alive ? 'disabled' : ''}>${S.me.voted && !S.me.vote ? 'You skipped' : 'Skip vote'}</button>
        <p class="muted">${S.me.voted ? 'Vote locked in. ' : ''}${votedN} of ${alive.length} have voted. If most people skip, nobody goes out.</p>`;
      panel.querySelectorAll('.vote-btn').forEach((b) => { b.onclick = () => socket.emit('vote', b.dataset.id); });
      const s = $('#skipBtn'); if (s) s.onclick = () => socket.emit('vote', null);
    }
  },
};

stages.result = {
  key: () => 'result:' + S.round,
  build() {
    const r = S.result, f = S.final;
    let verdict, sub = '', visual = '';
    if (r.eliminatedId) {
      visual = avatar(r.eliminatedName, 90);
      verdict = `${esc(r.eliminatedName)} was voted out`;
      sub = r.wasOdd ? '<b>They were the odd one out!</b>' : 'They had the same word as everyone else. The odd one is still hiding.';
    } else {
      verdict = 'Nobody was voted out';
      sub = r.reason === 'skip' ? 'Most players skipped the vote.' : 'The vote ended in a tie.';
    }
    const tallyChips = r.votes.map((v) => `<span>${esc(v.voter)} → ${v.target ? esc(v.target) : 'skip'}</span>`).join('');
    let next = '';
    if (f) {
      next = `<p><b>${f.winner === 'civilians' ? 'The group wins this game.' : 'The odd one out wins this game.'}</b> Final results coming up…</p>`;
    } else next = `<p class="muted">Round ${S.round + 1} starts shortly. Everyone left writes a new hint.</p>`;
    const bonus = r.bonusNames && r.bonusNames.length ? `<p class="muted">+25 points: ${r.bonusNames.map(esc).join(', ')} spotted the odd one.</p>` : '';
    $('#stage').innerHTML = `
      <div class="card stage-card center">
        ${visual}
        <div class="verdict">${verdict}</div>
        <p>${sub}</p>
        <div class="votes-list">${tallyChips}</div>
        ${bonus}${next}
      </div>`;
  },
  update() {},
};

stages.end = {
  key: () => 'end',
  build() {
    const f = S.final;
    const won = f.winner === 'civilians';
    const sorted = [...S.players].filter((p) => !p.left).sort((a, b) => b.score - a.score);
    const why = { caught: 'The odd one out was caught.', outnumbered: 'Only two players were left, so the odd one blended in.', survived: 'The odd one survived every round.' }[f.reason] || '';
    $('#stage').innerHTML = `
      <div class="card stage-card center">
        <div class="verdict">${won ? 'The group wins!' : 'The odd one out wins!'}</div>
        <p>${why}</p>
        <div class="pair">
          <div><span class="muted">Everyone’s word</span><strong>${esc(f.civWord)}</strong></div>
          <div class="odd"><span class="muted">${esc(f.oddName)}’s word</span><strong>${esc(f.oddWord)}</strong></div>
        </div>
        <h2>Scores</h2>
        <table class="score">${sorted.map((p) => `<tr><td>${avatar(p.name, 28)}</td><td style="width:100%">${esc(p.name)}${p.id === f.oddId ? ' <span class="tag out">odd one</span>' : ''}</td><td>${p.score}</td></tr>`).join('')}</table>
        <p class="muted">Scores stay until the host closes the lobby.</p>
        <div class="row" id="endBtns" style="flex-wrap:wrap;justify-content:center"></div>
      </div>`;
    $('#endBtns').innerHTML = S.me.host
      ? '<button class="btn mint" id="again">Play again</button><button class="btn coral" id="close">Close lobby</button>'
      : '<button class="btn plain" id="leave">Leave lobby</button><span class="muted">Waiting for the host…</span>';
    if (S.me.host) {
      $('#again').onclick = () => socket.emit('again');
      $('#close').onclick = () => confirm('Close the lobby for everyone? Scores will be lost.') && socket.emit('close');
    } else $('#leave').onclick = leave;
  },
  update() {},
};

function stageFor(phase) {
  return phase === 'chat' || phase === 'vote' ? stages.discuss : stages[phase];
}

function leave() {
  socket.emit('leave');
  session = null; save();
  history.replaceState(null, '', '/');
  renderHome();
}

/* ---------- state plumbing ---------- */
function render() {
  mountRoom();
  clockOffset = S.serverNow - Date.now();
  updateFrame();
  const st = stageFor(S.phase);
  const key = st.key();
  if (key !== stageKey) { stageKey = key; st.build(); }
  st.update();
}

socket.on('state', (s) => { S = s; render(); });
socket.on('closed', () => {
  session = null; save();
  renderHome();
  toast('The host closed the lobby.');
});
socket.on('connect', () => {
  if (session) {
    socket.emit('join', { code: session.code, pid: session.pid, name: session.name }, (res) => {
      if (!res.ok) { session = null; save(); renderHome(); toast(res.error); }
    });
  } else if (!S) renderHome();
});
socket.on('disconnect', () => toast('Connection lost. Trying to reconnect…'));

if (!session) renderHome();
