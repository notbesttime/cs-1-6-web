/* ============================================================
 *  nade.js — 投掷物（高爆 / 闪光 / 烟雾）
 *
 *  · 抛物线飞行 + 墙面反弹 + 引信定时
 *  · HE：范围伤害，按距离衰减并做视线检测（隔墙不吃伤害）
 *  · 闪光：按「与爆点的夹角 + 距离 + 视线」算致盲强度
 *  · 烟雾：生成持续约 14 秒的烟团，并真正阻断视线（bot 也看不穿）
 *
 *  game.js 通过 NADE.init(scene, tex, hooks) 注入依赖，
 *  hooks: { entities(), damage(e, attacker, dmg, w), blind(e, amount),
 *           playerRef(), eyeY(e) }
 * ============================================================ */
'use strict';

var NADE = (function () {

  var G = 800;                 // 与 phys.js 一致的重力
  var scene = null, tex = null, H = null;
  var live = [];               // 飞行中的手雷
  var smokes = [];             // 生效中的烟雾团
  var puffPool = [], PUFF_N = 90, puffI = 0;
  var meshPool = [], meshI = 0;

  function init(sc, textures, hooks) {
    scene = sc; tex = textures; H = hooks;
    for (var i = 0; i < 6; i++) {
      var m = WEAPONS.makeGrenadeMesh('he');
      m.visible = false;
      scene.add(m);
      meshPool.push(m);
    }
    for (i = 0; i < PUFF_N; i++) {
      var s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex.smoke, transparent: true, depthWrite: false, opacity: 0
      }));
      s.visible = false;
      scene.add(s);
      puffPool.push({ s: s, life: 0, max: 1, size: 100, vy: 0, base: 0 });
    }
  }

  /* ---------- 投掷 ---------- */
  function throwGrenade(owner, kind, dirX, dirY, dirZ, power) {
    var def = WEAPONS.defs[kind];
    if (!def) return null;
    var m = meshPool[meshI = (meshI + 1) % meshPool.length];
    var eye = H.eyeY(owner);
    var g = {
      kind: kind, def: def, owner: owner, team: owner.team,
      x: owner.x + dirX * 22, y: eye - 4 + dirY * 22, z: owner.z + dirZ * 22,
      vx: dirX * power + (owner.vx || 0) * 0.5,
      vy: dirY * power + 130,
      vz: dirZ * power + (owner.vz || 0) * 0.5,
      fuse: def.fuse, mesh: m, spin: Math.random() * 8
    };
    m.visible = true;
    m.position.set(g.x, g.y, g.z);
    live.push(g);
    SFX.grenadeThrow();
    return g;
  }

  /* ---------- 飞行 + 反弹 ---------- */
  function step(g, dt) {
    g.vy -= G * dt;
    var steps = 2;
    for (var s = 0; s < steps; s++) {
      var h = dt / steps;
      var dx = g.vx * h, dy = g.vy * h, dz = g.vz * h;
      var len = Math.hypot(dx, dy, dz);
      if (len > 0.001) {
        var hit = MAP.traceRay(g.x, g.y, g.z, dx / len, dy / len, dz / len, len + 4.5, {});
        if (hit) {
          // 贴着命中面停下并反射
          g.x = hit.x + hit.nx * 4.6;
          g.y = hit.y + hit.ny * 4.6;
          g.z = hit.z + hit.nz * 4.6;
          var vn = g.vx * hit.nx + g.vy * hit.ny + g.vz * hit.nz;
          g.vx -= 2 * vn * hit.nx; g.vy -= 2 * vn * hit.ny; g.vz -= 2 * vn * hit.nz;
          g.vx *= 0.45; g.vy *= 0.42; g.vz *= 0.45;
          var speed = Math.hypot(g.vx, g.vy, g.vz);
          if (speed > 40) SFX.grenadeBounce(H.distToPlayer(g.x, g.z));
          if (hit.ny > 0.7 && Math.abs(g.vy) < 55) { g.vy = 0; g.vx *= 0.7; g.vz *= 0.7; }
          continue;
        }
      }
      g.x += dx; g.y += dy; g.z += dz;
    }
    if (g.y < 3) { g.y = 3; g.vy = Math.abs(g.vy) * 0.35; g.vx *= 0.7; g.vz *= 0.7; }
    g.mesh.position.set(g.x, g.y, g.z);
    g.mesh.rotation.x += g.spin * dt;
    g.mesh.rotation.z += g.spin * 0.7 * dt;
  }

  /* ---------- 引爆 ---------- */
  function detonate(g, fx) {
    g.mesh.visible = false;
    if (g.kind === 'he') {
      SFX.explode();
      fx.explosion(g.x, g.y + 6, g.z);
      var list = H.entities();
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.dead) continue;
        // 队友不吃高爆伤害（这游戏子弹也打不到队友），但自己扔的会炸到自己
        if (e.team === g.team && e !== g.owner) continue;
        var ey = e.y + 34;
        var d = Math.hypot(e.x - g.x, ey - g.y, e.z - g.z);
        if (d > g.def.radius) continue;
        // 隔墙不吃伤害
        if (MAP.losBlocked(g.x, g.y, g.z, e.x, ey, e.z)) continue;
        var k = 1 - d / g.def.radius;
        H.damage(e, g.owner, g.def.dmg * k * k, false, g.def);
      }
      H.shake(g.x, g.z, 0.35, 18);
    } else if (g.kind === 'flash') {
      SFX.flashBang(H.distToPlayer(g.x, g.z) < 700);
      fx.flashPop(g.x, g.y + 10, g.z);
      var list2 = H.entities();
      for (var j = 0; j < list2.length; j++) {
        var t = list2[j];
        if (t.dead) continue;
        var ty = H.eyeY(t);
        var dist = Math.hypot(t.x - g.x, ty - g.y, t.z - g.z);
        if (dist > g.def.radius) continue;
        // 炸在脸上（220 单位内）时不看朝向也不看视线：
        // 这么近就算有个箱子角挡在中间、或者背对着，也会被闪到
        var closeUp = dist < 220;
        if (!closeUp && MAP.losBlocked(g.x, g.y, g.z, t.x, ty, t.z)) continue;
        // 正对着爆点最惨，背对基本没事
        var fwd = [-Math.sin(t.yaw) * Math.cos(t.pitch), Math.sin(t.pitch), -Math.cos(t.yaw) * Math.cos(t.pitch)];
        var to = [(g.x - t.x) / dist, (g.y - ty) / dist, (g.z - t.z) / dist];
        var dot = fwd[0] * to[0] + fwd[1] * to[1] + fwd[2] * to[2];
        if (!closeUp && dot < -0.1) continue;
        var near = 1 - Math.min(1, dist / 320);
        var factor = Math.max(Math.max(0, dot), near);
        var amount = factor * (1 - dist / g.def.radius);
        if (amount > 0.02) H.blind(t, 0.6 + amount * 3.4);
      }
    } else if (g.kind === 'smoke') {
      SFX.smokePop(H.distToPlayer(g.x, g.z));
      smokes.push({ x: g.x, y: Math.max(10, g.y), z: g.z, r: 190, life: 14, max: 14, seed: Math.random() * 6.28 });
    }
  }

  /* ---------- 每帧更新 ---------- */
  function update(dt, fx) {
    for (var i = live.length - 1; i >= 0; i--) {
      var g = live[i];
      step(g, dt);
      g.fuse -= dt;
      if (g.fuse <= 0) { detonate(g, fx); live.splice(i, 1); }
    }
    // 烟雾团：不断补充烟球
    for (i = smokes.length - 1; i >= 0; i--) {
      var sm = smokes[i];
      sm.life -= dt;
      if (sm.life <= 0) { smokes.splice(i, 1); continue; }
      var want = sm.life > 1.2 ? 3 : 0;
      for (var k = 0; k < want; k++) {
        if (Math.random() > dt * 6) continue;
        var p = puffPool[puffI = (puffI + 1) % puffPool.length];
        var a = Math.random() * 6.283, rr = Math.random() * sm.r * 0.75;
        p.s.position.set(sm.x + Math.cos(a) * rr, sm.y + Math.random() * sm.r * 0.55, sm.z + Math.sin(a) * rr);
        p.size = 150 + Math.random() * 120;
        p.life = p.max = 1.6 + Math.random() * 1.4;
        p.vy = 6 + Math.random() * 10;
        p.s.material.color.setHex(0xd8d8d4);
        p.s.visible = true;
      }
    }
    for (i = 0; i < puffPool.length; i++) {
      var pp = puffPool[i];
      if (pp.life <= 0) continue;
      pp.life -= dt;
      if (pp.life <= 0) { pp.s.visible = false; pp.s.material.opacity = 0; continue; }
      pp.s.position.y += pp.vy * dt;
      var t2 = 1 - pp.life / pp.max;
      pp.s.scale.setScalar(pp.size * (0.7 + t2 * 0.45));
      pp.s.material.opacity = Math.min(0.9, Math.sin(Math.min(1, pp.life / pp.max * 2.2) * Math.PI / 2) * 0.9);
    }
  }

  /* ---------- 烟雾遮挡视线 ---------- */
  function segPointDist(ax, ay, az, bx, by, bz, px, py, pz) {
    var abx = bx - ax, aby = by - ay, abz = bz - az;
    var apx = px - ax, apy = py - ay, apz = pz - az;
    var len2 = abx * abx + aby * aby + abz * abz;
    var t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
    var cx = ax + abx * t - px, cy = ay + aby * t - py, cz = az + abz * t - pz;
    return Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  /* 视线是否穿过烟雾（烟团中心稍微抬高，半径按剩余时间收缩） */
  function blocked(ax, ay, az, bx, by, bz) {
    for (var i = 0; i < smokes.length; i++) {
      var s = smokes[i];
      if (s.life < 0.6) continue;
      var grow = Math.min(1, (s.max - s.life) / 1.1);       // 起爆后 1 秒才成形
      var r = s.r * 0.85 * grow * Math.min(1, s.life / 1.5 + 0.35);
      if (r < 30) continue;
      if (segPointDist(ax, ay, az, bx, by, bz, s.x, s.y + 55, s.z) < r) return true;
    }
    return false;
  }

  function clear() {
    for (var i = 0; i < live.length; i++) live[i].mesh.visible = false;
    live.length = 0;
    smokes.length = 0;
    for (i = 0; i < puffPool.length; i++) { puffPool[i].life = 0; puffPool[i].s.visible = false; }
  }

  function count() { return { live: live.length, smokes: smokes.length }; }

  /* 烟团位置（自检 / 调试用） */
  function smokeList() {
    return smokes.map(function (s) { return { x: s.x, y: s.y, z: s.z, r: s.r, life: s.life }; });
  }

  /* 飞行中的手雷（自检 / 调试用） */
  function liveList() {
    return live.map(function (g) { return { kind: g.kind, x: g.x, y: g.y, z: g.z, fuse: g.fuse }; });
  }

  return {
    init: init, throwGrenade: throwGrenade, update: update,
    blocked: blocked, clear: clear, count: count,
    smokeList: smokeList, liveList: liveList
  };
})();
