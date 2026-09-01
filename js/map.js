/* ============================================================
 *  map.js — de_dust2（简化复刻）
 *  单位沿用 CS 的 unit（1 unit ≈ 1 英寸，玩家高 72）
 *  地图由「可行走矩形」栅格化生成，自动长出墙体 + 生成寻路网格
 * ============================================================ */
'use strict';

var MAP = (function () {

  var GRID = 64;                 // 栅格边长
  var N = 84;                    // 栅格数量 84*64 = 5376
  var ORIGIN = -(N * GRID) / 2;  // 世界坐标原点偏移
  var WALL_H = 232;              // 墙高
  var FLOOR_T = 16;              // 地板厚

  var walk = new Uint8Array(N * N);      // 1 = 可站立地面
  var navBlk = new Uint8Array(N * N);    // 1 = 被箱子等占据，寻路不可走
  var solids = [];                       // 碰撞体 {x1,y1,z1,x2,y2,z2}
  var hash = null, HCELL = 320, HN = 0;  // 碰撞体空间哈希

  /* -------------------- 关卡布局 -------------------- */
  /* 每项：[x1, z1, x2, z2]，-Z 为雷达上方（北），+X 为东 */
  var ROOMS = [
    // T 出生点（下方中央）
    ['T_SPAWN', -900, 1650, 500, 2300],
    // T 出生 → 隧道口（西侧）
    ['TUNNEL_OUT', -1750, 1650, -900, 2100],
    // 上层隧道（西侧竖向长廊）
    ['TUNNEL_UP', -1700, -250, -1350, 1700],
    // B 包点（左上）
    ['B_SITE', -2300, -1450, -1150, -250],
    // CT → B 的门洞
    ['B_DOOR', -1500, -1600, -1000, -1450],
    // 顶部横向走廊（CT 出生 → B 门）
    ['CT_TOP', -1150, -1900, 600, -1600],
    // 中路（下段 / 中门 / 上段）
    ['MID_LOW', -60, 600, 360, 1650],
    ['MID_DOOR', 40, 440, 300, 600],
    ['MID_UP', -60, -1000, 360, 440],
    // CT 中路广场
    ['CT_MID', -360, -1600, 700, -1000],
    // 小道（catwalk / A 短）
    ['CATWALK', 360, -800, 1000, -480],
    // A 包点（右侧）
    ['A_SITE', 1000, -1150, 1900, -300],
    // CT 出生点（右上）
    ['CT_SPAWN', 700, -1900, 1700, -1150],
    // 长通道
    ['LONG_A', 1350, -300, 1750, 1750],
    ['LONG_HALL', 500, 1450, 1150, 1750],
    ['LONG_DOOR', 1150, 1500, 1350, 1700],
    // 长通道的坑（pit）
    ['PIT', 1750, 250, 2080, 780]
  ];

  /* 场景道具（同时是掩体 / 碰撞体） */
  /* {x,z: 中心, w,d: 平面尺寸, h: 高度, y: 底部高度, mat: 材质} */
  var PROPS = [
    // ---- A 包点 ----
    { x: 1180, z: -520, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: 1180, z: -392, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: 1180, z: -520, w: 128, d: 128, h: 112, y: 128, mat: 'crate' },
    { x: 1560, z: -400, w: 96, d: 96, h: 152, mat: 'metal' },
    { x: 1800, z: -1000, w: 200, d: 300, h: 48, mat: 'top' },   // goose 平台（可跳上）
    { x: 1320, z: -1090, w: 176, d: 112, h: 96, mat: 'crate' },
    { x: 1700, z: -640, w: 112, d: 112, h: 112, mat: 'crate' },
    // ---- B 包点 ----
    { x: -1600, z: -880, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: -1600, z: -752, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: -1600, z: -880, w: 128, d: 128, h: 112, y: 128, mat: 'crate' },
    { x: -2150, z: -1330, w: 280, d: 200, h: 48, mat: 'top' },  // back plat
    { x: -1280, z: -1250, w: 160, d: 160, h: 160, mat: 'metal' },
    { x: -2200, z: -430, w: 120, d: 120, h: 120, mat: 'crate' },
    // ---- 中路 ----
    { x: 130, z: 150, w: 96, d: 96, h: 80, mat: 'metal' },      // xbox
    { x: 60, z: -820, w: 112, d: 112, h: 112, mat: 'crate' },
    // ---- 小道 ----
    { x: 690, z: -620, w: 112, d: 112, h: 112, mat: 'crate' },
    // ---- 长通道 ----
    { x: 1450, z: 1330, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: 1620, z: 520, w: 112, d: 112, h: 96, mat: 'metal' },
    { x: 1930, z: 480, w: 128, d: 128, h: 48, mat: 'top' },
    // ---- 出生点附近（注意不要压在出生坐标上）----
    { x: -820, z: 1980, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: 380, z: 2180, w: 112, d: 112, h: 112, mat: 'crate' },
    { x: 1250, z: -1620, w: 128, d: 128, h: 128, mat: 'crate' },
    { x: 1560, z: -1250, w: 112, d: 112, h: 112, mat: 'metal' },
    { x: -1560, z: 1900, w: 112, d: 112, h: 112, mat: 'crate' },
    { x: -1520, z: 900, w: 96, d: 96, h: 96, mat: 'metal' },
    { x: -600, z: -1780, w: 128, d: 128, h: 128, mat: 'crate' }
  ];

  /* 出生点 */
  var SPAWNS = {
    T: [[-750, 2150], [-500, 2200], [-250, 2150], [0, 2220], [250, 2160],
        [-620, 1900], [-150, 1900], [200, 1900], [-450, 1980], [-100, 2050]],
    CT: [[850, -1750], [1050, -1800], [1250, -1750], [1450, -1800], [1620, -1740],
         [900, -1500], [1150, -1450], [1400, -1500], [1050, -1600], [1350, -1550]]
  };

  /* 包点 */
  var SITES = [
    { name: 'A', x: 1400, z: -700, r: 420 },
    { name: 'B', x: -1720, z: -820, r: 420 }
  ];

  /* 区域名（HUD 显示 & bot 目标点） */
  var AREAS = [];

  /* -------------------- 栅格工具 -------------------- */
  function cx(x) { return Math.floor((x - ORIGIN) / GRID); }
  function cz(z) { return Math.floor((z - ORIGIN) / GRID); }
  function wx(i) { return ORIGIN + i * GRID + GRID / 2; }
  function wz(j) { return ORIGIN + j * GRID + GRID / 2; }
  function idx(i, j) { return j * N + i; }
  function inGrid(i, j) { return i >= 0 && j >= 0 && i < N && j < N; }

  function isWalk(i, j) { return inGrid(i, j) && walk[idx(i, j)] === 1; }
  function isNav(i, j) { return inGrid(i, j) && walk[idx(i, j)] === 1 && navBlk[idx(i, j)] === 0; }
  function isWalkWorld(x, z) { return isWalk(cx(x), cz(z)); }

  /* 贪心矩形合并：把 bool 栅格压成少量矩形，减少顶点数 */
  function mergeRects(mask) {
    var used = new Uint8Array(N * N), out = [];
    for (var j = 0; j < N; j++) {
      for (var i = 0; i < N; i++) {
        var k = idx(i, j);
        if (!mask[k] || used[k]) continue;
        var w = 1;
        while (i + w < N && mask[idx(i + w, j)] && !used[idx(i + w, j)]) w++;
        var h = 1;
        outer: while (j + h < N) {
          for (var t = 0; t < w; t++) {
            var k2 = idx(i + t, j + h);
            if (!mask[k2] || used[k2]) break outer;
          }
          h++;
        }
        for (var jj = 0; jj < h; jj++) for (var ii = 0; ii < w; ii++) used[idx(i + ii, j + jj)] = 1;
        out.push([i, j, w, h]);
      }
    }
    return out;
  }

  /* -------------------- 几何构建 -------------------- */
  function GeoBuf() { this.p = []; this.n = []; this.u = []; this.c = []; }

  /* 往缓冲里塞一个长方体（可指定每个面的贴图世界尺寸，实现无拉伸平铺）
   * 注意：顶/底面的 ua/va 轴向决定三角形绕序。原版顶面 ua=[1,0,0] va=[0,0,1]
   * 的叉积朝 -Y（朝下），从上方看是背面被剔除 —— 站上箱子会看到「穿透」，
   * 这就是障碍物顶部没有贴图的根因。交换两轴让绕序朝外。 */
  var FACES = [
    // dir, normal, u轴, v轴
    { n: [1, 0, 0], o: [1, 0, 0], ua: [0, 0, -1], va: [0, 1, 0] },
    { n: [-1, 0, 0], o: [-1, 0, 0], ua: [0, 0, 1], va: [0, 1, 0] },
    { n: [0, 1, 0], o: [0, 1, 0], ua: [0, 0, 1], va: [1, 0, 0] },
    { n: [0, -1, 0], o: [0, -1, 0], ua: [0, 0, -1], va: [1, 0, 0] },
    { n: [0, 0, 1], o: [0, 0, 1], ua: [1, 0, 0], va: [0, 1, 0] },
    { n: [0, 0, -1], o: [0, 0, -1], ua: [-1, 0, 0], va: [0, 1, 0] }
  ];

  function pushBox(g, b, texSize, tint, skipBottom) {
    var cxx = (b.x1 + b.x2) / 2, cyy = (b.y1 + b.y2) / 2, czz = (b.z1 + b.z2) / 2;
    var hx = (b.x2 - b.x1) / 2, hy = (b.y2 - b.y1) / 2, hz = (b.z2 - b.z1) / 2;
    for (var f = 0; f < 6; f++) {
      var F = FACES[f];
      if (skipBottom && F.n[1] === -1) continue;
      var ex = F.o[0] * hx, ey = F.o[1] * hy, ez = F.o[2] * hz;      // 面中心偏移
      var ux = F.ua[0] * hx, uy = F.ua[1] * hy, uz = F.ua[2] * hz;   // 半边 u
      var vx = F.va[0] * hx, vy = F.va[1] * hy, vz = F.va[2] * hz;   // 半边 v
      var uLen = Math.abs(ux) + Math.abs(uy) + Math.abs(uz);
      var vLen = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
      var us = texSize > 0 ? (uLen * 2) / texSize : 1;
      var vs = texSize > 0 ? (vLen * 2) / texSize : 1;
      // 顶面稍暗（避免朝上的面被阳光打爆），侧面按朝向轻微变化
      var shade = F.n[1] === 1 ? 0.9 : (F.n[1] === -1 ? 0.6 : (F.n[0] !== 0 ? 0.9 : 0.98));
      var q = [
        [-1, -1, 0, 0], [1, -1, us, 0], [1, 1, us, vs],
        [-1, -1, 0, 0], [1, 1, us, vs], [-1, 1, 0, vs]
      ];
      for (var t = 0; t < 6; t++) {
        var s = q[t][0], r = q[t][1];
        g.p.push(cxx + ex + ux * s + vx * r, cyy + ey + uy * s + vy * r, czz + ez + uz * s + vz * r);
        g.n.push(F.n[0], F.n[1], F.n[2]);
        g.u.push(q[t][2], q[t][3]);
        g.c.push(tint[0] * shade, tint[1] * shade, tint[2] * shade);
      }
    }
  }

  function makeMesh(g, map, name) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.u, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(g.c, 3));
    geo.computeBoundingSphere();
    var mat = new THREE.MeshLambertMaterial({ map: map, vertexColors: true });
    var m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.matrixAutoUpdate = false;
    return m;
  }

  /* -------------------- 碰撞 -------------------- */
  function addSolid(b) { solids.push(b); }

  function buildHash() {
    HN = Math.ceil((N * GRID) / HCELL) + 2;
    hash = new Array(HN * HN);
    for (var i = 0; i < hash.length; i++) hash[i] = null;
    for (var s = 0; s < solids.length; s++) {
      var b = solids[s];
      var i0 = hi(b.x1), i1 = hi(b.x2), j0 = hi(b.z1), j1 = hi(b.z2);
      for (var j = j0; j <= j1; j++) for (i = i0; i <= i1; i++) {
        var k = j * HN + i;
        if (k < 0 || k >= hash.length) continue;
        if (!hash[k]) hash[k] = [];
        hash[k].push(b);
      }
    }
  }
  function hi(v) {
    var i = Math.floor((v - ORIGIN) / HCELL);
    return i < 0 ? 0 : i >= HN ? HN - 1 : i;
  }

  /* 查询与 AABB 相交的候选碰撞体 */
  var qBuf = [], qMark = 0;
  function query(x1, y1, z1, x2, y2, z2, out) {
    out.length = 0;
    var i0 = hi(x1), i1 = hi(x2), j0 = hi(z1), j1 = hi(z2);
    qMark++;
    for (var j = j0; j <= j1; j++) for (var i = i0; i <= i1; i++) {
      var list = hash[j * HN + i];
      if (!list) continue;
      for (var t = 0; t < list.length; t++) {
        var b = list[t];
        if (b._m === qMark) continue;
        b._m = qMark;
        if (b.x2 <= x1 || b.x1 >= x2 || b.y2 <= y1 || b.y1 >= y2 || b.z2 <= z1 || b.z1 >= z2) continue;
        out.push(b);
      }
    }
    return out;
  }

  /* 世界射线检测（射线 vs AABB 集合），返回最近命中 */
  function traceRay(ox, oy, oz, dx, dy, dz, maxDist, hitOut) {
    var ex = ox + dx * maxDist, ey = oy + dy * maxDist, ez = oz + dz * maxDist;
    var list = query(Math.min(ox, ex) - 1, Math.min(oy, ey) - 1, Math.min(oz, ez) - 1,
                     Math.max(ox, ex) + 1, Math.max(oy, ey) + 1, Math.max(oz, ez) + 1, qBuf);
    var best = maxDist, nx = 0, ny = 0, nz = 0, found = false;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var t = rayBox(ox, oy, oz, dx, dy, dz, b, best);
      if (t >= 0 && t < best) {
        best = t; found = true;
        nx = rayBox.nx; ny = rayBox.ny; nz = rayBox.nz;
      }
    }
    if (!found) return null;
    if (!hitOut) hitOut = {};
    hitOut.dist = best;
    hitOut.x = ox + dx * best; hitOut.y = oy + dy * best; hitOut.z = oz + dz * best;
    hitOut.nx = nx; hitOut.ny = ny; hitOut.nz = nz;
    return hitOut;
  }

  /* slab 法：返回进入距离，命中面法线写在函数属性上 */
  function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
    var tmin = 0, tmax = maxT, axis = -1, sign = 1;
    // X
    var inv, t1, t2;
    if (Math.abs(dx) < 1e-8) { if (ox < b.x1 || ox > b.x2) return -1; }
    else {
      inv = 1 / dx; t1 = (b.x1 - ox) * inv; t2 = (b.x2 - ox) * inv;
      var s = 1; if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; s = -1; }
      if (t1 > tmin) { tmin = t1; axis = 0; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dy) < 1e-8) { if (oy < b.y1 || oy > b.y2) return -1; }
    else {
      inv = 1 / dy; t1 = (b.y1 - oy) * inv; t2 = (b.y2 - oy) * inv;
      s = 1; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; s = -1; }
      if (t1 > tmin) { tmin = t1; axis = 1; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dz) < 1e-8) { if (oz < b.z1 || oz > b.z2) return -1; }
    else {
      inv = 1 / dz; t1 = (b.z1 - oz) * inv; t2 = (b.z2 - oz) * inv;
      s = 1; if (t1 > t2) { tt = t1; t1 = t2; t2 = tt; s = -1; }
      if (t1 > tmin) { tmin = t1; axis = 2; sign = s; }
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    rayBox.nx = axis === 0 ? -sign : 0;
    rayBox.ny = axis === 1 ? -sign : 0;
    rayBox.nz = axis === 2 ? -sign : 0;
    if (axis === -1) { rayBox.nx = 0; rayBox.ny = 1; rayBox.nz = 0; }
    return tmin;
  }

  /* 两点之间是否被墙体阻挡（bot 视线用） */
  function losBlocked(ax, ay, az, bx, by, bz) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1) return false;
    var h = traceRay(ax, ay, az, dx / d, dy / d, dz / d, d - 2, losBlocked._h);
    return !!h;
  }
  losBlocked._h = {};

  /* -------------------- 构建 -------------------- */
  function build(scene, tex) {
    solids.length = 0;
    walk.fill(0); navBlk.fill(0);
    AREAS.length = 0;

    // 1. 标记可行走栅格
    for (var r = 0; r < ROOMS.length; r++) {
      var R = ROOMS[r];
      var x1 = R[1], z1 = R[2], x2 = R[3], z2 = R[4];
      var ci0 = Math.max(0, cx(x1)), ci1 = Math.min(N - 1, cx(x2 - 1));
      var cj0 = Math.max(0, cz(z1)), cj1 = Math.min(N - 1, cz(z2 - 1));
      for (var j = cj0; j <= cj1; j++) for (var i = ci0; i <= ci1; i++) walk[idx(i, j)] = 1;
      AREAS.push({
        name: R[0], x1: x1, z1: z1, x2: x2, z2: z2,
        cx: (x1 + x2) / 2, cz: (z1 + z2) / 2
      });
    }

    // 2. 地板（合并矩形 → 少量大盒子）
    var gFloor = new GeoBuf(), gStone = new GeoBuf();
    var floorRects = mergeRects(walk);
    for (r = 0; r < floorRects.length; r++) {
      var fr = floorRects[r];
      var b = {
        x1: ORIGIN + fr[0] * GRID, x2: ORIGIN + (fr[0] + fr[2]) * GRID,
        z1: ORIGIN + fr[1] * GRID, z2: ORIGIN + (fr[1] + fr[3]) * GRID,
        y1: -FLOOR_T, y2: 0
      };
      // 包点铺石板，其余沙地（只有整体落在包点内的地块才用石板）
      var mx = (b.x1 + b.x2) / 2, mz = (b.z1 + b.z2) / 2;
      var stone = false;
      for (var s2 = 0; s2 < SITES.length; s2++) {
        var S = SITES[s2];
        if (Math.abs(mx - S.x) < S.r * 0.95 && Math.abs(mz - S.z) < S.r * 0.95) stone = true;
      }
      pushBox(stone ? gStone : gFloor, b, stone ? 160 : 192,
        stone ? [0.78, 0.78, 0.77] : [0.72, 0.71, 0.68], true);
      addSolid({ x1: b.x1, y1: -400, z1: b.z1, x2: b.x2, y2: 0, z2: b.z2, kind: 'floor' });
    }
    scene.add(makeMesh(gFloor, tex.floor, 'floor'));
    scene.add(makeMesh(gStone, tex.stone, 'floorStone'));

    // 兜底地面：即使玩家看到地块缝隙也不会看到虚空
    // （贴着地板下方 4 单位，缝隙里只会露出沙地而不是天空）
    var baseFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(N * GRID + 4000, N * GRID + 4000),
      new THREE.MeshLambertMaterial({ map: tex.floor.clone(), color: 0xb9a06f })
    );
    baseFloor.material.map.wrapS = baseFloor.material.map.wrapT = THREE.RepeatWrapping;
    baseFloor.material.map.repeat.set(48, 48);
    baseFloor.material.map.needsUpdate = true;
    baseFloor.rotation.x = -Math.PI / 2;
    baseFloor.position.y = -4;
    scene.add(baseFloor);

    // 3. 墙体：与可行走格相邻（含对角）的不可行走格
    var wallMask = new Uint8Array(N * N);
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      if (walk[idx(i, j)]) continue;
      var near = false;
      for (var dj = -1; dj <= 1 && !near; dj++) for (var di = -1; di <= 1; di++) {
        if (isWalk(i + di, j + dj)) { near = true; break; }
      }
      if (near) wallMask[idx(i, j)] = 1;
    }
    var gWall = new GeoBuf(), gTop = new GeoBuf();
    var wallRects = mergeRects(wallMask);
    for (r = 0; r < wallRects.length; r++) {
      var wr = wallRects[r];
      var wb = {
        x1: ORIGIN + wr[0] * GRID, x2: ORIGIN + (wr[0] + wr[2]) * GRID,
        z1: ORIGIN + wr[1] * GRID, z2: ORIGIN + (wr[1] + wr[3]) * GRID,
        y1: -FLOOR_T, y2: WALL_H
      };
      var v = 0.93 + ((r * 37) % 10) * 0.016;
      pushBox(gWall, wb, 128, [v, v, v], true);
      // 墙帽
      pushBox(gTop, { x1: wb.x1 - 4, x2: wb.x2 + 4, z1: wb.z1 - 4, z2: wb.z2 + 4, y1: WALL_H, y2: WALL_H + 18 }, 128, [1, 1, 1], true);
      addSolid({ x1: wb.x1, y1: -FLOOR_T, z1: wb.z1, x2: wb.x2, y2: WALL_H + 18, z2: wb.z2, kind: 'wall' });
    }
    scene.add(makeMesh(gWall, tex.wall, 'walls'));
    scene.add(makeMesh(gTop, tex.top, 'wallTops'));

    // 4. 道具 / 掩体
    var gCrate = new GeoBuf(), gMetal = new GeoBuf(), gPlat = new GeoBuf();
    for (var p = 0; p < PROPS.length; p++) {
      var P = PROPS[p], y0 = P.y || 0;
      var pb = {
        x1: P.x - P.w / 2, x2: P.x + P.w / 2,
        z1: P.z - P.d / 2, z2: P.z + P.d / 2,
        y1: y0, y2: y0 + P.h
      };
      var g = P.mat === 'metal' ? gMetal : (P.mat === 'top' ? gPlat : gCrate);
      pushBox(g, pb, P.mat === 'crate' ? 0 : (P.mat === 'metal' ? 128 : 192), [1, 1, 1], y0 === 0);
      addSolid({ x1: pb.x1, y1: pb.y1, z1: pb.z1, x2: pb.x2, y2: pb.y2, z2: pb.z2, kind: 'prop' });
      // 高于 64 的箱子挡住寻路
      if (P.h + y0 > 64) {
        var bi0 = cx(pb.x1), bi1 = cx(pb.x2 - 1), bj0 = cz(pb.z1), bj1 = cz(pb.z2 - 1);
        for (j = bj0; j <= bj1; j++) for (i = bi0; i <= bi1; i++) if (inGrid(i, j)) navBlk[idx(i, j)] = 1;
      }
    }
    scene.add(makeMesh(gCrate, tex.crate, 'crates'));
    scene.add(makeMesh(gMetal, tex.metal, 'metalProps'));
    scene.add(makeMesh(gPlat, tex.top, 'platforms'));

    // 5. 远景建筑（纯装饰，不参与碰撞）
    var gFar = new GeoBuf();
    var farSeed = 7;
    function fr2() { farSeed = (farSeed * 16807) % 2147483647; return farSeed / 2147483647; }
    for (var k = 0; k < 46; k++) {
      var ang = fr2() * Math.PI * 2, dist = 3200 + fr2() * 2600;
      var fx = Math.cos(ang) * dist, fz = Math.sin(ang) * dist;
      var fw = 400 + fr2() * 900, fd = 400 + fr2() * 900, fh = 300 + fr2() * 900;
      pushBox(gFar, { x1: fx - fw / 2, x2: fx + fw / 2, z1: fz - fd / 2, z2: fz + fd / 2, y1: -200, y2: fh }, 192,
        [0.92 + fr2() * 0.12, 0.9 + fr2() * 0.1, 0.86 + fr2() * 0.1], true);
    }
    var farMesh = makeMesh(gFar, tex.wall, 'skyline');
    scene.add(farMesh);

    // 6. 包点标记
    for (s2 = 0; s2 < SITES.length; s2++) addSiteMarker(scene, SITES[s2]);

    buildHash();
    return { solids: solids.length };
  }

  /* 地面的 A / B 包点标记 */
  function addSiteMarker(scene, site) {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var x = c.getContext('2d');
    x.clearRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(255,235,120,.85)'; x.lineWidth = 8;
    x.setLineDash([26, 18]);
    x.strokeRect(14, 14, 228, 228);
    x.setLineDash([]);
    x.fillStyle = 'rgba(255,235,120,.5)';
    x.font = 'bold 150px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(site.name, 128, 138);
    var t = new THREE.CanvasTexture(c);
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(site.r * 1.7, site.r * 1.7),
      new THREE.MeshBasicMaterial({
        map: t, transparent: true, depthWrite: false, opacity: 0.85,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
      })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(site.x, 1.2, site.z);
    m.renderOrder = 1;
    scene.add(m);
  }

  /* 找一个安全落点（尽量在给定点附近的可行走格上） */
  function nearestOpen(x, z) {
    if (isNav(cx(x), cz(z))) return [x, z];
    for (var r = 1; r < 12; r++) {
      for (var dj = -r; dj <= r; dj++) for (var di = -r; di <= r; di++) {
        if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
        var i = cx(x) + di, j = cz(z) + dj;
        if (isNav(i, j)) return [wx(i), wz(j)];
      }
    }
    return [x, z];
  }

  function areaAt(x, z) {
    for (var i = 0; i < AREAS.length; i++) {
      var a = AREAS[i];
      if (x >= a.x1 && x <= a.x2 && z >= a.z1 && z <= a.z2) return a.name;
    }
    return '';
  }

  function siteAt(x, z) {
    for (var i = 0; i < SITES.length; i++) {
      var s = SITES[i];
      if (Math.abs(x - s.x) < s.r && Math.abs(z - s.z) < s.r) return s;
    }
    return null;
  }

  /* 购买区：各自出生区域 */
  var BUY_ZONES = {
    T: [-980, 1560, 580, 2320],
    CT: [620, -1980, 1780, -1120]
  };
  function inBuyZone(team, x, z) {
    var b = BUY_ZONES[team];
    return !!b && x > b[0] && x < b[2] && z > b[1] && z < b[3];
  }

  /* 找一个不与任何实体碰撞的出生位置（避免卡在箱子里） */
  function safeSpawn(x, z, probe) {
    if (!probe(x, z)) return [x, z];
    var step = 36;
    for (var r = 1; r <= 8; r++) {
      for (var a = 0; a < 12; a++) {
        var ang = (a / 12) * Math.PI * 2 + r * 0.31;
        var nx = x + Math.cos(ang) * step * r;
        var nz = z + Math.sin(ang) * step * r;
        if (isWalkWorld(nx, nz) && !probe(nx, nz)) return [nx, nz];
      }
    }
    return [x, z];
  }

  return {
    GRID: GRID, N: N, ORIGIN: ORIGIN, WALL_H: WALL_H,
    build: build,
    solids: solids,
    walk: walk, navBlk: navBlk,
    cx: cx, cz: cz, wx: wx, wz: wz, idx: idx, inGrid: inGrid,
    isWalk: isWalk, isNav: isNav, isWalkWorld: isWalkWorld,
    query: query, traceRay: traceRay, losBlocked: losBlocked,
    nearestOpen: nearestOpen, areaAt: areaAt, siteAt: siteAt,
    inBuyZone: inBuyZone, safeSpawn: safeSpawn, BUY_ZONES: BUY_ZONES,
    SPAWNS: SPAWNS, SITES: SITES, AREAS: AREAS
  };
})();
