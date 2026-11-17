const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const QUESTIONS = require('./questions');

const PORT = Number(process.env.PORT) || 3000;
const PIN = String(process.env.PIN || '2026');
// Senha da tela do apresentador. Vazia = sem senha (uso local).
const HOST_KEY = String(process.env.HOST_KEY || '');
const MAX_NAME = 18;
const MAX_POINTS = 1000;

// ---------- URL de acesso (QR code) ----------
function lanAddress() {
  const candidates = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/vethernet|virtualbox|vmware|docker|wsl|hyper-v/i.test(name)) continue;
      candidates.push(a.address);
    }
  }
  return (
    candidates.find((ip) => ip.startsWith('192.168.')) ||
    candidates.find((ip) => ip.startsWith('10.')) ||
    candidates[0] ||
    'localhost'
  );
}

const BASE_URL = (process.env.PUBLIC_URL || `http://${lanAddress()}:${PORT}`).replace(/\/+$/, '');
const WANT_TUNNEL = process.argv.includes('--online');
let tunnelUrl = ''; // preenchido quando o túnel do cloudflared fica pronto
const qrCache = new Map();

// Se o apresentador abrir /host por um endereço público (ex.: túnel cloudflared),
// o QR code usa esse mesmo endereço. Se abrir por localhost, usa o IP da rede local.
async function joinInfo(origin) {
  let base = tunnelUrl || BASE_URL;
  if (tunnelUrl) origin = '';
  try {
    const u = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
    if (!local && !process.env.PUBLIC_URL) base = u.origin;
  } catch {}
  const joinUrl = `${base}/?pin=${PIN}`;
  if (!qrCache.has(joinUrl)) {
    qrCache.set(
      joinUrl,
      await QRCode.toString(joinUrl, {
        type: 'svg',
        margin: 0,
        errorCorrectionLevel: 'M',
        color: { dark: '#4d002f', light: '#ffffff' },
      })
    );
  }
  return { joinUrl, displayUrl: base.replace(/^https?:\/\//, ''), qr: qrCache.get(joinUrl), pin: PIN };
}

// ---------- Estado do jogo ----------
const players = new Map(); // id -> { id, name, score, socketId, connected, lastPoints, lastCorrect, lastChoice }
const game = {
  phase: 'lobby', // lobby | question | reveal | leaderboard | podium
  qIndex: -1,
  startedAt: 0,
  endsAt: 0,
  answers: new Map(), // playerId -> { choice, ms }
  timer: null,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

function ranking() {
  return [...players.values()]
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'pt-BR'))
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, rank: i + 1, connected: p.connected }));
}

function currentQuestion() {
  return QUESTIONS[game.qIndex];
}

function publicQuestion() {
  const q = currentQuestion();
  if (!q) return null;
  return { text: q.text, options: q.options, time: q.time };
}

function remainingMs() {
  return Math.max(0, game.endsAt - Date.now());
}

function answerCounts() {
  const counts = [0, 0, 0, 0];
  for (const a of game.answers.values()) counts[a.choice]++;
  return counts;
}

function hostView() {
  const q = currentQuestion();
  const rank = ranking();
  return {
    phase: game.phase,
    qIndex: game.qIndex,
    total: QUESTIONS.length,
    question: publicQuestion(),
    remainingMs: game.phase === 'question' ? remainingMs() : 0,
    correct: game.phase === 'reveal' && q ? q.correct : null,
    counts: game.phase === 'reveal' ? answerCounts() : null,
    answered: game.answers.size,
    players: rank,
    connectedCount: rank.filter((p) => p.connected).length,
  };
}

function playerView(p) {
  const q = currentQuestion();
  const rank = ranking();
  const me = rank.find((r) => r.id === p.id);
  const answer = game.answers.get(p.id);
  const ahead = me && me.rank > 1 ? rank[me.rank - 2] : null;
  return {
    phase: game.phase,
    qIndex: game.qIndex,
    total: QUESTIONS.length,
    question: game.phase === 'question' ? publicQuestion() : null,
    remainingMs: game.phase === 'question' ? remainingMs() : 0,
    answered: Boolean(answer),
    correct: game.phase === 'reveal' && q ? q.correct : null,
    correctText: game.phase === 'reveal' && q ? q.options[q.correct] : null,
    you: {
      id: p.id,
      name: p.name,
      score: p.score,
      rank: me ? me.rank : null,
      of: rank.length,
      lastPoints: p.lastPoints,
      lastCorrect: p.lastCorrect,
      lastChoice: p.lastChoice,
      behind: ahead ? { name: ahead.name, gap: ahead.score - p.score } : null,
    },
  };
}

function broadcast() {
  io.to('hosts').emit('host:state', hostView());
  for (const p of players.values()) {
    if (p.socketId) io.to(p.socketId).emit('state', playerView(p));
  }
}

// Atualização leve para o apresentador (contagem de respostas / jogadores)
function pingHosts() {
  io.to('hosts').emit('host:state', hostView());
}

function startQuestion(index) {
  clearTimeout(game.timer);
  game.qIndex = index;
  game.phase = 'question';
  game.answers = new Map();
  const q = currentQuestion();
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + q.time * 1000;
  for (const p of players.values()) {
    p.lastPoints = 0;
    p.lastCorrect = null;
    p.lastChoice = null;
  }
  // pequena folga para latência da rede
  game.timer = setTimeout(reveal, q.time * 1000 + 400);
  broadcast();
}

function reveal() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const q = currentQuestion();
  for (const p of players.values()) {
    const a = game.answers.get(p.id);
    if (!a) {
      p.lastCorrect = null; // não respondeu
      p.lastPoints = 0;
      continue;
    }
    const ok = a.choice === q.correct;
    const fraction = Math.min(1, a.ms / (q.time * 1000));
    const points = ok ? Math.round(MAX_POINTS * (1 - fraction / 2)) : 0;
    p.lastCorrect = ok;
    p.lastPoints = points;
    p.lastChoice = a.choice;
    p.score += points;
  }
  game.phase = 'reveal';
  broadcast();
}

function next() {
  switch (game.phase) {
    case 'lobby':
      if (QUESTIONS.length) startQuestion(0);
      break;
    case 'question':
      reveal();
      break;
    case 'reveal':
      game.phase = game.qIndex >= QUESTIONS.length - 1 ? 'podium' : 'leaderboard';
      broadcast();
      break;
    case 'leaderboard':
      startQuestion(game.qIndex + 1);
      break;
    default:
      break;
  }
}

function resetGame({ keepPlayers }) {
  clearTimeout(game.timer);
  game.phase = 'lobby';
  game.qIndex = -1;
  game.answers = new Map();
  if (!keepPlayers) {
    for (const p of players.values()) {
      if (p.socketId) io.to(p.socketId).emit('kicked', 'O jogo foi reiniciado. Entre novamente.');
    }
    players.clear();
  } else {
    for (const p of players.values()) {
      p.score = 0;
      p.lastPoints = 0;
      p.lastCorrect = null;
      p.lastChoice = null;
    }
  }
  broadcast();
}

function cleanName(raw) {
  return String(raw || '')
    .replace(/[\u0000-\u001f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

function newId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// ---------- Socket.IO ----------
io.on('connection', (socket) => {
  // ----- Apresentador -----
  socket.on('host:hello', async (payload) => {
    const { origin, key } = typeof payload === 'object' && payload ? payload : { origin: payload, key: '' };
    if (HOST_KEY && String(key || '') !== HOST_KEY) {
      socket.emit('host:denied', key ? 'Senha incorreta.' : '');
      return;
    }
    socket.join('hosts');
    socket.data.isHost = true;
    socket.data.origin = origin;
    socket.emit('host:join', await joinInfo(origin));
    socket.emit('host:state', hostView());
  });

  socket.on('host:next', () => socket.data.isHost && next());
  socket.on('host:reset', (opts) => socket.data.isHost && resetGame({ keepPlayers: Boolean(opts && opts.keepPlayers) }));
  socket.on('host:kick', (id) => {
    if (!socket.data.isHost) return;
    const p = players.get(id);
    if (!p) return;
    if (p.socketId) io.to(p.socketId).emit('kicked', 'Você foi removido da sala pelo apresentador.');
    players.delete(id);
    game.answers.delete(id);
    broadcast();
  });

  // ----- Jogador -----
  socket.on('player:checkPin', (pin, ack) => {
    if (typeof ack !== 'function') return;
    ack({ ok: String(pin || '').trim() === PIN });
  });

  socket.on('player:resume', (id, ack) => {
    if (typeof ack !== 'function') return;
    const p = players.get(id);
    if (!p) return ack({ ok: false });
    p.socketId = socket.id;
    p.connected = true;
    socket.data.playerId = p.id;
    ack({ ok: true });
    socket.emit('state', playerView(p));
    pingHosts();
  });

  socket.on('player:join', ({ pin, name } = {}, ack) => {
    if (typeof ack !== 'function') return;
    if (String(pin || '').trim() !== PIN) return ack({ ok: false, error: 'PIN incorreto. Confira o código na tela.' });
    const clean = cleanName(name);
    if (clean.length < 2) return ack({ ok: false, error: 'Digite um nome com pelo menos 2 letras.' });
    const taken = [...players.values()].some((p) => p.name.toLocaleLowerCase('pt-BR') === clean.toLocaleLowerCase('pt-BR'));
    if (taken) return ack({ ok: false, error: 'Esse nome já está na sala. Escolha outro.' });

    const p = {
      id: newId(),
      name: clean,
      score: 0,
      socketId: socket.id,
      connected: true,
      lastPoints: 0,
      lastCorrect: null,
      lastChoice: null,
    };
    players.set(p.id, p);
    socket.data.playerId = p.id;
    ack({ ok: true, id: p.id });
    socket.emit('state', playerView(p));
    pingHosts();
  });

  socket.on('player:answer', (choice, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const p = players.get(socket.data.playerId);
    if (!p || game.phase !== 'question') return reply({ ok: false });
    if (game.answers.has(p.id)) return reply({ ok: false });
    const c = Number(choice);
    if (!Number.isInteger(c) || c < 0 || c > 3) return reply({ ok: false });
    if (Date.now() > game.endsAt + 400) return reply({ ok: false });
    game.answers.set(p.id, { choice: c, ms: Date.now() - game.startedAt });
    reply({ ok: true });
    socket.emit('state', playerView(p));

    const active = [...players.values()].filter((x) => x.connected).length;
    if (game.answers.size >= active) reveal();
    else pingHosts();
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      pingHosts();
    }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  A porta ${PORT} já está em uso — provavelmente o quiz já está aberto em outro terminal.`);
    console.error('  Feche o outro terminal (ou aperte Ctrl+C nele) e rode "npm start" de novo.\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log('\n  Desafio Clínico — quiz no ar\n');
  console.log(`  Apresentador (projetor):  http://localhost:${PORT}/host`);
  console.log(`  Jogadores (QR code):      ${BASE_URL}/?pin=${PIN}`);
  console.log(`  PIN da sala:              ${PIN}\n`);
  if (WANT_TUNNEL) startTunnel();
});

// ---------- Túnel público (npm run online) ----------
function startTunnel() {
  console.log('  Abrindo endereço público com o cloudflared…');
  const cf = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    windowsHide: true,
  });
  cf.on('error', () => {
    console.error('\n  O cloudflared não foi encontrado. Instale com: winget install Cloudflare.cloudflared\n');
  });
  const onData = async (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || tunnelUrl) return;
    tunnelUrl = m[0];
    console.log(`\n  Endereço público pronto:  ${tunnelUrl}/?pin=${PIN}`);
    console.log('  O QR code no telão já foi atualizado. Funciona em qualquer rede (Wi-Fi ou 4G).\n');
    for (const s of await io.in('hosts').fetchSockets()) s.emit('host:join', await joinInfo(s.data.origin));
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('exit', (code) => {
    if (tunnelUrl) console.error(`\n  O túnel foi encerrado (código ${code}). Rode "npm run online" de novo.\n`);
    tunnelUrl = '';
  });
  const stop = () => {
    cf.kill();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
