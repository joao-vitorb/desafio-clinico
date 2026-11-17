(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const LETTERS = ['A', 'B', 'C', 'D'];
  const SCREENS = ['sPin', 'sName', 'sWait', 'sQuestion', 'sSent', 'sResult', 'sFinal'];
  const KEY = 'desafio-clinico-player';
  const fmt = (n) => Number(n || 0).toLocaleString('pt-BR');

  const store = {
    get() {
      try { return localStorage.getItem(KEY); } catch { return null; }
    },
    set(v) {
      try { localStorage.setItem(KEY, v); } catch {}
    },
    clear() {
      try { localStorage.removeItem(KEY); } catch {}
    },
  };

  let pin = '';
  let joined = false;
  let renderedQ = -1;
  let timerRaf = 0;
  let pickedChoice = null;
  let toastTimer = 0;

  function show(id) {
    for (const s of SCREENS) $(s).hidden = s !== id;
    $('bar').hidden = !joined;
  }

  function toast(msg) {
    $('toast').textContent = msg;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('toast').hidden = true), 3500);
  }

  function shake(el) {
    el.classList.remove('shake');
    void el.offsetWidth;
    el.classList.add('shake');
  }

  // ---------- Entrada ----------
  function goPin(prefill) {
    joined = false;
    $('pinInput').value = prefill || '';
    show('sPin');
  }

  function goName() {
    $('pinShown').textContent = pin;
    show('sName');
    setTimeout(() => $('nameInput').focus(), 50);
  }

  $('pinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const value = $('pinInput').value.trim();
    if (!value) {
      $('pinErr').textContent = 'Digite o PIN que aparece no telão.';
      return shake($('pinInput'));
    }
    socket.emit('player:checkPin', value, (res) => {
      if (res && res.ok) {
        pin = value;
        $('pinErr').textContent = '';
        goName();
      } else {
        $('pinErr').textContent = 'PIN incorreto. Confira o código no telão.';
        shake($('pinInput'));
      }
    });
  });

  $('nameForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('nameInput').value.trim();
    const btn = e.submitter || $('nameForm').querySelector('button');
    btn.disabled = true;
    socket.emit('player:join', { pin, name }, (res) => {
      btn.disabled = false;
      if (res && res.ok) {
        joined = true;
        store.set(res.id);
        $('nameErr').textContent = '';
      } else {
        $('nameErr').textContent = (res && res.error) || 'Não foi possível entrar. Tente de novo.';
        shake($('nameInput'));
      }
    });
  });

  // ---------- Jogo ----------
  function startTimer(remaining, total) {
    const endsAt = performance.now() + remaining;
    cancelAnimationFrame(timerRaf);
    const tick = () => {
      const left = Math.max(0, endsAt - performance.now());
      $('timer').style.setProperty('--p', left / total);
      $('timer').classList.toggle('low', left < 5000);
      $('timerNum').textContent = Math.ceil(left / 1000);
      if (left > 0) timerRaf = requestAnimationFrame(tick);
      else lockAnswers();
    };
    tick();
  }

  function lockAnswers() {
    for (const b of $('answers').querySelectorAll('button')) b.disabled = true;
  }

  function renderQuestion(s) {
    if (renderedQ !== s.qIndex) {
      renderedQ = s.qIndex;
      pickedChoice = null;
      $('qCount').textContent = `Pergunta ${s.qIndex + 1} de ${s.total}`;
      $('qText').textContent = s.question.text;
      const list = $('answers');
      list.innerHTML = '';
      s.question.options.forEach((text, i) => {
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = `<span class="chev" aria-hidden="true">${LETTERS[i]}</span><span class="ans-text"></span>`;
        b.querySelector('.ans-text').textContent = text;
        b.setAttribute('aria-label', `${LETTERS[i]}: ${text}`);
        b.addEventListener('click', () => answer(i, b));
        li.appendChild(b);
        list.appendChild(li);
      });
    }
    show('sQuestion');
    startTimer(s.remainingMs, s.question.time * 1000);
  }

  function answer(i, btn) {
    if (pickedChoice !== null) return;
    pickedChoice = i;
    btn.classList.add('picked');
    lockAnswers();
    if (navigator.vibrate) navigator.vibrate(30);
    socket.emit('player:answer', i, (res) => {
      if (!res || !res.ok) toast('O tempo acabou antes da resposta chegar.');
    });
  }

  function ordinal(n) {
    return `${n}º`;
  }

  function renderResult(s) {
    const y = s.you;
    const card = $('resultCard');
    card.classList.remove('miss');
    // reinicia a animação
    void card.offsetWidth;
    if (y.lastCorrect === true) {
      $('resultLabel').textContent = `Pergunta ${s.qIndex + 1}`;
      $('resultTitle').textContent = 'Correto!';
      $('resultPoints').textContent = `+${fmt(y.lastPoints)} pontos`;
      $('resultAnswer').innerHTML = '';
      if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
    } else {
      card.classList.add('miss');
      $('resultLabel').textContent = `Pergunta ${s.qIndex + 1}`;
      $('resultTitle').textContent = y.lastCorrect === false ? 'Não foi dessa vez' : 'Sem resposta';
      $('resultPoints').textContent = '+0 pontos';
      $('resultAnswer').innerHTML = '';
      const label = document.createElement('span');
      label.textContent = 'Resposta certa:';
      const strong = document.createElement('strong');
      strong.textContent = `${LETTERS[s.correct]}. ${s.correctText}`;
      $('resultAnswer').append(label, strong);
    }
    renderStanding(y);
    show('sResult');
  }

  function renderStanding(y) {
    $('rankNum').textContent = y.rank || '–';
    $('rankText').textContent = y.rank ? `${ordinal(y.rank)} lugar de ${y.of}` : 'Fora do ranking';
    $('gapText').textContent = y.behind
      ? y.behind.gap === 0
        ? `Empatado com ${y.behind.name}`
        : `${fmt(y.behind.gap)} pontos atrás de ${y.behind.name}`
      : y.rank === 1
        ? 'Você está na liderança'
        : '';
  }

  function renderFinal(s) {
    const r = s.you.rank;
    $('finalPlace').textContent = r ? ordinal(r) : '–';
    $('finalPlace').classList.toggle('long', r >= 10);
    const titles = { 1: 'Primeiro lugar!', 2: 'Segundo lugar!', 3: 'Terceiro lugar!' };
    $('finalTitle').textContent = titles[r] || 'Bom trabalho!';
    $('finalText').textContent = `Você fez ${fmt(s.you.score)} pontos e terminou em ${ordinal(r)} de ${s.you.of}.`;
    show('sFinal');
  }

  socket.on('state', (s) => {
    joined = true;
    $('barName').textContent = s.you.name;
    $('barScore').textContent = fmt(s.you.score);
    if (s.phase !== 'question') cancelAnimationFrame(timerRaf);

    switch (s.phase) {
      case 'lobby':
        renderedQ = -1;
        $('waitTitle').innerHTML = 'Você está<br />na sala';
        $('waitText').textContent = 'Olhe para o telão. O quiz começa em instantes.';
        show('sWait');
        break;
      case 'question':
        if (s.answered) {
          $('sentLetter').textContent = pickedChoice !== null ? LETTERS[pickedChoice] : '✓';
          show('sSent');
          cancelAnimationFrame(timerRaf);
        } else {
          renderQuestion(s);
        }
        break;
      case 'reveal':
        renderResult(s);
        break;
      case 'leaderboard':
        $('waitTitle').innerHTML = 'Olhe o<br />placar';
        $('waitText').textContent = s.you.rank
          ? `Você está em ${ordinal(s.you.rank)} lugar com ${fmt(s.you.score)} pontos. A próxima pergunta já vem.`
          : 'A próxima pergunta já vem.';
        show('sWait');
        break;
      case 'podium':
        renderFinal(s);
        break;
    }
  });

  socket.on('kicked', (msg) => {
    store.clear();
    joined = false;
    renderedQ = -1;
    toast(msg);
    goPin(pin);
  });

  socket.on('connect', () => {
    const id = store.get();
    if (id) {
      socket.emit('player:resume', id, (res) => {
        if (res && res.ok) return; // o estado chega pelo evento 'state'
        store.clear();
        startJoinFlow();
      });
    } else if (!joined) {
      startJoinFlow();
    }
  });

  socket.on('disconnect', () => {
    if (joined) toast('Conexão perdida. Reconectando…');
  });

  function startJoinFlow() {
    if (!$('sPin').hidden || !$('sName').hidden) return;
    const urlPin = new URLSearchParams(location.search).get('pin');
    if (urlPin) {
      socket.emit('player:checkPin', urlPin, (res) => {
        if (res && res.ok) {
          pin = urlPin;
          goName();
        } else {
          goPin('');
        }
      });
    } else {
      goPin('');
    }
  }
})();
