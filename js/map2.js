/* ============================================================
 *  map2.js — 仓库地图「工业综合体」（v4 紧凑多路线版）
 *
 *  参考 de_dust2 / de_mirage / de_overpass 设计原则：
 *   · 每方 3 条路线（北线 / 中路 / 南线），中央大厅为交叉路口
 *   · 包点三面入口，出生点与包点之间必有转角（无直视线）
 *   · 紧凑尺寸：典型交火距离 400~1500（旧版 1500~2500 太远）
 *   · CT 出生居中枢纽，到 A/B 都比 T 快（A 略快 / B 显著快）
 *   · 高差全部 16 的倍数（≤20 自动上步），无 Z 轴瞬移
 *
 *  俯视（西=T，东=CT）：
 *    ┌A点═╗←A西门─A前厅─┐北走廊┌─CT北厅═A东门═┛
 *    ║高位║      └A连接道┐  └─CT出生枢纽─┬─CT北口
 *    ╚═╦══╝         ┌──┴──┐  ┌中口─┴─南口┘
 *   T出生─┬─中路走廊──┤中 路├──┐CT中路
 *    ┌┴──┐          └──┬──┘  └B连接道┐
 *    │南口│      ┌B连接道┘           │
 *   T南通道─B前厅─B西门─┌B点═╗←B东门─CT南厅
 *    └───┴──装卸月台──┴月台║
 *  ============================================================ */
'use strict';

var MAP2 = (function () {

  var GRID = 64;
  var N = 84;
  var ORIGIN = -(N * GRID) / 2;
  var WALL_H = 300;
  var FLOOR_T = 16;

  var walk = new Uint8Array(N * N);
  var navBlk = new Uint8Array(N * N);
  var solids = [];

  /* ================= 房间布局（紧凑 ±1500） =================
   * [名称, x1, z1, x2, z2]；连通房间重叠 ≥50，隔断房间 ≥2 格墙 */
  var ROOMS = [
    // ===== T 出生复合（西）=====
    ['T_SPAWN',    -1500, -350, -1100,  350],
    ['T_N_EXIT',   -1400, -700, -1200, -200],
    ['T_S_EXIT',   -1400,  200, -1200,  700],
    ['MID_UP',     -1150, -150,  -350,  150],   // T 中路走廊（HUD：中路上段）

    // ===== 北线：T → A =====
    ['N_CORR',     -1300, -800,  -650, -500],   // 北走廊
    ['A_HALL',      -700, -1000, -200, -650],   // A 前厅（L 弯）

    // ===== A 包点（西北，半高位）=====
    ['A_SITE',      -750, -1250, -150, -850],
    ['A_ENT_W',     -600,  -950, -350, -800],   // 西门（A 前厅 →）
    ['A_ENT_S',     -450,  -900, -300, -600],   // 南门（A 连接道 →）
    ['A_ENT_E',     -300, -1150,  100, -900],   // 东门（CT 北厅 →）
    ['A_CONNECT',   -450,  -650, -300, -300],   // A 连接道（通中路）

    // ===== 中路 =====
    ['MID_LOW',      -350, -350,   350,  350],  // 中央大厅（HUD：中路）
    ['MID_LINK_W',   -600, -350,  -300, -150],  // 大厅 ↔ A 连接道
    ['MID_LINK_E',    300,  150,   600,  350],  // 大厅 ↔ B 连接道

    // ===== B 连接道（中路 → B 北门）=====
    ['B_CONNECT',    450,   300,   600,  850],

    // ===== 南线：T → B =====
    ['S_CORR',     -1300,   500,  -300,  800],  // T 南通道
    ['B_HALL',      -350,   700,     0, 1000],  // B 前厅（L 弯）

    // ===== B 包点（东南，装卸月台）=====
    ['B_SITE',       350,   850,   850, 1250],
    ['B_ENT_W',       -50,   900,   400, 1100], // 西门（B 前厅 →）
    ['B_ENT_E',       800,   900,  1050, 1100], // 东门（CT 南厅 →）

    // ===== CT 出生复合（东，居中枢纽：到两点都快）=====
    ['CT_SPAWN',    1050,  -350,  1450,  350],
    ['CT_MID',       300,  -150,  1100,  150],  // CT 中路（HUD：CT 中路）
    ['CT_N_EXIT',   1150,  -600,  1350, -200],
    ['CT_S_EXIT',   1150,   200,  1350,  600],

    // ===== CT 旋转走廊（短回防）=====
    ['CT_N_HALL',    500,  -800,  1300, -500],  // 北厅
    ['CT_TO_A',        0, -1000,   550, -700],  // 北厅 ↔ A 东门
    ['CT_S_HALL',    700,   500,  1300,  750],  // 南厅
    ['CT_B_LINK',    800,   700,  1050,  950],  // 南厅 ↔ B 东门
  ];

  /* ================= 道具 =================
   * h ≤ 48：玩家可跳上（跳跃 52.5），楼梯 16 级自动上步
   * h ≥ 48：阻断寻路（bot 爬不上，绕行；否则顶在边上卡死） */
  var PROPS = [];

  function P(x, z, w, d, h, mat, tint, y) {
    PROPS.push({ x: x, z: z, w: w, d: d, h: h, mat: mat, tint: tint || [1, 1, 1], y: y || 0 });
  }

  /* 楼梯：从 (x,z)（最低一级中心）朝 [dx,dz] 上升到 48，3 级 × 16 高 */
  function stairs(x, z, across, dx, dz, mat) {
    for (var i = 0; i < 3; i++) {
      var h = 16 * (i + 1);
      var sx = x + dx * 48 * i, sz = z + dz * 48 * i;
      if (dx !== 0) P(sx, sz, 48, across, h, mat || 'metal');
      else P(sx, sz, across, 48, h, mat || 'metal');
    }
  }

  (function buildProps() {
    var MT = [0.44, 0.46, 0.50];   // 钢架灰蓝
    var CR = [1, 1, 1];            // 木箱原色
    var RS = [0.62, 0.50, 0.34];   // 锈蚀橙棕
    var DK = [0.58, 0.57, 0.53];   // 月台水泥

    // ===== T 出生区 =====
    P(-1180, 0, 64, 64, 128, 'rust', RS);           // 中央集装箱（挡出生直视中路）
    P(-1300, -450, 80, 48, 64, 'crate', CR);        // 北出口旁木箱
    P(-1300, 450, 80, 48, 64, 'crate', CR);         // 南出口旁木箱

    // ===== T 中路门框（与 CT 门框错开，切断出生点对出生点直视线）=====
    P(-750, -95, 48, 110, 160, 'metal', MT);        // 挡南侧 + 中侧，留北缝隙
    P(-750, 95, 48, 110, 160, 'metal', MT);

    // ===== 北走廊货架 zigzag =====
    P(-1050, -730, 48, 90, 112, 'metal', MT);
    P(-850, -570, 48, 90, 112, 'metal', MT);

    // ===== A 前厅 =====
    P(-450, -820, 80, 80, 64, 'crate', CR);

    // ===== A 包点：北半场 48 高位平台 + 楼梯 + 掩体 =====
    P(-450, -1050, 480, 192, 48, 'dock', DK);       // 平台 z -1146..-954
    stairs(-450, -834, 128, 0, -1, 'metal');        // 由南向北上台（末级接平台南缘）
    P(-560, -1080, 80, 80, 64, 'crate', CR, 48);    // 平台顶木箱
    P(-320, -1060, 64, 64, 112, 'metal', MT, 48);   // 平台顶货架
    P(-250, -900, 80, 64, 64, 'crate', CR);         // 点内地面木箱
    P(-680, -900, 64, 64, 128, 'rust', RS);         // 西南角集装箱

    // ===== A 连接道 =====
    P(-375, -475, 48, 64, 64, 'metal', MT);

    // ===== 中央大厅：双层集装箱挡中央视线 + 两侧观察台 =====
    P(0, 0, 192, 96, 64, 'rust', RS);
    P(0, 0, 128, 96, 64, 'rust', RS, 64);           // 叠一层（总 128 完全挡视线）
    P(-270, 230, 112, 112, 48, 'dock', DK);         // 西观察台 z 174..286
    stairs(-270, 54, 96, 0, 1, 'metal');            // 由北向南上台（末级 126..174 正接平台北缘）
    P(270, -230, 112, 112, 48, 'dock', DK);         // 东观察台
    stairs(270, -102, 96, 0, -1, 'metal');          // 由南向北上台
    P(-310, -310, 72, 72, 64, 'crate', CR);
    P(310, 310, 72, 72, 64, 'crate', CR);

    // ===== CT 中路门框（与 T 门框错开）=====
    P(750, -40, 48, 80, 160, 'metal', MT);          // 挡中侧 + 南侧，留北缝隙
    P(750, 40, 48, 80, 160, 'metal', MT);

    // ===== B 连接道 =====
    P(520, 560, 44, 80, 64, 'metal', MT);

    // ===== T 南通道 =====
    P(-1050, 650, 88, 44, 64, 'crate', CR);
    P(-750, 650, 88, 44, 64, 'crate', CR);
    P(-500, 650, 60, 60, 96, 'metal', MT);

    // ===== B 前厅 =====
    P(-180, 850, 72, 72, 64, 'crate', CR);

    // ===== B 包点：东侧装卸月台 48 + 楼梯 + 掩体 =====
    P(650, 1050, 320, 192, 48, 'dock', DK);         // 月台 z 954..1146
    stairs(660, 834, 100, 0, 1, 'metal');           // 由北向南上月台（不堵 B 连接道口）
    P(420, 1000, 72, 72, 64, 'crate', CR);          // 点内地面木箱
    P(420, 1180, 64, 64, 128, 'rust', RS);          // 西南角集装箱（挡西门远角视线）
    P(700, 1100, 72, 72, 64, 'crate', CR, 48);      // 月台顶木箱

    // ===== 装卸车（叉车）×2 =====
    P(-450, -730, 110, 50, 80, 'rust', RS);         // 北走廊末端
    P(-450, -730, 22, 26, 110, 'rust', [0.4, 0.32, 0.22], 80);
    P(180, 1000, 110, 50, 80, 'rust', RS);          // B 西门内
    P(180, 1000, 22, 26, 110, 'rust', [0.4, 0.32, 0.22], 80);

    // ===== CT 旋转走廊掩体 =====
    P(350, -850, 72, 48, 64, 'crate', CR);          // CT→A 通道
    P(950, -650, 72, 48, 64, 'crate', CR);          // CT 北厅
    P(950, 600, 72, 48, 64, 'crate', CR);           // CT 南厅

    // ===== CT 出生区 =====
    P(1200, -250, 80, 48, 64, 'crate', CR);
    P(1200, 250, 80, 48, 64, 'crate', CR);
  })();

  var SPAWNS = {
    T: [[-1400, -250], [-1400, 0], [-1400, 250], [-1250, -200], [-1250, 200],
        [-1460, -250], [-1460, 0], [-1460, 250], [-1320, -150], [-1320, 150]],
    CT: [[1350, -250], [1350, 0], [1350, 250], [1250, -200], [1250, 200],
         [1100, -250], [1100, 0], [1100, 250], [1400, -250], [1400, 250]]
  };

  var SITES = [
    { name: 'A', x: -450, z: -1050, r: 280, my: 50.2 },   // my：标记高度（A 中心在 48 平台上）
    { name: 'B', x: 600, z: 1050, r: 280, my: 50.2 },
  ];

  var AREAS = [];

  function cx(x) { return Math.floor((x - ORIGIN) / GRID); }
  function cz(z) { return Math.floor((z - ORIGIN) / GRID); }
  function wx(i) { return ORIGIN + i * GRID + GRID / 2; }
  function wz(j) { return ORIGIN + j * GRID + GRID / 2; }
  function idx(i, j) { return j * N + i; }
  function inGrid(i, j) { return i >= 0 && j >= 0 && i < N && j < N; }
  function isWalk(i, j) { return inGrid(i, j) && walk[idx(i, j)] === 1; }
  function isNav(i, j) { return inGrid(i, j) && walk[idx(i, j)] === 1 && navBlk[idx(i, j)] === 0; }
  function isWalkWorld(x, z) { return isWalk(cx(x), cz(z)); }

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

  /* 与 map.js 相同的绕序修正版：顶/底面 ua/va 交换，
   * 保证顶面法线朝 +Y（否则从上看是背面被剔除 = 「顶部没贴图」） */
  var FACES = [
    { n: [1, 0, 0], o: [1, 0, 0], ua: [0, 0, -1], va: [0, 1, 0] },
    { n: [-1, 0, 0], o: [-1, 0, 0], ua: [0, 0, 1], va: [0, 1, 0] },
    { n: [0, 1, 0], o: [0, 1, 0], ua: [0, 0, 1], va: [1, 0, 0] },
    { n: [0, -1, 0], o: [0, -1, 0], ua: [0, 0, -1], va: [1, 0, 0] },
    { n: [0, 0, 1], o: [0, 0, 1], ua: [1, 0, 0], va: [0, 1, 0] },
    { n: [0, 0, -1], o: [0, 0, -1], ua: [-1, 0, 0], va: [0, 1, 0] }
  ];

  /* 侧面进 gSide、顶面进 gTop（独立缓冲 → 顶面独立材质 + 全亮着色） */
  function pushBox(gSide, gTop, b, texSize, tint) {
    var cxx = (b.x1 + b.x2) / 2, cyy = (b.y1 + b.y2) / 2, czz = (b.z1 + b.z2) / 2;
    var hx = (b.x2 - b.x1) / 2, hy = (b.y2 - b.y1) / 2, hz = (b.z2 - b.z1) / 2;
    for (var f = 0; f < 6; f++) {
      var F = FACES[f];
      if (F.n[1] === -1) continue;                      // 底面不渲染（避免叠箱 Z-fighting）
      var ex = F.o[0] * hx, ey = F.o[1] * hy, ez = F.o[2] * hz;
      var ux = F.ua[0] * hx, uy = F.ua[1] * hy, uz = F.ua[2] * hz;
      var vx = F.va[0] * hx, vy = F.va[1] * hy, vz = F.va[2] * hz;
      var uLen = Math.abs(ux) + Math.abs(uy) + Math.abs(uz);
      var vLen = Math.abs(vx) + Math.abs(vy) + Math.abs(vz);
      var us = texSize > 0 ? (uLen * 2) / texSize : 1;
      var vs = texSize > 0 ? (vLen * 2) / texSize : 1;
      var isTop = F.n[1] === 1;
      var shade = isTop ? 1.0 : 0.92;
      var g = isTop ? gTop : gSide;
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

  function GeoBuf() { this.p = []; this.n = []; this.u = []; this.c = []; }

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

  function addSolid(b) { solids.push(b); }

  function build(scene, tex) {
    solids.length = 0;
    walk.fill(0);
    navBlk.fill(0);
    AREAS.length = 0;

    // 1. 可行走区域
    for (var r = 0; r < ROOMS.length; r++) {
      var R = ROOMS[r];
      var x1 = R[1], z1 = R[2], x2 = R[3], z2 = R[4];
      var ci0 = Math.max(0, cx(x1)), ci1 = Math.min(N - 1, cx(x2 - 1));
      var cj0 = Math.max(0, cz(z1)), cj1 = Math.min(N - 1, cz(z2 - 1));
      for (var j = cj0; j <= cj1; j++) for (var i = ci0; i <= ci1; i++) walk[idx(i, j)] = 1;
      AREAS.push({ name: R[0], x1: x1, z1: z1, x2: x2, z2: z2, cx: (x1 + x2) / 2, cz: (z1 + z2) / 2 });
    }

    // 2. 水泥地面（包点铺石板）——顶面独立缓冲
    var floorRects = mergeRects(walk);
    var gFloor = new GeoBuf(), gFloorTop = new GeoBuf();
    var gFloorStone = new GeoBuf(), gFloorStoneTop = new GeoBuf();
    for (r = 0; r < floorRects.length; r++) {
      var fr = floorRects[r];
      var b = {
        x1: ORIGIN + fr[0] * GRID, x2: ORIGIN + (fr[0] + fr[2]) * GRID,
        z1: ORIGIN + fr[1] * GRID, z2: ORIGIN + (fr[1] + fr[3]) * GRID,
        y1: -FLOOR_T, y2: 0
      };
      var mx = (b.x1 + b.x2) / 2, mz = (b.z1 + b.z2) / 2;
      var stone = false;
      for (var s2 = 0; s2 < SITES.length; s2++) {
        var S = SITES[s2];
        if (Math.abs(mx - S.x) < S.r * 0.85 && Math.abs(mz - S.z) < S.r * 0.85) stone = true;
      }
      pushBox(stone ? gFloorStone : gFloor, stone ? gFloorStoneTop : gFloorTop, b,
        stone ? 160 : 192, stone ? [0.62, 0.62, 0.62] : [0.58, 0.58, 0.55]);
      addSolid({ x1: b.x1, y1: -400, z1: b.z1, x2: b.x2, y2: 0, z2: b.z2, kind: 'floor' });
    }
    scene.add(makeMesh(gFloor, tex.concrete, 'floor2'));
    scene.add(makeMesh(gFloorTop, tex.concrete, 'floor2Top'));
    scene.add(makeMesh(gFloorStone, tex.stone, 'floorStone2'));
    scene.add(makeMesh(gFloorStoneTop, tex.stone, 'floorStone2Top'));

    // 兜底地面
    var baseFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(N * GRID + 4000, N * GRID + 4000),
      new THREE.MeshLambertMaterial({ map: tex.concrete.clone(), color: 0x767672 })
    );
    baseFloor.material.map.wrapS = baseFloor.material.map.wrapT = THREE.RepeatWrapping;
    baseFloor.material.map.repeat.set(48, 48);
    baseFloor.material.map.needsUpdate = true;
    baseFloor.rotation.x = -Math.PI / 2;
    baseFloor.position.y = -4;
    scene.add(baseFloor);

    // 3. 波纹铁皮墙
    var wallMask = new Uint8Array(N * N);
    for (j = 0; j < N; j++) for (i = 0; i < N; i++) {
      if (walk[idx(i, j)]) continue;
      var near = false;
      for (var dj = -1; dj <= 1 && !near; dj++) for (var di = -1; di <= 1; di++) {
        if (isWalk(i + di, j + dj)) { near = true; break; }
      }
      if (near) wallMask[idx(i, j)] = 1;
    }
    var gWall = new GeoBuf(), gWallTop = new GeoBuf();
    var wallRects = mergeRects(wallMask);
    for (r = 0; r < wallRects.length; r++) {
      var wr = wallRects[r];
      var wb = {
        x1: ORIGIN + wr[0] * GRID, x2: ORIGIN + (wr[0] + wr[2]) * GRID,
        z1: ORIGIN + wr[1] * GRID, z2: ORIGIN + (wr[1] + wr[3]) * GRID,
        y1: -FLOOR_T, y2: WALL_H
      };
      var v = 0.55 + (r % 5) * 0.03;
      pushBox(gWall, gWallTop, wb, 96, [v * 0.82, v * 0.84, v * 0.88]);
      addSolid({ x1: wb.x1, y1: -FLOOR_T, z1: wb.z1, x2: wb.x2, y2: WALL_H + 18, z2: wb.z2, kind: 'wall' });
    }
    scene.add(makeMesh(gWall, tex.ironWall, 'walls2'));
    scene.add(makeMesh(gWallTop, tex.metal, 'wallTops2'));

    // 4. 道具：侧面/顶面独立缓冲
    var gCrateS = new GeoBuf(), gCrateT = new GeoBuf();
    var gMetalS = new GeoBuf(), gMetalT = new GeoBuf();
    var gRustS = new GeoBuf(), gRustT = new GeoBuf();
    var gDockS = new GeoBuf(), gDockT = new GeoBuf();
    for (r = 0; r < PROPS.length; r++) {
      var Pp = PROPS[r], y0 = Pp.y || 0;
      var tint = Pp.tint || [1, 1, 1];
      var pb = {
        x1: Pp.x - Pp.w / 2, x2: Pp.x + Pp.w / 2,
        z1: Pp.z - Pp.d / 2, z2: Pp.z + Pp.d / 2,
        y1: y0, y2: y0 + Pp.h
      };
      var gs, gt, ts;
      if (Pp.mat === 'crate') { gs = gCrateS; gt = gCrateT; ts = 192; }
      else if (Pp.mat === 'rust') { gs = gRustS; gt = gRustT; ts = 128; }
      else if (Pp.mat === 'dock') { gs = gDockS; gt = gDockT; ts = 128; }
      else { gs = gMetalS; gt = gMetalT; ts = 128; }
      pushBox(gs, gt, pb, ts, tint);
      addSolid({ x1: pb.x1, y1: pb.y1, z1: pb.z1, x2: pb.x2, y2: pb.y2, z2: pb.z2, kind: 'prop' });
      /* ≥48 的箱体 bot 爬不上（跳跃 52.5 / 自动上步 20）→ 阻断寻路防卡死 */
      if (Pp.h + y0 >= 48) {
        var bi0 = cx(pb.x1), bi1 = cx(pb.x2 - 1), bj0 = cz(pb.z1), bj1 = cz(pb.z2 - 1);
        for (j = bj0; j <= bj1; j++) for (i = bi0; i <= bi1; i++) if (inGrid(i, j)) navBlk[idx(i, j)] = 1;
      }
    }
    scene.add(makeMesh(gCrateS, tex.crate, 'crates2'));
    scene.add(makeMesh(gCrateT, tex.crate, 'crates2Top'));
    scene.add(makeMesh(gMetalS, tex.metal, 'steelProps2'));
    scene.add(makeMesh(gMetalT, tex.metal, 'steelProps2Top'));
    scene.add(makeMesh(gRustS, tex.rustPlate, 'rustProps2'));
    scene.add(makeMesh(gRustT, tex.rustPlate, 'rustProps2Top'));
    scene.add(makeMesh(gDockS, tex.metal, 'dock2'));
    scene.add(makeMesh(gDockT, tex.metal, 'dock2Top'));

    // 5. 远景天际线（仓库群轮廓）
    var gFar = new GeoBuf(), gFarTop = new GeoBuf();
    var farSeed = 98765;
    function fr2() { farSeed = (farSeed * 16807) % 2147483647; return farSeed / 2147483647; }
    for (r = 0; r < 20; r++) {
      var ang = fr2() * Math.PI * 2, dist = 2200 + fr2() * 1600;
      var fx = Math.cos(ang) * dist, fz = Math.sin(ang) * dist;
      var fw = 400 + fr2() * 500, fd = 400 + fr2() * 500, fh = 120 + fr2() * 280;
      pushBox(gFar, gFarTop, { x1: fx - fw / 2, x2: fx + fw / 2, z1: fz - fd / 2, z2: fz + fd / 2, y1: -200, y2: fh }, 96,
        [0.35, 0.36, 0.38]);
    }
    scene.add(makeMesh(gFar, tex.ironWall, 'skyline2'));
    scene.add(makeMesh(gFarTop, tex.metal, 'skyline2Top'));

    // 6. 包点标记
    for (r = 0; r < SITES.length; r++) addSiteMarker(scene, SITES[r]);

    return { solids: solids.length };
  }

  function addSiteMarker(scene, site) {
    var c = document.createElement('canvas'); c.width = c.height = 256;
    var x = c.getContext('2d');
    x.clearRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(100,180,255,.85)'; x.lineWidth = 8;
    x.setLineDash([26, 18]);
    x.strokeRect(14, 14, 228, 228);
    x.setLineDash([]);
    x.fillStyle = 'rgba(100,180,255,.5)';
    x.font = 'bold 150px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(site.name, 128, 138);
    var t = new THREE.CanvasTexture(c);
    var m = new THREE.Mesh(
      new THREE.PlaneGeometry(site.r * 1.7, site.r * 1.7),
      new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(site.x, site.my || 1.2, site.z);   // 平台上的标记抬到平台之上
    m.renderOrder = 1;
    scene.add(m);
  }

  function query(x1, y1, z1, x2, y2, z2, out) {
    out.length = 0;
    for (var i = 0; i < solids.length; i++) {
      var b = solids[i];
      if (b.x2 <= x1 || b.x1 >= x2 || b.y2 <= y1 || b.y1 >= y2 || b.z2 <= z1 || b.z1 >= z2) continue;
      out.push(b);
    }
    return out;
  }
  var qBuf = [];
  function traceRay(ox, oy, oz, dx, dy, dz, maxDist, hitOut) {
    var ex = ox + dx * maxDist, ey = oy + dy * maxDist, ez = oz + dz * maxDist;
    var list = query(Math.min(ox, ex) - 1, Math.min(oy, ey) - 1, Math.min(oz, ez) - 1,
                     Math.max(ox, ex) + 1, Math.max(oy, ey) + 1, Math.max(oz, ez) + 1, qBuf);
    var best = maxDist, found = false;
    for (var i = 0; i < list.length; i++) {
      var t = rayBox(ox, oy, oz, dx, dy, dz, list[i], best);
      if (t >= 0 && t < best) { best = t; found = true; }
    }
    if (!found) return null;
    if (!hitOut) hitOut = {};
    hitOut.dist = best;
    hitOut.x = ox + dx * best; hitOut.y = oy + dy * best; hitOut.z = oz + dz * best;
    return hitOut;
  }
  function rayBox(ox, oy, oz, dx, dy, dz, b, maxT) {
    var tmin = 0, tmax = maxT;
    if (Math.abs(dx) < 1e-8) { if (ox < b.x1 || ox > b.x2) return -1; }
    else { var inv = 1 / dx, t1 = (b.x1 - ox) * inv, t2 = (b.x2 - ox) * inv; if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
    if (Math.abs(dy) < 1e-8) { if (oy < b.y1 || oy > b.y2) return -1; }
    else { var inv = 1 / dy, t1 = (b.y1 - oy) * inv, t2 = (b.y2 - oy) * inv; if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
    if (Math.abs(dz) < 1e-8) { if (oz < b.z1 || oz > b.z2) return -1; }
    else { var inv = 1 / dz, t1 = (b.z1 - oz) * inv, t2 = (b.z2 - oz) * inv; if (t1 > t2) { var tt = t1; t1 = t2; t2 = tt; } tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2); if (tmin > tmax) return -1; }
    return tmin;
  }
  function losBlocked(ax, ay, az, bx, by, bz) {
    var dx = bx - ax, dy = by - ay, dz = bz - az;
    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < 1) return false;
    var h = traceRay(ax, ay, az, dx / d, dy / d, dz / d, d - 2, {});
    return !!h;
  }

  function nearestOpen(x, z) {
    if (isNav(cx(x), cz(z))) return [x, z];
    for (var r = 1; r < 8; r++) {
      for (var dj = -r; dj <= r; dj++) for (var di = -r; di <= r; di++) {
        if (Math.abs(di) !== r && Math.abs(dj) !== r) continue;
        if (isNav(cx(x) + di, cz(z) + dj)) return [wx(cx(x) + di), wz(cz(z) + dj)];
      }
    }
    return [x, z];
  }
  function areaAt(x, z) {
    for (var i = 0; i < AREAS.length; i++) {
      if (x >= AREAS[i].x1 && x <= AREAS[i].x2 && z >= AREAS[i].z1 && z <= AREAS[i].z2) return AREAS[i].name;
    }
    return '';
  }
  function siteAt(x, z) {
    for (var i = 0; i < SITES.length; i++) {
      if (Math.abs(x - SITES[i].x) < SITES[i].r && Math.abs(z - SITES[i].z) < SITES[i].r) return SITES[i];
    }
    return null;
  }
  var BUY_ZONES = { T: [-1500, -350, -1100, 350], CT: [1050, -350, 1450, 350] };
  function inBuyZone(team, x, z) {
    var b = BUY_ZONES[team];
    return !!b && x > b[0] && x < b[2] && z > b[1] && z < b[3];
  }
  function safeSpawn(x, z, probe) {
    if (!probe(x, z)) return [x, z];
    for (var r = 1; r <= 6; r++) {
      for (var a = 0; a < 12; a++) {
        var ang = (a / 12) * Math.PI * 2 + r * 0.31;
        var nx = x + Math.cos(ang) * 36 * r, nz = z + Math.sin(ang) * 36 * r;
        if (isWalkWorld(nx, nz) && !probe(nx, nz)) return [nx, nz];
      }
    }
    return [x, z];
  }

  /* ================= 全图等比放大 18%（仅 X/Z 平面） =================
   * 高度体系（16/32/48/64 的台阶与跳跃判定）不参与缩放；
   * 布局坐标、道具占地、出生点、包点半径、购买区统一 ×1.18。
   * 房间间的贴合边界按同比例缩放，连通关系与缝隙关系保持不变。 */
  var SCALE = 1.18;
  (function scaleLayout() {
    var i, k;
    for (i = 0; i < ROOMS.length; i++) {
      ROOMS[i][1] = Math.round(ROOMS[i][1] * SCALE);
      ROOMS[i][2] = Math.round(ROOMS[i][2] * SCALE);
      ROOMS[i][3] = Math.round(ROOMS[i][3] * SCALE);
      ROOMS[i][4] = Math.round(ROOMS[i][4] * SCALE);
    }
    for (i = 0; i < PROPS.length; i++) {
      var pp = PROPS[i];
      pp.x = Math.round(pp.x * SCALE); pp.z = Math.round(pp.z * SCALE);
      pp.w = Math.round(pp.w * SCALE); pp.d = Math.round(pp.d * SCALE);
    }
    ['T', 'CT'].forEach(function (tm) {
      for (i = 0; i < SPAWNS[tm].length; i++) {
        SPAWNS[tm][i][0] = Math.round(SPAWNS[tm][i][0] * SCALE);
        SPAWNS[tm][i][1] = Math.round(SPAWNS[tm][i][1] * SCALE);
      }
    });
    for (i = 0; i < SITES.length; i++) {
      SITES[i].x = Math.round(SITES[i].x * SCALE);
      SITES[i].z = Math.round(SITES[i].z * SCALE);
      SITES[i].r = Math.round(SITES[i].r * SCALE);
    }
    for (k in BUY_ZONES) {
      BUY_ZONES[k][0] = Math.round(BUY_ZONES[k][0] * SCALE);
      BUY_ZONES[k][1] = Math.round(BUY_ZONES[k][1] * SCALE);
      BUY_ZONES[k][2] = Math.round(BUY_ZONES[k][2] * SCALE);
      BUY_ZONES[k][3] = Math.round(BUY_ZONES[k][3] * SCALE);
    }
  })();

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
