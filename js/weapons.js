/* ============================================================
 *  weapons.js — 武器数据 / 后坐力模型 / 购买表 / 第一人称模型
 *  角度单位为弧度；散布与后坐力参考 CS1.6 手感重新标定
 * ============================================================ */
'use strict';

var WEAPONS = (function () {

  /* -------- 武器数值 --------
   * spread       静止基础散布
   * moveSpread   满速移动附加散布
   * airSpread    腾空附加散布
   * crouchMul    下蹲散布系数
   * perShot      每发累加的散布惩罚（连发越久越散）
   * spreadMax    散布惩罚上限
   * recover      散布惩罚恢复速度（弧度/秒）
   * recoilV/H    每发视角上抬 / 左右抖动
   * ramp         连发后坐力放大系数（第 n 发 ≈ 1 + n*ramp）
   */
  var defs = {
    /* ------------ 手枪 ------------ */
    glock: {
      id: 'glock', name: 'Glock-18', kind: 'pistol', team: 'T', auto: false,
      dmg: 27, hsMul: 4.0, armorPen: 0.47, rpm: 400, mag: 20, reserve: 120,
      reloadTime: 2.1, range: 4096, sound: 'pistol',
      spread: 0.0030, moveSpread: 0.045, airSpread: 0.10, crouchMul: 0.78,
      perShot: 0.0050, spreadMax: 0.038, recover: 0.34,
      recoilV: 0.0080, recoilH: 0.0035, ramp: 0.10, kickBack: 1.2,
      price: 400, kill: 300, slot: 'secondary'
    },
    usp: {
      id: 'usp', name: 'USP45', kind: 'pistol', team: 'CT', auto: false,
      dmg: 34, hsMul: 4.0, armorPen: 0.50, rpm: 400, mag: 12, reserve: 100,
      reloadTime: 2.1, range: 4096, sound: 'pistol',
      spread: 0.0028, moveSpread: 0.042, airSpread: 0.10, crouchMul: 0.76,
      perShot: 0.0060, spreadMax: 0.040, recover: 0.34,
      recoilV: 0.0100, recoilH: 0.0040, ramp: 0.12, kickBack: 1.4,
      price: 500, kill: 300, slot: 'secondary'
    },
    deagle: {
      id: 'deagle', name: 'Desert Eagle', kind: 'pistol', auto: false,
      dmg: 54, hsMul: 4.0, armorPen: 0.62, rpm: 267, mag: 7, reserve: 35,
      reloadTime: 2.2, range: 4096, sound: 'pistol',
      spread: 0.0032, moveSpread: 0.060, airSpread: 0.12, crouchMul: 0.74,
      perShot: 0.0120, spreadMax: 0.055, recover: 0.30,
      recoilV: 0.0240, recoilH: 0.0080, ramp: 0.16, kickBack: 3.0,
      price: 650, kill: 300, slot: 'secondary'
    },
    /* ------------ 冲锋枪 / 霰弹枪 ------------ */
    mp5: {
      id: 'mp5', name: 'MP5 Navy', kind: 'smg', auto: true,
      dmg: 26, hsMul: 4.0, armorPen: 0.56, rpm: 750, mag: 30, reserve: 120,
      reloadTime: 2.6, range: 6000, sound: 'rifle',
      spread: 0.0035, moveSpread: 0.030, airSpread: 0.075, crouchMul: 0.80,
      perShot: 0.0035, spreadMax: 0.060, recover: 0.38,
      recoilV: 0.0050, recoilH: 0.0030, ramp: 0.07, kickBack: 1.2,
      price: 1500, kill: 600, slot: 'primary'
    },
    m3: {
      id: 'm3', name: 'M3 霰弹枪', kind: 'shotgun', auto: false,
      dmg: 22, hsMul: 3.0, armorPen: 0.50, rpm: 70, mag: 8, reserve: 32,
      reloadTime: 3.4, range: 3000, sound: 'shotgun', pellets: 9,
      spread: 0.055, moveSpread: 0.020, airSpread: 0.040, crouchMul: 0.9,
      perShot: 0.0, spreadMax: 0.0, recover: 0.5,
      recoilV: 0.0220, recoilH: 0.0070, ramp: 0.0, kickBack: 4.2,
      price: 1700, kill: 900, slot: 'primary'
    },
    /* ------------ 步枪 ------------ */
    galil: {
      id: 'galil', name: 'Galil', kind: 'rifle', team: 'T', auto: true,
      dmg: 30, hsMul: 4.0, armorPen: 0.775, rpm: 666, mag: 35, reserve: 90,
      reloadTime: 2.6, range: 8192, sound: 'rifle',
      spread: 0.0020, moveSpread: 0.050, airSpread: 0.090, crouchMul: 0.72,
      perShot: 0.0052, spreadMax: 0.082, recover: 0.30,
      recoilV: 0.0085, recoilH: 0.0048, ramp: 0.11, kickBack: 1.8,
      price: 2000, kill: 300, slot: 'primary'
    },
    famas: {
      id: 'famas', name: 'FAMAS', kind: 'rifle', team: 'CT', auto: true,
      dmg: 30, hsMul: 4.0, armorPen: 0.70, rpm: 666, mag: 25, reserve: 90,
      reloadTime: 2.5, range: 8192, sound: 'rifle',
      spread: 0.0019, moveSpread: 0.048, airSpread: 0.088, crouchMul: 0.72,
      perShot: 0.0046, spreadMax: 0.072, recover: 0.32,
      recoilV: 0.0075, recoilH: 0.0042, ramp: 0.10, kickBack: 1.7,
      price: 2250, kill: 300, slot: 'primary'
    },
    ak47: {
      id: 'ak47', name: 'AK-47', kind: 'rifle', team: 'T', auto: true,
      dmg: 36, hsMul: 4.0, armorPen: 0.775, rpm: 600, mag: 30, reserve: 90,
      reloadTime: 2.45, range: 8192, sound: 'rifle',
      spread: 0.0018, moveSpread: 0.055, airSpread: 0.095, crouchMul: 0.70,
      perShot: 0.0055, spreadMax: 0.085, recover: 0.30,
      recoilV: 0.0095, recoilH: 0.0050, ramp: 0.12, kickBack: 2.1,
      price: 2500, kill: 300, slot: 'primary'
    },
    m4a1: {
      id: 'm4a1', name: 'M4A1', kind: 'rifle', team: 'CT', auto: true,
      dmg: 32, hsMul: 4.0, armorPen: 0.70, rpm: 666, mag: 30, reserve: 90,
      reloadTime: 2.35, range: 8192, sound: 'rifle',
      spread: 0.0016, moveSpread: 0.048, airSpread: 0.088, crouchMul: 0.70,
      perShot: 0.0042, spreadMax: 0.068, recover: 0.32,
      recoilV: 0.0072, recoilH: 0.0038, ramp: 0.10, kickBack: 1.7,
      price: 3100, kill: 300, slot: 'primary'
    },
    awp: {
      id: 'awp', name: 'AWP', kind: 'sniper', auto: false, scope: true,
      dmg: 115, hsMul: 4.0, armorPen: 0.975, rpm: 41, mag: 10, reserve: 30,
      reloadTime: 3.6, range: 8192, sound: 'awp',
      spread: 0.0006, moveSpread: 0.180, airSpread: 0.260, crouchMul: 0.6,
      perShot: 0.0200, spreadMax: 0.090, recover: 0.28,
      recoilV: 0.0350, recoilH: 0.0100, ramp: 0.0, kickBack: 5.5,
      price: 4750, kill: 100, slot: 'primary'
    },
    /* ------------ 近战 ------------ */
    knife: {
      id: 'knife', name: '匕首', kind: 'knife', auto: false,
      dmg: 55, hsMul: 1.6, armorPen: 0.85, rpm: 130, mag: -1, reserve: -1,
      reloadTime: 0, range: 60, sound: 'knife',
      spread: 0, moveSpread: 0, airSpread: 0, crouchMul: 1,
      perShot: 0, spreadMax: 0, recover: 1,
      recoilV: 0.002, recoilH: 0.001, ramp: 0, kickBack: 0.8,
      price: 0, kill: 1500, slot: 'knife'
    },
    /* ------------ 投掷物 ------------ */
    he: {
      id: 'he', name: '高爆手雷', kind: 'grenade', gren: 'he',
      dmg: 98, radius: 380, fuse: 2.4, mag: -1, reserve: -1, rpm: 60,
      reloadTime: 0, range: 0, sound: 'none', hsMul: 1, armorPen: 0.5,
      spread: 0, moveSpread: 0, airSpread: 0, crouchMul: 1,
      perShot: 0, spreadMax: 0, recover: 1, recoilV: 0, recoilH: 0, ramp: 0, kickBack: 1.5,
      price: 300, kill: 300, slot: 'grenade', maxCarry: 1
    },
    flash: {
      id: 'flash', name: '闪光弹', kind: 'grenade', gren: 'flash',
      dmg: 0, radius: 1500, fuse: 1.8, mag: -1, reserve: -1, rpm: 60,
      reloadTime: 0, range: 0, sound: 'none', hsMul: 1, armorPen: 0.5,
      spread: 0, moveSpread: 0, airSpread: 0, crouchMul: 1,
      perShot: 0, spreadMax: 0, recover: 1, recoilV: 0, recoilH: 0, ramp: 0, kickBack: 1.5,
      price: 200, kill: 0, slot: 'grenade', maxCarry: 2
    },
    smoke: {
      id: 'smoke', name: '烟雾弹', kind: 'grenade', gren: 'smoke',
      dmg: 0, radius: 200, fuse: 2.0, mag: -1, reserve: -1, rpm: 60,
      reloadTime: 0, range: 0, sound: 'none', hsMul: 1, armorPen: 0.5,
      spread: 0, moveSpread: 0, airSpread: 0, crouchMul: 1,
      perShot: 0, spreadMax: 0, recover: 1, recoilV: 0, recoilH: 0, ramp: 0, kickBack: 1.5,
      price: 300, kill: 0, slot: 'grenade', maxCarry: 1
    }
  };

  /* -------- 购买菜单（按分类） -------- */
  var BUY = [
    {
      key: '1', label: '手枪', items: [
        { id: 'glock', team: 'T' }, { id: 'usp', team: 'CT' }, { id: 'deagle' }
      ]
    },
    {
      key: '2', label: '冲锋枪 / 霰弹枪', items: [
        { id: 'mp5' }, { id: 'm3' }
      ]
    },
    {
      key: '3', label: '步枪 / 狙击枪', items: [
        { id: 'galil', team: 'T' }, { id: 'famas', team: 'CT' },
        { id: 'ak47', team: 'T' }, { id: 'm4a1', team: 'CT' }, { id: 'awp' }
      ]
    },
    {
      key: '4', label: '装备', items: [
        { id: 'kevlar', name: '防弹衣', price: 650, equip: 'kevlar' },
        { id: 'kevhelm', name: '防弹衣 + 头盔', price: 1000, equip: 'kevhelm' },
        { id: 'defuser', name: '拆弹器', price: 200, equip: 'defuser', team: 'CT' }
      ]
    },
    {
      key: '5', label: '投掷物', items: [
        { id: 'he' }, { id: 'flash' }, { id: 'smoke' }
      ]
    }
  ];

  /* ---------------- 视角模型（方块拼装） ---------------- */
  var M = {};
  function mat(color, shiny) {
    var key = color + '_' + (shiny ? 1 : 0);
    if (!M[key]) {
      M[key] = shiny
        ? new THREE.MeshPhongMaterial({ color: color, shininess: 60, specular: 0x555555 })
        : new THREE.MeshLambertMaterial({ color: color });
    }
    return M[key];
  }
  function box(w, h, d, color, x, y, z, shiny) {
    var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, shiny));
    m.position.set(x, y, z);
    return m;
  }

  var C = {
    metal: 0x2b2b2f, metalLight: 0x4a4a52, wood: 0x6d4a25, woodLight: 0x8a6033,
    plastic: 0x1d1f22, skin: 0xc99a6b, sleeveT: 0x6b5a3c, sleeveCT: 0x3a4a5e,
    mag: 0x3a2f1e, dark: 0x15161a, army: 0x3f4a2e
  };

  function makeHand(sleeveColor, x, y, z, rx, ry, rz) {
    var g = new THREE.Group();
    g.add(box(2.5, 2.2, 4.6, C.skin, 0, 0, 0));
    g.add(box(2.8, 2.5, 4.0, sleeveColor, 0, -0.1, 3.2));
    g.position.set(x, y, z);
    g.rotation.set(rx || 0, ry || 0, rz || 0);
    return g;
  }

  function makeViewModel(id, team) {
    var d = defs[id];
    var root = new THREE.Group();
    var gun = new THREE.Group();
    var muzzle = new THREE.Object3D();
    var sleeve = team === 'T' ? C.sleeveT : C.sleeveCT;

    if (id === 'ak47') {
      gun.add(box(2.0, 2.4, 17, C.metal, 0, 0, -3, true));
      gun.add(box(1.7, 1.7, 12, C.metalLight, 0, 0.5, -13, true));
      gun.add(box(2.4, 2.0, 7, C.wood, 0, -0.6, -9.5));
      gun.add(box(2.2, 2.2, 8, C.wood, 0, -0.3, 8));
      gun.add(box(2.0, 5.0, 3.4, C.mag, 0, -3.0, -1.5));
      gun.add(box(1.6, 3.2, 2.0, C.plastic, 0, -2.6, 3.2));
      gun.add(box(0.5, 1.6, 0.5, C.dark, 0, 1.8, -8));
      gun.add(box(0.6, 1.2, 1.2, C.dark, 0, 1.7, 2.5));
      muzzle.position.set(0, 0.5, -19);
    } else if (id === 'galil') {
      gun.add(box(2.0, 2.4, 16, C.plastic, 0, 0, -3, true));
      gun.add(box(1.6, 1.6, 11, C.metalLight, 0, 0.4, -12.5, true));
      gun.add(box(2.4, 2.2, 7, C.army, 0, -0.5, -9));
      gun.add(box(2.0, 2.2, 7.5, C.army, 0, -0.2, 8));
      gun.add(box(2.0, 5.4, 3.2, C.army, 0, -3.1, -1.2));
      gun.add(box(1.6, 3.2, 2.0, C.plastic, 0, -2.6, 3.2));
      muzzle.position.set(0, 0.4, -18.5);
    } else if (id === 'famas') {
      gun.add(box(2.2, 3.0, 18, C.army, 0, 0, -3, true));
      gun.add(box(1.5, 1.5, 9, C.metalLight, 0, 0.6, -13, true));
      gun.add(box(1.6, 2.4, 5, C.army, 0, 1.9, -1));
      gun.add(box(1.9, 4.4, 3.0, C.plastic, 0, -2.8, -2.0));
      gun.add(box(1.6, 3.2, 2.0, C.plastic, 0, -2.6, 2.6));
      muzzle.position.set(0, 0.6, -18);
    } else if (id === 'm4a1') {
      gun.add(box(2.0, 2.4, 16, C.plastic, 0, 0, -3, true));
      gun.add(box(1.5, 1.5, 13, C.metalLight, 0, 0.4, -13, true));
      gun.add(box(2.6, 2.4, 7.5, C.plastic, 0, -0.4, -10));
      gun.add(box(2.2, 3.0, 7, C.plastic, 0, 0.3, 8));
      gun.add(box(1.9, 4.6, 3.2, C.metal, 0, -2.8, -1.0));
      gun.add(box(1.6, 3.2, 2.0, C.plastic, 0, -2.6, 3.6));
      gun.add(box(1.4, 1.6, 6, C.dark, 0, 1.9, 0));
      muzzle.position.set(0, 0.4, -20);
    } else if (id === 'mp5') {
      gun.add(box(2.0, 2.6, 13, C.plastic, 0, 0, -2, true));
      gun.add(box(1.5, 1.5, 6, C.metalLight, 0, 0.3, -10, true));
      gun.add(box(2.2, 2.0, 5, C.plastic, 0, -0.8, -7));
      gun.add(box(1.8, 2.4, 6.5, C.plastic, 0, 0.2, 6.5));
      gun.add(box(1.8, 6.0, 2.6, C.plastic, 0, -3.4, -1.5));
      gun.add(box(1.6, 3.0, 2.0, C.plastic, 0, -2.6, 2.4));
      muzzle.position.set(0, 0.3, -13.5);
    } else if (id === 'm3') {
      gun.add(box(2.2, 2.6, 17, C.metal, 0, 0, -3, true));
      gun.add(box(1.8, 1.8, 14, C.metalLight, 0, 1.0, -9, true));
      gun.add(box(2.2, 2.0, 7, C.wood, 0, -1.2, -7));
      gun.add(box(2.2, 3.0, 8, C.wood, 0, -0.4, 8));
      gun.add(box(1.6, 3.0, 2.0, C.wood, 0, -2.6, 3.4));
      muzzle.position.set(0, 0.8, -19);
    } else if (id === 'awp') {
      gun.add(box(2.2, 2.6, 20, C.plastic, 0, 0, -4, true));
      gun.add(box(1.6, 1.6, 16, C.metalLight, 0, 0.3, -17, true));
      gun.add(box(2.6, 3.2, 9, C.plastic, 0, -0.4, 9));
      gun.add(box(1.9, 3.4, 2.8, C.metal, 0, -2.4, -2));
      gun.add(box(1.7, 3.0, 2.0, C.plastic, 0, -2.4, 4));
      gun.add(box(2.4, 2.4, 9, C.dark, 0, 2.4, -3, true));
      gun.add(box(2.9, 2.9, 1.2, C.metal, 0, 2.4, -7.6, true));
      muzzle.position.set(0, 0.3, -26);
    } else if (d.kind === 'pistol') {
      var body = id === 'deagle' ? C.metalLight : C.plastic;
      gun.add(box(1.9, 2.4, 10, body, 0, 0, -2, true));
      gun.add(box(1.5, 1.5, 4, C.metalLight, 0, 0.2, -8, true));
      gun.add(box(1.8, 4.4, 2.6, C.plastic, 0, -2.8, 1.6));
      gun.add(box(0.5, 1.2, 0.5, C.dark, 0, 1.6, -6));
      muzzle.position.set(0, 0.2, -10.5);
    } else if (d.kind === 'grenade') {
      var col = d.gren === 'he' ? 0x3e4a30 : (d.gren === 'flash' ? 0x8a8f95 : 0x6a7a4a);
      var body2 = new THREE.Mesh(new THREE.SphereGeometry(2.4, 10, 8), mat(col));
      body2.scale.set(1, 1.25, 1);
      gun.add(body2);
      gun.add(box(1.2, 1.4, 1.2, C.metalLight, 0, 3.0, 0, true));   // 引信
      gun.add(box(0.4, 0.4, 2.4, C.metalLight, 1.0, 3.0, 0.6, true)); // 拉环
      muzzle.position.set(0, 0, -3);
    } else { // 匕首
      gun.add(box(0.5, 2.2, 11, 0xc9ccd2, 0, 0, -5, true));
      gun.add(box(1.4, 1.9, 4.4, C.plastic, 0, -0.1, 1.6));
      gun.add(box(2.2, 0.7, 0.8, C.metal, 0, 0.2, -0.6));
      muzzle.position.set(0, 0, -11);
    }

    gun.add(muzzle);
    root.add(gun);

    // 双手
    if (d.kind === 'knife') {
      root.add(makeHand(sleeve, 1.2, -2.4, 2.0, -0.25, 0.1, 0.2));
    } else if (d.kind === 'grenade') {
      root.add(makeHand(sleeve, 0.2, -2.6, 2.2, -0.2, 0, 0.15));
    } else if (d.kind === 'pistol') {
      root.add(makeHand(sleeve, 0.2, -3.4, 2.0, -0.18, 0, 0.1));
      root.add(makeHand(sleeve, -1.0, -3.0, 0.9, -0.26, 0.45, 0.28));
    } else {
      root.add(makeHand(sleeve, 0.5, -3.4, 2.6, -0.14, 0, 0.05));
      root.add(makeHand(sleeve, -0.9, -3.0, d.kind === 'smg' ? -6.5 : -9.0, -0.1, 0.28, 0.28));
    }

    // 屏幕右下的摆放位置（与 game.js 的 vm.base 联动）
    var base = d.kind === 'knife' ? { x: 4.6, y: -5.0, z: -17 }
      : d.kind === 'grenade' ? { x: 4.4, y: -4.8, z: -15 }
      : d.kind === 'pistol' ? { x: 4.6, y: -5.2, z: -21 }
      : d.kind === 'sniper' ? { x: 4.4, y: -4.6, z: -25 }
      : d.kind === 'smg' ? { x: 4.6, y: -5.0, z: -20 }
      : { x: 4.8, y: -5.0, z: -23 };
    root.position.set(base.x, base.y, base.z);
    root.rotation.set(0.02, 0.04, 0);

    return { root: root, gun: gun, muzzle: muzzle, def: d, base: base };
  }

  function makeShell() {
    return new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.3), mat(0xd8b45a, true));
  }

  /* 世界中的手雷实体外观 */
  function makeGrenadeMesh(gren) {
    var col = gren === 'he' ? 0x3e4a30 : (gren === 'flash' ? 0x8a8f95 : 0x6a7a4a);
    var m = new THREE.Mesh(new THREE.SphereGeometry(4.2, 10, 8), mat(col));
    m.scale.set(1, 1.25, 1);
    return m;
  }

  /* 开局默认配置：只有手枪 + 匕首，其余靠 B 购买菜单花钱买 */
  function loadoutFor(team) {
    return team === 'T' ? ['glock', 'knife'] : ['usp', 'knife'];
  }

  /* 购买项在当前阵营是否可见 */
  function itemForTeam(item, team) { return !item.team || item.team === team; }

  function priceOf(item) {
    return item.price !== undefined ? item.price : defs[item.id].price;
  }
  function nameOf(item) {
    return item.name || defs[item.id].name;
  }

  return {
    defs: defs, BUY: BUY,
    makeViewModel: makeViewModel, makeShell: makeShell, makeGrenadeMesh: makeGrenadeMesh,
    loadoutFor: loadoutFor, itemForTeam: itemForTeam, priceOf: priceOf, nameOf: nameOf,
    COLORS: C
  };
})();
