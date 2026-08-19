/* ============================================================
 *  phys.js — 角色物理（AABB 胶囊近似 + 台阶 + CS 式加速度）
 *  实体约定：位置 (x,y,z) 为「脚底」中心
 * ============================================================ */
'use strict';

var PHYS = (function () {

  var G = 800;              // 重力 u/s^2
  var HULL_R = 16;          // 半宽
  var STAND_H = 72;
  var CROUCH_H = 36;
  var STEP = 20;            // 可直接跨上的台阶高度
  var MAX_SPEED = 250;      // 步枪移动速度
  var ACCEL = 10;
  var AIR_ACCEL = 10;
  var FRICTION = 5.2;
  var JUMP_VEL = 290;
  var STOP_SPEED = 75;

  var qb = [];

  function height(e) { return e.crouch ? CROUCH_H : STAND_H; }

  /* 指定位置是否与世界相撞 */
  function collide(x, y, z, e, ignoreY) {
    var h = height(e);
    var x1 = x - HULL_R, x2 = x + HULL_R;
    var z1 = z - HULL_R, z2 = z + HULL_R;
    var y1 = y + 0.6, y2 = y + h;
    var list = MAP.query(x1, y1, z1, x2, y2, z2, qb);
    return list.length > 0;
  }

  /* 找脚下最高支撑面（用于落地吸附） */
  function groundY(x, y, z, e) {
    var h = height(e);
    var list = MAP.query(x - HULL_R, y - 64, z - HULL_R, x + HULL_R, y + 2, z + HULL_R, qb);
    var best = -10000;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (b.y2 <= y + 2 && b.y2 > best) best = b.y2;
    }
    return best;
  }

  function tryTranslate(e, dx, dz) {
    var nx = e.x + dx, nz = e.z + dz;
    if (!collide(nx, e.y, nz, e)) { e.x = nx; e.z = nz; return true; }
    // 分轴滑动
    var moved = false;
    if (dx !== 0 && !collide(e.x + dx, e.y, e.z, e)) { e.x += dx; moved = true; }
    if (dz !== 0 && !collide(e.x, e.y, e.z + dz, e)) { e.z += dz; moved = true; }
    return moved;
  }

  /* 带台阶的水平移动 */
  function stepMove(e, dx, dz) {
    var ox = e.x, oz = e.z;
    if (tryTranslate(e, dx, dz)) {
      if (Math.abs(e.x - ox) > 1e-6 || Math.abs(e.z - oz) > 1e-6) return true;
    }
    if (!e.onGround) return false;
    // 抬高后再走，然后吸附回地面
    var oy = e.y;
    if (collide(e.x, e.y + STEP, e.z, e)) return false;
    e.y += STEP;
    if (tryTranslate(e, dx, dz)) {
      var g = groundY(e.x, e.y, e.z, e);
      if (g > -9999 && g <= oy + STEP + 1) e.y = Math.max(g, oy);
      else e.y = oy;
      if (collide(e.x, e.y, e.z, e)) { e.y = oy; e.x = ox; e.z = oz; return false; }
      return true;
    }
    e.y = oy;
    return false;
  }

  /* 地面摩擦 / 加速（近似 Quake/CS 的 movement） */
  function applyFriction(e, dt) {
    var sp = Math.sqrt(e.vx * e.vx + e.vz * e.vz);
    if (sp < 0.5) { e.vx = 0; e.vz = 0; return; }
    var control = sp < STOP_SPEED ? STOP_SPEED : sp;
    var drop = control * FRICTION * dt;
    var newSp = Math.max(0, sp - drop) / sp;
    e.vx *= newSp; e.vz *= newSp;
  }

  function accelerate(e, wx, wz, wishSpeed, accel, dt) {
    var cur = e.vx * wx + e.vz * wz;
    var add = wishSpeed - cur;
    if (add <= 0) return;
    var accelSpeed = Math.min(accel * wishSpeed * dt, add);
    e.vx += accelSpeed * wx;
    e.vz += accelSpeed * wz;
  }

  /* 主更新：wishX/wishZ 为归一化的期望方向，speedScale 缩放最大速度 */
  function move(e, dt, wishX, wishZ, speedScale) {
    var wasGround = e.onGround;
    var maxSp = MAX_SPEED * (speedScale === undefined ? 1 : speedScale);
    if (e.crouch) maxSp *= 0.34;

    var wl = Math.sqrt(wishX * wishX + wishZ * wishZ);
    if (wl > 1e-4) { wishX /= wl; wishZ /= wl; } else { wishX = 0; wishZ = 0; }
    var wishSpeed = wl > 1e-4 ? maxSp : 0;

    if (e.onGround) {
      applyFriction(e, dt);
      accelerate(e, wishX, wishZ, wishSpeed, ACCEL, dt);
    } else {
      // 空中控制受限
      accelerate(e, wishX, wishZ, Math.min(wishSpeed, 30), AIR_ACCEL, dt);
    }

    // 水平移动
    stepMove(e, e.vx * dt, e.vz * dt);

    // 垂直移动
    e.vy -= G * dt;
    var dy = e.vy * dt;
    var ny = e.y + dy;
    if (!collide(e.x, ny, e.z, e)) {
      e.y = ny;
      // 贴地检测（避免下坡时反复起跳）
      if (e.vy <= 0) {
        var g = groundY(e.x, e.y, e.z, e);
        if (g > -9999 && e.y - g < 2.5) { e.y = g; e.landSpeed = -e.vy; e.vy = 0; e.onGround = true; }
        else e.onGround = false;
      } else e.onGround = false;
    } else {
      if (e.vy <= 0) {
        var g2 = groundY(e.x, e.y, e.z, e);
        e.y = g2 > -9999 ? g2 : e.y;
        e.onGround = true;
        e.landSpeed = -e.vy;
      } else {
        e.onGround = false;
      }
      e.vy = 0;
    }

    if (!wasGround && e.onGround) e.justLanded = true; else e.justLanded = false;

    // 掉出地图的保护
    if (e.y < -600) { e.y = 0; e.vy = 0; }
  }

  function jump(e) {
    if (!e.onGround) return false;
    e.vy = JUMP_VEL;
    e.onGround = false;
    e.landSpeed = 0;
    return true;
  }

  /* 起身时检查头顶空间 */
  function canStand(e) {
    var saved = e.crouch;
    e.crouch = false;
    var bad = collide(e.x, e.y, e.z, e);
    e.crouch = saved;
    return !bad;
  }

  /* 实体之间的软分离，避免叠在一起。
   * 远程玩家（isRemote）的位置来自网络插值，本地不能去推他，否则会跟插值打架。 */
  function separate(list) {
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (a.dead || a.isRemote) continue;
      for (var j = i + 1; j < list.length; j++) {
        var b = list[j];
        if (b.dead || b.isRemote) continue;
        var dx = b.x - a.x, dz = b.z - a.z;
        var d2 = dx * dx + dz * dz;
        var minD = HULL_R * 2 - 4;
        if (d2 > minD * minD || d2 < 1e-6) continue;
        if (Math.abs((a.y + height(a)) - b.y) < 4 || Math.abs((b.y + height(b)) - a.y) < 4) continue; // 站在头上
        var d = Math.sqrt(d2), push = (minD - d) * 0.5;
        dx /= d; dz /= d;
        if (!collide(a.x - dx * push, a.y, a.z - dz * push, a)) { a.x -= dx * push; a.z -= dz * push; }
        if (!collide(b.x + dx * push, b.y, b.z + dz * push, b)) { b.x += dx * push; b.z += dz * push; }
      }
    }
  }

  return {
    G: G, HULL_R: HULL_R, STAND_H: STAND_H, CROUCH_H: CROUCH_H,
    MAX_SPEED: MAX_SPEED, JUMP_VEL: JUMP_VEL,
    height: height, collide: collide, groundY: groundY,
    move: move, jump: jump, canStand: canStand, separate: separate
  };
})();
