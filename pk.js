function showPKMenu() { document.getElementById('levelSelectScreen').style.display = 'none'; document.getElementById('pkMenuScreen').style.display = 'flex'; }

// 统一的顶部UI刷新函数
function updatePKUI() {
  const p1Name = state.mode === 'pk_host' ? state.name : (state.opponentName || '房主');
  const p2Name = state.mode === 'pk_guest' ? state.name : (state.opponentName || '客机');
  const hpColor = state.pkHp > 30 ? '#4caf50' : '#e53935';
  
  document.getElementById('pkPlayer1Info').innerHTML = `
    <div style="font-size:13px; opacity:0.8;">🌱 ${p1Name} (植物)</div>
    <div style="font-size:18px; color:${hpColor};">HP: ${state.pkHp}</div>
    <div style="font-size:12px; color:#ffd166;">房号: ${state.roomId}</div>
  `;
  
  document.getElementById('pkPlayer2Info').innerHTML = `
    <div style="font-size:13px; opacity:0.8;">🧟 ${p2Name} (僵尸)</div>
    <div style="font-size:18px; color:#ff9800;">剩余: ${30 - state.pkZombieCount}</div>
  `;
}

function createRoom() {
  const roomId = Math.floor(1000 + Math.random() * 9000).toString();
  state.roomId = roomId; state.mode = 'pk_host'; state.side = 'plant';
  
  document.getElementById('pkMenuScreen').style.display = 'none'; document.getElementById('gameScreen').classList.add('active');
  document.getElementById('singleTopBar').style.display = 'none'; document.getElementById('pkTopBar').style.display = 'flex'; document.getElementById('sideBar').style.display = 'none';
  
  state.pkHp = 100; state.pkZombieCount = 0;
  updatePKUI();
  
  state.channel = dbClient.channel('room_' + roomId);
  
  state.channel.on('broadcast', { event: 'join' }, payload => {
    state.opponentName = payload.payload.name;
    updatePKUI();
    showToast(`${state.opponentName} 已加入！`);
  });
  
  // 房主接收客机的放置指令（带上客机生成的唯一 ID）
  state.channel.on('broadcast', { event: 'guest_place' }, payload => {
    applyPKPlace(payload.payload.type, payload.payload.row, payload.payload.col, payload.payload.id);
  });

  state.channel.on('broadcast', { event: 'gameover' }, payload => {
    if (payload.payload.win === 'zombie') {
      state.isPlaying = false; alert('僵尸胜利！植物被吃掉了脑子。'); location.reload();
    }
  });
  
  state.channel.subscribe(); 
  renderCards(); 
  startMusic();
  
  state.isPlaying = true;
  state.lastTime = performance.now();
  requestAnimationFrame(pkLoop);
}

function joinRoom() {
  const roomId = document.getElementById('roomIdInput').value.trim();
  if (roomId.length !== 4) return showToast('请输入4位房间号');
  state.roomId = roomId; state.mode = 'pk_guest'; state.side = 'zombie';
  
  document.getElementById('pkMenuScreen').style.display = 'none'; document.getElementById('gameScreen').classList.add('active');
  document.getElementById('singleTopBar').style.display = 'none'; document.getElementById('pkTopBar').style.display = 'flex'; document.getElementById('sideBar').style.display = 'none';
  
  state.pkHp = 100; state.pkZombieCount = 0;
  updatePKUI();
  
  state.channel = dbClient.channel('room_' + roomId);
  
  // 客机接收房主同步的画面
  state.channel.on('broadcast', { event: 'sync' }, payload => {
    const s = payload.payload; 
    state.plants = s.plants; 
    state.bullets = s.bullets;
    
    // 画面合并策略：防止刚放的僵尸被旧数据覆盖
    const localZombieIds = state.zombies.map(z => z.id);
    const serverZombieIds = s.zombies.map(z => z.id);
    
    // 将服务端（房主）的僵尸数据作为基准
    let mergedZombies = [...s.zombies];
    
    // 检查客机本地有没有房主还没同步到的“新僵尸”（网络延迟导致），如果存在则保留它，避免闪烁
    state.zombies.forEach(localZ => {
      if (!serverZombieIds.includes(localZ.id)) {
        // 如果这个僵尸是刚放不到 2 秒的，强行保留在画面上
        if (Date.now() - localZ.id < 2000) {
          mergedZombies.push(localZ);
        }
      }
    });
    
    state.zombies = mergedZombies;
    state.pkHp = s.hp; state.pkZombieCount = s.zombieCount;
    state.opponentName = s.hostName; 
    updatePKUI(); 
    renderBoard();
  });
  
  state.channel.on('broadcast', { event: 'gameover' }, payload => {
    state.isPlaying = false;
    alert(payload.payload.win === 'zombie' ? '僵尸胜利！' : '植物胜利！');
    location.reload();
  });
  
  state.channel.subscribe(status => {
    if (status === 'SUBSCRIBED') {
      state.channel.send({ type: 'broadcast', event: 'join', payload: { name: state.name } });
    }
  });
  
  renderCards(); 
  startMusic();
  state.isPlaying = true;
}

// 房主专属的物理循环
let pkSyncTimer = 0;
function pkLoop(timestamp) {
  if (state.mode !== 'pk_host' || !state.isPlaying) return;
  if (!state.lastTime) state.lastTime = timestamp;
  let dt = (timestamp - state.lastTime) / 1000; state.lastTime = timestamp;
  if (dt > 0.1) dt = 0.1;
  
  updatePK(dt);
  
  pkSyncTimer += dt;
  if (pkSyncTimer > 0.1) { // 每 0.1 秒同步一次画面给客机
    pkSyncTimer = 0;
    state.channel.send({ type: 'broadcast', event: 'sync', payload: {
      plants: state.plants, zombies: state.zombies, bullets: state.bullets, 
      hp: state.pkHp, zombieCount: state.pkZombieCount, hostName: state.name
    }});
  }
  renderBoard(); 
  requestAnimationFrame(pkLoop);
}

// 房主的物理引擎
function updatePK(dt) {
  let hpChanged = false;
  for (let i = state.zombies.length - 1; i >= 0; i--) {
    let z = state.zombies[i];
    let col = Math.floor(z.x);
    let plant = state.plants.find(p => p.row === z.row && p.col === col);
    
    if (plant) {
      z.attackTimer = (z.attackTimer || 0) - dt;
      if (z.attackTimer <= 0) {
        z.attackTimer = 1.0; plant.hp -= 1;
        if (plant.hp <= 0) state.plants = state.plants.filter(p => p.id !== plant.id);
      }
    } else {
      z.x -= z.speed * dt;
      if (z.x <= 0.2) {
        state.pkHp -= 10; hpChanged = true;
        state.zombies = state.zombies.filter(zz => zz.id !== z.id);
        if (state.pkHp <= 0) {
          state.channel.send({ type: 'broadcast', event: 'gameover', payload: { win: 'zombie' } });
          state.isPlaying = false; alert('僵尸胜利！'); location.reload(); return;
        }
      }
    }
  }
  if (hpChanged) updatePKUI(); 
  
  state.plants.forEach(p => {
    p.cd -= dt;
    if (p.cd <= 0) {
      if (['peashooter', 'cornpult', 'snowpea', 'repeater', 'cannon', 'custom_plant'].includes(p.type)) {
        let targets = state.zombies.filter(z => z.row === p.row && z.x > p.col);
        if (targets.length > 0) {
          targets.sort((a,b) => a.x - b.x); let target = targets[0];
          state.bullets.push({ id: Date.now() + Math.random(), row: p.row, x: p.col + 0.5, dmg: PLANT_TYPES[p.type].dmg, freeze: PLANT_TYPES[p.type].freeze || false, emoji: p.type === 'cornpult' ? '🌽' : (p.type === 'snowpea' ? '❄️' : '🟢') });
          p.cd = PLANT_TYPES[p.type].cooldown;
        }
      }
    }
  });
  
  for (let i = state.bullets.length - 1; i >= 0; i--) {
    let b = state.bullets[i]; b.x += 10 * dt; let hit = false;
    for (let z of state.zombies) {
      if (z.row === b.row && b.x >= z.x && b.x <= z.x + 0.8) {
        z.hp -= b.dmg; if (b.freeze) z.slowTimer = 2.0; hit = true;
        if (z.hp <= 0) state.zombies = state.zombies.filter(zz => zz.id !== z.id);
        break;
      }
    }
    if (hit || b.x > 9.5) state.bullets.splice(i, 1);
  }
}

// 双方独立答题按钮
let pkQPool = [];
function openPKQuiz() {
  if (!state.isPlaying) return showToast('游戏未开始');
  const allQs = [...QUESTIONS_L1, ...QUESTIONS_L2];
  if (pkQPool.length === 0) pkQPool = allQs.map((_, i) => i).sort(() => Math.random() - 0.5);
  currentQ = allQs[pkQPool.pop()];
  selectedOpts.clear(); isAnswering = false; quizStartTime = Date.now(); quizModifyCount = 0;
  
  document.getElementById('quizQuestion').textContent = currentQ.q;
  const img = document.getElementById('quizImage');
  if (currentQ.image) { img.style.display = 'block'; img.src = currentQ.image + '.png'; img.onerror = function() { this.src = currentQ.image + '.jpg'; }; } 
  else { img.style.display = 'none'; }
  
  const box = document.getElementById('quizOptions'); box.innerHTML = '';
  currentQ.options.forEach((opt, i) => {
    const btn = document.createElement('button'); btn.className = 'option'; btn.textContent = String.fromCharCode(65 + i) + '. ' + opt;
    btn.onclick = () => onOptClick(i, btn); box.appendChild(btn);
  });
  document.getElementById('quizSubmit').style.display = currentQ.multi ? 'block' : 'none'; document.getElementById('quizSubmit').disabled = true;
  document.getElementById('quizModal').classList.add('active');
}

// 答对发牌
window.pkAnswerHandler = function(isCorrect) {
  if (isCorrect) {
    if (state.side === 'plant') {
      const plants = ['peashooter', 'cornpult', 'snowpea', 'repeater', 'wallnut', 'cannon'];
      const randType = plants[Math.floor(Math.random() * plants.length)];
      state.cards.push({ id: Date.now(), type: randType }); renderCards();
      showToast(`答对啦！获得植物：${PLANT_TYPES[randType].name}！`);
    } else {
      const zombies = ['normal', 'cone', 'bucket', 'football', 'girl'];
      const randType = zombies[Math.floor(Math.random() * zombies.length)];
      state.cards.push({ id: Date.now(), type: 'zombie_' + randType }); renderCards();
      showToast(`答对啦！获得僵尸：${ZOMBIE_TYPES[randType].name}！`);
    }
  } else {
    showToast('答错了！再试一次吧。');
  }
};

// 放置逻辑
window.pkPlaceHandler = function(type, row, col, cardIdx) {
  if (state.side === 'plant' && type.includes('zombie')) return showToast('你是植物方，不能放僵尸！');
  if (state.side === 'zombie' && !type.includes('zombie')) return showToast('你是僵尸方，不能放植物！');
  
  // 统一生成唯一 ID（利用时间戳+随机数）
  const uniqueId = Date.now() + Math.random();

  if (state.mode === 'pk_host') { 
    applyPKPlace(type, row, col, uniqueId); 
  } else {
    // 客机本地先放，立刻渲染防闪烁
    applyPKPlace(type, row, col, uniqueId);
    // 把相同的 uniqueId 广播给房主
    state.channel.send({ type: 'broadcast', event: 'guest_place', payload: { type, row, col, id: uniqueId } });
  }
  state.cards.splice(cardIdx, 1); state.selectedCardId = null; renderCards();
};

// 应用放置
function applyPKPlace(type, row, col, customId = null) {
  if (type.includes('zombie')) {
    if (state.pkZombieCount >= 30) return showToast('僵尸放置次数已满！');
    const zType = type.replace('zombie_', '');
    const zData = ZOMBIE_TYPES[zType];
    if (!zData) return showToast('找不到该僵尸类型');

    state.zombies.push({ 
      id: customId || (Date.now()+Math.random()), 
      row, x: 8.5, 
      hp: zData.hp, maxHp: zData.hp, 
      speed: zData.speed, emoji: zData.emoji, img: zData.img, 
      attackTimer: 0 
    });
    state.pkZombieCount++;
  } else {
    if (state.plants.find(p => p.row === row && p.col === col)) return;
    const pData = PLANT_TYPES[type];
    if (!pData) return showToast('找不到该植物类型');
    
    state.plants.push({ id: customId || (Date.now()+Math.random()), type, row, col, hp: pData.hp, maxHp: pData.hp, cd: 0, plantTime: Date.now() });
  }
  updatePKUI();
  renderBoard();
}
