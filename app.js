/* ==========================================================================
   VibeGoals — логика трекера
   Ванильный JS, без зависимостей. Состояние в localStorage,
   опциональная синхронизация с server.js.
   ========================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------------
     Константы и состояние
     ------------------------------------------------------------------------ */

  const LS_STATE = 'vibegoals.state.v1';
  const LS_CFG = 'vibegoals.config.v1';
  const LS_VIEW = 'vibegoals.view.v1';

  const DAY = 86400000;

  const DEFAULT_STATE = {
    version: 1,
    startDate: '2026-11-01',
    people: [
      { id: 'denis', name: 'Денис', color: '#4ade80' },
      { id: 'gleb', name: 'Глеб', color: '#60a5fa' },
    ],
    goals: [
      { id: 'feb', label: 'К февралю', target: 500, deadline: '2027-02-01' },
      { id: 'summer', label: 'К лету', target: 1000, deadline: '2027-06-01' },
    ],
    entries: [],
    deleted: [],
    updatedAt: 0,
  };

  const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

  let state = loadState();
  let cfg = loadConfig();
  let view = localStorage.getItem(LS_VIEW) || 'team';
  if (!['team', ...state.people.map((p) => p.id)].includes(view)) view = 'team';

  let pollTimer = null;
  let pushTimer = null;
  let syncing = false;
  let toastTimer = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------------
     Утилиты
     ------------------------------------------------------------------------ */

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function parseDate(str) {
    const [y, m, d] = String(str).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
  }

  function dateStr(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  function today() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 12, 0, 0, 0);
  }

  function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d;
  }

  function dayDiff(a, b) {
    return Math.round((b - a) / DAY);
  }

  function money(value) {
    const n = Math.round((Number(value) || 0) * 100) / 100;
    return '$' + n.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  }

  function formatDate(date) {
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(date);
  }

  function plural(n, one, few, many) {
    const abs = Math.abs(n) % 100;
    const last = abs % 10;
    if (abs > 10 && abs < 20) return many;
    if (last === 1) return one;
    if (last >= 2 && last <= 4) return few;
    return many;
  }

  function daysText(n) {
    return `${n} ${plural(n, 'день', 'дня', 'дней')}`;
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function timeNow() {
    const d = new Date();
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /* ------------------------------------------------------------------------
     Хранилище
     ------------------------------------------------------------------------ */

  function normalizeState(raw) {
    const s = Object.assign(clone(DEFAULT_STATE), raw || {});
    if (!Array.isArray(s.people) || s.people.length < 1) s.people = clone(DEFAULT_STATE.people);
    s.people = s.people.slice(0, 2).map((p, i) => ({
      id: p.id || `person${i + 1}`,
      name: (p.name || `Игрок ${i + 1}`).slice(0, 24),
      color: p.color || (i === 0 ? '#4ade80' : '#60a5fa'),
    }));
    if (!Array.isArray(s.goals) || s.goals.length < 2) s.goals = clone(DEFAULT_STATE.goals);
    s.goals = s.goals.slice(0, 2).map((g, i) => ({
      id: g.id || DEFAULT_STATE.goals[i].id,
      label: (g.label || DEFAULT_STATE.goals[i].label).slice(0, 32),
      target: Math.max(1, Number(g.target) || DEFAULT_STATE.goals[i].target),
      deadline: g.deadline || DEFAULT_STATE.goals[i].deadline,
    }));
    s.startDate = s.startDate || DEFAULT_STATE.startDate;
    s.entries = (Array.isArray(s.entries) ? s.entries : [])
      .filter((e) => e && s.people.some((p) => p.id === e.personId))
      .map((e) => ({
        id: e.id || uid(),
        personId: e.personId,
        amount: Math.max(0, Number(e.amount) || 0),
        date: e.date || dateStr(today()),
        source: String(e.source || '').slice(0, 60),
        note: String(e.note || '').slice(0, 120),
      }))
      .filter((e) => e.amount > 0);
    s.deleted = Array.isArray(s.deleted) ? s.deleted : [];
    s.updatedAt = Number(s.updatedAt) || 0;
    return s;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      return raw ? normalizeState(JSON.parse(raw)) : clone(DEFAULT_STATE);
    } catch {
      return clone(DEFAULT_STATE);
    }
  }

  function loadConfig() {
    try {
      const raw = localStorage.getItem(LS_CFG);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Сохранённая настройка (даже пустая) важнее автоопределения.
        if (typeof parsed.endpoint === 'string') {
          return { endpoint: parsed.endpoint.trim() };
        }
      }
    } catch {
      /* ignore */
    }
    // Первый запуск на хостинге: сервер живёт по тому же адресу.
    if (location.protocol === 'http:' || location.protocol === 'https:') {
      return { endpoint: location.origin };
    }
    return { endpoint: '' };
  }

  function saveLocal() {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify(state));
    } catch {
      toast('Не удалось сохранить локально');
    }
  }

  function saveConfig() {
    try {
      localStorage.setItem(LS_CFG, JSON.stringify(cfg));
    } catch {
      /* noop */
    }
  }

  function touch() {
    state.updatedAt = Date.now();
    saveLocal();
    render();
    schedulePush();
  }

  /* ------------------------------------------------------------------------
     Расчёты
     ------------------------------------------------------------------------ */

  function personById(id) {
    return state.people.find((p) => p.id === id);
  }

  function entriesFor(personId) {
    return state.entries
      .filter((e) => !personId || e.personId === personId)
      .sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)));
  }

  function sumEntries(list) {
    return list.reduce((sum, e) => sum + e.amount, 0);
  }

  function activePeople() {
    if (view === 'team') return state.people;
    return state.people.filter((p) => p.id === view);
  }

  function isTeam() {
    return view === 'team';
  }

  function viewTotals() {
    const people = activePeople();
    const list = state.entries.filter((e) => people.some((p) => p.id === e.personId));
    return { list, total: sumEntries(list), count: list.length };
  }

  function goalStats(goal, target, earned) {
    const start = parseDate(state.startDate);
    const deadline = parseDate(goal.deadline);
    const now = today();

    const totalDays = Math.max(1, dayDiff(start, deadline));
    const elapsed = clamp(dayDiff(start, now), 0, totalDays);
    const leftDays = Math.max(0, dayDiff(now, deadline));
    const isLate = dayDiff(now, deadline) < 0;

    const expected = target * (elapsed / totalDays);
    const remaining = Math.max(0, target - earned);
    const pct = target > 0 ? clamp((earned / target) * 100, 0, 100) : 0;
    const planPct = target > 0 ? clamp((expected / target) * 100, 0, 100) : 0;
    const done = earned >= target;

    const paceWeek = elapsed > 0 ? earned / (elapsed / 7) : 0;
    const needWeek = leftDays > 0 ? remaining / (leftDays / 7) : remaining;

    let status;
    let tone;
    if (done) {
      status = 'цель взята';
      tone = 'ok';
    } else if (isLate) {
      status = 'дедлайн прошёл';
      tone = 'bad';
    } else if (earned - expected >= -0.05 * target) {
      status = 'в графике';
      tone = 'ok';
    } else if (earned - expected >= -0.2 * target) {
      status = 'немного отстаём';
      tone = 'warn';
    } else {
      status = 'отстаём';
      tone = 'bad';
    }

    let forecast = '';
    if (done) {
      forecast = 'Цель закрыта — можно ставить следующую.';
    } else if (paceWeek > 0) {
      const daysNeeded = Math.round(remaining / (paceWeek / 7));
      forecast = `При текущем темпе — к ${formatDate(addDays(now, daysNeeded))}.`;
    } else {
      forecast = 'Пока нет темпа: добавьте первую запись.';
    }

    return {
      target, earned, remaining, pct, planPct, leftDays, isLate,
      expected, paceWeek, needWeek, status, tone, done, forecast,
    };
  }

  /* ------------------------------------------------------------------------
     Рендер: шапка и герой
     ------------------------------------------------------------------------ */

  function render() {
    renderHeader();
    renderHero();
    renderTabs();
    renderGoals();
    renderChart();
    renderEntries();
    renderBadges();
    renderFormPeople();
  }

  function renderHeader() {
    const start = parseDate(state.startDate);
    const now = today();
    const day = dayDiff(start, now) + 1;
    $('#dayCount').textContent = day >= 1 ? `День ${day}` : 'Скоро старт';
  }

  function renderHero() {
    const { total, count } = viewTotals();
    const mult = state.people.length;
    const firstGoal = state.goals[0];
    const target = firstGoal.target * mult;
    const stats = goalStats(firstGoal, target, total);

    const start = parseDate(state.startDate);
    const elapsedDays = Math.max(1, dayDiff(start, today()));
    const pace = total / (elapsedDays / 7);

    $('#heroTotal').textContent = money(total);
    $('#heroOf').textContent = `из ${money(target)} к ${formatDate(parseDate(firstGoal.deadline))}`;

    const bar = $('#heroBar');
    bar.setAttribute('aria-valuenow', String(Math.round(stats.pct)));
    $('#heroFill').style.width = `${stats.pct}%`;
    $('#heroPlan').style.left = `${stats.planPct}%`;

    let note;
    if (stats.done) {
      const next = state.goals[1];
      note = `Командная цель на февраль взята. Следующая — ${money(next.target * mult)} к ${formatDate(parseDate(next.deadline))}.`;
    } else {
      const diff = total - stats.expected;
      const diffText = diff >= 0
        ? `опережаете план на ${money(diff)}`
        : `отстаёте от плана на ${money(-diff)}`;
      note = `До цели ${daysText(stats.leftDays)}. Сейчас ${diffText}, нужно ${money(stats.needWeek)} в неделю.`;
    }
    $('#heroNote').textContent = note;

    $('#statEntries').textContent = String(count);
    $('#statPerWeek').textContent = money(pace);
    $('#statLeft').textContent = stats.done ? 'взята' : daysText(stats.leftDays);
  }

  function renderTabs() {
    $$('#tabs .tab').forEach((tab) => {
      const isActive = tab.dataset.view === view;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
      const person = personById(tab.dataset.view);
      if (person) {
        tab.textContent = person.name;
        tab.style.setProperty('--person-color', person.color);
      }
    });
  }

  /* ------------------------------------------------------------------------
     Рендер: цели
     ------------------------------------------------------------------------ */

  function renderGoals() {
    const { total } = viewTotals();
    const mult = isTeam() ? state.people.length : 1;
    const person = personById(view);

    const cards = state.goals.map((goal, index) => {
      const target = goal.target * mult;
      const stats = goalStats(goal, target, total);
      const pctTone = stats.tone === 'ok' ? '' : `is-${stats.tone}`;
      const classes = ['goal'];
      if (stats.done) classes.push('is-done');
      if (!isTeam() && person && person.id === 'gleb') classes.push('is-gleb');

      return `
        <article class="${classes.join(' ')}">
          <div class="goal__top">
            <div>
              <p class="goal__tag">Цель ${index + 1} · ${esc(goal.label)}${isTeam() ? ' · вместе' : ''}</p>
              <p class="goal__amount">${money(target)}</p>
            </div>
            <span class="goal__pct ${pctTone}">${Math.round(stats.pct)}%</span>
          </div>

          <div class="goal__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
               aria-valuenow="${Math.round(stats.pct)}" aria-label="${esc(goal.label)}">
            <div class="goal__fill" style="width:${stats.pct}%"></div>
            <span class="goal__plan" style="left:${stats.planPct}%" title="План на сегодня"></span>
          </div>

          <div class="goal__nums">
            <span>Заработано <b>${money(stats.earned)}</b></span>
            <span>${stats.done ? 'Цель взята' : `Осталось <b>${money(stats.remaining)}</b>`}</span>
          </div>

          <div class="goal__meta">
            <span>${stats.done ? 'Закрыта' : `Осталось ${daysText(stats.leftDays)}`}</span>
            <span>${stats.done ? '—' : `Нужно ${money(stats.needWeek)}/нед`}</span>
            <span class="pill is-${stats.tone}">${stats.status}</span>
          </div>

          <p class="goal__forecast">${stats.forecast}</p>
        </article>
      `;
    });

    $('#goals').innerHTML = cards.join('');
  }

  /* ------------------------------------------------------------------------
     Рендер: график
     ------------------------------------------------------------------------ */

  function niceStep(value) {
    if (!isFinite(value) || value <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(value)));
    const n = value / pow;
    const steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
    const factor = steps.find((s) => s >= n - 1e-9) || 10;
    return factor * pow;
  }

  function renderChart() {
    const svg = $('#chart');
    const W = 760;
    const H = 320;
    const P = { l: 54, r: 16, t: 18, b: 38 };
    const plotW = W - P.l - P.r;
    const plotH = H - P.t - P.b;

    const people = activePeople();
    const mult = isTeam() ? state.people.length : 1;
    const start = parseDate(state.startDate);
    const lastGoal = state.goals[state.goals.length - 1];
    const now = today();
    const end = new Date(Math.max(parseDate(lastGoal.deadline).getTime(), now.getTime()));

    const series = people.map((person) => {
      const entries = entriesFor(person.id);
      let cum = 0;
      const points = entries.map((e) => {
        cum += e.amount;
        return { date: parseDate(e.date), value: cum };
      });
      return { person, entries, points, total: cum };
    });

    // В командном режиме показываем ещё и суммарную линию.
    if (isTeam()) {
      const entries = entriesFor(null);
      let cum = 0;
      const points = entries.map((e) => {
        cum += e.amount;
        return { date: parseDate(e.date), value: cum };
      });
      series.unshift({
        person: { id: 'team', name: 'Вместе', color: '#a78bfa' },
        entries,
        points,
        total: cum,
      });
    }

    const maxValue = Math.max(
      lastGoal.target * mult,
      ...series.map((s) => s.total),
      1
    );
    const step = niceStep((maxValue * 1.08) / 4);
    const yMax = step * 4;

    const x = (date) => P.l + ((date - start) / Math.max(1, end - start)) * plotW;
    const y = (value) => P.t + plotH - (value / yMax) * plotH;

    const parts = [];

    parts.push(`<defs>
      ${series.map((s, i) => `
        <linearGradient id="area-${i}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${s.person.color}" stop-opacity="0.18" />
          <stop offset="100%" stop-color="${s.person.color}" stop-opacity="0" />
        </linearGradient>`).join('')}
    </defs>`);

    // сетка и подписи Y
    for (let i = 0; i <= 4; i += 1) {
      const value = step * i;
      const py = y(value);
      parts.push(`<line class="chart-grid" x1="${P.l}" y1="${py}" x2="${W - P.r}" y2="${py}" />`);
      parts.push(`<text class="chart-axis" x="${P.l - 10}" y="${py + 3}" text-anchor="end">${money(value)}</text>`);
    }

    // подписи X по месяцам
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1, 12);
    while (cursor <= end) {
      if (cursor >= start) {
        const px = x(cursor);
        parts.push(`<line class="chart-grid" x1="${px}" y1="${P.t}" x2="${px}" y2="${H - P.b}" />`);
        parts.push(`<text class="chart-axis" x="${px}" y="${H - P.b + 18}" text-anchor="middle">${MONTHS_SHORT[cursor.getMonth()]}</text>`);
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // план
    const planPoints = [
      [start, 0],
      [parseDate(state.goals[0].deadline), state.goals[0].target * mult],
      [parseDate(state.goals[1].deadline), state.goals[1].target * mult],
    ];
    parts.push(`<polyline class="chart-plan" points="${planPoints.map(([d, v]) => `${x(d)},${y(v)}`).join(' ')}" />`);

    // линии участников
    series.forEach((s, i) => {
      if (!s.points.length) return;
      let d = `M ${x(start)} ${y(0)}`;
      let prev = 0;
      s.points.forEach((p) => {
        const px = clamp(x(p.date), P.l, W - P.r);
        d += ` L ${px} ${y(prev)} L ${px} ${y(p.value)}`;
        prev = p.value;
      });
      const endX = clamp(x(now), P.l, W - P.r);
      d += ` L ${endX} ${y(prev)}`;

      const area = `${d} L ${endX} ${y(0)} L ${x(start)} ${y(0)} Z`;
      parts.push(`<path d="${area}" fill="url(#area-${i})" />`);
      parts.push(`<path class="chart-line" d="${d}" stroke="${s.person.color}" />`);

      s.points.forEach((p) => {
        parts.push(`<circle class="chart-dot" cx="${clamp(x(p.date), P.l, W - P.r)}" cy="${y(p.value)}" r="3.2" fill="${s.person.color}" />`);
      });
    });

    // линия «сегодня»
    const todayX = clamp(x(now), P.l, W - P.r);
    if (now >= start && now <= end) {
      parts.push(`<line class="chart-today" x1="${todayX}" y1="${P.t}" x2="${todayX}" y2="${H - P.b}" />`);
      parts.push(`<text class="chart-today-label" x="${todayX + 4}" y="${P.t + 10}">сегодня</text>`);
    }

    // прозрачный слой для тултипа
    parts.push(`<rect id="chartHit" x="${P.l}" y="${P.t}" width="${plotW}" height="${plotH}" fill="transparent" style="cursor:crosshair" />`);

    svg.innerHTML = parts.join('');

    // легенда
    const legend = series
      .map((s) => `<span class="legend__item"><i class="legend__swatch" style="background:${s.person.color}"></i>${esc(s.person.name)}</span>`)
      .join('');
    $('#legend').innerHTML = `${legend}<span class="legend__item"><i class="legend__swatch legend__swatch--plan"></i>план</span>`;

    $('#chartSub').textContent = isTeam()
      ? 'Суммарный заработок обоих и план до лета'
      : `Накопленный заработок: ${personById(view)?.name || ''} и план`;

    attachChartTooltip({ svg, x, y, series, start, end, W, H, P, now });
  }

  function attachChartTooltip({ svg, x, y, series, start, end, W, H, P, now }) {
    const hit = $('#chartHit');
    const tip = $('#chartTip');
    if (!hit || !tip) return;

    const cumAt = (s, date) => {
      let value = 0;
      for (const p of s.points) {
        if (p.date <= date) value = p.value;
        else break;
      }
      return value;
    };

    const onMove = (event) => {
      const rect = svg.getBoundingClientRect();
      const px = ((event.clientX - rect.left) / rect.width) * W;
      if (px < P.l || px > W - P.r) {
        tip.hidden = true;
        return;
      }
      const ratio = (px - P.l) / (W - P.l - P.r);
      const date = new Date(start.getTime() + ratio * (end - start));

      const rows = series.map((s) => {
        const value = cumAt(s, date);
        return `<span><i style="background:${s.person.color}"></i>${esc(s.person.name)} · <b>${money(value)}</b></span>`;
      }).join('');

      tip.innerHTML = `<b>${formatDate(date)}</b>${rows}`;
      tip.hidden = false;

      const py = y(Math.max(0, ...series.map((s) => cumAt(s, date))));
      tip.style.left = `${(x(date) / W) * rect.width}px`;
      tip.style.top = `${(py / H) * rect.height}px`;
    };

    hit.addEventListener('mousemove', onMove);
    hit.addEventListener('mouseleave', () => { tip.hidden = true; });
  }

  /* ------------------------------------------------------------------------
     Рендер: история
     ------------------------------------------------------------------------ */

  function renderEntries() {
    const list = viewTotals().list.slice().sort((a, b) => (
      a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)
    ));

    $('#entriesSub').textContent = list.length
      ? `${list.length} ${plural(list.length, 'запись', 'записи', 'записей')} · ${money(sumEntries(list))}`
      : 'Пока пусто';

    if (!list.length) {
      $('#entries').innerHTML = `
        <li class="empty">
          Здесь появятся заработки. Добавьте первую сумму — и график оживёт.
        </li>`;
      return;
    }

    $('#entries').innerHTML = list.map((entry) => {
      const person = personById(entry.personId);
      const initial = person ? person.name.trim().charAt(0).toUpperCase() : '?';
      const metaParts = [formatDate(parseDate(entry.date))];
      if (entry.note) metaParts.push(entry.note);

      return `
        <li class="entry">
          <span class="entry__who" style="--who-color:${person ? person.color : '#4ade80'}">${esc(initial)}</span>
          <div class="entry__main">
            <div class="entry__title">
              <b>${money(entry.amount)}</b>
              <span class="entry__source">${esc(entry.source || 'без источника')}</span>
              ${isTeam() && person ? `<span class="entry__source">· ${esc(person.name)}</span>` : ''}
            </div>
            <div class="entry__meta">${esc(metaParts.join(' · '))}</div>
          </div>
          <button class="entry__del" type="button" data-del="${esc(entry.id)}" title="Удалить запись" aria-label="Удалить запись">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M4 7h16M9 7V5h6v2M7 7l1 13h8l1-13M10 11v6M14 11v6" />
            </svg>
          </button>
        </li>
      `;
    }).join('');
  }

  /* ------------------------------------------------------------------------
     Рендер: достижения
     ------------------------------------------------------------------------ */

  const BADGES = [
    { icon: '🌱', title: 'Первый доллар', note: 'первая запись', test: (s) => s.total > 0 },
    { icon: '💵', title: '$10', note: 'первые деньги', test: (s) => s.total >= 10 },
    { icon: '💸', title: '$50', note: 'уже не игрушки', test: (s) => s.total >= 50 },
    { icon: '💼', title: '$100', note: 'сотня', test: (s) => s.total >= 100 },
    { icon: '🔥', title: '$250', note: 'половина февраля', test: (s) => s.total >= 250 },
    { icon: '🏆', title: '$500', note: 'цель февраля', test: (s) => s.total >= 500 },
    { icon: '🚀', title: '$1000', note: 'цель лета', test: (s) => s.total >= 1000 },
    { icon: '🧾', title: '5 записей', note: 'системность', test: (s) => s.count >= 5 },
    { icon: '📚', title: '10 записей', note: 'привычка', test: (s) => s.count >= 10 },
  ];

  function renderBadges() {
    const { total, count } = viewTotals();
    const ctx = { total, count };
    $('#badges').innerHTML = BADGES.map((badge) => {
      const earned = badge.test(ctx);
      return `
        <div class="badge ${earned ? 'is-earned' : ''}" title="${earned ? 'Получено' : 'Ещё не открыто'}">
          <span class="badge__icon">${badge.icon}</span>
          <span class="badge__title">${badge.title}</span>
          <span class="badge__note">${badge.note}</span>
        </div>
      `;
    }).join('');
  }

  /* ------------------------------------------------------------------------
     Форма
     ------------------------------------------------------------------------ */

  function renderFormPeople() {
    const select = $('#fPerson');
    const current = select.value;
    select.innerHTML = state.people
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join('');

    if (current && state.people.some((p) => p.id === current)) {
      select.value = current;
    } else if (!isTeam()) {
      select.value = view;
    }
  }

  /* ------------------------------------------------------------------------
     Синхронизация
     ------------------------------------------------------------------------ */

  function apiUrl(path = '/api/state') {
    return cfg.endpoint.replace(/\/+$/, '') + path;
  }

  async function fetchJson(url, options = {}, timeout = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, { ...options, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function mergeStates(a, b) {
    const map = new Map();
    for (const entry of [...(b.entries || []), ...(a.entries || [])]) map.set(entry.id, entry);
    const deleted = new Set([...(b.deleted || []), ...(a.deleted || [])]);
    const newer = (a.updatedAt || 0) >= (b.updatedAt || 0) ? a : b;

    return normalizeState({
      ...newer,
      entries: [...map.values()].filter((e) => !deleted.has(e.id)),
      deleted: [...deleted],
      updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
    });
  }

  function fingerprint(s) {
    return JSON.stringify({
      p: s.people,
      g: s.goals,
      st: s.startDate,
      e: [...s.entries].sort((x, y) => x.id.localeCompare(y.id)),
      d: [...s.deleted].sort(),
    });
  }

  function setSync(kind, text) {
    const dot = $('#syncDot');
    dot.classList.toggle('is-ok', kind === 'ok');
    dot.classList.toggle('is-error', kind === 'error');
    $('#syncText').textContent = text;
  }

  async function pushRemote() {
    if (!cfg.endpoint) return;
    try {
      const remote = await fetchJson(apiUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
      });
      if (remote && Array.isArray(remote.entries)) {
        const merged = mergeStates(state, remote);
        if (fingerprint(merged) !== fingerprint(state)) {
          state = merged;
          saveLocal();
          render();
        }
        setSync('ok', `Синхронизировано · ${timeNow()}`);
      }
    } catch {
      setSync('error', 'Офлайн · сервер недоступен');
    }
  }

  async function pullRemote() {
    if (!cfg.endpoint || syncing) return;
    syncing = true;
    try {
      const remote = await fetchJson(apiUrl());
      if (remote && Array.isArray(remote.entries)) {
        const merged = mergeStates(state, remote);
        const changed = fingerprint(merged) !== fingerprint(state);
        if (changed) {
          state = merged;
          saveLocal();
          render();
        }
        if (fingerprint(merged) !== fingerprint(remote)) {
          await pushRemote();
        } else {
          setSync('ok', `Синхронизировано · ${timeNow()}`);
        }
      } else {
        await pushRemote();
      }
    } catch {
      setSync('error', 'Офлайн · сервер недоступен');
    } finally {
      syncing = false;
    }
  }

  function schedulePush() {
    if (!cfg.endpoint) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(pushRemote, 800);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = null;
    if (!cfg.endpoint) {
      setSync('', 'Локально · данные в браузере');
      return;
    }
    pullRemote();
    pollTimer = setInterval(pullRemote, 30000);
  }

  /* ------------------------------------------------------------------------
     Экспорт / импорт / сброс
     ------------------------------------------------------------------------ */

  function exportData() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `vibegoals-${dateStr(today())}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    toast('Данные выгружены');
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (!parsed || !Array.isArray(parsed.entries)) throw new Error('bad');
        if (!confirm('Заменить текущие данные импортированными?')) return;
        state = normalizeState(parsed);
        state.updatedAt = Date.now();
        saveLocal();
        render();
        schedulePush();
        toast('Данные импортированы');
      } catch {
        toast('Не получилось прочитать файл');
      }
    };
    reader.readAsText(file);
  }

  function resetAll() {
    if (!confirm('Сбросить все данные: записи, цели и имена?')) return;
    state = clone(DEFAULT_STATE);
    localStorage.removeItem(LS_STATE);
    localStorage.removeItem(LS_VIEW);
    view = 'team';
    saveLocal();
    render();
    schedulePush();
    toast('Всё сброшено');
  }

  /* ------------------------------------------------------------------------
     Настройки
     ------------------------------------------------------------------------ */

  function openSettings() {
    $('#sName1').value = state.people[0]?.name || '';
    $('#sName2').value = state.people[1]?.name || '';
    $('#sStart').value = state.startDate;
    $('#sLabel1').value = state.goals[0].label;
    $('#sTarget1').value = state.goals[0].target;
    $('#sDeadline1').value = state.goals[0].deadline;
    $('#sLabel2').value = state.goals[1].label;
    $('#sTarget2').value = state.goals[1].target;
    $('#sDeadline2').value = state.goals[1].deadline;
    $('#sEndpoint').value = cfg.endpoint;
    $('#settingsDialog').showModal();
  }

  function applySettings() {
    const name1 = $('#sName1').value.trim() || state.people[0].name;
    const name2 = $('#sName2').value.trim() || state.people[1].name;
    const target1 = Math.max(1, Number($('#sTarget1').value) || 1);
    const target2 = Math.max(1, Number($('#sTarget2').value) || 1);
    const deadline1 = $('#sDeadline1').value || state.goals[0].deadline;
    const deadline2 = $('#sDeadline2').value || state.goals[1].deadline;
    const startDate = $('#sStart').value || state.startDate;
    const endpoint = $('#sEndpoint').value.trim().replace(/\/+$/, '');

    state.people[0].name = name1.slice(0, 24);
    state.people[1].name = name2.slice(0, 24);
    state.startDate = startDate;
    state.goals[0] = {
      ...state.goals[0],
      label: $('#sLabel1').value.trim().slice(0, 32) || state.goals[0].label,
      target: target1,
      deadline: deadline1,
    };
    state.goals[1] = {
      ...state.goals[1],
      label: $('#sLabel2').value.trim().slice(0, 32) || state.goals[1].label,
      target: target2,
      deadline: deadline2,
    };

    cfg = { endpoint };
    saveConfig();
    state.updatedAt = Date.now();
    saveLocal();
    render();
    startPolling();
    schedulePush();
    toast('Настройки сохранены');
  }

  /* ------------------------------------------------------------------------
     Уведомления
     ------------------------------------------------------------------------ */

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('is-visible'), 2400);
  }

  /* ------------------------------------------------------------------------
     События
     ------------------------------------------------------------------------ */

  function bindEvents() {
    $('#tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (!tab) return;
      view = tab.dataset.view;
      localStorage.setItem(LS_VIEW, view);
      render();
      if (!isTeam()) $('#fPerson').value = view;
    });

    $('#entryForm').addEventListener('submit', (event) => {
      event.preventDefault();
      const amount = Number($('#fAmount').value);
      const date = $('#fDate').value || dateStr(today());
      const personId = $('#fPerson').value;
      const source = $('#fSource').value.trim();
      const note = $('#fNote').value.trim();

      if (!Number.isFinite(amount) || amount <= 0) {
        toast('Сумма должна быть больше нуля');
        $('#fAmount').focus();
        return;
      }
      if (!personId) {
        toast('Выберите, кто заработал');
        return;
      }

      state.entries.push({
        id: uid(),
        personId,
        amount: Math.round(amount * 100) / 100,
        date,
        source,
        note,
      });

      $('#fAmount').value = '';
      $('#fSource').value = '';
      $('#fNote').value = '';
      touch();
      toast(`Записано ${money(amount)}`);
    });

    $('#entries').addEventListener('click', (event) => {
      const button = event.target.closest('[data-del]');
      if (!button) return;
      const id = button.dataset.del;
      const entry = state.entries.find((e) => e.id === id);
      if (!entry) return;
      if (!confirm(`Удалить запись на ${money(entry.amount)}?`)) return;
      state.entries = state.entries.filter((e) => e.id !== id);
      state.deleted.push(id);
      touch();
      toast('Запись удалена');
    });

    $('#settingsBtn').addEventListener('click', openSettings);

    $('#settingsForm').addEventListener('submit', (event) => {
      if (event.submitter && event.submitter.value === 'save') {
        if (!$('#sDeadline1').value || !$('#sDeadline2').value) {
          event.preventDefault();
          toast('Укажите дедлайны целей');
          return;
        }
        applySettings();
      }
    });

    $('#exportBtn').addEventListener('click', exportData);
    $('#importBtn').addEventListener('click', () => $('#importFile').click());
    $('#importFile').addEventListener('change', (event) => {
      const file = event.target.files && event.target.files[0];
      if (file) importData(file);
      event.target.value = '';
    });
    $('#resetBtn').addEventListener('click', resetAll);

    window.addEventListener('storage', (event) => {
      if (event.key === LS_STATE && event.newValue) {
        try {
          state = normalizeState(JSON.parse(event.newValue));
          render();
        } catch {
          /* noop */
        }
      }
    });
  }

  /* ------------------------------------------------------------------------
     Старт
     ------------------------------------------------------------------------ */

  function init() {
    $('#fDate').value = dateStr(today());
    $('#fDate').max = dateStr(addDays(today(), 1));
    bindEvents();
    render();
    renderFormPeople();
    startPolling();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
