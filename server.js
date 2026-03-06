'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, pingInterval: 10000, pingTimeout: 30000 });

/*
═══════════════════════════════════════════════════
  TOKAT OYUNU — 2-4 Kişilik Matematik Savaşı Server
  
  FLOW:
    lobby(2-4 players) → question(12s) → reveal → next question
  
  RULES:
    • 2-4 players, 2 teams (Team A vs Team B)
    • 2 players: 1v1 (slot 0 = A, slot 1 = B)
    • 3 players: slot 0,1 = A;  slot 2 = B
    • 4 players: slot 0,1 = A;  slot 2,3 = B
    • Math question shown to everyone
    • Everyone types answer and submits
    • First CORRECT answer wins the round
    • Winner slaps a wrong-answering opponent
    • Slapped player loses HP
    • 100 HP per player — team loses when ALL members die
    • Slap damage: 15-25 HP
═══════════════════════════════════════════════════
*/

// ── Question generator ──
function makeQuestion() {
  const ops = ['+','-','×','÷','²+','×+'];
  const op  = ops[Math.floor(Math.random() * ops.length)];
  let q, ans;

  if (op === '+') {
    const a = ri(5,50), b = ri(5,50);
    q = `${a} + ${b}`; ans = a + b;
  } else if (op === '-') {
    const a = ri(20,99), b = ri(1, a-1);
    q = `${a} − ${b}`; ans = a - b;
  } else if (op === '×') {
    const a = ri(2,12), b = ri(2,12);
    q = `${a} × ${b}`; ans = a * b;
  } else if (op === '÷') {
    const b = ri(2,12), ans2 = ri(2,12);
    const a = b * ans2;
    q = `${a} ÷ ${b}`; ans = ans2;
  } else if (op === '²+') {
    const a = ri(2,9), b = ri(1,20);
    q = `${a}² + ${b}`; ans = a*a + b;
  } else {
    const a = ri(2,9), b = ri(2,9), c = ri(1,20);
    q = `${a} × ${b} + ${c}`; ans = a*b + c;
  }

  return { q, ans: String(ans), id: crypto.randomUUID() };
}

function ri(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

// ── Room state ──
const ROOMS  = new Map();
let   rSeq   = 1;
const timers = new Map();

const AVATARS = ['👊','🤜','🥊','💪','🤛','✊','👋','🖐'];
const COLORS  = ['#ef4444','#3b82f6','#f59e0b','#22c55e'];
const NAMES   = ['Savaşçı','Gladyatör','Şampiyon','Yıldırım'];
const MAX_HP  = 100;
const Q_TIME  = 12000; // ms per question
const SLAP_DMG = () => ri(15, 25);

function makeRoom(id) {
  return {
    id,
    players: [],   // max 4
    phase:   'lobby',
    question: null,
    answers:  {},  // pid → { val, time }
    winner:   null,
    round:    0,
    history:  [],
    tEnd:     0,
    created:  Date.now(),
  };
}

function findOrCreate() {
  for (const [,r] of ROOMS)
    if (r.phase === 'lobby' && r.players.length < 4) return r;
  const id = `T${rSeq++}`, r = makeRoom(id);
  ROOMS.set(id, r); return r;
}

function byId(r, id)   { return r.players.find(p => p.id === id); }
function alive(r)      { return r.players.filter(p => p.hp > 0); }
function pub(r, ev, d) { io.to(`r:${r.id}`).emit(ev, d); }

function setTimer(r, ms, cb) {
  clearTimeout(timers.get(r.id));
  timers.set(r.id, setTimeout(() => { if(ROOMS.has(r.id)) cb(); }, ms));
}
function clearTimer(r) { clearTimeout(timers.get(r.id)); timers.delete(r.id); }

function broadcast(r) { pub(r, 'state', makeSnap(r)); }

function makeSnap(r) {
  return {
    id:       r.id,
    phase:    r.phase,
    round:    r.round,
    question: r.question ? { q: r.question.q, id: r.question.id } : null,
    tEnd:     r.tEnd,
    winner:   r.winner,
    history:  r.history.slice(-5),
    players:  r.players.map(p => ({
      id:     p.id,
      name:   p.name,
      avatar: p.avatar,
      color:  p.color,
      team:   p.team,
      hp:     p.hp,
      slot:   p.slot,
      on:     p.on,
      answered: r.answers[p.id] !== undefined,
    })),
  };
}

// ── Game logic ──
function startRound(r) {
  if (r.phase === 'ended') return;
  r.round++;
  r.question = makeQuestion();
  r.answers  = {};
  r.phase    = 'question';
  r.tEnd     = Date.now() + Q_TIME;

  broadcast(r);

  setTimer(r, Q_TIME, () => {
    // Time's up — reveal without slap opportunity
    endQuestion(r, null, null, true);
  });
}

function endQuestion(r, winnerId, loserId, timeout = false) {
  clearTimer(r);
  r.phase = 'reveal';

  const w   = winnerId ? byId(r, winnerId) : null;
  const l   = loserId  ? byId(r, loserId)  : null;
  let dmg   = 0;

  if (w && l && w.team !== l.team) {
    dmg    = SLAP_DMG();
    l.hp   = Math.max(0, l.hp - dmg);
  }

  const entry = {
    qText:     r.question?.q,
    answer:    r.question?.ans,
    winnerId,  winnerName: w?.name, winnerAvatar: w?.avatar,
    loserId,   loserName:  l?.name,  loserAvatar:  l?.avatar,
    dmg, timeout,
    answers: { ...r.answers },
  };
  r.history.push(entry);

  // Check win condition
  const aTeams = new Set(alive(r).map(p => p.team));
  if (aTeams.size === 1) {
    r.phase  = 'ended';
    r.winner = [...aTeams][0];
    broadcast(r);
    pub(r, 'game_over', { winner: r.winner });
    return;
  }
  if (alive(r).length === 0) {
    r.phase = 'ended'; r.winner = 'draw';
    broadcast(r); return;
  }

  broadcast(r);
  // Slap event
  if (w && l && dmg > 0) {
    pub(r, 'slap_event', { slapper: winnerId, victim: loserId, dmg, slapperName: w.name, victimName: l.name });
  }
  if (l && l.hp <= 0) {
    pub(r, 'death_event', { pid: loserId, name: l.name });
  }

  // Next round after 3s
  setTimeout(() => {
    if (!ROOMS.has(r.id) || r.phase === 'ended') return;
    startRound(r);
  }, 3200);
}

function handleAnswer(r, pid, val) {
  if (r.phase !== 'question') return;
  if (r.answers[pid] !== undefined) return; // already answered

  r.answers[pid] = { val: String(val).trim(), time: Date.now() };

  const correct = String(r.question.ans) === String(val).trim();
  const p = byId(r, pid);

  // Tell everyone someone answered (without revealing)
  pub(r, 'someone_answered', { pid, name: p?.name, avatar: p?.avatar });

  if (correct) {
    // Find wrong answerers on opposing team
    const opponents = r.players.filter(op => op.team !== p.team && op.hp > 0);
    // Check if any opponent answered wrong already
    const wrongOpp = opponents.find(op => r.answers[op.id] && r.answers[op.id].val !== r.question.ans);
    if (wrongOpp) {
      endQuestion(r, pid, wrongOpp.id);
    } else {
      // Wait to see if others answer wrong or timeout wins
      // Check if all opponents answered
      const allOppAnswered = opponents.every(op => r.answers[op.id] !== undefined);
      const allWrong = opponents.filter(op => r.answers[op.id]).every(op => r.answers[op.id].val !== r.question.ans);
      if (allOppAnswered && allWrong) {
        // Slap last wrong opponent
        const target = opponents.find(op => r.answers[op.id]?.val !== r.question.ans) || opponents[0];
        endQuestion(r, pid, target?.id);
      }
      // Otherwise keep waiting
    }
  } else {
    // Wrong answer — check if an opponent already got it right
    const correctOpponent = r.players.find(op =>
      op.team !== p.team && r.answers[op.id]?.val === r.question.ans
    );
    if (correctOpponent) {
      endQuestion(r, correctOpponent.id, pid);
    }
  }
}

// ── Sockets ──
io.on('connection', socket => {

  socket.on('join', ({ name, roomId: rId } = {}, cb) => {
    const nm = (name || 'Savaşçı').slice(0, 16).trim();
    let room;
    if (rId && ROOMS.has(rId)) room = ROOMS.get(rId);
    else room = findOrCreate();

    if (room.players.length >= 4) return cb?.({ ok: false, e: 'Oda dolu' });
    if (room.phase !== 'lobby')   return cb?.({ ok: false, e: 'Oyun başladı' });

    const slot = room.players.length;
    // Team assignment: slot 0 → A, slot 1 → B, slot 2 → A, slot 3 → B  (alternating = fair)
    const team = slot % 2 === 0 ? 'A' : 'B';
    const player = {
      id: socket.id, name: nm, slot,
      avatar: AVATARS[slot],
      color:  COLORS[slot],
      team,
      hp: MAX_HP,
      on: true,
    };
    room.players.push(player);
    socket.join(`r:${room.id}`);
    socket.data.rid = room.id;

    broadcast(room);
    cb?.({ ok: true, roomId: room.id, pid: socket.id, slot, team: player.team });

    // Auto-start when 2+ players (with short delay to allow more to join)
    const n = room.players.length;
    if (n >= 2) {
      // Wait 8s for more players, then start anyway
      clearTimeout(timers.get(room.id + '_start'));
      const delay = n >= 4 ? 800 : 8000;
      timers.set(room.id + '_start', setTimeout(() => {
        if (room.phase === 'lobby' && room.players.length >= 2) {
          room.phase = 'countdown';
          broadcast(room);
          pub(room, 'countdown', {});
          setTimeout(() => startRound(room), 3000);
        }
      }, delay));
    }
  });

  socket.on('answer', ({ val } = {}) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    handleAnswer(room, socket.id, val);
  });

  socket.on('restart', ({} = {}, cb) => {
    const room = ROOMS.get(socket.data.rid);
    if (!room || room.phase !== 'ended') return cb?.({ ok: false });
    room.phase    = 'lobby';
    room.round    = 0;
    room.winner   = null;
    room.question = null;
    room.answers  = {};
    room.history  = [];
    for (const p of room.players) { p.hp = MAX_HP; }
    broadcast(room);
    cb?.({ ok: true });
    if (room.players.length >= 2) {
      const delay = room.players.length >= 4 ? 800 : 3000;
      setTimeout(() => {
        if (room.phase === 'lobby') {
          room.phase = 'countdown';
          broadcast(room);
          pub(room, 'countdown', {});
          setTimeout(() => startRound(room), 3000);
        }
      }, delay);
    }
  });

  socket.on('disconnect', () => {
    const room = ROOMS.get(socket.data.rid);
    if (!room) return;
    const p = byId(room, socket.id);
    if (p) p.on = false;
    broadcast(room);
    setTimeout(() => {
      const r = ROOMS.get(room?.id);
      if (r && r.players.every(x => !x.on)) ROOMS.delete(room.id);
    }, 300000);
  });
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`👋  Tokat Oyunu  →  http://localhost:${PORT}`));
