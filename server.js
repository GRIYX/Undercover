const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Word Pairs ---
const WORD_PAIRS = [
  { civilian: 'Plage', undercover: 'Piscine' },
  { civilian: 'Chat', undercover: 'Chien' },
  { civilian: 'Pizza', undercover: 'Tarte flambée' },
  { civilian: 'Avion', undercover: 'Hélicoptère' },
  { civilian: 'Montagne', undercover: 'Colline' },
  { civilian: 'Café', undercover: 'Thé' },
  { civilian: 'Guitare', undercover: 'Violon' },
  { civilian: 'Cinéma', undercover: 'Théâtre' },
  { civilian: 'Football', undercover: 'Rugby' },
  { civilian: 'Vampire', undercover: 'Zombie' },
  { civilian: 'Boulangerie', undercover: 'Pâtisserie' },
  { civilian: 'Médecin', undercover: 'Infirmier' },
  { civilian: 'Soleil', undercover: 'Lune' },
  { civilian: 'Chocolat', undercover: 'Caramel' },
  { civilian: 'Paris', undercover: 'Lyon' },
  { civilian: 'Mariage', undercover: 'Fiançailles' },
  { civilian: 'Livre', undercover: 'Magazine' },
  { civilian: 'Requin', undercover: 'Dauphin' },
  { civilian: 'Hôtel', undercover: 'Auberge' },
  { civilian: 'Policier', undercover: 'Détective' },
  { civilian: 'Musée', undercover: 'Galerie' },
  { civilian: 'Tigre', undercover: 'Lion' },
  { civilian: 'Robe', undercover: 'Jupe' },
  { civilian: 'Camion', undercover: 'Bus' },
  { civilian: 'Cascade', undercover: 'Fontaine' },
];

// --- Game State ---
const rooms = {};

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

function broadcast(room, data, excludeId = null) {
  const r = rooms[room];
  if (!r) return;
  const msg = JSON.stringify(data);
  r.players.forEach(p => {
    if (p.id !== excludeId && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(msg);
    }
  });
}

function sendTo(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function getPublicPlayers(room) {
  return rooms[room].players.map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive,
    isHost: p.isHost,
    hasSpoken: p.hasSpoken,
    hasVoted: p.hasVoted,
    role: rooms[room].phase === 'ended' ? p.role : undefined,
  }));
}

function broadcastRoom(roomCode) {
  const r = rooms[roomCode];
  if (!r) return;
  r.players.forEach(p => {
    sendTo(p.ws, {
      type: 'room_update',
      players: getPublicPlayers(roomCode),
      phase: r.phase,
      round: r.round,
      votes: r.phase === 'voting' ? r.votes : undefined,
      hostId: r.hostId,
    });
  });
}

function assignRoles(roomCode) {
  const r = rooms[roomCode];
  const players = r.players;
  const n = players.length;
  
  // Determine role counts
  let undercoverCount = n >= 6 ? 2 : 1;
  let mrWhiteCount = n >= 5 ? 1 : 0;
  
  // Pick word pair
  const pair = WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)];
  r.wordPair = pair;
  
  // Shuffle players
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  
  shuffled.forEach((p, i) => {
    if (i < undercoverCount) {
      p.role = 'undercover';
      p.word = pair.undercover;
    } else if (i < undercoverCount + mrWhiteCount) {
      p.role = 'mrwhite';
      p.word = null;
    } else {
      p.role = 'civilian';
      p.word = pair.civilian;
    }
  });
}

function checkWinCondition(roomCode) {
  const r = rooms[roomCode];
  const alive = r.players.filter(p => p.alive);
  const civilians = alive.filter(p => p.role === 'civilian');
  const undercovers = alive.filter(p => p.role === 'undercover' || p.role === 'mrwhite');
  
  if (undercovers.length === 0) {
    return { winner: 'civilians', reason: 'Tous les imposteurs ont été éliminés !' };
  }
  if (undercovers.length >= civilians.length) {
    return { winner: 'undercovers', reason: 'Les imposteurs sont en majorité !' };
  }
  return null;
}

function startVoting(roomCode) {
  const r = rooms[roomCode];
  r.phase = 'voting';
  r.votes = {};
  r.players.forEach(p => { p.hasVoted = false; });
  broadcastRoom(roomCode);
  broadcast(roomCode, { type: 'phase_change', phase: 'voting', message: 'Votez pour éliminer un joueur !' });
}

function processVotes(roomCode) {
  const r = rooms[roomCode];
  const tally = {};
  
  Object.values(r.votes).forEach(targetId => {
    tally[targetId] = (tally[targetId] || 0) + 1;
  });
  
  let maxVotes = 0;
  let eliminated = null;
  let tie = false;
  
  Object.entries(tally).forEach(([id, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = id;
      tie = false;
    } else if (count === maxVotes) {
      tie = true;
    }
  });
  
  if (tie) {
    broadcast(roomCode, { type: 'vote_result', tie: true, message: 'Égalité ! Personne n\'est éliminé.' });
    r.round++;
    r.players.forEach(p => { p.hasSpoken = false; });
    r.phase = 'speaking';
    broadcastRoom(roomCode);
    return;
  }
  
  const eliminatedPlayer = r.players.find(p => p.id === eliminated);
  if (eliminatedPlayer) {
    eliminatedPlayer.alive = false;
    
    // Mr. White gets to guess if eliminated
    if (eliminatedPlayer.role === 'mrwhite') {
      r.phase = 'mrwhite_guess';
      r.eliminatedThisRound = eliminatedPlayer;
      broadcastRoom(roomCode);
      broadcast(roomCode, {
        type: 'mrwhite_eliminated',
        playerId: eliminatedPlayer.id,
        playerName: eliminatedPlayer.name,
        message: `${eliminatedPlayer.name} est éliminé ! C'était Mr. White ! Il peut tenter de deviner le mot civil...`
      });
      sendTo(eliminatedPlayer.ws, { type: 'mrwhite_guess_prompt' });
      return;
    }
    
    broadcast(roomCode, {
      type: 'vote_result',
      eliminated: eliminated,
      eliminatedName: eliminatedPlayer.name,
      role: eliminatedPlayer.role,
      word: eliminatedPlayer.word,
      message: `${eliminatedPlayer.name} est éliminé ! Il était ${getRoleLabel(eliminatedPlayer.role)}.`
    });
  }
  
  const win = checkWinCondition(roomCode);
  if (win) {
    endGame(roomCode, win);
  } else {
    r.round++;
    r.players.forEach(p => { if (p.alive) p.hasSpoken = false; });
    r.phase = 'speaking';
    broadcastRoom(roomCode);
    broadcast(roomCode, { type: 'phase_change', phase: 'speaking', round: r.round });
  }
}

function endGame(roomCode, result) {
  const r = rooms[roomCode];
  r.phase = 'ended';
  broadcastRoom(roomCode);
  broadcast(roomCode, {
    type: 'game_over',
    winner: result.winner,
    reason: result.reason,
    wordPair: r.wordPair,
    players: r.players.map(p => ({ id: p.id, name: p.name, role: p.role, word: p.word }))
  });
}

function getRoleLabel(role) {
  if (role === 'civilian') return 'Civil';
  if (role === 'undercover') return 'Undercover';
  if (role === 'mrwhite') return 'Mr. White';
  return role;
}

// --- WebSocket ---
wss.on('connection', (ws) => {
  let playerId = Math.random().toString(36).substring(2, 10);
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type } = msg;

    if (type === 'create_room') {
      const code = generateRoomCode();
      rooms[code] = {
        code,
        hostId: playerId,
        players: [],
        phase: 'lobby',
        round: 1,
        votes: {},
        wordPair: null,
      };
      currentRoom = code;
      const player = { id: playerId, name: msg.name, ws, alive: true, isHost: true, role: null, word: null, hasSpoken: false, hasVoted: false };
      rooms[code].players.push(player);
      sendTo(ws, { type: 'room_created', code, playerId });
      broadcastRoom(code);
    }

    else if (type === 'join_room') {
      const code = msg.code.toUpperCase();
      if (!rooms[code]) { sendTo(ws, { type: 'error', message: 'Salon introuvable.' }); return; }
      if (rooms[code].phase !== 'lobby') { sendTo(ws, { type: 'error', message: 'La partie a déjà commencé.' }); return; }
      if (rooms[code].players.length >= 12) { sendTo(ws, { type: 'error', message: 'Salon plein.' }); return; }
      
      currentRoom = code;
      const player = { id: playerId, name: msg.name, ws, alive: true, isHost: false, role: null, word: null, hasSpoken: false, hasVoted: false };
      rooms[code].players.push(player);
      sendTo(ws, { type: 'room_joined', code, playerId });
      broadcastRoom(code);
      broadcast(code, { type: 'player_joined', name: msg.name }, playerId);
    }

    else if (type === 'start_game') {
      const r = rooms[currentRoom];
      if (!r || r.hostId !== playerId) return;
      if (r.players.length < 3) { sendTo(ws, { type: 'error', message: 'Il faut au moins 3 joueurs.' }); return; }
      
      assignRoles(currentRoom);
      r.phase = 'role_reveal';
      r.round = 1;
      r.players.forEach(p => { p.hasSpoken = false; p.alive = true; });
      
      broadcastRoom(currentRoom);
      
      // Send each player their role privately
      r.players.forEach(p => {
        sendTo(p.ws, {
          type: 'your_role',
          role: p.role,
          word: p.word,
          label: getRoleLabel(p.role),
        });
      });
      
      broadcast(currentRoom, { type: 'phase_change', phase: 'role_reveal', message: 'Les rôles ont été distribués ! Mémorisez votre mot.' });
      
      // Auto-start speaking phase after delay
      setTimeout(() => {
        if (rooms[currentRoom] && rooms[currentRoom].phase === 'role_reveal') {
          r.phase = 'speaking';
          broadcastRoom(currentRoom);
          broadcast(currentRoom, { type: 'phase_change', phase: 'speaking', round: 1 });
        }
      }, 8000);
    }

    else if (type === 'mark_spoken') {
      const r = rooms[currentRoom];
      if (!r || r.phase !== 'speaking') return;
      const player = r.players.find(p => p.id === playerId);
      if (player) player.hasSpoken = true;
      broadcastRoom(currentRoom);
      
      const allAliveSpoken = r.players.filter(p => p.alive).every(p => p.hasSpoken);
      if (allAliveSpoken) {
        setTimeout(() => startVoting(currentRoom), 1000);
      }
    }

    else if (type === 'vote') {
      const r = rooms[currentRoom];
      if (!r || r.phase !== 'voting') return;
      const voter = r.players.find(p => p.id === playerId);
      if (!voter || !voter.alive || voter.hasVoted) return;
      const target = r.players.find(p => p.id === msg.targetId && p.alive);
      if (!target) return;
      
      voter.hasVoted = true;
      r.votes[playerId] = msg.targetId;
      broadcastRoom(currentRoom);
      
      broadcast(currentRoom, { type: 'player_voted', voterName: voter.name, voterCount: Object.keys(r.votes).length });
      
      const aliveCount = r.players.filter(p => p.alive).length;
      if (Object.keys(r.votes).length >= aliveCount) {
        setTimeout(() => processVotes(currentRoom), 1000);
      }
    }

    else if (type === 'mrwhite_guess') {
      const r = rooms[currentRoom];
      if (!r || r.phase !== 'mrwhite_guess') return;
      const guesser = r.players.find(p => p.id === playerId);
      if (!guesser || guesser.role !== 'mrwhite') return;
      
      const guess = msg.guess.toLowerCase().trim();
      const correctWord = r.wordPair.civilian.toLowerCase();
      
      if (guess === correctWord) {
        endGame(currentRoom, { winner: 'mrwhite', reason: `Mr. White a deviné le mot civil "${r.wordPair.civilian}" !` });
      } else {
        broadcast(currentRoom, {
          type: 'mrwhite_guess_result',
          correct: false,
          guess: msg.guess,
          playerName: guesser.name,
          message: `${guesser.name} (Mr. White) a deviné "${msg.guess}" — Mauvaise réponse !`
        });
        
        const win = checkWinCondition(currentRoom);
        if (win) {
          endGame(currentRoom, win);
        } else {
          r.round++;
          r.players.forEach(p => { if (p.alive) p.hasSpoken = false; });
          r.phase = 'speaking';
          broadcastRoom(currentRoom);
          broadcast(currentRoom, { type: 'phase_change', phase: 'speaking', round: r.round });
        }
      }
    }

    else if (type === 'restart_game') {
      const r = rooms[currentRoom];
      if (!r || r.hostId !== playerId) return;
      r.phase = 'lobby';
      r.round = 1;
      r.votes = {};
      r.wordPair = null;
      r.players.forEach(p => { p.alive = true; p.role = null; p.word = null; p.hasSpoken = false; p.hasVoted = false; });
      broadcastRoom(currentRoom);
      broadcast(currentRoom, { type: 'phase_change', phase: 'lobby' });
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const r = rooms[currentRoom];
    const idx = r.players.findIndex(p => p.id === playerId);
    if (idx !== -1) {
      const name = r.players[idx].name;
      r.players.splice(idx, 1);
      broadcast(currentRoom, { type: 'player_left', name });
      
      if (r.players.length === 0) {
        delete rooms[currentRoom];
      } else if (r.hostId === playerId && r.players.length > 0) {
        r.hostId = r.players[0].id;
        r.players[0].isHost = true;
        broadcastRoom(currentRoom);
      } else {
        broadcastRoom(currentRoom);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🕵️  UnderCover server running on http://localhost:${PORT}`);
});
