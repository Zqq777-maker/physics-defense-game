/* =====================================================================
 * pk.js —— 双人实时 PK 对战逻辑（独立于 index.html 的单机逻辑）
 * 规则：房主=植物方（运行物理引擎），客机=僵尸方（放置僵尸）。
 * 房主每 0.1s 通过 Supabase Realtime 广播画面快照给客机。
 * 依赖：index.html 内联脚本暴露的 PLANT_DEFS / ZOMBIE_DEFS / showQuestion /
 *       Audio8 / toast / currentUser / LS / addChest（均为全局）。
 * ===================================================================== */
window.PK = (function () {

  const ROWS = 5, COLS = 9, W = 900, H = 500, cw = W / COLS, ch = H / ROWS; // H 为画布高度常量
  let role = null;          // 'plant'(host) | 'zombie'(client)
  let code = null, channel = null, running = false;
  let raf = null, bcastTimer = null;

  // 房主物理引擎状态（ENG 避免与高度常量 H 冲突）
  const ENG = {
    canvas: null, ctx: null, plants: [], zombies: [], peas: [], mowers: [],
    grid: [], hp: 100, placed: 0, maxZ: 30, lastTs: 0,
    hand: [], selected: -1, asked: new Set(), speedPenalty: 0,
  };
  // 客机状态
  const CLI = { canvas: null, ctx: null, state: null, localZombies: [], hand: [], selected: -1, asked: new Set() };

  /* ---------- 基础：房间建立 ---------- */
  function status(msg) { document.getElementById('pk-status').textContent = msg; }

  function open() {
    if (!window.supabase || !sb) { toast('双人PK需配置 Supabase 云端', 'danger'); return; }
    showScreen('pk'); document.getElementById('pk-lobby').classList.remove('hidden');
    document.getElementById('pk-battle').classList.add('hidden'); status('请输入房间号加入，或创建房间。');
  }

  function makeCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

  function joinChannel(c) {
    channel = sb.channel('pk-' + c, { config: { broadcast: { self: true } } });
    channel.on('broadcast', { event: 'requestJoin' }, onRequestJoin);
    channel.on('broadcast', { event: 'accepted' }, onAccepted);
    channel.on('broadcast', { event: 'place' }, onPlace);
    channel.on('broadcast', { event: 'state' }, onState);
    channel.on('broadcast', { event: 'gameover' }, onGameOver);
    channel.subscribe((st) => {
      if (st !== 'SUBSCRIBED') { status('连接中…'); return; }
      if (role === 'zombie') channel.send({ type: 'broadcast', event: 'requestJoin', payload: { role: 'zombie' } });
      else status('房间 ' + code + ' 已创建，等待对手加入…');
    });
  }

  function createRoom() {
    role = 'plant'; code = makeCode(); status('创建房间 ' + code + ' …'); joinChannel(code);
  }
  function joinRoom() {
    const v = document.getElementById('pk-code').value.trim();
    if (!/^\d{4}$/.test(v)) { toast('请输入4位数字房间号', 'warn'); return; }
    role = 'zombie'; code = v; status('加入房间 ' + code + ' …'); joinChannel(code);
  }
  function exit() {
    running = false; if (raf) cancelAnimationFrame(raf); if (bcastTimer) clearInterval(bcastTimer);
    if (channel) { channel.unsubscribe(); channel = null; }
    showScreen('lobby');
  }

  /* ---------- 握手 ---------- */
  function onRequestJoin() { // 仅房主收到
    if (role !== 'plant') return;
    channel.send({ type: 'broadcast', event: 'accepted', payload: { role: 'plant', code } });
    status('对手已加入！开始对战。');
    if (!running) startBattle();
  }
  function onAccepted() { // 仅客机收到
    if (role !== 'zombie') return;
    status('已加入房间 ' + code + '，开始对战！');
    if (!running) startBattle();
  }

  /* ---------- 开始对战 ---------- */
  function startBattle() {
    running = true;
    document.getElementById('pk-lobby').classList.add('hidden');
    document.getElementById('pk-battle').classList.remove('hidden');
    document.getElementById('pk-room').textContent = '房间 ' + code;
    document.getElementById('pk-role').textContent = role === 'plant' ? '🌻 我方：植物方' : '🧟 我方：僵尸方';
    document.getElementById('pk-answer-btn').textContent = role === 'plant' ? '📝 答题获植物' : '📝 答题获僵尸';

    if (role === 'plant') {
      ENG.canvas = document.getElementById('pk-canvas'); ENG.ctx = ENG.canvas.getContext('2d');
      ENG.grid = Array.from({ length: 5 }, () => Array(9).fill(null));
      ENG.mowers = Array.from({ length: 5 }, () => ({ used: false, active: false, px: -1 }));
      ENG.plants = []; ENG.zombies = []; ENG.peas = []; ENG.hp = 100; ENG.placed = 0; ENG.hand = [];
      ENG.hand.push(Object.assign({}, PLANT_DEFS.peashooter)); // 起始卡
      ENG.lastTs = performance.now();
      renderHandPk();
      ENG.canvas.addEventListener('click', hostClick);
      ENG.lastTs = performance.now(); ENG.loop(ENG.lastTs);
      bcastTimer = setInterval(broadcast, 100);
    } else {
      CLI.canvas = document.getElementById('pk-canvas'); CLI.ctx = CLI.canvas.getContext('2d');
      CLI.state = { zombies: [], peas: [], plants: [], hp: 100, placed: 0, maxZ: 30 };
      CLI.localZombies = []; CLI.hand = []; CLI.selected = -1;
      CLI.canvas.addEventListener('click', clientClick);
      CLI.loop();
    }
    updateTopbar();
  }

  /* ---------- 房主：物理引擎 ---------- */
  ENG.loop = function (ts) {
    if (!running || role !== 'plant') return;
    const dt = Math.min(0.05, (ts - ENG.lastTs) / 1000); ENG.lastTs = ts;
    updateHost(dt); renderHost(); raf = requestAnimationFrame(t => ENG.loop(t));
  };
  function updateHost(dt) {
    const now = performance.now();
    const baseSpeed = 0.3 + ENG.speedPenalty;
    // 植物开火
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) {
      const p = ENG.grid[r][c]; if (!p || p.def.atk <= 0) continue;
      p.cd = (p.cd || 0) - dt;
      const front = ENG.zombies.some(z => z.row === r && z.zx >= c - 0.2);
      if (p.cd <= 0 && front) { ENG.peas.push({ row: r, px: (c + 0.5) * cw, dmg: p.def.dmg, slow: !!p.def.slow }); p.cd = p.def.atk; Audio8.playSfx('plant'); }
    }
    // 僵尸移动 / 啃食
    for (const z of ENG.zombies) {
      let sp = baseSpeed; if (z.slowUntil > now) sp *= 0.5; if (z.stunUntil > now) sp = 0;
      z.zx -= sp * dt;
      const col = Math.floor(z.zx);
      const p = (z.zx >= 0 && col >= 0 && col <= 8) ? ENG.grid[z.row][col] : null;
      if (p) { p.hp -= 6 * dt; if (p.hp <= 0) ENG.grid[z.row][col] = null; }
    }
    // 子弹
    for (const pe of ENG.peas) pe.px += 4.5 * dt * cw;
    ENG.peas = ENG.peas.filter(pe => {
      if (pe.px > W) return false;
      const hit = ENG.zombies.find(z => z.row === pe.row && Math.abs(z.zx * cw - pe.px) <= 22);
      if (hit) { hit.hp -= pe.dmg; if (pe.slow) hit.slowUntil = now + 3000; Audio8.playSfx('hit'); return false; }
      return true;
    });
    ENG.zombies = ENG.zombies.filter(z => z.hp > 0);
    // 小推车 / 破防扣血（每个僵尸突破仅扣一次）
    for (const z of ENG.zombies) {
      if (z.zx <= 0.2) {
        const m = ENG.mowers[z.row];
        if (!m.active && !m.used) { m.active = true; m.used = true; }
        else if (m.used && !m.active) { ENG.hp -= 20; z.dead = true; }
      }
    }
    for (const m of ENG.mowers) if (m.active) {
      m.px += 14 * dt * cw;
      const row = ENG.mowers.indexOf(m);
      ENG.zombies = ENG.zombies.filter(z => !(z.row === row && z.zx * cw <= m.px));
      if (m.px > W) m.active = false;
    }
    ENG.zombies = ENG.zombies.filter(z => !z.dead);
    if (ENG.hp <= 0) { gameOver('zombie'); return; }
    if (ENG.placed >= ENG.maxZ && ENG.zombies.length === 0) { gameOver('plant'); return; }
  }
  function renderHost() {
    const ctx = ENG.ctx; ctx.clearRect(0, 0, W, H);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) { ctx.fillStyle = (r + c) % 2 ? '#a8d672' : '#9bce63'; ctx.fillRect(c * cw, r * ch, cw, ch); }
    ENG.mowers.forEach((m, r) => { ctx.fillStyle = m.used && !m.active ? '#999' : '#ddd'; ctx.fillRect(-2 + (m.active ? m.px : 0), r * ch + 40, 22, 20); });
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) {
      const p = ENG.grid[r][c]; if (!p) continue; const x = c * cw, y = r * ch;
      ctx.fillStyle = p.def.color; ctx.fillRect(x + 22, y + 30, 56, 56);
      if (p.base64) { const im = new Image(); im.src = p.base64; ctx.drawImage(im, x + 26, y + 34, 48, 48); }
      else { ctx.font = '40px serif'; ctx.textAlign = 'center'; ctx.fillText(p.def.emoji, x + 50, y + 72); }
    }
    ENG.zombies.forEach(z => drawZombie(ctx, z));
    ENG.peas.forEach(pe => { ctx.fillStyle = pe.slow ? '#5bc0de' : '#7ed957'; ctx.beginPath(); ctx.arc(pe.px, pe.row * ch + 60, 8, 0, 7); ctx.fill(); });
  }
  function drawZombie(ctx, z) {
    const x = z.zx * cw, y = z.row * ch;
    ctx.fillStyle = z.stunUntil > performance.now() ? '#9bbf8a' : (z.color || '#7a9c5b');
    ctx.fillRect(x + 24, y + 40, 40, 50);
    if (z.base64) { const im = new Image(); im.src = z.base64; ctx.drawImage(im, x + 28, y + 20, 32, 32); }
    else { ctx.font = '34px serif'; ctx.textAlign = 'center'; ctx.fillText(z.emoji || '🧟', x + 44, y + 60); }
    if (z.hat === 'cone') { ctx.fillStyle = '#d98b3b'; ctx.beginPath(); ctx.moveTo(x + 44, y + 12); ctx.lineTo(x + 34, y + 40); ctx.lineTo(x + 54, y + 40); ctx.fill(); }
    if (z.hat === 'bucket') { ctx.fillStyle = '#9aa0a6'; ctx.fillRect(x + 34, y + 14, 20, 28); }
    if (z.hat === 'football') { ctx.fillStyle = '#8b5a2b'; ctx.beginPath(); ctx.ellipse(x + 44, y + 22, 16, 12, 0, 0, 7); ctx.fill(); }
    ctx.fillStyle = '#b33'; ctx.fillRect(x + 24, y + 36, 40 * Math.max(0, z.hp / z.maxhp), 4);
  }
  function broadcast() {
    if (role !== 'plant') return;
    channel.send({ type: 'broadcast', event: 'state', payload: {
      zombies: ENG.zombies.map(z => ({ id: z.id, row: z.row, zx: z.zx, hp: z.hp, maxhp: z.maxhp, hat: z.hat, base64: z.base64, emoji: z.emoji, color: z.color, name: z.name, stunUntil: z.stunUntil })),
      peas: ENG.peas.map(p => ({ row: p.row, px: p.px })),
      plants: Object.values(ENG.grid).flat().filter(Boolean).map(p => ({ row: p._r, col: p._c, base64: p.base64, emoji: p.def.emoji, color: p.def.color, name: p.def.name, hp: p.hp, maxhp: p.def.hp })),
      hp: ENG.hp, placed: ENG.placed, maxZ: ENG.maxZ,
    } });
  }

  /* ---------- 房主：接收客机放置指令 ---------- */
  function onPlace({ payload }) {
    if (role !== 'plant') return;
    if (ENG.placed >= ENG.maxZ) return;
    const { id, row, type } = payload;
    if (ENG.zombies.some(z => z.id === id)) return; // 去重
    const z = buildZombie(type); z.id = id; z.row = row; z.zx = 9.4; z.slowUntil = 0; z.stunUntil = 0;
    ENG.zombies.push(z); ENG.placed++;
  }
  function buildZombie(type) {
    if (type.startsWith('LOCALZ:')) {
      const def = (LS.get('pvz_local_zombies', []).find(d => d.key === type.split(':')[1]));
      return { name: def.name, hp: def.hp, maxhp: def.hp, speed: def.speed, base64: def.base64, color: def.color, custom: true };
    }
    const d = ZOMBIE_DEFS[type]; return { name: d.name, hp: d.hp, maxhp: d.hp, speed: d.speed, hat: d.hat, emoji: d.emoji, color: d.color };
  }

  /* ---------- 客机：接收快照并渲染 ---------- */
  function onState({ payload }) {
    if (role !== 'zombie') return;
    CLI.state = payload;
    const ids = new Set(payload.zombies.map(z => z.id));
    CLI.localZombies = CLI.localZombies.filter(z => !ids.has(z.id)); // 已被房主确认则移除（防闪烁）
    updateTopbar();
  }
  CLI.loop = function () {
    if (!running || role !== 'zombie') return;
    renderClient(); raf = requestAnimationFrame(() => CLI.loop());
  };
  function renderClient() {
    const ctx = CLI.ctx; const s = CLI.state || { zombies: [], peas: [], plants: [], hp: 100 };
    ctx.clearRect(0, 0, W, H);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 9; c++) { ctx.fillStyle = (r + c) % 2 ? '#a8d672' : '#9bce63'; ctx.fillRect(c * cw, r * ch, cw, ch); }
    (s.plants || []).forEach(p => { const x = p.col * cw, y = p.row * ch; ctx.fillStyle = p.color; ctx.fillRect(x + 22, y + 30, 56, 56); if (p.base64) { const im = new Image(); im.src = p.base64; ctx.drawImage(im, x + 26, y + 34, 48, 48); } else { ctx.font = '40px serif'; ctx.textAlign = 'center'; ctx.fillText(p.emoji, x + 50, y + 72); } });
    const seen = new Set((s.zombies || []).map(z => z.id));
    (s.zombies || []).forEach(z => drawZombie(ctx, z));
    CLI.localZombies.filter(z => !seen.has(z.id)).forEach(z => drawZombie(ctx, z)); // 本地防闪烁
    (s.peas || []).forEach(pe => { ctx.fillStyle = '#7ed957'; ctx.beginPath(); ctx.arc(pe.px, pe.row * ch + 60, 8, 0, 7); ctx.fill(); });
  }

  /* ---------- 放置 ---------- */
  function hostClick(e) {
    if (ENG.selected < 0) return;
    const rect = ENG.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (W / rect.width);
    const cy = (e.clientY - rect.top) * (H / rect.height);
    const c = Math.floor(x / cw), r = Math.floor(cy / ch);
    if (c < 0 || c > 8 || r < 0 || r > 4) return;
    if (ENG.grid[r][c]) { toast('该格已有植物', 'warn'); return; }
    const def = ENG.hand[ENG.selected];
    ENG.grid[r][c] = { def, hp: def.hp, base64: def.base64, cd: 0, _r: r, _c: c };
    ENG.hand.splice(ENG.selected, 1); ENG.selected = -1; renderHandPk(); Audio8.playSfx('plant');
  }
  function clientClick(e) {
    if (CLI.selected < 0) return;
    const rect = CLI.canvas.getBoundingClientRect();
    const cy = (e.clientY - rect.top) * (H / rect.height);
    const r = Math.floor(cy / ch);
    if (r < 0 || r > 4) return;
    const def = CLI.hand[CLI.selected];
    const key = def.key.startsWith('local_zombie_') ? 'LOCALZ:' + def.key : def.key;
    const id = 'z_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5);
    const z = buildZombie(key);
    z.id = id; z.row = r; z.zx = 9.4; z.slowUntil = 0; z.stunUntil = 0;
    CLI.localZombies.push(z); // 本地先渲染防闪烁
    channel.send({ type: 'broadcast', event: 'place', payload: { id, row: r, type: key } });
    CLI.hand.splice(CLI.selected, 1); CLI.selected = -1; renderHandPk(); Audio8.playSfx('plant');
  }
  function renderHandPk() {
    const wrap = document.getElementById(role === 'plant' ? 'hand' : 'pk-hand');
    const hand = role === 'plant' ? ENG.hand : CLI.hand;
    const sel = role === 'plant' ? ENG.selected : CLI.selected;
    wrap.innerHTML = hand.map((d, i) =>
      `<div class="card ${i === sel ? 'sel' : ''}" onclick="PK.selCard(${i})">
        <div class="emoji">${d.base64 ? '<img style="width:34px;height:34px;border-radius:6px;" src="' + d.base64 + '"/>' : d.emoji}</div>
        <div class="nm">${d.name}</div></div>`).join('');
  }

  /* ---------- 答题（双方独立） ---------- */
  function getQuestion() {
    const pool = QUESTIONS_L1.concat(QUESTIONS_L2);
    const asked = role === 'plant' ? ENG.asked : CLI.asked;
    let i, n = 0; do { i = Math.floor(Math.random() * pool.length); n++; } while (asked.has(i) && n < 40);
    asked.add(i); return pool[i];
  }
  function openQuestion() {
    const q = getQuestion();
    showQuestion(q, q.answer.length > 1, (correct, secs, modify, qq) => {
      if (correct) {
        Audio8.playSfx('correct'); toast('✅ 答对');
        if (role === 'plant') { ENG.hand.push(Object.assign({}, PLANT_DEFS.peashooter)); renderHandPk(); }
        else { const keys = Object.keys(ZOMBIE_DEFS); const d = ZOMBIE_DEFS[keys[Math.floor(Math.random() * keys.length)]]; CLI.hand.push(Object.assign({}, d)); renderHandPk(); }
        if (Math.random() < 0.01) addChest('music'); // 音乐宝箱（单/双人通用）
      } else {
        Audio8.playSfx('wrong'); toast('❌ 答错', 'warn');
        if (role === 'plant') ENG.speedPenalty += 0.1;
      }
    });
  }
  function selCard(i) { if (role === 'plant') ENG.selected = (ENG.selected === i ? -1 : i); else CLI.selected = (CLI.selected === i ? -1 : i); renderHandPk(); }

  /* ---------- 胜负 ---------- */
  function gameOver(winner) {
    running = false; if (raf) cancelAnimationFrame(raf); if (bcastTimer) clearInterval(bcastTimer);
    if (role === 'plant') channel.send({ type: 'broadcast', event: 'gameover', payload: { winner } });
    const win = (winner === role);
    toast(win ? '🏆 我方胜利！' : '💀 我方失败', win ? '' : 'danger');
    Audio8.playSfx(win ? 'win' : 'lose');
  }
  function onGameOver({ payload }) {
    if (role !== 'zombie') return;
    const win = payload.winner === role;
    toast(win ? '🏆 我方胜利！' : '💀 我方失败', win ? '' : 'danger');
    Audio8.playSfx(win ? 'win' : 'lose');
    running = false; if (raf) cancelAnimationFrame(raf);
  }

  /* ---------- 顶栏 ---------- */
  function updateTopbar() {
    if (role === 'plant') {
      document.getElementById('pk-hp').textContent = '植物方HP ' + Math.max(0, ENG.hp);
      document.getElementById('pk-zleft').textContent = '僵尸剩余 ' + (ENG.maxZ - ENG.placed);
    } else if (CLI.state) {
      document.getElementById('pk-hp').textContent = '植物方HP ' + Math.max(0, CLI.state.hp);
      document.getElementById('pk-zleft').textContent = '僵尸剩余 ' + (CLI.state.maxZ - CLI.state.placed);
    }
  }

  return { open, createRoom, joinRoom, exit, openQuestion, selCard };
})();
