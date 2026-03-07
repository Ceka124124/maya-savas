'use strict';
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors:{origin:'*'}, pingInterval:8000, pingTimeout:20000 });

const ROOMS = new Map();
let rSeq = 1;
const timers = new Map();
const ri = (a,b) => Math.floor(Math.random()*(b-a+1))+a;

function makeQ() {
  const t = ri(0,5);
  if (t===0) { const a=ri(8,60),b=ri(5,40); return {q:`${a} + ${b}`, ans:a+b}; }
  if (t===1) { const a=ri(20,99),b=ri(5,a-1); return {q:`${a} − ${b}`, ans:a-b}; }
  if (t===2) { const a=ri(2,12),b=ri(2,12); return {q:`${a} × ${b}`, ans:a*b}; }
  if (t===3) { const b=ri(2,12),c=ri(2,12); return {q:`${b*c} ÷ ${b}`, ans:c}; }
  if (t===4) { const a=ri(2,9),b=ri(2,20); return {q:`${a}² + ${b}`, ans:a*a+b}; }
  const a=ri(2,9),b=ri(2,9),c=ri(1,20); return {q:`${a}×${b}+${c}`, ans:a*b+c};
}

const COLORS = ['#ff3322','#2255ff','#ffaa00','#22cc44'];
const MAX_HP = 100, Q_MS = 12000;
const DMG = () => ri(14,26);

function makeRoom(id) {
  return { id, players:[], phase:'lobby', q:null, ans:{}, round:0, tEnd:0 };
}
function findOrCreate() {
  for (const [,r] of ROOMS)
    if (r.phase==='lobby' && r.players.length<4) return r;
  const id=`R${rSeq++}`, r=makeRoom(id);
  ROOMS.set(id,r); return r;
}
const byId = (r,id) => r.players.find(p=>p.id===id);
const alive = r => r.players.filter(p=>p.hp>0);
function setT(k,ms,cb){ clearTimeout(timers.get(k)); timers.set(k,setTimeout(()=>{timers.delete(k);cb();},ms)); }
function clearT(k){ clearTimeout(timers.get(k)); timers.delete(k); }
function pub(r,ev,d){ io.to('r:'+r.id).emit(ev,d); }

function snap(r) {
  return {
    id:r.id, phase:r.phase, round:r.round, tEnd:r.tEnd,
    question: r.q ? r.q.q : null,
    players: r.players.map(p=>({
      id:p.id, name:p.name, team:p.team, hp:p.hp,
      skin:p.skin, slot:p.slot, on:p.on,
      answered: r.ans[p.id] !== undefined
    }))
  };
}
function bcast(r){ pub(r,'state',snap(r)); }

function startRound(r) {
  if (r.phase==='ended') return;
  r.round++; r.q=makeQ(); r.ans={}; r.phase='question'; r.tEnd=Date.now()+Q_MS;
  bcast(r);
  setT(r.id+'q', Q_MS, ()=>endQ(r,null,null,true));
}

function endQ(r, wId, lId, timeout=false) {
  clearT(r.id+'q');
  r.phase = 'reveal';
  const w=wId?byId(r,wId):null, l=lId?byId(r,lId):null;
  let dmg=0;
  if (w&&l&&w.team!==l.team) { dmg=DMG(); l.hp=Math.max(0,l.hp-dmg); }

  if (w&&l&&dmg>0) {
    pub(r,'slap',{
      slapper:wId, slapperName:w.name, slapperSkin:w.skin, slapperTeam:w.team,
      victim:lId, victimName:l.name, victimTeam:l.team,
      dmg, answer:r.q?.ans
    });
  } else if (timeout) {
    pub(r,'timeout',{answer:r.q?.ans});
  } else {
    pub(r,'correct_noslap',{answer:r.q?.ans, wId});
  }

  if (l&&l.hp<=0) setTimeout(()=>pub(r,'death',{pid:lId,name:l.name,team:l.team}),700);

  const aTeams = new Set(alive(r).map(p=>p.team));
  if (aTeams.size<=1) {
    r.phase='ended'; r.winner=[...aTeams][0]||'draw';
    setTimeout(()=>{ bcast(r); pub(r,'game_over',{winner:r.winner}); }, 1800);
    return;
  }
  bcast(r);
  setT(r.id+'next', 3800, ()=>{ if(r.phase!=='ended') startRound(r); });
}

function handleAnswer(r, pid, val) {
  if (r.phase!=='question' || r.ans[pid]!==undefined) return;
  r.ans[pid] = { val:String(val).trim(), t:Date.now() };
  const p = byId(r,pid);
  pub(r,'answered',{pid, name:p?.name});
  const correct = String(r.q.ans)===String(val).trim();
  if (correct) {
    const opps = r.players.filter(o=>o.team!==p.team&&o.hp>0);
    const wrongOpp = opps.find(o=>r.ans[o.id]&&r.ans[o.id].val!==String(r.q.ans));
    if (wrongOpp) { endQ(r,pid,wrongOpp.id); return; }
    if (opps.every(o=>r.ans[o.id]!==undefined)) {
      const t=opps.find(o=>r.ans[o.id]?.val!==String(r.q.ans))||opps[0];
      if (t) endQ(r,pid,t.id);
    }
  } else {
    const co = r.players.find(o=>o.team!==p.team&&r.ans[o.id]?.val===String(r.q.ans));
    if (co) endQ(r,co.id,pid);
  }
}

io.on('connection', socket => {
  socket.on('join', ({name,roomId:rId,skin='fair'}={}, cb) => {
    const nm = (name||'Savaşçı').slice(0,14).trim();
    let room = (rId&&ROOMS.has(rId)) ? ROOMS.get(rId) : findOrCreate();
    if (room.players.length>=4) return cb?.({ok:false,e:'Oda dolu'});
    if (room.phase!=='lobby') return cb?.({ok:false,e:'Oyun başladı'});
    const slot=room.players.length, team=slot%2===0?'A':'B';
    const player = {id:socket.id,name:nm,slot,team,skin,color:COLORS[slot],hp:MAX_HP,on:true};
    room.players.push(player);
    socket.join('r:'+room.id);
    socket.data.rid = room.id;
    bcast(room);
    cb?.({ok:true, roomId:room.id, pid:socket.id, slot, team, skin});
    if (room.players.length>=2) {
      const delay = room.players.length>=4 ? 800 : 8000;
      setT(room.id+'start', delay, ()=>{
        if (room.phase==='lobby'&&room.players.length>=2) {
          room.phase='countdown'; bcast(room); pub(room,'countdown',{});
          setT(room.id+'cd', 3200, ()=>startRound(room));
        }
      });
    }
  });

  socket.on('answer', ({val}={}) => {
    const r=ROOMS.get(socket.data.rid); if(r) handleAnswer(r,socket.id,val);
  });

  socket.on('restart', ({},cb) => {
    const r=ROOMS.get(socket.data.rid);
    if (!r||r.phase!=='ended') return cb?.({ok:false});
    r.phase='lobby'; r.round=0; r.winner=null; r.q=null; r.ans={};
    r.players.forEach(p=>{p.hp=MAX_HP;});
    bcast(r);
    setT(r.id+'start', 2000, ()=>{
      if (r.phase==='lobby'&&r.players.length>=2) {
        r.phase='countdown'; bcast(r); pub(r,'countdown',{});
        setT(r.id+'cd', 3200, ()=>startRound(r));
      }
    });
    cb?.({ok:true});
  });

  socket.on('disconnect', () => {
    const r=ROOMS.get(socket.data.rid); if(!r) return;
    const p=byId(r,socket.id); if(p) p.on=false;
    bcast(r);
    setTimeout(()=>{ const x=ROOMS.get(r?.id); if(x&&x.players.every(p=>!p.on)) ROOMS.delete(r.id); }, 300000);
  });
});

app.use(express.static(path.join(__dirname,'public')));
app.get('*',(_,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(process.env.PORT||3000, ()=>console.log('👋 Tokat 3D v4 → http://localhost:3000'));
