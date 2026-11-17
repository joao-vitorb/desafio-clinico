(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const LETTERS = ['A', 'B', 'C', 'D'];
  const screens = ['lobby', 'question', 'board', 'podium'];
  const fmt = (n) => n.toLocaleString('pt-BR');

  let state = null;
  let timerEndsAt = 0;
  let timerTotal = 1;
  let timerRaf = 0;
  let renderedQuestion = -1;
  let podiumShown = false;
  let prevScores = new Map();

  function show(name) {
    for (const s of screens) $(s).hidden = s !== name;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- Lobby ----------
  function renderLobby(s) {
    show('lobby');
    const n = s.players.length;
    $('playerCount').textContent = n;
    $('playerWord').textContent = n === 1 ? 'jogador na sala' : 'jogadores na sala';
    $('startBtn').disabled = n === 0;
    $('emptyHint').hidden = n > 0;

    const cloud = $('nameCloud');
    const existing = new Map([...cloud.children].map((li) => [li.dataset.id, li]));
    const ids = new Set();
    // ordem de chegada: mais recentes no fim
    for (const p of s.players.slice().sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))) {
      ids.add(p.id);
      let li = existing.get(p.id);
      if (!li) {
        li = document.createElement('li');
        li.dataset.id = p.id;
        li.innerHTML = `<button type="button" title="Remover ${esc(p.name)}">${esc(p.name)}</button>`;
        li.firstChild.addEventListener('click', () => socket.emit('host:kick', p.id));
        cloud.appendChild(li);
      }
      li.classList.toggle('off', !p.connected);
    }
    for (const [id, li] of existing) if (!ids.has(id)) li.remove();
  }

  // ---------- Pergunta ----------
  function renderQuestion(s) {
    show('question');
    const q = s.question;
    const isReveal = s.phase === 'reveal';
    $('qCount').textContent = `Pergunta ${s.qIndex + 1} de ${s.total}`;

    if (renderedQuestion !== s.qIndex) {
      renderedQuestion = s.qIndex;
      $('qText').textContent = q.text;
      $('options').innerHTML = q.options
        .map(
          (o, i) => `<li class="option">
            <span class="chev" aria-hidden="true">${LETTERS[i]}</span>
            <div class="opt-body"><span class="opt-bar"></span><span class="opt-text">${esc(o)}</span><span class="opt-count"></span></div>
          </li>`
        )
        .join('');
    }

    const list = $('options');
    list.classList.toggle('revealed', isReveal);
    $('answered').textContent = s.answered;
    $('answeredBox').hidden = isReveal;
    $('skipBtn').hidden = isReveal;
    $('nextBtn').hidden = !isReveal;
    $('nextBtn').textContent = s.qIndex >= s.total - 1 ? 'Ver o pódio' : 'Ver placar';

    const items = [...list.children];
    if (isReveal) {
      const total = s.counts.reduce((a, b) => a + b, 0) || 1;
      const max = Math.max(...s.counts, 1);
      items.forEach((li, i) => {
        li.classList.toggle('right', i === s.correct);
        li.classList.toggle('wrong', i !== s.correct);
        li.querySelector('.opt-count').textContent = s.counts[i];
        li.querySelector('.opt-count').title = `${Math.round((s.counts[i] / total) * 100)}%`;
        requestAnimationFrame(() => {
          li.querySelector('.opt-bar').style.width = `${(s.counts[i] / max) * 100}%`;
        });
      });
      stopTimer();
      $('timer').style.setProperty('--p', 0);
      $('timerNum').textContent = '0';
    } else {
      items.forEach((li) => {
        li.classList.remove('right', 'wrong');
        li.querySelector('.opt-count').textContent = '';
        li.querySelector('.opt-bar').style.width = '0';
      });
      startTimer(s.remainingMs, q.time * 1000);
    }
  }

  function startTimer(remaining, total) {
    timerEndsAt = performance.now() + remaining;
    timerTotal = total;
    cancelAnimationFrame(timerRaf);
    const tick = () => {
      const left = Math.max(0, timerEndsAt - performance.now());
      $('timer').style.setProperty('--p', left / timerTotal);
      $('timer').classList.toggle('low', left < 5000);
      $('timerNum').textContent = Math.ceil(left / 1000);
      if (left > 0) timerRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopTimer() {
    cancelAnimationFrame(timerRaf);
    $('timer').classList.remove('low');
  }

  // ---------- Placar ----------
  function renderBoard(s) {
    show('board');
    $('boardSub').textContent = `Depois da pergunta ${s.qIndex + 1} de ${s.total}`;
    const top = s.players.slice(0, 5);
    $('boardList').innerHTML = top
      .map((p, i) => {
        const gain = p.score - (prevScores.get(p.id) || 0);
        return `<li style="animation-delay:${i * 90}ms">
          <span class="chev">${p.rank}</span>
          <div class="row">
            <span class="name">${esc(p.name)}${gain > 0 ? `<span class="gain">+${fmt(gain)}</span>` : ''}</span>
            <span class="pts">${fmt(p.score)}</span>
          </div>
        </li>`;
      })
      .join('');
    $('boardNext').focus();
  }

  // ---------- Pódio ----------
  const CROWN =
    '<svg class="crown" viewBox="0 0 200 54" aria-hidden="true" preserveAspectRatio="none"><path d="M0 54V34C0 12 18 1 44 3c22 2 32 14 56 10 24 4 34-8 56-10 26-2 44 9 44 31v20z"/></svg>';

  function renderPodium(s) {
    show('podium');
    if (podiumShown) return;
    podiumShown = true;
    const [p1, p2, p3] = s.players;
    const slot = (p, place, cls) => `
      <div class="tooth ${cls}${p ? '' : ' empty'}" data-place="${place}">
        <div class="who">
          <strong>${p ? esc(p.name) : '—'}</strong>
          <span>${p ? `${fmt(p.score)} pontos` : ''}</span>
        </div>
        ${CROWN}
        <div class="root"><b>${place}º</b></div>
      </div>`;
    $('podiumStage').innerHTML = slot(p2, 2, 'second') + slot(p1, 1, 'first') + slot(p3, 3, 'third');
    // revela 3º, depois 2º, e por último o 1º
    const order = [3, 2, 1];
    order.forEach((place, i) => {
      setTimeout(() => {
        const el = $('podiumStage').querySelector(`[data-place="${place}"]`);
        if (el) el.classList.add('show');
      }, 600 + i * (place === 1 ? 1500 : 1300));
    });
  }

  // ---------- Estado ----------
  // ---------- Senha do apresentador ----------
  const KEY_STORE = 'desafio-clinico-host-key';
  let hostKey = '';
  try { hostKey = sessionStorage.getItem(KEY_STORE) || ''; } catch {}
  const params = new URLSearchParams(location.search);
  if (params.has('senha')) {
    hostKey = params.get('senha') || '';
    try { sessionStorage.setItem(KEY_STORE, hostKey); } catch {}
    // tira a senha da barra de endereço para não aparecer no projetor
    params.delete('senha');
    history.replaceState(null, '', location.pathname + (params.toString() ? `?${params}` : ''));
  }

  const hello = () => socket.emit('host:hello', { origin: location.origin, key: hostKey });

  socket.on('connect', () => {
    $('offline').hidden = true;
    hello();
  });

  socket.on('host:denied', (msg) => {
    for (const s of screens) $(s).hidden = true;
    $('locked').hidden = false;
    $('lockErr').textContent = msg || '';
    $('lockInput').value = '';
    $('lockInput').focus();
  });

  $('lockForm').addEventListener('submit', (e) => {
    e.preventDefault();
    hostKey = $('lockInput').value.trim();
    try { sessionStorage.setItem(KEY_STORE, hostKey); } catch {}
    hello();
  });

  socket.on('host:join', (j) => {
    $('locked').hidden = true;
    $('pin').textContent = j.pin;
    $('displayUrl').textContent = j.displayUrl;
    $('qr').innerHTML = j.qr;
  });
  socket.on('disconnect', () => ($('offline').hidden = false));

  socket.on('host:state', (s) => {
    const prevPhase = state && state.phase;
    // guarda pontuação antes da revelação para mostrar o ganho da rodada no placar
    if (s.phase === 'question' && prevPhase !== 'question') {
      prevScores = new Map(s.players.map((p) => [p.id, p.score]));
    }
    state = s;
    if (s.phase !== 'podium') podiumShown = false;
    if (s.phase === 'lobby') renderedQuestion = -1;

    switch (s.phase) {
      case 'lobby':
        renderLobby(s);
        break;
      case 'question':
      case 'reveal':
        renderQuestion(s);
        break;
      case 'leaderboard':
        renderBoard(s);
        break;
      case 'podium':
        renderPodium(s);
        break;
    }
  });

  // ---------- Controles ----------
  const next = () => socket.emit('host:next');
  $('startBtn').addEventListener('click', next);
  $('skipBtn').addEventListener('click', next);
  $('nextBtn').addEventListener('click', next);
  $('boardNext').addEventListener('click', next);
  $('againBtn').addEventListener('click', () => socket.emit('host:reset', { keepPlayers: true }));
  $('resetBtn').addEventListener('click', () => socket.emit('host:reset', { keepPlayers: false }));

  // Barra de espaço / seta para a direita avançam (útil com passador de slides)
  document.addEventListener('keydown', (e) => {
    if (!state || e.target.closest('input, textarea')) return;
    if (e.key !== ' ' && e.key !== 'ArrowRight' && e.key !== 'PageDown') return;
    if (e.target.closest('button') && e.key === ' ') return; // o botão focado já trata
    if (state.phase === 'lobby' && state.players.length === 0) return;
    if (state.phase === 'podium') return;
    e.preventDefault();
    next();
  });
})();
