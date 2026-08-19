/* ============================================================
 *  bots.js — 机器人角色模型 + A* 寻路 + 战术 AI
 * ============================================================ */
'use strict';

/* ---------------------------------------------------------------
 *  NAV：基于地图栅格的 A* 寻路
 * --------------------------------------------------------------- */
var NAV = (function () {
  var N = MAP.N;
  var size = N * N;
  var g = new Float32Array(size);
  var f = new Float32Array(size);
  var from = new Int32Array(size);
  var stamp = new Int32Array(size);
  var closed = new Int32Array(size);
  var mark = 0;
  var heap = new Int32Array(size), heapN = 0;

  function hpush(c) {
    var i = heapN++;
    heap[i] = c;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (f[heap[p]] <= f[heap[i]]) break;
      var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
    }
  }
  function hpop() {
    var top = heap[0];
    heapN--;
    if (heapN > 0) {
      heap[0] = heap[heapN];
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, m = i;
        if (l < heapN && f[heap[l]] < f[heap[m]]) m = l;
        if (r < heapN && f[heap[r]] < f[heap[m]]) m = r;
        if (m === i) break;
        var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
      }
    }
    return top;
  }

  function openCell(i, j) { return MAP.isNav(i, j); }

  /* ---- 每帧寻路预算 ----
   * A* 在 84×84 栅格上单次最多 9000 次扩展，5v5 时十个 bot 同一帧重算会明显掉帧。
   * game.js 每帧调用 beginFrame() 重置额度，bot 调 take() 申请一次计算机会。 */
  var BUDGET = 2, budgetLeft = BUDGET;
  function beginFrame() { budgetLeft = BUDGET; }
  function take() { if (budgetLeft <= 0) return false; budgetLeft--; return true; }


  function nearestCell(x, z) {
    var i = MAP.cx(x), j = MAP.cz(z);
    if (openCell(i, j)) return [i, j];
    for (var r = 1; r <= 10; r++) {
      for (var dj = -r; dj <= r; dj++) for (var di = -r; di <= r; di++) {
        if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
        if (openCell(i + di, j + dj)) return [i + di, j + dj];
      }
    }
    return null;
  }

  /* 两点之间栅格直线是否通畅（用于路径平滑） */
  function clearLine(x0, z0, x1, z1) {
    var dx = x1 - x0, dz = z1 - z0;
    var d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1) return true;
    var stepN = Math.ceil(d / 24);
    for (var s = 1; s < stepN; s++) {
      var t = s / stepN;
      var px = x0 + dx * t, pz = z0 + dz * t;
      // 检查角色半宽范围内的四个角
      if (!MAP.isNav(MAP.cx(px - 14), MAP.cz(pz - 14))) return false;
      if (!MAP.isNav(MAP.cx(px + 14), MAP.cz(pz - 14))) return false;
      if (!MAP.isNav(MAP.cx(px - 14), MAP.cz(pz + 14))) return false;
      if (!MAP.isNav(MAP.cx(px + 14), MAP.cz(pz + 14))) return false;
    }
    return true;
  }

  var DIRS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
              [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];

  function findPath(sx, sz, tx, tz) {
    var s = nearestCell(sx, sz), t = nearestCell(tx, tz);
    if (!s || !t) return null;
    var si = s[0], sj = s[1], ti = t[0], tj = t[1];
    var start = MAP.idx(si, sj), goal = MAP.idx(ti, tj);
    if (start === goal) return [[tx, tz]];

    mark++;
    heapN = 0;
    g[start] = 0;
    f[start] = 0;
    from[start] = -1;
    stamp[start] = mark;
    hpush(start);
    var iter = 0, found = false;

    while (heapN > 0 && iter++ < 9000) {
      var cur = hpop();
      if (closed[cur] === mark) continue;
      closed[cur] = mark;
      if (cur === goal) { found = true; break; }
      var ci = cur % N, cj = (cur - ci) / N;
      for (var d = 0; d < 8; d++) {
        var ni = ci + DIRS[d][0], nj = cj + DIRS[d][1];
        if (!openCell(ni, nj)) continue;
        if (DIRS[d][2] > 1.1) { // 对角需要两侧都通
          if (!openCell(ci + DIRS[d][0], cj) || !openCell(ci, cj + DIRS[d][1])) continue;
        }
        var nk = MAP.idx(ni, nj);
        if (closed[nk] === mark) continue;
        var ng = g[cur] + DIRS[d][2];
        if (stamp[nk] === mark && ng >= g[nk]) continue;
        stamp[nk] = mark;
        g[nk] = ng;
        from[nk] = cur;
        var hx = ti - ni, hz = tj - nj;
        f[nk] = ng + Math.sqrt(hx * hx + hz * hz) * 1.02;
        hpush(nk);
      }
    }
    if (!found) return null;

    // 回溯
    var cells = [];
    var c = goal;
    while (c !== -1 && cells.length < 4000) { cells.push(c); c = from[c]; }
    cells.reverse();

    var pts = [];
    for (var i = 0; i < cells.length; i++) {
      var ii = cells[i] % N, jj = (cells[i] - ii) / N;
      pts.push([MAP.wx(ii), MAP.wz(jj)]);
    }
    pts[pts.length - 1] = [tx, tz];

    // 平滑：跳过能直线到达的中间点
    var out = [];
    var idx = 0;
    out.push([sx, sz]);
    while (idx < pts.length - 1) {
      var best = idx + 1;
      for (var k = pts.length - 1; k > idx; k--) {
        if (clearLine(pts[idx][0], pts[idx][1], pts[k][0], pts[k][1])) { best = k; break; }
      }
      out.push(pts[best]);
      idx = best;
    }
    out.shift();
    return out.length ? out : [[tx, tz]];
  }

  return { findPath: findPath, clearLine: clearLine, nearestCell: nearestCell,
           take: take, beginFrame: beginFrame, BUDGET: BUDGET };
})();


/* ---------------------------------------------------------------
 *  CHAR：角色模型（方块小人，CS1.6 味）
 * --------------------------------------------------------------- */
var CHAR = (function () {
  var cache = {};
  function mat(c) {
    if (!cache[c]) cache[c] = new THREE.MeshLambertMaterial({ color: c });
    return cache[c];
  }
  function box(w, h, d, color, x, y, z) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color));
    m.position.set(x, y, z);
    return m;
  }

  var SKIN = { T: 0xb9905f, CT: 0xc79a6a };
  var COL = {
    T: { shirt: 0xa5854c, pants: 0x6a5533, gear: 0x6f5c38, head: 0x4a3f2e },
    CT: { shirt: 0x4a6580, pants: 0x2b3644, gear: 0x35455a, head: 0x5b6b78 }
  };

  function make(team) {
    var c = COL[team], skin = SKIN[team];
    var g = new THREE.Group();

    // 腿
    var legL = new THREE.Group(), legR = new THREE.Group();
    legL.add(box(11, 32, 13, c.pants, 0, -16, 0));
    legR.add(box(11, 32, 13, c.pants, 0, -16, 0));
    legL.position.set(-6.5, 34, 0);
    legR.position.set(6.5, 34, 0);
    g.add(legL); g.add(legR);
    g.add(box(12, 8, 15, 0x22201c, -6.5, 3, -1.5));   // 鞋
    g.add(box(12, 8, 15, 0x22201c, 6.5, 3, -1.5));

    // 躯干
    g.add(box(26, 10, 15, c.pants, 0, 37, 0));
    g.add(box(27, 22, 16, c.shirt, 0, 51, 0));
    g.add(box(28, 15, 17, c.gear, 0, 49, 0));         // 防弹衣 / 战术背心
    if (team === 'T') g.add(box(20, 6, 13, 0x6d5a35, 0, 41, 0)); // 腰带

    // 头
    var head = new THREE.Group();
    head.add(box(15, 15, 15, skin, 0, 7.5, 0));
    if (team === 'CT') {
      head.add(box(17, 6, 17, c.head, 0, 16, 0));      // 头盔
      head.add(box(16, 4, 4, 0x1a1c20, 0, 12, -7));    // 护目镜
    } else {
      head.add(box(16, 8, 16, c.head, 0, 15, 0));      // 头巾
      head.add(box(15, 5, 3, 0x2c261d, 0, 6, -7.6));   // 面罩
    }
    head.position.set(0, 60, 0);
    g.add(head);

    /* ---- 手臂 + 枪：整体挂在 arms 组上 ----
     * 模型正面是 -Z（与实体 forward = (-sin yaw, -cos yaw) 一致）。
     * 这里不再用「让长条手臂绕肩膀转一个角度」的写法（那种写法枪和手是两个
     * 互不相干的物体，手根本没握在枪上，一旦角度不对手臂就跑到身后去），
     * 改成直接把上臂 / 小臂 / 手按前伸姿势摆好，枪固定在双手之间，
     * 整组再跟着 pitch 抬降，怎么瞄手都在枪上。 */
    var arms = new THREE.Group();
    arms.position.set(0, 54, 0);

    // 枪（右手握把、左手护木）
    var gun = new THREE.Group();
    gun.add(box(4.5, 6.0, 24, 0x24242a, 0, 0, -15));    // 机匣  z: -27..-3
    gun.add(box(3.0, 3.0, 12, 0x3a3a42, 0, 1.2, -32));  // 枪管  z: -38..-26
    gun.add(box(4.0, 9.0, 5, 0x2e2618, 0, -6.5, -12));  // 弹匣
    gun.add(box(4.0, 5.0, 9, 0x2e2618, 0, 0.5, 1));     // 枪托（贴着胸口）
    gun.position.set(1.5, -7, 0);
    arms.add(gun);

    // 右臂：肩 → 小臂 → 手（在握把上）
    arms.add(box(7.5, 7.5, 7.5, c.shirt, 10.5, -1, -1));
    arms.add(box(6.5, 6.5, 14, c.shirt, 7.0, -5, -8));
    arms.add(box(6.0, 5.5, 6.0, skin, 4.5, -7, -14));
    // 左臂：肩 → 前伸小臂 → 手（在护木上）
    arms.add(box(7.5, 7.5, 7.5, c.shirt, -10.5, -1, -1));
    arms.add(box(6.5, 6.5, 20, c.shirt, -5.5, -6, -13));
    arms.add(box(6.0, 5.5, 6.0, skin, -1.5, -7.5, -24));

    g.add(arms);

    // 脚下阴影
    var shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(44, 44),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 1.5;
    g.add(shadow);

    // 让尸体绕自身竖轴先转 yaw、再向前倒（Euler 顺序 YXZ）
    g.rotation.order = 'YXZ';

    return { group: g, legL: legL, legR: legR, arms: arms, gun: gun, head: head, shadow: shadow, phase: 0 };
  }

  function animate(m, e, dt) {
    var sp = Math.sqrt(e.vx * e.vx + e.vz * e.vz);
    if (e.dead) {
      // 倒地：保留朝向，绕自身横轴前扑
      e.deadTilt = Math.min(1, (e.deadTilt || 0) + dt * 4.5);
      m.group.rotation.set(-Math.PI / 2 * e.deadTilt * 0.98, e.yaw, 0);
      m.group.position.set(e.x, e.y + 10 * e.deadTilt, e.z);
      m.arms.rotation.x = 0;
      m.shadow.visible = false;
      return;
    }
    m.phase += sp * dt * 0.028;
    var swing = sp > 12 ? Math.sin(m.phase) * Math.min(0.62, sp / 300) : 0;
    m.legL.rotation.x = swing;
    m.legR.rotation.x = -swing;
    // 手臂随瞄准俯仰抬降（+pitch = 抬头，模型正面是 -Z，绕 +X 转正角刚好朝上）
    m.arms.rotation.x = e.pitch;
    m.arms.rotation.z = swing * 0.06;
    m.head.rotation.x = e.pitch * 0.65;

    var sy = e.crouch ? 0.66 : 1;
    m.group.scale.y = sy;
    m.group.position.set(e.x, e.y, e.z);
    m.group.rotation.set(0, e.yaw, 0);
    m.shadow.visible = true;
    m.shadow.position.y = 1.5 / sy;
  }

  return { make: make, animate: animate };
})();


/* ---------------------------------------------------------------
 *  BOT：实体 + AI
 * --------------------------------------------------------------- */
var BOT_NAMES = ['Ada', 'Bill', 'Cliffe', 'Dave', 'Eddie', 'Fred', 'Gunner', 'Hank',
  'Ivan', 'Joe', 'Kyle', 'Larry', 'Moe', 'Nick', 'Opie', 'Pete', 'Quade', 'Rip',
  'Steve', 'Tom', 'Ulrik', 'Vinny', 'Wade', 'Xander', 'Yuri', 'Zach'];

var SKILLS = {
  easy:   { react: 0.62, aimErr: 0.055, turn: 4.5,  spray: 0.75, hear: 900,  fov: 100, aggr: 0.5,  hp: 100, crouch: 0.1, name: '简单' },
  normal: { react: 0.38, aimErr: 0.030, turn: 7.5,  spray: 0.52, hear: 1400, fov: 110, aggr: 0.7,  hp: 100, crouch: 0.25, name: '普通' },
  hard:   { react: 0.24, aimErr: 0.017, turn: 11.0, spray: 0.36, hear: 1900, fov: 120, aggr: 0.85, hp: 100, crouch: 0.4, name: '困难' },
  expert: { react: 0.15, aimErr: 0.009, turn: 15.0, spray: 0.24, hear: 2500, fov: 130, aggr: 1.0,  hp: 100, crouch: 0.5, name: '专家' }
};

function Bot(team, name, skillKey, scene) {
  this.isBot = true;
  this.team = team;
  this.name = name;
  this.skillKey = skillKey;
  this.skill = SKILLS[skillKey];
  this.x = 0; this.y = 0; this.z = 0;
  this.vx = 0; this.vy = 0; this.vz = 0;
  this.yaw = 0; this.pitch = 0;
  this.health = 100; this.armor = 0; this.helmet = false; this.defuser = false;
  this.money = 800; this.nades = {}; this.blindT = 0;
  this.spreadPen = 0; this.shotsInBurst = 0;
  this.dead = true;
  this.crouch = false;
  this.onGround = true;
  this.kills = 0; this.deaths = 0;
  this.weapons = [];
  this.wi = 0;
  this.ammo = {};
  this.reserve = {};
  this.nextFire = 0;
  this.reloadEnd = 0;
  this.burst = 0;
  this.burstPause = 0;
  this.state = 'move';
  this.path = null;
  this.pathIdx = 0;
  this.pathTime = 0;
  this.goal = null;
  this.goalKind = 'push';
  this.target = null;
  this.spotT = 0;          // 看到目标的累计时间（反应时间）
  this.lostT = 0;
  this.lastPos = { x: 0, z: 0 };
  this.stuckT = 0;
  this.strafe = 0;
  this.strafeT = 0;
  this.plantT = 0;
  this.defuseT = 0;
  this.investigate = null;
  this.model = CHAR.make(team);
  this.model.group.visible = false;
  scene.add(this.model.group);
  this.spawnGuard = 0;
}

Bot.prototype.eyeY = function () { return this.y + (this.crouch ? 30 : 58); };

Bot.prototype.weapon = function () { return WEAPONS.defs[this.weapons[this.wi]]; };

Bot.prototype.giveLoadout = function (list) {
  this.weapons = list.slice();
  this.ammo = {}; this.reserve = {};
  for (var i = 0; i < list.length; i++) {
    var d = WEAPONS.defs[list[i]];
    this.ammo[list[i]] = d.mag;
    this.reserve[list[i]] = d.reserve;
  }
  this.wi = 0;
};

Bot.prototype.spawn = function (x, z, loadout, y, keepKit) {
  this.x = x; this.y = y || 0; this.z = z;
  this.vx = this.vy = this.vz = 0;
  this.health = this.skill.hp;
  if (!keepKit) { this.armor = 0; this.helmet = false; this.defuser = false; this.nades = {}; }
  this.dead = false;
  this.blindT = 0;
  this.crouch = false;
  this.deadTilt = 0;
  this.state = 'move';
  this.target = null;
  this.path = null; this.goal = null;
  this.investigate = null;
  this.plantT = 0; this.defuseT = 0;
  this.spotT = 0;
  this.reloadEnd = 0;
  this.shotsInBurst = 0; this.spreadPen = 0;
  this.giveLoadout(loadout);
  this.model.group.visible = true;
  this.model.group.rotation.set(0, 0, 0);
  this.model.group.scale.set(1, 1, 1);
  // 面朝地图中心
  this.yaw = Math.atan2(-(0 - x), -(0 - z));
  this.pitch = 0;
  this.spawnGuard = 0.4;
};

Bot.prototype.die = function () {
  this.dead = true;
  this.deaths++;
  this.vx = this.vz = 0;
  this.target = null;
};

/* ---------- 感知 ---------- */
Bot.prototype.canSee = function (e) {
  if (!e || e.dead) return false;
  if (this.blindT > 0) return false;                 // 被闪光弹闪到时看不见
  var dx = e.x - this.x, dz = e.z - this.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  if (dist > 4200) return false;
  var fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
  var dot = (dx * fwdX + dz * fwdZ) / (dist || 1);
  var half = Math.cos(this.skill.fov * Math.PI / 360);
  if (dot < half) return false;
  var ey = this.eyeY();
  var ty = e.y + (e.crouch ? 26 : 52);
  // 烟雾挡视线（和玩家一样看不穿）
  if (NADE.blocked(this.x, ey, this.z, e.x, ty, e.z)) return false;
  if (!MAP.losBlocked(this.x, ey, this.z, e.x, ty, e.z)) return true;
  if (!MAP.losBlocked(this.x, ey, this.z, e.x, e.y + (e.crouch ? 34 : 66), e.z)) return true;
  return false;
};

Bot.prototype.pickTarget = function (enemies) {
  var best = null, bestScore = -1e9;
  for (var i = 0; i < enemies.length; i++) {
    var e = enemies[i];
    if (e.dead) continue;
    if (!this.canSee(e)) continue;
    var dx = e.x - this.x, dz = e.z - this.z;
    var d = Math.sqrt(dx * dx + dz * dz);
    var score = 3000 - d + (e === this.target ? 600 : 0) + (e.health < 40 ? 400 : 0);
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return best;
};

Bot.prototype.hearGunfire = function (x, z, dist) {
  if (dist > this.skill.hear) return;
  if (this.target) return;
  if (Math.random() > 0.7) return;
  this.investigate = [x + (Math.random() - 0.5) * 200, z + (Math.random() - 0.5) * 200];
  this.path = null;
  // 转向声源
  this.desiredYaw = Math.atan2(-(x - this.x), -(z - this.z));
};

/* ---------- 目标点决策 ---------- */
Bot.prototype.chooseGoal = function (G) {
  var site = G.targetSite;
  if (this.team === 'T') {
    if (G.bombPlanted) {
      var b = G.bombPos;
      var a = Math.random() * 6.283, r = 260 + Math.random() * 420;
      var p = MAP.nearestOpen(b[0] + Math.cos(a) * r, b[1] + Math.sin(a) * r);
      this.goal = p; this.goalKind = 'hold';
    } else if (G.carrier === this) {
      var s = site;
      var pp = MAP.nearestOpen(s.x + (Math.random() - 0.5) * 340, s.z + (Math.random() - 0.5) * 340);
      this.goal = pp; this.goalKind = 'plant';
    } else {
      var s2 = site;
      var q = MAP.nearestOpen(s2.x + (Math.random() - 0.5) * 700, s2.z + (Math.random() - 0.5) * 700);
      this.goal = q; this.goalKind = 'push';
    }
  } else {
    if (G.bombPlanted) {
      this.goal = MAP.nearestOpen(G.bombPos[0] + (Math.random() - 0.5) * 60, G.bombPos[1] + (Math.random() - 0.5) * 60);
      this.goalKind = 'defuse';
    } else {
      var ds = this.defendSite || MAP.SITES[0];
      var w = MAP.nearestOpen(ds.x + (Math.random() - 0.5) * 640, ds.z + (Math.random() - 0.5) * 640);
      this.goal = w; this.goalKind = 'defend';
    }
  }
  this.path = null;
};

/* ---------- 主更新 ---------- */
Bot.prototype.update = function (dt, G) {
  if (this.dead) { CHAR.animate(this.model, this, dt); return; }
  var t = G.time;
  if (this.spawnGuard > 0) this.spawnGuard -= dt;
  if (this.blindT > 0) this.blindT = Math.max(0, this.blindT - dt);
  // 散布惩罚回落（和玩家同一套模型：开火后 0.18 秒内不回落，否则连发惩罚会被抵消）
  var wNow = this.weapon();
  if (this.spreadPen > 0 && (t - (this.lastShotT || -9)) > 0.18) {
    this.spreadPen = Math.max(0, this.spreadPen - wNow.spreadMax * wNow.recover * 2.2 * dt);
    if (this.spreadPen === 0) this.shotsInBurst = 0;
  }

  var enemies = this.team === 'T' ? G.ctList : G.tList;

  /* --- 感知 --- */
  var seen = this.pickTarget(enemies);
  if (seen) {
    if (this.target !== seen) { this.target = seen; this.spotT = 0; }
    this.spotT += dt;
    this.lostT = 0;
    this.state = 'combat';
    this.investigate = null;
  } else {
    if (this.target) {
      this.lostT += dt;
      if (this.lostT > 2.2) { this.target = null; this.state = 'move'; this.spotT = 0; }
    }
  }

  /* --- 目标点 --- */
  if (!this.goal || this.goalStale) { this.chooseGoal(G); this.goalStale = false; }
  // 局势变化（安放/拆除）时强制重选
  if ((this.goalKind === 'push' || this.goalKind === 'defend') && G.bombPlanted) this.chooseGoal(G);
  if (this.goalKind === 'plant' && G.bombPlanted) this.chooseGoal(G);
  if (this.goalKind === 'defuse' && !G.bombPlanted) this.chooseGoal(G);

  var wishX = 0, wishZ = 0, speedScale = 1;
  var aimX = null, aimY = null, aimZ = null;

  /* --- 战斗 --- */
  if (this.target && !this.target.dead) {
    var T = this.target;
    var dx = T.x - this.x, dz = T.z - this.z;
    var dist = Math.sqrt(dx * dx + dz * dz);
    aimX = T.x; aimZ = T.z;
    // 瞄准点：胸口，技能越高越偏头
    var headChance = this.skillKey === 'expert' ? 0.5 : this.skillKey === 'hard' ? 0.3 : 0.12;
    if (this.aimHead === undefined || Math.random() < 0.01) this.aimHead = Math.random() < headChance;
    aimY = T.y + (T.crouch ? (this.aimHead ? 32 : 24) : (this.aimHead ? 66 : 50));

    // 战斗中的走位
    this.strafeT -= dt;
    if (this.strafeT <= 0) {
      this.strafeT = 0.5 + Math.random() * 0.9;
      this.strafe = Math.random() < 0.5 ? -1 : (Math.random() < 0.5 ? 0 : 1);
    }
    var wantDist = this.weapon().kind === 'knife' ? 40 : 700;
    var rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    var fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);

    if (this.weapon().kind === 'knife') {
      wishX = fwdX; wishZ = fwdZ; speedScale = 1;
    } else if (this.health < 40 && Math.random() < 0.6) {
      wishX = -fwdX * 0.7 + rightX * this.strafe;
      wishZ = -fwdZ * 0.7 + rightZ * this.strafe;
      speedScale = 1;
    } else if (dist > 1500) {
      wishX = fwdX * 0.9; wishZ = fwdZ * 0.9;
      speedScale = 1;
    } else if (this.spotT > 0.35) {
      // 停下开火，偶尔小幅横向移动
      wishX = rightX * this.strafe * 0.55;
      wishZ = rightZ * this.strafe * 0.55;
      speedScale = 0.55;
    }
    // 远距离蹲下压枪
    this.crouch = (dist > 900 && Math.random() < this.skill.crouch * dt * 6) ? true
      : (this.crouch && dist > 700 && Math.random() > dt * 1.2);

    // 偶尔往敌人身上扔个高爆（有雷 + 中距离 + 已确认目标 + 冷却好了）
    this.nadeCd = Math.max(0, (this.nadeCd || 0) - dt);
    if (this.nades && this.nades.he > 0 && this.nadeCd <= 0 && this.spotT > 0.45 &&
      dist > 380 && dist < 1500 && Math.random() < dt * 0.55) {
      var arc = dirFromAngles(this.yaw, this.pitch + 0.20 + dist / 9000);
      G.throwNade(this, 'he', arc[0], arc[1], arc[2], 620 + dist * 0.12);
      this.nades.he--;
      this.nadeCd = 8;
    }
  } else if (this.investigate) {
    var ix = this.investigate[0], iz = this.investigate[1];
    var idx2 = ix - this.x, idz = iz - this.z;
    if (idx2 * idx2 + idz * idz < 150 * 150) this.investigate = null;
    else {
      var mv = this.follow(dt, ix, iz, G);
      wishX = mv[0]; wishZ = mv[1];
    }
    this.crouch = false;
  } else {
    /* --- 行进 / 目标行为 --- */
    var g2 = this.goal;
    var gx = g2[0], gz = g2[1];
    var ddx = gx - this.x, ddz = gz - this.z;
    var gd = Math.sqrt(ddx * ddx + ddz * ddz);
    this.crouch = false;

    if (gd < 70) {
      // 到达目标点
      if (this.goalKind === 'plant' && !G.bombPlanted && G.carrier === this) {
        var s3 = MAP.siteAt(this.x, this.z);
        if (s3) {
          this.plantT += dt;
          if (this.plantT > 3.0) G.plantBomb(this);
        } else { this.goalStale = true; }
      } else if (this.goalKind === 'defuse' && G.bombPlanted) {
        var bd = Math.sqrt(Math.pow(G.bombPos[0] - this.x, 2) + Math.pow(G.bombPos[1] - this.z, 2));
        if (bd < 75) {
          var needT = this.defuser ? 5.0 : 10.0;      // 拆弹器减半
          this.defuseT += dt;
          G.defuseProgress = Math.max(G.defuseProgress, this.defuseT / needT);
          if (this.defuseT > needT) G.defuseBomb(this);
          // 提示音同样按固定节拍，且只有离玩家不远时才播
          this.tickT = (this.tickT || 0) - dt;
          if (this.tickT <= 0) {
            this.tickT = 0.25;
            if (G.distToPlayer(this) < 1200) SFX.defuseTick(this.defuseT / needT);
          }
        } else this.goalStale = true;
      } else {
        // 站桩守点：左右扫视
        this.holdT = (this.holdT || 0) + dt;
        this.desiredYaw = (this.baseYaw === undefined ? (this.baseYaw = this.yaw) : this.baseYaw)
          + Math.sin(t * 0.7 + this.name.length) * 0.9;
        if (this.holdT > 5 + Math.random() * 6) { this.holdT = 0; this.goalStale = true; }
      }
    } else {
      this.plantT = 0; this.defuseT = 0;
      var mv2 = this.follow(dt, gx, gz, G);
      wishX = mv2[0]; wishZ = mv2[1];
    }
  }

  /* --- 转向 --- */
  var wantYaw, wantPitch = 0;
  if (aimX !== null) {
    wantYaw = Math.atan2(-(aimX - this.x), -(aimZ - this.z));
    var hd = Math.sqrt(Math.pow(aimX - this.x, 2) + Math.pow(aimZ - this.z, 2));
    wantPitch = Math.atan2(aimY - this.eyeY(), hd);
  } else if (this.desiredYaw !== undefined && wishX === 0 && wishZ === 0) {
    wantYaw = this.desiredYaw;
  } else if (wishX !== 0 || wishZ !== 0) {
    wantYaw = Math.atan2(-wishX, -wishZ);
  } else wantYaw = this.yaw;

  var turn = this.skill.turn * (this.target ? 1.0 : 0.55);
  this.yaw = approachAngle(this.yaw, wantYaw, turn * dt);
  this.pitch += (wantPitch - this.pitch) * Math.min(1, turn * dt * 0.8);

  /* --- 开火 --- */
  this.updateShooting(dt, G);

  /* --- 移动 --- */
  if (this.crouch && !PHYS.canStand(this)) { /* 保持下蹲 */ }
  PHYS.move(this, dt, wishX, wishZ, speedScale);

  // 卡住检测
  var moved = Math.abs(this.x - this.lastPos.x) + Math.abs(this.z - this.lastPos.z);
  if ((wishX !== 0 || wishZ !== 0) && moved < 6 * dt * 60 * 0.1) {
    this.stuckT += dt;
    if (this.stuckT > 0.6) {
      this.stuckT = 0;
      this.path = null;
      if (Math.random() < 0.4) PHYS.jump(this);
      else this.goalStale = true;
    }
  } else this.stuckT = 0;
  this.lastPos.x = this.x; this.lastPos.z = this.z;

  // 脚步声
  var sp = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  this.stepAcc = (this.stepAcc || 0) + sp * dt;
  if (this.stepAcc > 100 && this.onGround) {
    this.stepAcc = 0;
    var pd = G.distToPlayer(this);
    if (pd < 1400) SFX.footstep(pd, sp > 180);
  }

  CHAR.animate(this.model, this, dt);
};

/* 沿路径前进，返回期望移动方向 */
Bot.prototype.follow = function (dt, gx, gz, G) {
  this.pathTime -= dt;
  if (!this.path || this.pathTime <= 0) {
    // A* 限流：每帧最多算 NAV.BUDGET 条路径，5v5 时避免所有 bot 同帧重算造成掉帧
    if (!NAV.take()) {
      this.pathTime = 0.05 + Math.random() * 0.1;
      if (!this.path) return [0, 0];
    } else {
      this.path = NAV.findPath(this.x, this.z, gx, gz);
      this.pathIdx = 0;
      this.pathTime = 0.9 + Math.random() * 0.6;
      if (!this.path) { this.goalStale = true; return [0, 0]; }
    }
  }
  if (this.pathIdx >= this.path.length) {
    var dxx = gx - this.x, dzz = gz - this.z;
    var dl = Math.sqrt(dxx * dxx + dzz * dzz) || 1;
    return [dxx / dl, dzz / dl];
  }
  var wp = this.path[this.pathIdx];
  var dx = wp[0] - this.x, dz = wp[1] - this.z;
  var d = Math.sqrt(dx * dx + dz * dz);
  if (d < 46) {
    this.pathIdx++;
    if (this.pathIdx >= this.path.length) return [0, 0];
    wp = this.path[this.pathIdx];
    dx = wp[0] - this.x; dz = wp[1] - this.z;
    d = Math.sqrt(dx * dx + dz * dz) || 1;
  }
  return [dx / d, dz / d];
};

Bot.prototype.updateShooting = function (dt, G) {
  var w = this.weapon();
  var id = w.id;
  var t = G.time;

  // 换弹
  if (this.reloadEnd > 0) {
    if (t >= this.reloadEnd) {
      var need = w.mag - this.ammo[id];
      var take = Math.min(need, this.reserve[id]);
      this.ammo[id] += take; this.reserve[id] -= take;
      this.reloadEnd = 0;
    }
    return;
  }
  if (w.mag > 0 && this.ammo[id] <= 0) {
    if (this.reserve[id] > 0) {
      this.reloadEnd = t + w.reloadTime;
      var pd0 = G.distToPlayer(this);
      if (pd0 < 900) SFX.reload(1);
    } else if (this.weapons.length > 1) {
      this.wi = Math.min(this.weapons.length - 1, this.wi + 1);
    }
    return;
  }
  // 没有敌人时把主武器补满
  if (!this.target && w.mag > 0 && this.ammo[id] < w.mag * 0.4 && this.reserve[id] > 0) {
    this.reloadEnd = t + w.reloadTime;
    return;
  }
  // 切回主武器
  if (!this.target && this.wi !== 0 && this.ammo[this.weapons[0]] > 0) this.wi = 0;

  if (!this.target || this.target.dead) { this.burst = 0; return; }
  if (this.spotT < this.skill.react || this.spawnGuard > 0) return;
  if (this.blindT > 0.3) return;                 // 被闪到就别打了

  var T = this.target;
  var aimY = T.y + (T.crouch ? 26 : 50);
  var dx = T.x - this.x, dz = T.z - this.z;
  var dist = Math.sqrt(dx * dx + dz * dz);
  var ey = this.eyeY();

  // 准心是否已经对上
  var wantYaw = Math.atan2(-dx, -dz);
  var dyaw = Math.abs(angleDiff(this.yaw, wantYaw));
  if (dyaw > 0.09) return;
  if (MAP.losBlocked(this.x, ey, this.z, T.x, aimY, T.z)) return;
  if (NADE.blocked(this.x, ey, this.z, T.x, aimY, T.z)) return;

  if (w.kind === 'knife') {
    if (dist < 70 && t >= this.nextFire) {
      this.nextFire = t + 60 / w.rpm;
      G.meleeAttack(this, w);
    }
    return;
  }

  if (this.burstPause > 0) { this.burstPause -= dt; return; }
  if (t < this.nextFire) return;
  if (this.burst <= 0) {
    this.burst = w.auto ? (dist < 500 ? 5 + Math.random() * 6 : dist < 1200 ? 3 + Math.random() * 3 : 1 + Math.random() * 2) : 1;
  }

  this.nextFire = t + 60 / w.rpm;
  this.burst--;
  this.shotsInBurst++;
  this.lastShotT = t;
  if (this.burst <= 0) this.burstPause = 0.12 + Math.random() * (w.auto ? 0.35 : 0.55) * this.skill.spray;

  // 命中偏差：技能 + 距离 + 移动 + 连发累积散布（和玩家用同一套 perShot/spreadMax）
  var err = this.skill.aimErr;
  var sp = Math.sqrt(this.vx * this.vx + this.vz * this.vz);
  err *= 1 + sp / 260 * 1.6;
  err *= 1 + Math.max(0, (dist - 600)) / 2600;
  if (this.crouch) err *= 0.7;
  // 连发惩罚：越突越散，bot 也要吃这个亏（技能越高越会点射）
  this.spreadPen = Math.min(w.spreadMax,
    (this.spreadPen || 0) + w.perShot * (1 + (this.shotsInBurst - 1) * w.ramp));
  err += this.spreadPen * (0.55 + this.skill.spray * 0.9);

  var fwd = dirFromAngles(this.yaw, this.pitch);
  var ax = fwd[0] + (Math.random() - 0.5) * err * 2;
  var ay = fwd[1] + (Math.random() - 0.5) * err * 1.6;
  var az = fwd[2] + (Math.random() - 0.5) * err * 2;
  var l = Math.sqrt(ax * ax + ay * ay + az * az);
  this.ammo[id]--;
  G.fireBullet(this, this.x, ey, this.z, ax / l, ay / l, az / l, w);
};

/* ---------- 购买（和玩家共用一套经济数值） ----------
 * 由 game.js 在冻结阶段调用一次。优先级：主武器 → 护甲 → 拆弹器 → 手雷。 */
Bot.prototype.buyPhase = function (opts) {
  var money = this.money || 0;
  var mine = this.team;
  var wantRifle = mine === 'T' ? 'ak47' : 'm4a1';
  var cheapRifle = mine === 'T' ? 'galil' : 'famas';
  var has = {};
  for (var i = 0; i < this.weapons.length; i++) has[this.weapons[i]] = 1;
  var hasPrimary = false;
  for (i = 0; i < this.weapons.length; i++) {
    var d0 = WEAPONS.defs[this.weapons[i]];
    if (d0 && d0.slot === 'primary') hasPrimary = true;
  }

  function price(id) { return WEAPONS.defs[id].price; }
  var self = this;
  function buyGun(id) {
    if (money < price(id)) return false;
    money -= price(id);
    // 换掉原有主武器
    for (var k = self.weapons.length - 1; k >= 0; k--) {
      var dd = WEAPONS.defs[self.weapons[k]];
      if (dd && dd.slot === 'primary') self.weapons.splice(k, 1);
    }
    self.weapons.unshift(id);
    self.ammo[id] = WEAPONS.defs[id].mag;
    self.reserve[id] = WEAPONS.defs[id].reserve;
    self.wi = 0;
    hasPrimary = true;
    return true;
  }

  if (!hasPrimary) {
    // AWP 只有钱多且抽中时才买，避免满场狙
    if (money >= 5400 && Math.random() < 0.18) buyGun('awp');
    else if (money >= price(wantRifle) + 650) buyGun(wantRifle);
    else if (money >= price(cheapRifle) + 300) buyGun(cheapRifle);
    else if (money >= 1500 + 300 && Math.random() < 0.7) buyGun('mp5');
    else if (money >= 1700 && Math.random() < 0.3) buyGun('m3');
  }
  if (this.armor < 100 && money >= 1000 && Math.random() < 0.8) { this.armor = 100; this.helmet = true; money -= 1000; }
  else if (this.armor < 100 && money >= 650) { this.armor = 100; money -= 650; }
  if (mine === 'CT' && !this.defuser && money >= 200 && Math.random() < 0.65) { this.defuser = true; money -= 200; }
  // 手雷
  this.nades = this.nades || {};
  if (money >= 300 && !this.nades.he && Math.random() < 0.75) { this.nades.he = 1; money -= 300; }
  if (money >= 200 && !this.nades.flash && Math.random() < 0.35) { this.nades.flash = 1; money -= 200; }
  if (money >= 300 && !this.nades.smoke && Math.random() < 0.2) { this.nades.smoke = 1; money -= 300; }
  this.money = money;
};

/* ---------------- 小工具 ---------------- */
function angleDiff(a, b) {
  var d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
function approachAngle(cur, want, maxStep) {
  var d = angleDiff(cur, want);
  if (Math.abs(d) <= maxStep) return want;
  return cur + Math.sign(d) * maxStep;
}
function dirFromAngles(yaw, pitch) {
  var cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
