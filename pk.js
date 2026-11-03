function showPKMenu() { document.getElementById('levelSelectScreen').style.display = 'none'; document.getElementById('pkMenuScreen').style.display = 'flex'; }

function createRoom() {
  const roomId = Math.floor(1000 + Math.random() * 9000).toString();
  state.roomId = roomId; state.mode = 'pk_host'; state.side = 'plant';
  
  document.getElementById('pkMenuScreen').style.display = 'none'; document.getElementById('gameScreen').classList.add('active');
  document.getElementById('singleTopBar').style.display = 'none'; document.getElementById('pkTopBar').style.display = 'flex'; document.getElementById('sideBar').style.display = 'none';
  document.getElementById('pkPlayer1Info').innerHTML = `${state.name} (植物)<br><span style="font-size:20px;">房号: ${roomId}</span>`;
  document.getElementById('pkPlayer2Info').innerHTML = `等待加入...`;
  
  // 初始化频道
  state.channel = dbClient.channel('room_' + roomId);
  
  state.channel.on('broadcast', { event: 'join' }, payload => {
    document.getElementById('pkPlayer2Info').innerHTML = `${payload.payload.name} (僵尸)`;
    showToast(`${payload.payload.name} 已加入！`);
  });
  
  // 接收到客机放置僵尸的广播
  state.channel.on('broadcast', { event: 'guest_place' }, payload => {
    applyPKPlace(payload.payload.type, payload.payload.row, payload.payload.col);
  });

  // 接收到客机扣血/胜利的广播 (可选)
  state.channel.on('broadcast', { event: 'gameover' }, payload => {
    if (payload.payload.win === 'zombie') {
      state.isPlaying = false;
      alert('僵尸胜利！植物被吃掉了脑子。');
      location.reload();
    }
  });
  
  state.channel.subscribe(); 
  renderCards(); 
  startMusic();
  
  // 房主直接开启游戏和物理循环
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
  document.getElementById('pkPlayer1Info').innerHTML = `房主 (植物)`;
  document.getElementById('pkPlayer2Info').innerHTML = `${state.name} (僵尸)`;
  
  state.channel = dbClient.channel('room_' + roomId);
  
  // 接收房主同步的物理画面
  state.channel.on('broadcast', { event: 'sync' }, payload => {
    const s = payload.payload; 
    state.plants = s.plants; state.zombies = s.zombies; state.bullets = s.bullets;
    state.pkHp = s.hp; state.pkZombieCount = s.zombieCount;
    document.getElementById('pkPlayer1Info').innerHTML = `房主 (植物)<br>HP: ${state.pkHp}`;
    document.getElementById('pkPlayer2Info').innerHTML = `${state.name} (僵尸)<br>剩余僵尸: ${30 - state.pkZombieCount}`;
    renderBoard();
  });
  
  // 接收房主广播的游戏结束
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
  
  // 客机加入后直接开启游戏，随时可答题放僵尸
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
  if (pkSyncTimer > 0.1) {
    pkSyncTimer = 0;
    state.channel.send({ type: 'broadcast', event: 'sync', payload: {
      plants: state.plants, zombies: state.zombies, bullets: state.bullets, hp: state.pkHp, zombieCount: state.pkZombieCount
    }});
  }
  renderBoard(); 
  requestAnimationFrame(pkLoop);
}

// 房主的物理引擎（计算植物攻击、僵尸移动和啃咬）
function updatePK(dt) {
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
        state.pkHp -= 10; state.zombies = state.zombies.filter(zz => zz.id !== z.id);
        if (state.pkHp <= 0) {
          state.channel.send({ type: 'broadcast', event: 'gameover', payload: { win: 'zombie' } });
          state.isPlaying = false; alert('僵尸胜利！'); location.reload(); return;
        }
      }
    }
  }
  
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

// 双方独立的答题按钮逻辑
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

// 答对后独立发牌，不干扰对方
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

// 放置逻辑：房主放植物，客机放僵尸
window.pkPlaceHandler = function(type, row, col, cardIdx) {
  if (state.side === 'plant' && type.includes('zombie')) return showToast('你是植物方，不能放僵尸！');
  if (state.side === 'zombie' && !type.includes('zombie')) return showToast('你是僵尸方，不能放植物！');
  
  if (state.mode === 'pk_host') { 
    // 房主放植物
    applyPKPlace(type, row, col); 
  } else {
    // 客机放僵尸：先在本地渲染，然后告诉房主
    applyPKPlace(type, row, col);
    state.channel.send({ type: 'broadcast', event: 'guest_place', payload: { type, row, col } });
  }
  state.cards.splice(cardIdx, 1); state.selectedCardId = null; renderCards();
};

function applyPKPlace(type, row, col) {
  if (type.includes('zombie')) {
    if (state.pkZombieCount >= 30) return showToast('僵尸放置次数已满！');
    const zType = type.replace('zombie_', '');
    state.zombies.push({ id: Date.now()+Math.random(), row, x: 8.5, hp: ZOMBIE_TYPES[zType].hp, maxHp: ZOMBIE_TYPES[zType].hp, speed: ZOMBIE_TYPES[zType].speed, emoji: ZOMBIE_TYPES[zType].emoji, attackTimer: 0 });
    state.pkZombieCount++;
  } else {
    if (state.plants.find(p => p.row === row && p.col === col)) return;
    state.plants.push({ id: Date.now()+Math.random(), type, row, col, hp: PLANT_TYPES[type].hp, maxHp: PLANT_TYPES[type].hp, cd: 0, plantTime: Date.now() });
  }
  renderBoard();
}
