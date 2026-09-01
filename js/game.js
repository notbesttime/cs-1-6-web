/* ============================================================
 *  game.js — 主循环 / 玩家 / 回合制 / 命中判定 / 特效 / HUD
 * ============================================================ */
'use strict';

var GAME = (function () {

  /* ---------------- 配置 ---------------- */
  var SET = {
    sens: 2.2, fov: 90, volume: 0.7, difficulty: 'normal',
    teamSize: 4, team: 'CT', maxScore: 16, roundTime: 115, bombTime: 40,
    invertStrafe: false,
    // ---- 团队竞技模式新增 ----
    gameMode: 'bomb',          // 'bomb' | 'teamdm'
    map: 'dust2',              // 'dust2' | 'warehouse'
    lives: 20,                 // 团队竞技：队伍击杀目标（20~60）
    loadout: 'ak47',           // 团队竞技：默认主武器
    playerSize: 2              // 联机：每队真人数上限（房间创建时设置）
  };

  /* ---------------- 当前使用的地图模块 ---------------- */
  function getMapModule() {
    if (typeof MAPS !== 'undefined') {
      var m = MAPS.get(SET.map);
      if (m && m.module) return m.module;
    }
    return MAP;  // fallback
  }

  /* 换地图时清空地图分组并重建几何（地板/墙/掩体/远景/包点标记） */
  function rebuildMap() {
    if (!mapGroup) return;
    for (var i = mapGroup.children.length - 1; i >= 0; i--) {
      var c = mapGroup.children[i];
      mapGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
    }
    getMapModule().build(mapGroup, tex);
  }
  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('cs16_settings') || '{}');
      for (var k in s) if (SET.hasOwnProperty(k)) SET[k] = s[k];
    } catch (e) { }
    // VibeHub 持久化
    try {
      if (typeof VIBE !== 'undefined') VIBE.loadSettings();
    } catch (e) { }
  }
  function saveSettings() {
    try { localStorage.setItem('cs16_settings', JSON.stringify(SET)); } catch (e) { }
  }

  /* ---------------- 状态（含团队竞技） ---------------- */
  var renderer, scene, camera, vmScene, vmCam, tex, clock;
  var player, bots = [], all = [], tList = [], ctList = [];
  var running = false, paused = false, started = false;
  var time = 0, lastT = 0;
  var round = 0, score = { T: 0, CT: 0 };
  var phase = 'freeze', phaseT = 0, roundClock = 0;
  var bomb = { planted: false, pos: [0, 0], timer: 0, mesh: null, defusing: 0, beepT: 0 };
  var carrier = null, targetSite = null;
  var defuseProgress = 0, plantProgress = 0, botDefuse = 0;
  var killfeed = [];
  var vm = null, vmRecoil = { x: 0, y: 0, z: 0 }, vmBob = 0, vmSwayX = 0, vmSwayY = 0;
  var punch = { x: 0, y: 0 };
  var recoilIdx = 0;
  var lastShotT = 0;
  var mouse = { down: false, rdown: false };
  var keys = {};
  var hud = {};
  var radarCtx = null, radarBase = null;
  var effects = null;
  var spectate = null, deadT = 0;
  var matchOver = false;
  var stepAcc = 0, lastFootT = 0;
  var sbTimer = 0;
  var scoped = false;
  var hadLock = false;
  var suppressAutoPause = false;
  // 团队竞技
  var teamDmKillLimit = 0;
  var teamDmRespawning = false;
  var teamDmRespawnTimer = 0;
  var playerCorpse = null;   // 玩家尸体模型（团队竞技第三人称死亡视角）
  var mapGroup = null;       // 地图几何独立分组，换地图时整体重建
  // 性能
  var vmModelCache = {};

  var shakeT = 0, shakeMag = 0;
  var peak = { spread: 0, punch: 0, burst: 0 };   // 仅用于自检读数
  var blindT = 0, blindMax = 1;                   // 玩家被闪光弹致盲
  var nadeHold = false;                           // 手雷已拉环、等松手投出
  var testInvuln = false;                         // 自检用：让玩家不被打死，保证测试可重复
  var tickT = 0;                                  // 安放 / 拆弹提示音的节拍

  /* ---------------- 联机状态（Stage 2：位姿同步 + 命中链路） ---------------- */
  var netMode = false;          // 是否处于联机对局
  var netT = null;              // 传输层（VibeTransport 或 LoopbackTransport）
  var netClock = new NET.Clock();
  var netRemotes = new Map();   // peerId → 远程玩家实体
  var netPoseTick = new NET.Ticker(NET.P.POSE_HZ);
  var netSnapTick = new NET.Ticker(NET.P.SNAPSHOT_HZ);
  var netPingTick = new NET.Ticker(NET.P.PING_MS, true);
  var netShotSeq = 0;
  var netSnapSeq = 0;
  var netDedupe = new NET.ShotDedupe();
  var netMyLife = 1;            // 每次重生 +1，防止用上一条命的射击结算
  var netPending = new Map();   // 房主侧：等 dmgAck 的射击 key → {shooterId, victimId, w, headshot}
  var netStats = { sentPose: 0, recvPose: 0, sentSnap: 0, recvSnap: 0, fires: 0, hits: 0, rejects: {} };
  var netLastPredictHit = -9;   // 本地预测命中的时刻（用来抑制重复的确认音）

  /* ---- Stage 3：回合 / 经济 / C4 / bot 的 match 通道 ---- */
  var netRole = 'none';                  // 'none' | 'host' | 'client'
  var netMatchTick = new NET.Ticker(NET.P.MATCH_MS, true);
  var netFullTick = new NET.Ticker(NET.P.FULL_MATCH_MS, true);
  var netMatchSeq = 0;
  var netMatchGuard = new NET.SeqGuard();
  var netBotDelta = new NET.DeltaTracker(NET.P.MATCH_MS);
  var netBots = new Map();               // 客户端侧：房主下发的 bot 实体（id → entity）
  var netHoldE = false;                  // 客户端上报的"按住 E"状态
  var netRemoteHold = new Map();         // 房主侧：各远程玩家的按 E 状态
  var netMatchStats = { sentMatch: 0, recvMatch: 0, resync: 0, applied: 0, botRows: 0 };

  /* 是否由本机跑权威模拟（单机 或 联机房主） */
  function netAuthoritative() { return !netMode || netIsHost(); }

  function netIsHost() { return !!(netT && netT.isHost); }
  function netNow() { return netClock.now(); }

  /* 致盲：玩家走白屏，bot 走 blindT（会停火并乱瞄） */
  function blindEntity(e, sec) {
    if (!e || e.dead) return;
    if (e.isPlayer) {
      blindT = Math.max(blindT, sec);
      blindMax = Math.max(blindT, 0.001);
    } else {
      e.blindT = Math.max(e.blindT || 0, sec);
    }
  }

  /* ---------------- 经济（CS1.6 数值） ---------------- */
  var MONEY = {
    start: 800, max: 16000,
    lossBonus: [1400, 1900, 2400, 2900, 3400],   // 连败第 1~5 次
    winElim: 3250,     // 灭队取胜
    winBomb: 3500,     // 炸弹爆炸（T）
    winDefuse: 3500,   // 拆除炸弹（CT）
    winTime: 3250,     // 时间到（CT 防守成功）
    plant: 300,        // 安放者
    defuse: 300,       // 拆弹者
    buyTime: 20        // 回合开始后可购买的秒数
  };
  var lossStreak = { T: 0, CT: 0 };

  function addMoney(e, n, why) {
    if (!e) return;
    e.money = Math.max(0, Math.min(MONEY.max, (e.money || 0) + n));
    if (e.isPlayer) {
      updateHud();
      if (n > 0 && why) moneyPop('+$' + n + ' ' + why);
    }
  }

  function teamMoney(team, n) {
    var list = team === 'T' ? tList : ctList;
    for (var i = 0; i < list.length; i++) addMoney(list[i], n);
  }

  /* 回合结算：胜方拿胜利奖金，败方拿连败递增奖金 */
  function awardRoundMoney(winner, reason) {
    var loser = winner === 'T' ? 'CT' : 'T';
    var win = reason === '炸弹爆炸' ? MONEY.winBomb
      : reason === '炸弹被拆除' ? MONEY.winDefuse
        : reason === '时间到' ? MONEY.winTime : MONEY.winElim;
    teamMoney(winner, win);
    var bonus = MONEY.lossBonus[Math.min(MONEY.lossBonus.length - 1, lossStreak[loser])];
    teamMoney(loser, bonus);
    lossStreak[loser] = Math.min(MONEY.lossBonus.length - 1, lossStreak[loser] + 1);
    lossStreak[winner] = 0;
    if (player) {
      var mine = winner === player.team;
      banner2(mine ? '+$' + win : '+$' + bonus + '（连败奖金）');
    }
  }

  /* 是否处于可购买状态 —— 存活 + 在自家出生区 + 购买窗口内
   * 爆破：回合开始 buyTime 秒内；团队竞技：每次复活后 buyTime 秒内 */
  function buyState() {
    if (!player || player.dead) return { ok: false, why: '阵亡后不能购买' };
    if (matchOver) return { ok: false, why: '比赛已结束' };
    var inTime;
    if (SET.gameMode === 'teamdm') {
      inTime = time < (player.buyUntil || 0);
      if (!inTime) return { ok: false, why: '复活后 ' + MONEY.buyTime + ' 秒内才能购买' };
    } else {
      inTime = phase === 'freeze' || (phase === 'live' && roundClock > SET.roundTime - MONEY.buyTime);
      if (!inTime) return { ok: false, why: '购买时间已过（回合开始 ' + MONEY.buyTime + ' 秒内）' };
    }
    if (!getMapModule().inBuyZone(player.team, player.x, player.z)) return { ok: false, why: '必须回到自家出生区才能购买' };
    return { ok: true, why: '' };
  }

  /* ================================================================
   *  初始化
   * ================================================================ */
  function init() {
    loadSettings();
    var canvas = document.getElementById('gl');
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.autoClear = false;
    renderer.setClearColor(0xa9c4dd, 1);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xc9b489, 2200, 6000);

    // near 太小会让远处地板 / 远景建筑深度打架（看起来像地板漏光）
    camera = new THREE.PerspectiveCamera(SET.fov, window.innerWidth / window.innerHeight, 8, 12000);

    camera.rotation.order = 'YXZ';

    // 视角武器模型使用独立场景，避免插进墙里
    vmScene = new THREE.Scene();
    vmCam = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.4, 400);
    var vl = new THREE.DirectionalLight(0xffffff, 0.95); vl.position.set(-0.4, 1, 0.6);
    vmScene.add(vl);
    vmScene.add(new THREE.AmbientLight(0x8899aa, 0.75));

    tex = TEX.build();

    // 光照
    scene.add(new THREE.HemisphereLight(0xbfd7ef, 0x9a7b4a, 0.55));
    var sun = new THREE.DirectionalLight(0xfff2d2, 0.62);
    sun.position.set(-0.45, 1, 0.32);
    scene.add(sun);
    var fill = new THREE.DirectionalLight(0xffd9a0, 0.22);
    fill.position.set(0.6, 0.35, -0.7);
    scene.add(fill);

    // 天空
    var sky = new THREE.Mesh(
      new THREE.SphereGeometry(9000, 24, 16),
      new THREE.MeshBasicMaterial({ map: tex.sky, side: THREE.BackSide, fog: false, depthWrite: false })
    );
    scene.add(sky);

    mapGroup = new THREE.Group();
    scene.add(mapGroup);
    getMapModule().build(mapGroup, tex);
    effects = makeEffects();
    buildBombMesh();

    // 投掷物 & 购买菜单
    NADE.init(scene, tex, {
      entities: function () { return all; },
      damage: function (e, attacker, dmg, hs, w) { applyDamage(e, attacker, dmg, hs, w); },
      blind: function (e, sec) { blindEntity(e, sec); },
      eyeY: function (e) { return e.isPlayer ? eyeY(e) : (e.y + (e.crouch ? 30 : 58)); },
      distToPlayer: function (x, z) { return player ? Math.hypot(x - player.x, z - player.z) : 2000; },
      shake: function (x, z, t, m) {
        if (!player) return;
        var d = Math.hypot(x - player.x, z - player.z);
        if (d < 900) shake(t, m * (1 - d / 900));
      }
    });
    BUYMENU.init({
      buyState: buyState,
      money: function () { return player ? player.money : 0; },
      team: function () { return player ? player.team : 'CT'; },
      owned: ownedInfo,
      buy: purchaseItem,
      notify: function (msg) { if (msg) moneyPop(msg); }
    });

    cacheHud();
    initRadar();
    bindInput();
    // 手机触控初始化（在 bindInput 之后，不冲突）
    if (typeof TOUCH !== 'undefined') TOUCH.detect();
    bindUI();
    applySettingsToUI();

    window.addEventListener('resize', onResize);
    clock = performance.now();
    requestAnimationFrame(frame);

    // 便于自动化测试 / 快速开局：index.html?autostart=1&max=3&diff=hard&team=T
    if (/autostart|selftest/.test(location.search)) {
      var q = location.search;
      var m = q.match(/max=(\d+)/); if (m) SET.maxScore = parseInt(m[1], 10);
      m = q.match(/diff=(\w+)/); if (m && SKILLS[m[1]]) SET.difficulty = m[1];
      m = q.match(/team=(CT|T)\b/); if (m) SET.team = m[1];
      m = q.match(/size=(\d+)/); if (m) SET.teamSize = parseInt(m[1], 10);
      setTimeout(startMatch, 60);
    }
  }

  function onResize() {
    var w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    vmCam.aspect = w / h; vmCam.updateProjectionMatrix();
  }

  /* ================================================================
   *  玩家
   * ================================================================ */
  function makePlayer(team) {
    var defaultName = '你';
    try {
      if (typeof VIBE !== 'undefined' && VIBE.getUser) {
        var u = VIBE.getUser();
        if (u && u.name) defaultName = u.name;
      }
    } catch (e) { }
    return {
      isPlayer: true, name: defaultName, team: team,
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
      yaw: 0, pitch: 0, health: 100, armor: 0, helmet: false, defuser: false,
      money: MONEY.start, nades: {},
      dead: false, crouch: false, onGround: true,
      kills: 0, deaths: 0, weapons: [], wi: 0, ammo: {}, reserve: {},
      nextFire: 0, reloadEnd: 0, shotsInBurst: 0, spreadPen: 0, curSpread: 0
    };
  }

function giveLoadout(e, list) {
  e.weapons = list.slice();
  e.ammo = {}; e.reserve = {};
  for (var i = 0; i < list.length; i++) {
    var d = WEAPONS.defs[list[i]];
    e.ammo[list[i]] = d.mag;
    e.reserve[list[i]] = d.reserve;
  }
  e.wi = 0;
  if (e.isPlayer) setViewModel(list[0], e.team);
}

  /* 补满已有武器的弹药（回合开始时 CS 会把备弹补满） */
  function refillAmmo(e) {
    for (var i = 0; i < e.weapons.length; i++) {
      var d = WEAPONS.defs[e.weapons[i]];
      if (!d || d.kind === 'grenade') continue;
      e.ammo[e.weapons[i]] = d.mag;
      e.reserve[e.weapons[i]] = d.reserve;
    }
  }

  /* 按槽位（primary / secondary / knife / grenade）找武器下标 */
  function slotIndex(e, slot, gid) {
    for (var i = 0; i < e.weapons.length; i++) {
      var d = WEAPONS.defs[e.weapons[i]];
      if (!d) continue;
      if (d.slot === slot && (!gid || e.weapons[i] === gid)) return i;
    }
    return -1;
  }

  /* 1 主武器 / 2 手枪 / 3 匕首 / 4 HE / 5 闪光 / 6 烟雾 */
  function selectSlot(slot, gid) {
    var i = slotIndex(player, slot, gid);
    if (i >= 0) switchWeapon(i);
    else if (slot === 'grenade') SFX.buyFail();
  }

  /* ---------------- 购买 ----------------
   * granted=true 表示这是房主批准后的补发，跳过本地的钱/买区/时间校验 */
  function purchaseItem(item, granted) {
    if (!granted) {
      var st = buyState();
      if (!st.ok) return { ok: false, why: st.why };
      if (!WEAPONS.itemForTeam(item, player.team)) return { ok: false, why: '本阵营不可用' };
      var price0 = WEAPONS.priceOf(item);
      if ((player.money || 0) < price0) return { ok: false, why: '钱不够（需要 $' + price0 + '）' };
      // 联机客户端：钱和购买资格由房主说了算，先申请，等 buyResult 再真正到手
      if (netMode && !netIsHost()) return netRequestBuy(item.id);
    }
    var price = WEAPONS.priceOf(item);

    if (item.equip) {
      if (item.equip === 'kevlar') {
        if (player.armor >= 100 && !player.helmet) return { ok: false, why: '已经有防弹衣了' };
        player.armor = 100;
      } else if (item.equip === 'kevhelm') {
        if (player.armor >= 100 && player.helmet) return { ok: false, why: '已经有防弹衣和头盔了' };
        player.armor = 100; player.helmet = true;
      } else if (item.equip === 'defuser') {
        if (player.team !== 'CT') return { ok: false, why: '只有 CT 能买拆弹器' };
        if (player.defuser) return { ok: false, why: '已经有拆弹器了' };
        player.defuser = true;
      }
    } else {
      var d = WEAPONS.defs[item.id];
      if (!d) return { ok: false, why: '没有这件武器' };
      if (d.kind === 'grenade') {
        var have = (player.nades[d.id] || 0);
        if (have >= (d.maxCarry || 1)) return { ok: false, why: '带不了更多了（上限 ' + (d.maxCarry || 1) + '）' };
        player.nades[d.id] = have + 1;
        if (player.weapons.indexOf(d.id) < 0) {
          player.weapons.push(d.id);
          player.ammo[d.id] = -1; player.reserve[d.id] = -1;
        }
      } else {
        var slot = d.slot || 'primary';
        var old = slotIndex(player, slot);
        if (old >= 0 && player.weapons[old] === d.id && player.reserve[d.id] === WEAPONS.defs[d.id].reserve) {
          return { ok: false, why: '已经拿着同一把枪了' };
        }
        if (old >= 0) {
          var oldId = player.weapons[old];
          player.weapons[old] = d.id;
          delete player.ammo[oldId]; delete player.reserve[oldId];
        } else {
          player.weapons.unshift(d.id);
        }
        player.ammo[d.id] = d.mag;
        player.reserve[d.id] = d.reserve;
        var idx = player.weapons.indexOf(d.id);
        player.wi = idx;
        player.reloadEnd = 0; player.nextFire = time + 0.3;
        player.shotsInBurst = 0; player.spreadPen = 0;
        scoped = false; setScope(false);
        setViewModel(d.id, player.team);
      }
    }
    // granted 时钱已由房主扣过（buyResult 里带权威值），本地不能再扣一次
    if (!granted) addMoney(player, -price);
    SFX.buyOk();
    updateHud();
    return { ok: true, why: WEAPONS.nameOf(item) + ' -$' + price };
  }

  /* 给购买菜单用的当前持有状态 */
  function ownedInfo(item) {
    if (!player) return '';
    if (item.equip === 'kevlar' || item.equip === 'kevhelm') {
      return player.armor >= 100 ? (player.helmet ? '已有 甲+盔' : '已有 甲') : '';
    }
    if (item.equip === 'defuser') return player.defuser ? '已有' : '';
    var d = WEAPONS.defs[item.id];
    if (!d) return '';
    if (d.kind === 'grenade') {
      var n = player.nades[d.id] || 0;
      return n > 0 ? '×' + n : '';
    }
    return player.weapons.indexOf(d.id) >= 0 ? '持有' : '';
  }

  function eyeY(e) { return e.y + (e.crouch ? 30 : 64); }
  function weaponOf(e) { return WEAPONS.defs[e.weapons[e.wi]]; }

  function setViewModel(id, team) {
    // 团队竞技时 team 需要传入（可能观战 bot）
    var t = team || (player ? player.team : 'CT');
    var key = id + '_' + t;
    if (vm && vm.id === id && vm.team === t) return;  // 同武器不重建
    if (vmModelCache[key]) {
      if (vm) vmScene.remove(vm.root);
      vm = vmModelCache[key];
      vmScene.add(vm.root);
      /* 火光 Sprite 只挂一次：反复 add 会叠一堆，旧 sprite 的计时器引用被
       * 覆盖后永远 visible=true —— 这就是「枪口火光一直存在」的根因 */
      if (!vm.flash) { vm.flash = effects.makeVmFlash(); vm.muzzle.add(vm.flash); }
      vm.flash.visible = false; vm.flashT = 0;
      return;
    }
    if (vm) vmScene.remove(vm.root);
    vm = WEAPONS.makeViewModel(id, t);
    vm.id = id;
    vm.team = t;
    vmModelCache[key] = vm;
    vmScene.add(vm.root);
    if (!vm.flash) { vm.flash = effects.makeVmFlash(); vm.muzzle.add(vm.flash); }
    vm.flash.visible = false; vm.flashT = 0;
  }

  /* ================================================================
   *  开始比赛 / 回合
   * ================================================================ */

  /* 清掉上一局残留的瞬时 UI 与状态。
   * 「再来一局」按钮不经过 onQuit 直接调 startMatch，团队竞技的 startTeamDM
   * 又不像 newRound 那样逐项复位 —— 上一局死亡时的中央阵亡提示 / 复活进度条 /
   * 白屏 / 尸体 / 飞行中的手雷会全部带进新对局，直到下次复活才被冲掉。 */
  function resetMatchHud() {
    spectate = null; deadT = 0;
    clearSpectateHidden();
    blindT = 0; nadeHold = false;
    punch.x = punch.y = 0;
    scoped = false;
    teamDmRespawning = false; teamDmRespawnTimer = 0;
    bomb.planted = false; bomb.timer = 0; bomb.defusing = 0;
    if (bomb.mesh) bomb.mesh.visible = false;
    var ids = ['deadmsg', 'progressWrap', 'scope', 'bombhud'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.classList.add('hidden');
    }
    if (hud.flashblind) hud.flashblind.style.opacity = 0;
    if (hud.flash) hud.flash.style.opacity = 0;
    if (hud.banner) { clearTimeout(banner._t); hud.banner.style.opacity = 0; hud.banner.classList.add('hidden'); }
    if (hud.dmgdir) hud.dmgdir.innerHTML = '';
    if (hud.killfeed) hud.killfeed.innerHTML = '';
    if (hud.radiofeed) hud.radiofeed.innerHTML = '';
    removePlayerCorpse();
    if (BUYMENU && BUYMENU.isOpen()) BUYMENU.close();
    if (effects) effects.clear();
    if (NADE && NADE.clear) NADE.clear();
  }

  function startMatch() {
    saveSettings();
    SFX.init(); SFX.setVolume(SET.volume); SFX.resume();
    resetMatchHud();   // 先清上一局残留（死亡提示 / 白屏 / 手雷 / 尸体等）

    // 让全局 MAP 指向当前选择的地图，bots.js 里的 MAP.* 才会用对地图
    MAP = getMapModule();
    rebuildMap();  // 换地图后重建 3D 几何
    initRadar();   // 换地图后重新烘焙雷达底图

    // 清理旧 bot
    for (var i = 0; i < bots.length; i++) scene.remove(bots[i].model.group);
    bots = []; all = []; tList = []; ctList = [];
    removePlayerCorpse();
    teamDmRespawning = false; teamDmRespawnTimer = 0;
    nameplates.forEach(function (p) { disposeNameplate(p); });
    nameplates.clear();

    player = makePlayer(SET.team);
    all.push(player);

    var used = {};
    function pickName() {
      var n;
      do { n = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (used[n]);
      used[n] = 1; return n;
    }
    // 每队总人数 = SET.teamSize；真人（本机玩家 + 已进房的联机玩家）占用的名额由 bot 补齐
    var humansMy = 0, humansOther = 0, hi;
    for (hi = 0; hi < all.length; hi++) {
      if (all[hi].isBot) continue;
      if (all[hi].team === SET.team) humansMy++; else humansOther++;
    }
    var myBots = Math.max(0, SET.teamSize - humansMy);
    var otherBots = Math.max(0, SET.teamSize - humansOther);
    var other = SET.team === 'T' ? 'CT' : 'T';
    for (i = 0; i < myBots; i++) bots.push(new Bot(SET.team, pickName(), SET.difficulty, scene));
    for (i = 0; i < otherBots; i++) bots.push(new Bot(other, pickName(), SET.difficulty, scene));
    all = all.concat(bots);
    rebuildTeams();

    score.T = 0; score.CT = 0; round = 0; matchOver = false;
    lossStreak.T = 0; lossStreak.CT = 0;
    killfeed = [];
    started = true; running = true; paused = false;
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('matchend').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');

    // 团队竞技 vs 爆破模式分支
    if (SET.gameMode === 'teamdm') {
      startTeamDM();
    } else {
      // 爆破模式：先让所有人阵亡，触发默认装备发放
      for (i = 0; i < all.length; i++) {
        all[i].money = MONEY.start;
        all[i].armor = 0; all[i].helmet = false; all[i].defuser = false;
        all[i].nades = {};
        all[i].dead = true;
      }
      newRound();
    }
    requestLock();
  }

  /* ================================================================
   *  团队竞技模式
   * ================================================================ */
  function startTeamDM() {
    teamDmKillLimit = SET.lives;
    teamDmRespawning = false;
    for (var i = 0; i < all.length; i++) {
      all[i].money = 99999;
      all[i].armor = 100;
      all[i].helmet = true;
      all[i].defuser = false;
      all[i].nades = {};
      all[i].dead = false;
      giveTeamDMLoadout(all[i]);
    }
    // 直接从 live 开始，不打 freeze
    phase = 'live'; phaseT = 0;
    var tSp = getMapModule().SPAWNS.T.slice(), ctSp = getMapModule().SPAWNS.CT.slice();
    shuffle(tSp); shuffle(ctSp);
    var ti = 0, ci = 0;
    var takenT = [], takenCT = [];
    for (i = 0; i < all.length; i++) {
      var e = all[i];
      var sp = e.team === 'T' ? tSp[(ti++) % tSp.length] : ctSp[(ci++) % ctSp.length];
      var pos = placeEntity(e, sp, e.team === 'T' ? takenT : takenCT);
      e.x = pos[0]; e.y = pos[1]; e.z = pos[2];
      e.vx = e.vy = e.vz = 0;
      e.health = 100; e.dead = false; e.crouch = false;
      e.reloadEnd = 0; e.nextFire = 0;
      e.shotsInBurst = 0; e.spreadPen = 0; e.curSpread = 0;
      setViewModel(e.weapons[e.wi], e.team);
      e.yaw = Math.atan2(-(0 - e.x), -(0 - e.z));
      e.pitch = 0;
      e.buyUntil = time + MONEY.buyTime;   // 团队竞技：复活后 20 秒可购买
      e.spawnProtectedUntil = netNow() + NET.P.SPAWN_PROTECT_MS;
    }
    banner('团队竞技 · 先达到 ' + teamDmKillLimit + ' 杀获胜', 2.5);
    SFX.roundStart();
    updateHud();
  }

  function giveTeamDMLoadout(e) {
    /* 随机主武器 + 副武器，加 1~2 颗投掷物 */
    var primaries = ['ak47', 'famas', 'galil', 'm4a1', 'mp5', 'm3', 'awp'];
    var secondaries = e.team === 'T' ? ['glock'] : ['usp'];
    var pWeap = primaries[Math.floor(Math.random() * primaries.length)];
    var sWeap = secondaries[Math.floor(Math.random() * secondaries.length)];
    var loadout = ['knife', pWeap, sWeap];
    // 投掷物：随机 1~2 颗
    var nades = ['he', 'flash', 'smoke'];
    var nadeCount = 1 + Math.floor(Math.random() * 2);
    for (var n = 0; n < nadeCount; n++) {
      var pick = nades[Math.floor(Math.random() * nades.length)];
      if (loadout.indexOf(pick) < 0) loadout.push(pick);
    }
    giveLoadout(e, loadout);
  }

  /* 玩家尸体（团队竞技）：生成 / 移除 */
  function spawnPlayerCorpse() {
    removePlayerCorpse();
    var model = CHAR.make(player.team);
    playerCorpse = {
      model: model,
      x: player.x, y: player.y, z: player.z,
      yaw: player.yaw, pitch: 0,
      dead: true, deadTilt: 0, vx: 0, vz: 0, crouch: false
    };
    model.group.visible = true;
    scene.add(model.group);
  }
  function removePlayerCorpse() {
    if (playerCorpse) { scene.remove(playerCorpse.model.group); playerCorpse = null; }
  }

  function teamDMRespawn(e) {
    var sp = getMapModule().SPAWNS[e.team];
    var pos = placeEntity(e, sp[Math.floor(Math.random() * sp.length)], []);
    if (e.isBot) {
      // bot：用 spawn 重置模型（站起、朝向、可见）并发装备
      e.spawn(pos[0], pos[2], e.weapons.slice(), pos[1], true);
      e.armor = 100; e.helmet = true;
      e.goalStale = true;
      return;
    }
    // 玩家：移除尸体、恢复第一人称
    removePlayerCorpse();
    if (hud.progressWrap) hud.progressWrap.classList.add('hidden');
    if (hud.deadmsg) hud.deadmsg.classList.add('hidden');
    e.dead = false;
    e.health = 100;
    e.armor = 100; e.helmet = true; e.defuser = false;
    e.nades = {};
    giveTeamDMLoadout(e);
    e.x = pos[0]; e.y = pos[1]; e.z = pos[2];
    e.vx = e.vy = e.vz = 0;
    e.reloadEnd = 0; e.nextFire = 0;
    e.shotsInBurst = 0; e.spreadPen = 0; e.curSpread = 0;
    setViewModel(e.weapons[e.wi], e.team);
    e.yaw = Math.atan2(-(0 - e.x), -(0 - e.z));
    e.pitch = 0;
    e.buyUntil = time + MONEY.buyTime;   // 复活后 20 秒可购买
    e.spawnProtectedUntil = netNow() + NET.P.SPAWN_PROTECT_MS;
    if (e.history) e.history.clear();
    updateHud();
  }

  function showMatchEnd() {
    running = false;
    releaseLock();
    var el = document.getElementById('matchend');
    var limit = SET.gameMode === 'teamdm' ? teamDmKillLimit : SET.maxScore;
    var win = score[player.team] >= limit;
    document.getElementById('meTitle').textContent = win ? '比赛胜利' : '比赛失败';
    document.getElementById('meTitle').style.color = win ? '#9ce06a' : '#ff7f6a';
    document.getElementById('meScore').textContent = 'CT ' + score.CT + '  :  ' + score.T + ' T';
    var modeLabel = SET.gameMode === 'teamdm' ? (' · 目标 ' + teamDmKillLimit + ' 杀') : (' · 回合 ' + round);
    document.getElementById('meStat').textContent = '击杀 ' + player.kills + ' · 死亡 ' + player.deaths + modeLabel;
    el.classList.remove('hidden');
    var btnAgain = document.getElementById('btnAgain');
    if (btnAgain) btnAgain.onclick = function () { el.classList.add('hidden'); startMatch(); };
    var btnMenu2 = document.getElementById('btnMenu2');
    if (btnMenu2) btnMenu2.onclick = function () {
      el.classList.add('hidden');
      document.getElementById('hud').classList.add('hidden');
      document.getElementById('menu').classList.remove('hidden');
      started = false;
    };
  }

  function rebuildTeams() {
    tList = []; ctList = [];
    for (var i = 0; i < all.length; i++) (all[i].team === 'T' ? tList : ctList).push(all[i]);
  }

  /* 出生点是否被地图几何（箱子 / 墙）或已出生的队友占据。
   * getMapModule().safeSpawn 需要这样一个探测函数，用它可以把人挤到旁边的空地上，
   * 避免直接把人塞进箱子里动不了。 */
  function makeSpawnProbe(taken) {
    var probe = { x: 0, y: 0, z: 0, crouch: false };
    return function (x, z) {
      probe.x = x; probe.z = z; probe.y = 0;
      if (PHYS.collide(x, 0, z, probe)) return true;
      // 站在箱子顶上也算「不干净」：脚下必须是实心且高度接近地面
      for (var i = 0; i < taken.length; i++) {
        var dx = taken[i][0] - x, dz = taken[i][1] - z;
        if (dx * dx + dz * dz < 44 * 44) return true;
      }
      return false;
    };
  }

  function placeEntity(e, sp, taken) {
    var probe = makeSpawnProbe(taken);
    var p = getMapModule().safeSpawn(sp[0], sp[1], probe);
    // 万一还是被包住（极端情况），抬到脚下支撑面上再放
    var y = 0;
    if (probe(p[0], p[1])) {
      var g = PHYS.groundY(p[0], 200, p[1], { crouch: false });
      if (g > -9999) y = g;
    }
    taken.push([p[0], p[1]]);
    return [p[0], y, p[1]];
  }

  /* 按每队总人数补齐/移除 bot（真人加入或离开后，回合开始时重新平衡） */
  function balanceBots() {
    var humansT = 0, humansCT = 0, i;
    for (i = 0; i < all.length; i++) {
      if (all[i].isBot) continue;
      if (all[i].team === 'T') humansT++; else humansCT++;
    }
    var wantT = Math.max(0, SET.teamSize - humansT);
    var wantCT = Math.max(0, SET.teamSize - humansCT);
    function teamCount(t) { var n = 0; for (var k = 0; k < bots.length; k++) if (bots[k].team === t) n++; return n; }
    for (i = bots.length - 1; i >= 0; i--) {
      var b = bots[i];
      if (teamCount(b.team) > (b.team === 'T' ? wantT : wantCT)) {
        scene.remove(b.model.group);
        var bi = bots.indexOf(b); if (bi >= 0) bots.splice(bi, 1);
        var ai = all.indexOf(b); if (ai >= 0) all.splice(ai, 1);
      }
    }
    var used = {};
    function pickName() {
      var n;
      do { n = BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]; } while (used[n]);
      used[n] = 1; return n;
    }
    while (teamCount('T') < wantT) { var bt = new Bot('T', pickName(), SET.difficulty, scene); bots.push(bt); all.push(bt); }
    while (teamCount('CT') < wantCT) { var bc = new Bot('CT', pickName(), SET.difficulty, scene); bots.push(bc); all.push(bc); }
    rebuildTeams();
  }

  function newRound() {
    round++;
    phase = 'freeze'; phaseT = 2.2;
    roundClock = SET.roundTime;
    bomb.planted = false; bomb.timer = 0; bomb.defusing = 0;
    if (bomb.mesh) bomb.mesh.visible = false;
    defuseProgress = 0; plantProgress = 0; botDefuse = 0;
    clearSpectateHidden();
    spectate = null; deadT = 0;
    document.getElementById('deadmsg').classList.add('hidden');
    document.getElementById('progressWrap').classList.add('hidden');
    scoped = false; setScope(false);
    punch.x = punch.y = 0;
    blindT = 0; nadeHold = false;
    if (hud.flashblind) hud.flashblind.style.opacity = 0;
    effects.clear();
    NADE.clear();

    // 权威端：真人加入/离开后，按每队总人数重新平衡 bot
    if (netAuthoritative()) balanceBots();

    targetSite = getMapModule().SITES[Math.floor(Math.random() * getMapModule().SITES.length)];

    // T / CT 出生
    var tSp = getMapModule().SPAWNS.T.slice(), ctSp = getMapModule().SPAWNS.CT.slice();
    shuffle(tSp); shuffle(ctSp);
    var ti = 0, ci = 0;
    var takenT = [], takenCT = [];
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      var sp = e.team === 'T' ? tSp[(ti++) % tSp.length] : ctSp[(ci++) % ctSp.length];
      var pos = placeEntity(e, sp, e.team === 'T' ? takenT : takenCT);
      // 上回合活下来的人保留武器 / 护甲 / 拆弹器（弹药补满），阵亡者回落到手枪 + 匕首
      var survived = !e.dead && round > 1 && e.weapons && e.weapons.length > 0;
      if (e.isPlayer) {
        e.x = pos[0]; e.y = pos[1]; e.z = pos[2];
        e.vx = e.vy = e.vz = 0;
        e.health = 100; e.dead = false; e.crouch = false;
        e.reloadEnd = 0; e.nextFire = 0;
        e.shotsInBurst = 0; e.spreadPen = 0; e.curSpread = 0;
        if (survived) {
          refillAmmo(e);
          e.wi = Math.max(0, slotIndex(e, 'primary') >= 0 ? slotIndex(e, 'primary') : slotIndex(e, 'secondary'));
        } else {
          e.armor = 0; e.helmet = false; e.defuser = false; e.nades = {};
          giveLoadout(e, WEAPONS.loadoutFor(e.team));
        }
    setViewModel(e.weapons[e.wi], e.team);
    e.yaw = Math.atan2(-(0 - e.x), -(0 - e.z));
    e.pitch = 0;
    // 联机：每次重生换一个 lifeId，并给一小段重生保护
    netMyLife++;
    e.spawnProtectedUntil = netNow() + NET.P.SPAWN_PROTECT_MS;
    if (e.history) e.history.clear();
  } else {
        e.spawn(pos[0], pos[2], survived ? e.weapons.slice() : WEAPONS.loadoutFor(e.team), pos[1], survived);
        if (survived) refillAmmo(e);
        e.buyPhase();                 // bot 用同一套经济买枪 / 护甲 / 拆弹器 / 手雷
        e.defendSite = getMapModule().SITES[i % getMapModule().SITES.length];
        e.goalStale = true;
      }
    }
    // 指定携带 C4 的人
    var ts = tList.filter(function (e) { return !e.dead; });
    carrier = ts.length ? ts[Math.floor(Math.random() * ts.length)] : null;
    for (i = 0; i < bots.length; i++) bots[i].goalStale = true;

    banner('第 ' + round + ' 回合 · ' + (SET.team === 'T' ? '进攻' : '防守'), 1.6);
    setBombHud(false);
    SFX.roundStart();
    if (BUYMENU) BUYMENU.close();
    roundStartRadio();   // 战术语音：真实的购买与去向播报（最多 4 条）
    // 联机房主：把出生点、钱和 C4 携带者下发给客户端
    if (netMode && netIsHost()) { netBotDelta.reset(); netBroadcastRoundStart(); netBroadcastMatch(true); }
    updateHud();
  }

  function endRound(winner, reason) {
    if (phase === 'over') return;
    phase = 'over'; phaseT = 4.0;
    score[winner]++;
    if (SET.gameMode !== 'teamdm') awardRoundMoney(winner, reason);
    var mine = winner === player.team;
    banner((winner === 'T' ? '恐怖分子' : '反恐精英') + '获胜 · ' + reason, 3.4, mine ? '#8fdc6a' : '#ff8b6a');
    if (mine) SFX.win(); else SFX.lose();
    var limit = SET.gameMode === 'teamdm' ? teamDmKillLimit : SET.maxScore;
    if (score[winner] >= limit) { matchOver = true; setTimeout(showMatchEnd, 2600); }
    if (netMode && netIsHost()) netBroadcastRoundEnd(winner, reason);
    updateHud();
  }

  function showMatchEnd() {
    running = false;
    releaseLock();
    var el = document.getElementById('matchend');
    var win = score[player.team] >= SET.maxScore;
    document.getElementById('meTitle').textContent = win ? '比赛胜利' : '比赛失败';
    document.getElementById('meTitle').style.color = win ? '#9ce06a' : '#ff7f6a';
    document.getElementById('meScore').textContent = 'CT ' + score.CT + '  :  ' + score.T + ' T';
    document.getElementById('meStat').textContent =
      '击杀 ' + player.kills + ' · 死亡 ' + player.deaths + ' · 回合 ' + round;
    el.classList.remove('hidden');
    // 给「再来一局」和「返回主菜单」绑定（每次都绑，安全）
    var btnAgain = document.getElementById('btnAgain');
    if (btnAgain) btnAgain.onclick = function () {
      el.classList.add('hidden');
      startMatch();
    };
    var btnMenu2 = document.getElementById('btnMenu2');
    if (btnMenu2) btnMenu2.onclick = function () {
      el.classList.add('hidden');
      document.getElementById('hud').classList.add('hidden');
      document.getElementById('menu').classList.remove('hidden');
      started = false;
    };
  }

  function aliveCount(list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (!list[i].dead) n++;
    return n;
  }

  /* ================================================================
   *  炸弹
   * ================================================================ */
  function buildBombMesh() {
    var g = new THREE.Group();
    var b = new THREE.Mesh(new THREE.BoxGeometry(22, 14, 16),
      new THREE.MeshLambertMaterial({ map: tex.c4 }));
    b.position.y = 7;
    g.add(b);
    var led = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 2),
      new THREE.MeshBasicMaterial({ color: 0xff2020 }));
    led.position.set(0, 12, 8.5);
    g.add(led);
    g.visible = false;
    scene.add(g);
    bomb.mesh = g;
    bomb.led = led;
  }

  function plantBomb(who) {
    if (bomb.planted) return;
    bomb.planted = true;
    bomb.timer = SET.bombTime;
    bomb.pos = [who.x, who.z];
    bomb.mesh.position.set(who.x, 2, who.z);
    bomb.mesh.visible = true;
    plantProgress = 0;
    SFX.bombPlant();
    addMoney(who, MONEY.plant, '安放 C4');
    var site = getMapModule().siteAt(who.x, who.z);
    banner('炸弹已安放' + (site ? ' 在 ' + site.name + ' 点' : ''), 2.2, '#ffd24a');
    addKillfeed(who.name, '安放了 C4', '', false, true);
    setBombHud(true);
    for (var i = 0; i < bots.length; i++) bots[i].goalStale = true;
    // 战术语音（分队：只播玩家阵营的通讯）——
    // 安放后存活队友真实转向包点：CT 是回防拆弹（defuse），T 是回守（hold）
    var myTeam = player ? player.team : SET.team;
    var mates = [];
    for (var j = 0; j < bots.length; j++) if (bots[j].team === myTeam && !bots[j].dead) mates.push(bots[j]);
    shuffle(mates);
    var siteName = site ? site.name : '';
    var msg = myTeam === 'CT' ? '正在回防' + siteName + '区' : '正在回守' + siteName + '区，守住C4';
    for (var k = 0; k < Math.min(2, mates.length); k++) {
      (function (bb, delay) {
        setTimeout(function () { if (running && !bb.dead) addRadio(bb.name, bb.team, msg); }, delay);
      })(mates[k], 600 + k * 700);
    }
  }

  function defuseBomb(who) {
    if (!bomb.planted) return;
    bomb.planted = false;
    bomb.mesh.visible = false;
    setBombHud(false);
    addMoney(who, MONEY.defuse, '拆除 C4');
    addKillfeed(who.name, '拆除了 C4', '', false, true);
    endRound('CT', '炸弹被拆除');
  }

  function explodeBomb() {
    bomb.planted = false;
    bomb.mesh.visible = false;
    setBombHud(false);
    SFX.explode();
    shake(1.1, 26);
    effects.explosion(bomb.pos[0], 20, bomb.pos[1]);
    // 范围伤害
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.dead) continue;
      var d = Math.hypot(e.x - bomb.pos[0], e.z - bomb.pos[1]);
      if (d < 900) applyDamage(e, null, 500 * (1 - d / 900) + 40, false, null);
    }
    endRound('T', '炸弹爆炸');
  }

  /* ================================================================
   *  射击 / 伤害
   * ================================================================ */
  function hitboxes(e) {
    var f = e.crouch ? 0.55 : 1;
    return [
      { y1: 60 * f, y2: 73 * f, r: 9, mul: 'head' },
      { y1: 45 * f, y2: 60 * f, r: 15, mul: 1.0 },
      { y1: 30 * f, y2: 45 * f, r: 16, mul: 1.25 },
      { y1: 0, y2: 30 * f, r: 16, mul: 0.75 }
    ];
  }

  function rayBoxLocal(ox, oy, oz, dx, dy, dz, x1, y1, z1, x2, y2, z2, maxT) {
    var tmin = 0, tmax = maxT;
    var pairs = [[ox, dx, x1, x2], [oy, dy, y1, y2], [oz, dz, z1, z2]];
    for (var i = 0; i < 3; i++) {
      var o = pairs[i][0], d = pairs[i][1], a = pairs[i][2], b = pairs[i][3];
      if (Math.abs(d) < 1e-8) { if (o < a || o > b) return -1; continue; }
      var inv = 1 / d, t1 = (a - o) * inv, t2 = (b - o) * inv;
      if (t1 > t2) { var t = t1; t1 = t2; t2 = t; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return -1;
    }
    return tmin;
  }

  /* 主射线：命中世界或实体。quiet=true 用于霰弹的第 2..n 颗弹丸（不重复播枪声） */
  function fireBullet(shooter, ox, oy, oz, dx, dy, dz, w, quiet) {
    var maxD = w.range;
    var wallHit = getMapModule().traceRay(ox, oy, oz, dx, dy, dz, maxD, {});
    var wallDist = wallHit ? wallHit.dist : maxD;

    var enemies = shooter.team === 'T' ? ctList : tList;
    var bestT = wallDist, bestEnt = null, bestMul = 1;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead || e === shooter) continue;
      var hb = hitboxes(e);
      for (var b = 0; b < hb.length; b++) {
        var h = hb[b];
        var t = rayBoxLocal(ox, oy, oz, dx, dy, dz,
          e.x - h.r, e.y + h.y1, e.z - h.r, e.x + h.r, e.y + h.y2, e.z + h.r, bestT);
        if (t >= 0 && t < bestT) { bestT = t; bestEnt = e; bestMul = h.mul; }
      }
    }

    // 曳光弹
    var endX = ox + dx * bestT, endY = oy + dy * bestT, endZ = oz + dz * bestT;
    effects.tracer(ox, oy, oz, endX, endY, endZ, shooter.isPlayer);

    // 枪声
    var sd = shooter.isPlayer ? 0 : Math.hypot(shooter.x - player.x, shooter.z - player.z);
    if (!quiet) {
      SFX.shoot(w.sound, sd);
      if (!shooter.isPlayer) {
        effects.worldFlash(shooter.x + (-Math.sin(shooter.yaw)) * 26, eyeY(shooter) - 6, shooter.z + (-Math.cos(shooter.yaw)) * 26);
        // 子弹擦身而过
        var missD = pointSegDist(player.x, eyeY(player), player.z, ox, oy, oz, endX, endY, endZ);
        if (!player.dead && missD < 90 && missD > 20) SFX.whiz();
      }
      // bot 听枪声
      for (i = 0; i < bots.length; i++) {
        var bt = bots[i];
        if (bt.dead || bt === shooter) continue;
        bt.hearGunfire(shooter.x, shooter.z, Math.hypot(bt.x - shooter.x, bt.z - shooter.z));
      }
    }

    if (bestEnt) {
      var isHead = bestMul === 'head';
      var mul = isHead ? w.hsMul : bestMul;
      var dmg = w.dmg * mul;
      // 距离衰减（简化）
      dmg *= Math.max(0.55, 1 - bestT / 9000);
      applyDamage(bestEnt, shooter, dmg, isHead, w);
      effects.blood(endX, endY, endZ, dx, dy, dz);
      SFX.fleshHit(shooter.isPlayer ? Math.hypot(bestEnt.x - player.x, bestEnt.z - player.z) : sd);
      if (shooter.isPlayer) {
        SFX.hitmark(isHead); showHitmarker(isHead);
        if (netMode && bestEnt.isRemote) netLastPredictHit = time;   // 这是预测反馈
      }
    } else if (wallHit) {
      effects.impact(endX, endY, endZ, wallHit.nx, wallHit.ny, wallHit.nz);
      SFX.impact(shooter.isPlayer ? bestT : sd);
    }
  }

  function meleeAttack(attacker, w) {
    var fwd = [-Math.sin(attacker.yaw) * Math.cos(attacker.pitch), Math.sin(attacker.pitch), -Math.cos(attacker.yaw) * Math.cos(attacker.pitch)];
    var ox = attacker.x, oy = eyeY(attacker), oz = attacker.z;
    SFX.knifeSwing(attacker.isPlayer ? 0 : Math.hypot(attacker.x - player.x, attacker.z - player.z));
    var enemies = attacker.team === 'T' ? ctList : tList;
    var best = null, bestT = 70, mulOut = 1;
    for (var i = 0; i < enemies.length; i++) {
      var e = enemies[i];
      if (e.dead) continue;
      var hb = hitboxes(e);
      for (var b = 0; b < hb.length; b++) {
        var h = hb[b];
        var t = rayBoxLocal(ox, oy, oz, fwd[0], fwd[1], fwd[2],
          e.x - h.r - 8, e.y + h.y1, e.z - h.r - 8, e.x + h.r + 8, e.y + h.y2, e.z + h.r + 8, bestT);
        if (t >= 0 && t < bestT) { bestT = t; best = e; mulOut = h.mul; }
      }
    }
    if (best) {
      // 背后攻击致命
      var fx = -Math.sin(best.yaw), fz = -Math.cos(best.yaw);
      var toX = attacker.x - best.x, toZ = attacker.z - best.z;
      var l = Math.hypot(toX, toZ) || 1;
      var behind = (fx * toX + fz * toZ) / l < -0.55;
      var dmg = behind ? 180 : w.dmg * (mulOut === 'head' ? 1.6 : mulOut);
      applyDamage(best, attacker, dmg, mulOut === 'head', w);
      SFX.knifeHit(attacker.isPlayer ? 0 : 400);
      effects.blood(best.x, best.y + 50, best.z, fwd[0], fwd[1], fwd[2]);
      if (attacker.isPlayer) { SFX.hitmark(false); showHitmarker(false); }
    }
  }

  function applyDamage(victim, attacker, dmg, headshot, w) {
    if (victim.dead) return;
    if (!isFinite(victim.health)) victim.health = 100;   // 血量一旦 NaN 就永远打不死，这里硬性拉回
    if (testInvuln && victim.isPlayer) return;      // 只有 ?selftest 模式会打开
    // 联机：远程玩家的血量由他自己算（房主只负责判定命中并通知他）。
    // 这条拦截保证任何本地路径（爆炸、手雷、预测弹道）都不会替别人扣血。
    if (netMode && victim.isRemote) {
      if (netIsHost()) netSendSplashDamage(victim, attacker, dmg, headshot, w);
      return;
    }
    // 头盔削减爆头伤害（CS1.6 里头盔能把很多枪的爆头从必死变成重伤）
    if (headshot && victim.helmet && w) dmg *= 0.45;
    var pen = w ? (w.armorPen > 0 ? w.armorPen : 0.75) : 0.8;
    if (victim.armor > 0) {
      var toArmor = dmg * (1 - pen) * 0.5;
      dmg = dmg * pen;
      victim.armor = Math.max(0, victim.armor - Math.max(1, toArmor * 1.6));
    }
    /* 兜底：任何路径算出 NaN/0/负数都会让血量永久不变（看起来就是「无敌」），
     * 这里保证伤害永远是 ≥1 的有效数字 */
    dmg = Math.round(dmg);
    if (!isFinite(dmg) || dmg < 1) dmg = 1;
    victim.health -= dmg;

    if (victim.isPlayer) {
      SFX.pain();
      damageFlash(dmg);
      if (attacker) showDamageDir(attacker.x, attacker.z);
      shake(0.16, Math.min(9, dmg * 0.25));
    }
    if (victim.health <= 0) {
      killEntity(victim, attacker, headshot, w);
    } else if (!victim.isPlayer && attacker) {
      // 被打中会转身寻找敌人
      if (!victim.target && victim.hearGunfire) {
        victim.investigate = [attacker.x, attacker.z];
        victim.desiredYaw = Math.atan2(-(attacker.x - victim.x), -(attacker.z - victim.z));
        victim.path = null;
      }
    }
    if (victim.isPlayer) updateHud();
  }

  function killEntity(victim, attacker, headshot, w) {
    victim.health = 0;
    if (victim.isPlayer) {
      victim.dead = true; victim.deaths++;
      deadT = 0;
      document.getElementById('deadmsg').classList.remove('hidden');
      SFX.death(0);
      setScope(false);
      // 团队竞技：生成尸体 + 3 秒后复活（不进入观战）
      if (SET.gameMode === 'teamdm') {
        spawnPlayerCorpse();
        teamDmRespawning = true;
        teamDmRespawnTimer = 3.0;
      }
    } else {
      victim.die();
      SFX.death(Math.hypot(victim.x - player.x, victim.z - player.z));
      // 团队竞技：bot 也复活
      if (SET.gameMode === 'teamdm') {
        setTimeout(function () { if (started && SET.gameMode === 'teamdm') teamDMRespawn(victim); }, 2500 + Math.random() * 1500);
      }
    }
    if (attacker && attacker !== victim) {
      attacker.kills++;
      // 团队竞技：直接给队伍加一分
      if (SET.gameMode === 'teamdm') {
        score[attacker.team]++;
        checkRoundEnd();
      } else {
        addMoney(attacker, w && w.kill !== undefined ? w.kill : 300, '击杀');
      }
    }

    addKillfeed(attacker ? attacker.name : '世界', w ? w.name : '', victim.name, headshot,
      false, attacker ? attacker.team : null, victim.team);
    // C4 携带者死亡 → 转交
    if (victim === carrier && !bomb.planted) {
      var cands = tList.filter(function (e) { return !e.dead; });
      carrier = cands.length ? cands[0] : null;
      for (var i = 0; i < bots.length; i++) if (bots[i].team === 'T') bots[i].goalStale = true;
    }
    checkRoundEnd();
    updateHud();
  }

  function checkRoundEnd() {
    if (SET.gameMode === 'teamdm') {
      if (phase === 'over') return;
      if (score.T >= teamDmKillLimit) endRound('T', '团队竞技 · 恐怖分子达成 ' + teamDmKillLimit + ' 杀');
      else if (score.CT >= teamDmKillLimit) endRound('CT', '团队竞技 · 反恐精英达成 ' + teamDmKillLimit + ' 杀');
      return;
    }
    if (phase === 'over') return;
    if (!netAuthoritative()) return;
    var tAlive = aliveCount(tList), ctAlive = aliveCount(ctList);
    if (tAlive === 0 && !bomb.planted) endRound('CT', '恐怖分子被全部消灭');
    else if (ctAlive === 0) endRound('T', '反恐精英被全部消灭');
  }

  function pointSegDist(px, py, pz, ax, ay, az, bx, by, bz) {
    var abx = bx - ax, aby = by - ay, abz = bz - az;
    var apx = px - ax, apy = py - ay, apz = pz - az;
    var len2 = abx * abx + aby * aby + abz * abz;
    var t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
    var cx = ax + abx * t - px, cy = ay + aby * t - py, cz = az + abz * t - pz;
    return Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  /* ================================================================
   *  玩家输入 / 更新
   * ================================================================ */
  function bindInput() {
    var canvas = document.getElementById('gl');
    canvas.addEventListener('click', function () {
      if (started && running && !paused && !BUYMENU.isOpen()) requestLock();
    });
    document.addEventListener('pointerlockchange', function () {
      var locked = document.pointerLockElement === canvas;
      if (locked) { hadLock = true; suppressAutoPause = false; return; }
      // 是我们自己为了让鼠标能点购买菜单而释放的锁，不是用户按 Esc / 切窗口，
      // 不能当成暂停信号（否则按 B 会莫名弹出暂停菜单）
      if (suppressAutoPause || BUYMENU.isOpen()) { suppressAutoPause = false; return; }
      // 只有「曾经锁定过又丢失」才自动暂停；从未获得锁定时不打断游戏
      if (hadLock && started && running && !paused && !matchOver) togglePause(true);
    });
    document.addEventListener('mousemove', function (e) {
      if (document.pointerLockElement !== canvas || !player || player.dead) return;
      var s = SET.sens * 0.00022 * (scoped ? 0.35 : 1);
      player.yaw -= e.movementX * s;
      player.pitch -= e.movementY * s;
      var lim = Math.PI / 2 - 0.02;
      player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
    });
    document.addEventListener('mousedown', function (e) {
      if (!started || paused) return;
      if (BUYMENU.isOpen()) return;   // 菜单开着时点击只作用于菜单
      if (e.button === 0) {
        mouse.down = true;
        // 阵亡后左键切换观战对象
        if (player && player.dead) { nextSpectate(1); updateSpectateHud(); }
      }
      if (e.button === 2) {
        mouse.rdown = true;
        if (player && !player.dead && weaponOf(player).scope) { scoped = !scoped; setScope(scoped); }
      }
    });
    document.addEventListener('mouseup', function (e) {
      if (e.button === 0) mouse.down = false;
      if (e.button === 2) mouse.rdown = false;
    });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    document.addEventListener('wheel', function (e) {
      if (!started || paused || !player || player.dead) return;
      var d = e.deltaY > 0 ? 1 : -1;
      switchWeapon((player.wi + d + player.weapons.length) % player.weapons.length);
    }, { passive: true });

    document.addEventListener('keydown', function (e) {
      var c = e.code;
      keys[c] = true;
      if (!started) return;
      if (c === 'Escape') {
        if (bigMapOpen) { toggleBigMap(); return; }
        // 菜单开着时 Esc 只关菜单并把鼠标锁回来，不进暂停
        if (BUYMENU.isOpen()) { BUYMENU.close(); requestLock(); return; }
        togglePause(); return;
      }
      if (paused) return;
      if (c === 'Tab') { e.preventDefault(); showScoreboard(true); }
      if (!player) return;
      // 阵亡后空格切换观战对象
      if (player.dead) {
        if (c === 'Space') { e.preventDefault(); nextSpectate(1); updateSpectateHud(); }
        return;
      }
      // 购买菜单优先吃掉按键（B / 数字 / 退格）
      if (BUYMENU.key(c)) {
        e.preventDefault();
        // 开菜单要放开鼠标才能点，关菜单再锁回去
        if (BUYMENU.isOpen()) releaseLock(true); else requestLock();
        return;
      }
      if (c === 'KeyR') startReload();
      if (c === 'KeyM') toggleBigMap();
      if (c === 'Digit1') selectSlot('primary');
      if (c === 'Digit2') selectSlot('secondary');
      if (c === 'Digit3') selectSlot('knife');
      if (c === 'Digit4') selectSlot('grenade', 'he');
      if (c === 'Digit5') selectSlot('grenade', 'flash');
      if (c === 'Digit6') selectSlot('grenade', 'smoke');
      if (c === 'KeyQ') switchWeapon((player.wi + 1) % player.weapons.length);
      if (c === 'Space') { if (PHYS.jump(player)) SFX.jump(0); }
    });
    document.addEventListener('keyup', function (e) {
      keys[e.code] = false;
      if (e.code === 'Tab') showScoreboard(false);
    });
  }

  function requestLock() {
    var c = document.getElementById('gl');
    if (c.requestPointerLock) c.requestPointerLock();
  }
  /* intentional=true 表示是游戏自己要释放（开购买菜单），不该触发自动暂停 */
  function releaseLock(intentional) {
    if (intentional) suppressAutoPause = true;
    if (document.exitPointerLock) document.exitPointerLock();
  }

function switchWeapon(i) {
  if (i < 0 || i >= player.weapons.length || i === player.wi) return;
  player.wi = i;
  player.reloadEnd = 0;
  player.nextFire = time + 0.28;
  player.shotsInBurst = 0;
  player.spreadPen = 0;
  scoped = false; setScope(false);
  setViewModel(player.weapons[i], player.team);
  SFX.switchWeapon();
  vmRecoil.z = -2.5;
  updateHud();
}

  function startReload() {
    var w = weaponOf(player);
    if (w.mag <= 0 || player.reloadEnd > 0) return;
    if (player.ammo[w.id] >= w.mag || player.reserve[w.id] <= 0) return;
    player.reloadEnd = time + w.reloadTime;
    SFX.reload(0);
    setTimeout(function () { if (running) SFX.reload(1); }, w.reloadTime * 400);
    setTimeout(function () { if (running) SFX.reload(2); }, w.reloadTime * 800);
  }

  function finishReload() {
    var w = weaponOf(player);
    var need = w.mag - player.ammo[w.id];
    var take = Math.min(need, player.reserve[w.id]);
    player.ammo[w.id] += take;
    player.reserve[w.id] -= take;
    player.reloadEnd = 0;
    updateHud();
  }

  function updatePlayer(dt) {
    if (player.dead) {
      deadT += dt;
      // 团队竞技：不观战，第三人称看自己尸体 + 复活进度条
      if (SET.gameMode === 'teamdm') {
        if (playerCorpse) CHAR.animate(playerCorpse.model, playerCorpse, dt);
        if (hud.progressWrap && teamDmRespawning) {
          hud.progressLabel.textContent = '复活中…';
          setProgress(1 - Math.max(0, teamDmRespawnTimer) / 3.0);
          hud.progressWrap.classList.remove('hidden');
        }
        return;
      }
      // 爆破模式：死亡后跟随队友视角
      if (deadT > 2.4 && (!spectate || spectate.dead)) {
        var mates = spectateMates();
        spectate = mates.length ? mates[Math.floor(Math.random() * mates.length)] : null;
      }
      // 观战对象换武器时更新视角模型（走缓存 + 标 id，否则会每帧重建泄漏几何体）
      if (spectate && !spectate.dead) {
        var specWi = spectate.weapons[spectate.wi];
        if (specWi && vm && vm.id !== specWi) {
          setViewModel(specWi, spectate.team);
        }
      }
      updateSpectateHud();
      return;
    }

    var w = weaponOf(player);
    if (player.reloadEnd > 0 && time >= player.reloadEnd) finishReload();

    // 移动输入（fwd = -sin,-cos；right = cos,-sin —— 面朝 -Z 时右手边是 +X）
    var fx = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    var rx = Math.cos(player.yaw), rz = -Math.sin(player.yaw);
    if (SET.invertStrafe) { rx = -rx; rz = -rz; }   // 菜单里的「左右移动反转」
    var wx = 0, wz = 0;
    if (keys['KeyW']) { wx += fx; wz += fz; }
    if (keys['KeyS']) { wx -= fx; wz -= fz; }
    if (keys['KeyA']) { wx -= rx; wz -= rz; }
    if (keys['KeyD']) { wx += rx; wz += rz; }
    var walking = keys['ShiftLeft'] || keys['ShiftRight'];
    var wantCrouch = keys['ControlLeft'] || keys['ControlRight'] || keys['KeyC'];
    if (wantCrouch) player.crouch = true;
    else if (player.crouch && PHYS.canStand(player)) player.crouch = false;

    var scale = walking ? 0.52 : 1;
    if (scoped) scale *= 0.45;
    if (phase === 'freeze') { wx = 0; wz = 0; }
    PHYS.move(player, dt, wx, wz, scale);

    // 落地
    if (player.justLanded) {
      SFX.land(0);
      if (player.landSpeed > 380) {
        var fall = Math.min(60, (player.landSpeed - 380) * 0.16);
        applyDamage(player, null, fall, false, null);
      }
      vmRecoil.y -= 1.6;
      shake(0.1, 3);
    }

    // 脚步
    var sp = Math.hypot(player.vx, player.vz);
    stepAcc += sp * dt;
    if (player.onGround && sp > 60 && stepAcc > (walking ? 130 : 105)) {
      stepAcc = 0;
      SFX.footstep(0, sp > 190 && !walking);
      // bot 听脚步
      if (!walking && sp > 150) {
        for (var i = 0; i < bots.length; i++) {
          var b = bots[i];
          if (b.dead || b.team === player.team) continue;
          var d = Math.hypot(b.x - player.x, b.z - player.z);
          if (d < 700 && !b.target && Math.random() < 0.25) {
            b.investigate = [player.x, player.z];
            b.path = null;
          }
        }
      }
    }

    // 射击
    var isNade = w.kind === 'grenade';
    if (isNade) {
      // 手雷：按下拉环，松手投出
      if (phase !== 'freeze' && mouse.down && !nadeHold) { nadeHold = true; SFX.pinPull(); vmRecoil.z = -3; }
      else if (nadeHold && !mouse.down) { nadeHold = false; throwPlayerNade(w); }
    } else if (phase !== 'freeze' && mouse.down && time >= player.nextFire && player.reloadEnd === 0) {
      if (w.kind === 'knife') {
        player.nextFire = time + 60 / w.rpm;
        meleeAttack(player, w);
        vmRecoil.z = -3; vmRecoil.x = -0.1;
      } else if (player.ammo[w.id] > 0) {
        shootPlayer(w);
        if (!w.auto) mouse.down = false;
      } else {
        player.nextFire = time + 0.35;
        SFX.reload(2);
        if (player.reserve[w.id] > 0) startReload();
      }
    }
    if (!mouse.down && time - lastShotT > 0.25) player.shotsInBurst = 0;

    // 散布惩罚回落（停火后越久越准）
    recoverSpread(player, w, dt, time - lastShotT);
    player.curSpread = spreadOf(player, w, scoped);
    // 峰值记录（供 selftest 读取，正常游戏无副作用）
    if (player.curSpread > peak.spread) peak.spread = player.curSpread;
    if (Math.abs(punch.x) > Math.abs(peak.punch)) peak.punch = punch.x;
    if (player.shotsInBurst > peak.burst) peak.burst = player.shotsInBurst;

    // 后坐力回复：开火期间回得慢（压枪要靠自己往下拉），停火后快速归位
    var back = mouse.down && time - lastShotT < 0.25 ? 3.5 : 11;
    punch.x += (0 - punch.x) * Math.min(1, dt * back);
    punch.y += (0 - punch.y) * Math.min(1, dt * back);
    if (!isFinite(punch.x)) punch.x = 0;
    if (!isFinite(punch.y)) punch.y = 0;

    // C4 安放 / 拆除
    handleBombInteract(dt);
  }

  /* 当前武器的总散布（弧度）：基础 + 移动/腾空 + 连发累积惩罚
   * 连发惩罚存在 e.spreadPen 里，由 recoverSpread() 按 w.recover 回落，
   * 所以「站在原地一直突」会越打越散，停火后又慢慢收回来。 */
  function spreadOf(e, w, isScoped) {
    var sp = Math.hypot(e.vx, e.vz);
    var s = w.spread;
    if (!e.onGround) s += w.airSpread;
    else s += w.moveSpread * Math.min(1, sp / PHYS.MAX_SPEED);
    if (e.crouch) s *= w.crouchMul;
    s += e.spreadPen || 0;
    if (isScoped) s *= 0.12;
    return s;
  }

  /* 散布惩罚回落 + 连发计数衰减
   * 两个要点：
   * 1) 开火后 0.18 秒内不回落。否则「每发加的量」和「两发之间回落的量」几乎相等，
   *    连发惩罚会被抵消掉，扫射永远打在一个点上（这个坑很隐蔽，靠自检才抓出来）。
   * 2) recover 当成相对速度用：spreadMax * recover * 2.2 (弧度/秒)，
   *    各枪都是「打满上限后约 1.2~1.8 秒恢复到基础精度」。 */
  function recoverSpread(e, w, dt, sinceShot) {
    if (!(e.spreadPen > 0)) { e.spreadPen = 0; return; }
    if (sinceShot < 0.18) return;
    e.spreadPen = Math.max(0, e.spreadPen - w.spreadMax * w.recover * 2.2 * dt);
    if (e.spreadPen === 0) e.shotsInBurst = 0;
  }

  /* 沿视线方向按散布抖动出一条弹道 */
  function spreadDir(yaw, pit, spread) {
    var cp = Math.cos(pit);
    var fx = -Math.sin(yaw) * cp, fy = Math.sin(pit), fz = -Math.cos(yaw) * cp;
    var rx = Math.cos(yaw), ry = 0, rz = -Math.sin(yaw);
    var ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
    var a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spread;
    var ox = Math.cos(a) * r, oy = Math.sin(a) * r;
    var dx = fx + rx * ox + ux * oy;
    var dy = fy + ry * ox + uy * oy;
    var dz = fz + rz * ox + uz * oy;
    var l = Math.hypot(dx, dy, dz) || 1;
    return [dx / l, dy / l, dz / l];
  }

  function shootPlayer(w) {
    var t = time;
    player.nextFire = t + 60 / w.rpm;
    player.ammo[w.id]--;
    player.shotsInBurst++;
    lastShotT = t;

    var spread = spreadOf(player, w, scoped);
    player.curSpread = spread;

    var yaw = player.yaw + punch.y, pit = player.pitch + punch.x;
    var ox = player.x, oy = eyeY(player), oz = player.z;
    var pellets = w.pellets || 1;
    var firstDir = null;
    for (var i = 0; i < pellets; i++) {
      var d = spreadDir(yaw, pit, spread);
      if (!firstDir) firstDir = d;
      // 霰弹只在第一颗弹丸播枪声，避免 9 个音源同时炸开
      fireBullet(player, ox, oy, oz, d[0], d[1], d[2], w, i > 0);
    }
    // 联机：把这一发交给房主回溯判定（走可靠通道，不可丢）
    if (netMode && firstDir) netReportShot(w, ox, oy, oz, firstDir[0], firstDir[1], firstDir[2]);

    // 连发散布惩罚：越往后每一发加得越多（ramp），到 spreadMax 封顶
    var n = player.shotsInBurst;
    player.spreadPen = Math.min(w.spreadMax,
      (player.spreadPen || 0) + w.perShot * (1 + (n - 1) * w.ramp));

    // 视角后坐力：垂直为主（recoilV），水平左右抖（recoilH），连发放大
    var ramp = 1 + (n - 1) * w.ramp;
    var kick = w.recoilV * ramp * (player.crouch ? 0.75 : 1) * (scoped ? 0.7 : 1);
    punch.x += kick;                                    // 正值 = 视角上抬
    punch.y += (Math.random() - 0.5) * 2 * w.recoilH * ramp;
    if (!isFinite(punch.x)) punch.x = 0;
    if (!isFinite(punch.y)) punch.y = 0;
    vmRecoil.z = -w.kickBack;
    vmRecoil.x = -kick * 1.4;
    shake(0.05, w.kickBack * 0.35);

    // 枪口火焰 / 弹壳
    effects.vmFlash(vm);
    if (w.kind !== 'knife') effects.shell(player, camera);
    updateHud();
  }

  /* 投出手雷：右键是轻抛，左键是远投 */
  function throwPlayerNade(w) {
    if ((player.nades[w.id] || 0) <= 0) { SFX.buyFail(); return; }
    var yaw = player.yaw + punch.y, pit = player.pitch + punch.x;
    var cp = Math.cos(pit);
    var dx = -Math.sin(yaw) * cp, dy = Math.sin(pit), dz = -Math.cos(yaw) * cp;
    var power = mouse.rdown ? 330 : 780;
    NADE.throwGrenade(player, w.id, dx, dy, dz, power);
    player.nades[w.id]--;
    vmRecoil.z = -6; vmRecoil.x = -0.12;
    if (player.nades[w.id] <= 0) {
      // 用完就从武器栏里去掉，切回主武器
      var i = player.weapons.indexOf(w.id);
      if (i >= 0) {
        player.weapons.splice(i, 1);
        delete player.ammo[w.id]; delete player.reserve[w.id];
        var back = slotIndex(player, 'primary');
        if (back < 0) back = slotIndex(player, 'secondary');
        if (back < 0) back = slotIndex(player, 'knife');
        player.wi = Math.max(0, back);
        setViewModel(player.weapons[player.wi]);
      }
    }
    player.nextFire = time + 0.6;
    updateHud();
  }

  function handleBombInteract(dt) {

    var pressing = keys['KeyE'];
    var label = hud.progressLabel;
    var show = false;
    // 联机客户端：只上报按键，进度由房主推进后下发（避免两边各算一套）
    var client = netMode && !netIsHost();
    if (client) netSendHold(!!pressing);
    var amCarrier = client ? netIsCarrier : (carrier === player);
    // 安放 / 拆除的提示音按固定节奏播（原来每帧随机触发，节奏散乱又太短，听着像只响了一下）
    var ticking = false, tickProgress = 0;
    if (player.team === 'T' && !bomb.planted && amCarrier) {
      var site = getMapModule().siteAt(player.x, player.z);
      if (site && player.onGround) {
        show = true;
        var pProg = client ? netHostPlantProgress : plantProgress;
        label.textContent = pressing
          ? '安放 C4… ' + Math.max(0, (1 - pProg) * 3).toFixed(1) + 's'
          : '按住 [E] 安放 C4';
        if (pressing && Math.hypot(player.vx, player.vz) < 40) {
          if (!client) {
            plantProgress += dt / 3.0;
            if (plantProgress >= 1) { plantBomb(player); show = false; }
          }
          ticking = true; tickProgress = pProg;
        } else if (!client) plantProgress = Math.max(0, plantProgress - dt);
        setProgress(client ? netHostPlantProgress : plantProgress);
      } else if (!client) plantProgress = 0;
    } else if (player.team === 'CT' && bomb.planted) {
      var d = Math.hypot(player.x - bomb.pos[0], player.z - bomb.pos[1]);
      if (d < 85) {
        show = true;
        // 拆弹器：10 秒 → 5 秒
        var need = player.defuser ? 5.0 : 10.0;
        var dProg = client ? netHostDefuseProgress : defuseProgress;
        label.textContent = pressing
          ? '正在拆除… ' + Math.max(0, (1 - dProg) * need).toFixed(1) + 's' +
            (player.defuser ? '（拆弹器）' : '')
          : '按住 [E] 拆除炸弹' + (player.defuser ? '（拆弹器 5s）' : '（10s）');
        if (pressing && Math.hypot(player.vx, player.vz) < 40) {
          if (!client) {
            defuseProgress += dt / need;
            if (defuseProgress >= 1) { defuseBomb(player); show = false; }
          }
          ticking = true; tickProgress = dProg;
        } else if (!client) defuseProgress = Math.max(0, defuseProgress - dt * 0.6);
        setProgress(client ? netHostDefuseProgress : defuseProgress);
      } else if (!client) defuseProgress = 0;
    }
    if (ticking) {
      tickT -= dt;
      if (tickT <= 0) { tickT = 0.25; SFX.defuseTick(tickProgress); }
    } else tickT = 0;
    // 要切换的是最外层的 #progressWrap。
    // 原来写的是 #progress 的 parentNode（那其实是 #progressBar），
    // 而 #progressWrap 在 newRound 里被加了 hidden 之后再没人摘掉 —— 进度条于是永远不显示。
    hud.progressWrap.classList.toggle('hidden', !show);
  }
  function setProgress(v) {
    hud.progress.style.width = Math.max(0, Math.min(1, v)) * 100 + '%';
  }

  /* ================================================================
   *  摄像机 / 视角模型
   * ================================================================ */
  function updateCamera(dt) {
    // 团队竞技：玩家死亡时第三人称看自己尸体，不观战
    if (player.dead && SET.gameMode === 'teamdm') {
      var dist = 110, height = 70;
      var bx = player.x + Math.sin(player.yaw) * dist;   // 身后
      var bz = player.z + Math.cos(player.yaw) * dist;
      camera.position.set(bx, player.y + height, bz);
      camera.lookAt(player.x, player.y + 26, player.z);
      if (vm) vm.root.visible = false;   // 死亡时不显示第一人称武器
      return;
    }
    var src = player;
    if (player.dead && spectate && !spectate.dead) src = spectate;

    // 观战时把被观战者自己的模型藏起来，否则他的头盔 / 护目镜 / 枪就糊在镜头上，
    // 抬头低头会被自己的身体挡住（这是「观战视角上下被遮挡」的原因）
    setSpectateHidden(src === player ? null : src);

    // 观战用被观战者的真实眼高（bot 站 58 / 蹲 30，与 Bot.eyeY 一致）
    var ey = src === player ? eyeY(player) : (src.y + (src.crouch ? 30 : 58));
    var camY = ey;
    if (player.dead && src === player) camY = player.y + 22;

    // 行走呼吸感
    var sp = Math.hypot(src.vx, src.vz);
    if (!player.dead) {
      vmBob += dt * sp * 0.021;
      camY += Math.sin(vmBob * 2) * Math.min(1.6, sp / 250 * 1.6);
    }

    // 屏幕震动
    var shx = 0, shy = 0;
    if (shakeT > 0) {
      shakeT -= dt;
      var m = shakeMag * Math.max(0, shakeT / 0.2);
      shx = (Math.random() - 0.5) * m; shy = (Math.random() - 0.5) * m;
    }

    camera.position.set(src.x + shx, camY + shy, src.z);
    camera.rotation.y = src.yaw + (src === player ? punch.y : 0);
    camera.rotation.x = src.pitch + (src === player ? punch.x : 0);
    camera.rotation.z = 0;
    // 兜底：任何一个 NaN 传进相机就会让整个投影矩阵失效，屏幕上只剩清屏色
    // （看起来就像「地板变透明了」），所以这里硬性拦一道
    if (!isFinite(camera.position.x) || !isFinite(camera.position.y) || !isFinite(camera.position.z)) {
      camera.position.set(src.x || 0, (src.y || 0) + 64, src.z || 0);
    }
    if (!isFinite(camera.rotation.x)) camera.rotation.x = 0;
    if (!isFinite(camera.rotation.y)) camera.rotation.y = 0;

    var wantFov = scoped ? 28 : SET.fov;
    if (Math.abs(camera.fov - wantFov) > 0.2) {
      camera.fov += (wantFov - camera.fov) * Math.min(1, dt * 16);
      camera.updateProjectionMatrix();
    }

    // 视角模型：摆动 + 后坐 + 换弹动作
    if (vm) {
      // 观战队友时也显示武器模型（用被观战者持有的武器）
      var vmVisible = !scoped && (player.dead ? (!!spectate && !spectate.dead && spectate !== player) : true);
      vm.root.visible = vmVisible;
      var vmSrc = (player.dead && spectate && !spectate.dead) ? spectate : player;
      var swayTarget = 0;
      var vmSp = Math.hypot(vmSrc.vx, vmSrc.vz);
      vmSwayX += ((vmSp / 250) * Math.sin(vmBob) * 0.5 - vmSwayX) * Math.min(1, dt * 8);
      vmSwayY += ((vmSp / 250) * Math.abs(Math.cos(vmBob)) * 0.55 - vmSwayY) * Math.min(1, dt * 8);
      vmRecoil.z += (0 - vmRecoil.z) * Math.min(1, dt * 12);
      vmRecoil.x += (0 - vmRecoil.x) * Math.min(1, dt * 10);

      var reloadOff = 0, reloadRot = 0;
      if (vmSrc.reloadEnd > 0) {
        var w = weaponOf(vmSrc);
        var pr = 1 - (vmSrc.reloadEnd - time) / w.reloadTime;
        var s = Math.sin(Math.min(1, Math.max(0, pr)) * Math.PI);
        reloadOff = -s * 4.5; reloadRot = s * 0.9;
      }
      vm.root.position.set(vm.base.x + vmSwayX, vm.base.y + vmSwayY + reloadOff + vmRecoil.x * 6, vm.base.z + vmRecoil.z);
      vm.root.rotation.set(0.02 + vmRecoil.x + reloadRot, 0.04 - vmSwayX * 0.06, -vmSwayX * 0.05);
    }
  }

  function shake(t, m) { shakeT = Math.max(shakeT, t); shakeMag = Math.max(shakeMag, m); }

  /* 闪光白屏：先纯白，再随剩余时间淡出 */
  function updateBlind(dt) {
    if (!hud.flashblind) return;
    if (blindT <= 0) { hud.flashblind.style.opacity = 0; return; }
    blindT = Math.max(0, blindT - dt);
    var k = blindT / blindMax;                 // 1 → 0
    var op = k > 0.75 ? 1 : Math.pow(k / 0.75, 1.3);
    hud.flashblind.style.opacity = op.toFixed(3);
    // bot 的致盲计时
  }

  /* ---------------- 观战 ---------------- */
  var spectateHidden = null;

  function setSpectateHidden(e) {
    if (spectateHidden === e) return;
    /* 恢复上一个观战目标（无论死活） */
    if (spectateHidden && spectateHidden.model) spectateHidden.model.group.visible = true;
    spectateHidden = e;
    if (e && e.model) e.model.group.visible = false;
  }

  /* 恢复所有被隐藏的模型（回合开始 / 复活时调用） */
  function clearSpectateHidden() {
    if (spectateHidden && spectateHidden.model) spectateHidden.model.group.visible = true;
    spectateHidden = null;
  }

  function spectateMates() {
    return (player.team === 'T' ? tList : ctList).filter(function (e) { return !e.dead && !e.isPlayer; });
  }

  /* 切换观战对象（左键 / 空格） */
  function nextSpectate(dir) {
    var mates = spectateMates();
    if (!mates.length) { spectate = null; return; }
    var i = mates.indexOf(spectate);
    spectate = mates[((i < 0 ? 0 : i + (dir || 1)) + mates.length) % mates.length];
  }

  function updateSpectateHud() {
    var el = hud.deadmsg;
    if (!player.dead) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    var who = spectate && !spectate.dead ? spectate.name : null;
    el.innerHTML = who
      ? '你已阵亡<small>观战：' + esc(who) + '　[左键 / 空格 / 点击屏幕] 切换视角</small>'
      : '你已阵亡<small>等待本回合结束…</small>';
  }

  /* ================================================================
   *  特效
   * ================================================================ */
  function makeEffects() {
    var decalNormal = new THREE.Vector3();
    var decalFwd = new THREE.Vector3(0, 0, 1);
    var decals = [], decalI = 0, DECAL_N = 110;
    var holeMat = new THREE.MeshBasicMaterial({
      map: tex.hole, transparent: true, depthWrite: false, opacity: 0.95,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    for (var i = 0; i < DECAL_N; i++) {
      var m = new THREE.Mesh(new THREE.PlaneGeometry(13, 13), holeMat);
      m.visible = false; m.renderOrder = 2;
      scene.add(m); decals.push(m);
    }

    var parts = [], PART_N = 190;
    for (i = 0; i < PART_N; i++) {
      var mat = new THREE.SpriteMaterial({ map: tex.smoke, transparent: true, depthWrite: false, opacity: 1 });
      var s = new THREE.Sprite(mat);
      s.visible = false;
      scene.add(s);
      parts.push({ s: s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grav: 0, size0: 1, size1: 1, fade: 1 });
    }
    var pi = 0;

    var tracers = [], TR_N = 26;
    var trMat = new THREE.MeshBasicMaterial({ color: 0xffe9a0, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
    for (i = 0; i < TR_N; i++) {
      var t = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), trMat);
      t.visible = false;
      scene.add(t);
      tracers.push({ m: t, life: 0 });
    }
    var tri = 0;

    var shells = [], SH_N = 24;
    for (i = 0; i < SH_N; i++) {
      var sh = WEAPONS.makeShell();
      sh.visible = false;
      scene.add(sh);
      shells.push({ m: sh, life: 0, vx: 0, vy: 0, vz: 0, rx: 0, ry: 0 });
    }
    var shi = 0;

    var wf = [], WF_N = 10;
    for (i = 0; i < WF_N; i++) {
      var fm = new THREE.SpriteMaterial({ map: tex.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
      var fs = new THREE.Sprite(fm);
      fs.scale.set(34, 34, 1);
      fs.visible = false;
      scene.add(fs);
      wf.push({ s: fs, life: 0 });
    }
    var wfi = 0;

    function spawnPart(x, y, z, texture, size0, size1, life, vx, vy, vz, grav, additive, color) {
      var p = parts[pi = (pi + 1) % parts.length];
      p.s.material.map = texture;
      p.s.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
      p.s.material.opacity = 1;
      p.s.material.color.setHex(color === undefined ? 0xffffff : color);
      p.s.material.needsUpdate = true;
      p.s.position.set(x, y, z);
      p.s.scale.set(size0, size0, 1);
      p.s.visible = true;
      p.life = life; p.max = life;
      p.vx = vx; p.vy = vy; p.vz = vz; p.grav = grav;
      p.size0 = size0; p.size1 = size1;
      return p;
    }

    return {
      impact: function (x, y, z, nx, ny, nz) {
        // 弹孔：用四元数对齐法线（lookAt 在法线与 up 平行时会退化成非法矩阵，
        // 那会让贴花变成一块横跨屏幕的黑面，看起来像“地板透明”）
        var d = decals[decalI = (decalI + 1) % decals.length];
        decalNormal.set(nx, ny, nz).normalize();
        d.quaternion.setFromUnitVectors(decalFwd, decalNormal);
        d.rotateZ(Math.random() * 6.283);
        d.position.set(x + decalNormal.x * 0.8, y + decalNormal.y * 0.8, z + decalNormal.z * 0.8);
        var sc = 0.7 + Math.random() * 0.6;
        d.scale.set(sc, sc, 1);
        d.visible = true;
        // 灰尘 + 火花
        for (var i = 0; i < 3; i++) {
          spawnPart(x + nx * 2, y + ny * 2, z + nz * 2, tex.smoke, 6, 26, 0.45 + Math.random() * 0.3,
            nx * 40 + (Math.random() - 0.5) * 50, ny * 40 + Math.random() * 40 + 15, nz * 40 + (Math.random() - 0.5) * 50,
            -30, false, 0xbfae8c);
        }
        for (i = 0; i < 4; i++) {
          spawnPart(x + nx * 2, y + ny * 2, z + nz * 2, tex.spark, 3.4, 0.6, 0.22 + Math.random() * 0.18,
            nx * 150 + (Math.random() - 0.5) * 220, ny * 150 + Math.random() * 160, nz * 150 + (Math.random() - 0.5) * 220,
            -420, true);
        }
      },
      blood: function (x, y, z, dx, dy, dz) {
        for (var i = 0; i < 7; i++) {
          spawnPart(x, y, z, tex.blood, 5 + Math.random() * 5, 14, 0.4 + Math.random() * 0.35,
            dx * 90 + (Math.random() - 0.5) * 130, dy * 60 + Math.random() * 90, dz * 90 + (Math.random() - 0.5) * 130,
            -300, false, 0x8a0d0d);
        }
      },
      explosion: function (x, y, z) {
        for (var i = 0; i < 26; i++) {
          spawnPart(x, y, z, tex.smoke, 40, 400, 1.4 + Math.random() * 1.2,
            (Math.random() - 0.5) * 420, Math.random() * 320, (Math.random() - 0.5) * 420,
            -60, false, 0x3a3a3a);
        }
        for (i = 0; i < 20; i++) {
          spawnPart(x, y, z, tex.spark, 60, 8, 0.5 + Math.random() * 0.4,
            (Math.random() - 0.5) * 900, Math.random() * 600, (Math.random() - 0.5) * 900,
            -300, true, 0xffb040);
        }
        spawnPart(x, y + 40, z, tex.flash, 300, 700, 0.35, 0, 0, 0, 0, true, 0xffd070);
      },
      tracer: function (ox, oy, oz, ex, ey, ez, fromPlayer) {
        var t = tracers[tri = (tri + 1) % tracers.length];
        var dx = ex - ox, dy = ey - oy, dz = ez - oz;
        var len = Math.hypot(dx, dy, dz);
        if (len < 30) { t.m.visible = false; return; }
        var mx = (ox + ex) / 2, my = (oy + ey) / 2, mz = (oz + ez) / 2;
        t.m.position.set(mx, my, mz);
        t.m.scale.set(fromPlayer ? 1.1 : 1.6, fromPlayer ? 1.1 : 1.6, len);
        t.m.lookAt(ex, ey, ez);
        t.m.visible = true;
        t.life = 0.055;
      },
      worldFlash: function (x, y, z) {
        var f = wf[wfi = (wfi + 1) % wf.length];
        f.s.position.set(x, y, z);
        f.s.scale.set(30 + Math.random() * 14, 30 + Math.random() * 14, 1);
        f.s.material.rotation = Math.random() * 6.28;
        f.s.visible = true;
        f.life = 0.05;
      },
      /* 闪光弹爆点的强光（比枪口火焰大得多） */
      flashPop: function (x, y, z) {
        spawnPart(x, y, z, tex.flash, 260, 620, 0.45, 0, 0, 0, 0, true, 0xffffff);
        for (var i = 0; i < 10; i++) {
          spawnPart(x, y, z, tex.spark, 30, 4, 0.35 + Math.random() * 0.25,
            (Math.random() - 0.5) * 500, Math.random() * 300, (Math.random() - 0.5) * 500, -260, true, 0xfff2c0);
        }
      },
      makeVmFlash: function () {
        var m = new THREE.SpriteMaterial({ map: tex.flash, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
        var s = new THREE.Sprite(m);
        s.scale.set(5, 5, 1);
        s.visible = false;
        s.position.set(0, 0, -1.5);
        return s;
      },
      vmFlash: function (v) {
        if (!v || !v.flash) return;
        v.flash.visible = true;
        v.flash.material.rotation = Math.random() * 6.28;
        var sc = 4 + Math.random() * 3;
        v.flash.scale.set(sc, sc, 1);
        v.flashT = 0.045;
      },
      shell: function (p, cam) {
        var s = shells[shi = (shi + 1) % shells.length];
        var right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        var fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        s.m.position.set(p.x + right.x * 14 + fwd.x * 18, eyeY(p) - 6, p.z + right.z * 14 + fwd.z * 18);
        s.m.visible = true;
        s.vx = right.x * 110 + (Math.random() - 0.5) * 40 + p.vx;
        s.vz = right.z * 110 + (Math.random() - 0.5) * 40 + p.vz;
        s.vy = 90 + Math.random() * 60;
        s.rx = Math.random() * 12; s.ry = Math.random() * 12;
        s.life = 1.6;
      },
      update: function (dt) {
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          if (p.life <= 0) continue;
          p.life -= dt;
          if (p.life <= 0) { p.s.visible = false; continue; }
          p.vy += p.grav * dt;
          p.s.position.x += p.vx * dt;
          p.s.position.y += p.vy * dt;
          p.s.position.z += p.vz * dt;
          var k = 1 - p.life / p.max;
          var sz = p.size0 + (p.size1 - p.size0) * k;
          p.s.scale.set(sz, sz, 1);
          p.s.material.opacity = Math.max(0, 1 - k * k);
        }
        for (i = 0; i < tracers.length; i++) {
          if (tracers[i].life > 0) {
            tracers[i].life -= dt;
            if (tracers[i].life <= 0) tracers[i].m.visible = false;
          }
        }
        for (i = 0; i < wf.length; i++) {
          if (wf[i].life > 0) {
            wf[i].life -= dt;
            if (wf[i].life <= 0) wf[i].s.visible = false;
          }
        }
        for (i = 0; i < shells.length; i++) {
          var s = shells[i];
          if (s.life <= 0) continue;
          s.life -= dt;
          if (s.life <= 0) { s.m.visible = false; continue; }
          s.vy -= 700 * dt;
          s.m.position.x += s.vx * dt;
          s.m.position.y += s.vy * dt;
          s.m.position.z += s.vz * dt;
          s.m.rotation.x += s.rx * dt; s.m.rotation.y += s.ry * dt;
          if (s.m.position.y < 1.5) { s.m.position.y = 1.5; s.vy = -s.vy * 0.3; s.vx *= 0.6; s.vz *= 0.6; }
        }
        if (vm && vm.flashT > 0) {
          vm.flashT -= dt;
          if (vm.flashT <= 0) vm.flash.visible = false;
        }
      },
      clear: function () {
        for (var i = 0; i < decals.length; i++) decals[i].visible = false;
        for (i = 0; i < parts.length; i++) { parts[i].life = 0; parts[i].s.visible = false; }
        for (i = 0; i < shells.length; i++) { shells[i].life = 0; shells[i].m.visible = false; }
        for (i = 0; i < tracers.length; i++) { tracers[i].life = 0; tracers[i].m.visible = false; }
      }
    };
  }

  /* ================================================================
   *  HUD
   * ================================================================ */
  function cacheHud() {
    ['hp', 'armor', 'ammoCur', 'ammoRes', 'wname', 'roundTime', 'scoreT', 'scoreCT',
      'aliveT', 'aliveCT', 'killfeed', 'radiofeed', 'hitmarker', 'crosshair', 'locname', 'bombhud',
      'bombtime', 'banner', 'scoreboard', 'pause', 'deadmsg', 'flash', 'scope',
      'sbBody', 'dmgdir', 'money', 'moneypop', 'kititems', 'buyhint', 'nadeicons',
      'flashblind', 'progressWrap', 'progress', 'progressLabel',
      'playerNameDisplay', 'btnRename'].forEach(function (id) {
        hud[id] = document.getElementById(id);
      });
  }

  /* 钱数变动的小飘字 */
  function moneyPop(text) {
    if (!hud.moneypop) return;
    hud.moneypop.textContent = text;
    hud.moneypop.style.opacity = 1;
    clearTimeout(moneyPop._t);
    moneyPop._t = setTimeout(function () { hud.moneypop.style.opacity = 0; }, 1400);
  }
  /* 更新玩家名字显示 */
  function updatePlayerNameDisplay() {
    if (!player) return;
    if (hud.playerNameDisplay) {
      hud.playerNameDisplay.textContent = player.name;
      hud.playerNameDisplay.style.color = player.team === 'T' ? '#ffb44a' : '#6fa8ff';
    }
  }
  /* 回合结算提示（跟主横幅错开显示） */
  function banner2(text) { moneyPop(text); }

  function updateHud() {
    if (!player) return;
    updatePlayerNameDisplay();
    if (hud.btnRename && started) hud.btnRename.style.display = 'inline';
    else if (hud.btnRename) hud.btnRename.style.display = 'none';
    hud.hp.textContent = Math.max(0, player.health);
    hud.armor.textContent = Math.max(0, Math.round(player.armor));
    hud.armor.parentNode.style.opacity = player.armor > 0 ? 1 : 0.35;
    if (hud.money) hud.money.textContent = '$' + (player.money || 0);
    var w = weaponOf(player);
    hud.wname.textContent = w.name;
    if (w.kind === 'grenade') {
      hud.ammoCur.textContent = (player.nades[w.id] || 0);
      hud.ammoRes.textContent = '颗';
    } else if (w.mag > 0) {
      hud.ammoCur.textContent = player.ammo[w.id];
      hud.ammoRes.textContent = '/ ' + player.reserve[w.id];
    } else {
      hud.ammoCur.textContent = '—';
      hud.ammoRes.textContent = '';
    }
    // 装备栏：头盔 / 拆弹器 / 手雷
    if (hud.kititems) {
      var kit = [];
      if (player.helmet) kit.push('<span title="头盔">⛑ 头盔</span>');
      if (player.defuser) kit.push('<span title="拆弹器" style="color:#7ee38a">✂ 拆弹器</span>');
      var nn = [];
      if (player.nades.he) nn.push('HE×' + player.nades.he);
      if (player.nades.flash) nn.push('闪×' + player.nades.flash);
      if (player.nades.smoke) nn.push('烟×' + player.nades.smoke);
      if (nn.length) kit.push('<span style="color:#cfe2a0">' + nn.join(' ') + '</span>');
      hud.kititems.innerHTML = kit.join('　');
    }
    // 购买提示
    if (hud.buyhint) {
      var st = buyState();
      hud.buyhint.textContent = st.ok ? '按 [B] 购买' : '';
      hud.buyhint.classList.toggle('hidden', !st.ok);
    }
    hud.scoreT.textContent = score.T;
    hud.scoreCT.textContent = score.CT;
    hud.aliveT.textContent = aliveCount(tList);
    hud.aliveCT.textContent = aliveCount(ctList);
    hud.hp.parentNode.style.color = player.health < 30 ? '#ff6b5a' : '';
    if (BUYMENU.isOpen()) BUYMENU.render();     // 钱数变了就刷新菜单里的价格颜色
  }

  function updateClockHud(dt) {
    var t = Math.max(0, Math.ceil(bomb.planted ? bomb.timer : roundClock));
    var mm = Math.floor(t / 60), ss = t % 60;
    hud.roundTime.textContent = mm + ':' + (ss < 10 ? '0' : '') + ss;
    hud.roundTime.style.color = bomb.planted ? '#ff5a3c' : (t < 20 ? '#ffd24a' : '');
    if (bomb.planted) hud.bombtime.textContent = Math.max(0, bomb.timer).toFixed(1);
    var loc = MAP.areaAt(player.x, player.z);
    hud.locname.textContent = LOC_NAMES[loc] || '';
    // 准星开合 = 真实散布角在屏幕上的投影半径（像素）
    var w = weaponOf(player);
    var spread = player.curSpread === undefined ? spreadOf(player, w, scoped) : player.curSpread;
    var pxPerRad = (window.innerHeight / 2) / Math.tan(camera.fov * Math.PI / 360);
    var gap = 3 + spread * pxPerRad;
    hud.crosshair.style.setProperty('--gap', Math.min(40, gap).toFixed(1) + 'px');
    // 购买提示按帧刷新（走出购买区 / 超时后立刻消失）
    if (hud.buyhint) {
      var bs = buyState();
      hud.buyhint.textContent = bs.ok ? '按 [B] 购买' : '';
      hud.buyhint.classList.toggle('hidden', !bs.ok);
      // 购买时间结束或离开出生区就自动关掉菜单
      if (!bs.ok && BUYMENU.isOpen()) { BUYMENU.close(); requestLock(); }
    }
  }

  var LOC_NAMES = {
    T_SPAWN: 'T 出生点', CT_SPAWN: 'CT 出生点', TUNNEL_OUT: '隧道口外', TUNNEL_UP: '上层隧道',
    B_SITE: 'B 包点', B_DOOR: 'B 门', CT_TOP: 'CT 通道', MID_LOW: '中路', MID_DOOR: '中门',
    MID_UP: '中路上段', CT_MID: 'CT 中路', CATWALK: '小道', A_SITE: 'A 包点',
    LONG_A: '长通道', LONG_HALL: '长道大厅', LONG_DOOR: '长通道大门', PIT: '坑'
  };

  function banner(text, dur, color) {
    hud.banner.textContent = text;
    hud.banner.style.color = color || '#ffe9a8';
    hud.banner.classList.remove('hidden');
    hud.banner.style.opacity = 1;
    clearTimeout(banner._t);
    banner._t = setTimeout(function () {
      hud.banner.style.opacity = 0;
      setTimeout(function () { hud.banner.classList.add('hidden'); }, 400);
    }, dur * 1000);
  }

  function addKillfeed(killer, weapon, victim, headshot, plain, kTeam, vTeam) {
    var row = document.createElement('div');
    row.className = 'kfrow';
    if (plain) {
      row.innerHTML = '<span class="k' + (killer === player.name ? ' me' : '') + '">' + esc(killer) + '</span> ' + esc(weapon);
    } else {
      row.innerHTML = '<span class="k ' + (kTeam === 'T' ? 'tt' : 'ct') + (killer === player.name ? ' me' : '') + '">' + esc(killer) + '</span>' +
        '<span class="w">' + esc(weapon) + (headshot ? ' ✱' : '') + '</span>' +
        '<span class="v ' + (vTeam === 'T' ? 'tt' : 'ct') + (victim === player.name ? ' me' : '') + '">' + esc(victim) + '</span>';
    }
    hud.killfeed.appendChild(row);
    setTimeout(function () {
      row.style.opacity = 0;
      setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 500);
    }, 4200);
    while (hud.killfeed.children.length > 6) hud.killfeed.removeChild(hud.killfeed.firstChild);
  }
  function esc(s) { return String(s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; }); }

  /* ---------------- 战术语音（左侧播报，最多同时 4 条） ----------------
   * 内容全部来自真实状态：buyPhase 记录的购买清单、carrier/defendSite 的实际去向。 */
  function addRadio(name, team, text) {
    var feed = hud.radiofeed;
    if (!feed) return;
    var row = document.createElement('div');
    row.className = 'rrow';
    row.innerHTML = '<span class="rn" style="color:' + (team === 'T' ? '#ffb44a' : '#6fa8ff') + '">' +
      esc(name) + '</span>: &quot;' + esc(text) + '&quot;';
    feed.appendChild(row);
    while (feed.children.length > 4) feed.removeChild(feed.firstChild);
    setTimeout(function () {
      row.style.opacity = 0;
      setTimeout(function () { if (row.parentNode) row.parentNode.removeChild(row); }, 700);
    }, 6500);
  }

  /* 回合开场：从真实状态里抽最多 4 条播出（购买 / 去向），间隔错开。
   * 无线电分队：只播玩家自己队伍的通讯，敌方通话听不到。 */
  function roundStartRadio() {
    if (SET.gameMode === 'teamdm') return;
    var myTeam = player ? player.team : SET.team;
    var pool = [];
    var siteName = targetSite ? targetSite.name : 'A';
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (b.dead || b.team !== myTeam) continue;
      if (b.bought && b.bought.length) {
        pool.push({ n: b.name, t: b.team, m: '已购买 ' + b.bought.slice(0, 2).join('、') });
      }
      if (b.team === 'T') {
        if (carrier === b) pool.push({ n: b.name, t: b.team, m: '携带C4前往' + siteName + '区' });
        else if (Math.random() < 0.5) pool.push({ n: b.name, t: b.team, m: '正在前往' + siteName + '区' });
      } else {
        if (Math.random() < 0.6) {
          pool.push({ n: b.name, t: b.team, m: '前往' + (b.defendSite ? b.defendSite.name : 'A') + '区布防' });
        }
      }
    }
    shuffle(pool);
    var count = Math.min(4, pool.length);
    for (var k = 0; k < count; k++) {
      (function (item, delay) {
        setTimeout(function () { if (running) addRadio(item.n, item.t, item.m); }, delay);
      })(pool[k], 1100 + k * 450);
    }
  }

  function showHitmarker() {
    hud.hitmarker.style.opacity = 1;
    clearTimeout(showHitmarker._t);
    showHitmarker._t = setTimeout(function () { hud.hitmarker.style.opacity = 0; }, 110);
  }

  function damageFlash(dmg) {
    hud.flash.style.opacity = Math.min(0.65, 0.16 + dmg / 90);
    clearTimeout(damageFlash._t);
    damageFlash._t = setTimeout(function () { hud.flash.style.opacity = 0; }, 130);
  }

  function showDamageDir(x, z) {
    var dx = x - player.x, dz = z - player.z;
    var ang = Math.atan2(dx, -dz) - player.yaw;   // 相对角度
    var el = document.createElement('div');
    el.className = 'dmgarrow';
    el.style.transform = 'rotate(' + (-ang * 180 / Math.PI) + 'deg)';
    hud.dmgdir.appendChild(el);
    setTimeout(function () {
      el.style.opacity = 0;
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 400);
    }, 700);
  }

  function setBombHud(on) {
    hud.bombhud.classList.toggle('hidden', !on);
  }
  function setScope(on) {
    hud.scope.classList.toggle('hidden', !on);
  }

  function showScoreboard(on) {
    hud.scoreboard.classList.toggle('hidden', !on);
    if (!on) return;
    var rows = [];
    function line(e) {
      return '<tr class="' + (e.team === 'T' ? 'tt' : 'ct') + (e.isPlayer ? ' me' : '') + (e.dead ? ' dead' : '') + '">' +
        '<td>' + esc(e.name) + (e.isBot ? ' <i>BOT</i>' : '') + '</td>' +
        '<td>' + e.kills + '</td><td>' + e.deaths + '</td>' +
        '<td>' + (e.dead ? '阵亡' : Math.max(0, e.health)) + '</td>' +
        '<td>$' + (e.money || 0) + '</td></tr>';
    }
    var sortFn = function (a, b) { return b.kills - a.kills; };
    var ct = ctList.slice().sort(sortFn), tt = tList.slice().sort(sortFn);
    var html = '<table><tr class="hdr"><th>反恐精英 ' + score.CT + '</th><th>K</th><th>D</th><th>HP</th><th>$</th></tr>';
    for (var i = 0; i < ct.length; i++) html += line(ct[i]);
    html += '<tr class="gap"><td colspan="5"></td></tr>';
    html += '<tr class="hdr"><th>恐怖分子 ' + score.T + '</th><th>K</th><th>D</th><th>HP</th><th>$</th></tr>';
    for (i = 0; i < tt.length; i++) html += line(tt[i]);
    html += '</table>';
    hud.sbBody.innerHTML = html;
  }

  /* ---------------- 友军头顶名字 ----------------
   *  只给同阵营单位（bot + 联机队友）显示；
   *  近距离完全显示，越远越透明，超过距离后隐藏。
   * ================================================================ */
  var nameplates = new Map();   // 实体 → { sprite }
  var NAMEPLATE_NEAR = 500;     // 此距离内完全不透明
  var NAMEPLATE_FAR = 2400;     // 此距离之外完全隐藏

  function makeNameplate(name) {
    var cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    var x = cv.getContext('2d');
    x.font = 'bold 28px "Microsoft YaHei", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.lineWidth = 6; x.strokeStyle = 'rgba(0,0,0,.75)';
    x.strokeText(name, 128, 32);
    x.fillStyle = '#a8f0a8';
    x.fillText(name, 128, 32);
    var tex = new THREE.CanvasTexture(cv);
    var mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
    var sp = new THREE.Sprite(mat);
    sp.scale.set(46, 11.5, 1);   // 小字号：不遮视野
    sp.renderOrder = 5;
    scene.add(sp);
    return sp;
  }

  function disposeNameplate(p) {
    scene.remove(p.sprite);
    if (p.sprite.material.map) p.sprite.material.map.dispose();
    p.sprite.material.dispose();
  }

  function updateNameplates() {
    // 清理已离场单位的名字牌
    nameplates.forEach(function (p, e) {
      if (all.indexOf(e) < 0) { disposeNameplate(p); nameplates.delete(e); }
    });
    if (!player) return;
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e === player) continue;
      if (e.team !== player.team) continue;          // 只显示友军
      var p = nameplates.get(e);
      if (!p) { p = { sprite: makeNameplate(e.name) }; nameplates.set(e, p); }
      if (e.dead) { p.sprite.visible = false; continue; }
      var headY = e.y + (e.crouch ? 52 : 86);
      p.sprite.position.set(e.x, headY, e.z);
      var d = Math.hypot(e.x - player.x, e.z - player.z);
      var alpha = 1 - Math.max(0, (d - NAMEPLATE_NEAR) / (NAMEPLATE_FAR - NAMEPLATE_NEAR));
      alpha = Math.max(0, Math.min(1, alpha));
      p.sprite.material.opacity = alpha;
      p.sprite.visible = alpha > 0.02;
    }
  }

  /* ---------------- 雷达 ---------------- */
  function initRadar() {
    var c = document.getElementById('radar');
    radarCtx = c.getContext('2d');
    var M = getMapModule();
    var N = M.N;
    radarBase = document.createElement('canvas');
    radarBase.width = radarBase.height = N;
    var x = radarBase.getContext('2d');
    x.clearRect(0, 0, N, N);
    for (var j = 0; j < N; j++) for (var i = 0; i < N; i++) {
      if (M.walk[M.idx(i, j)]) {
        x.fillStyle = 'rgba(120,190,255,.30)';
        x.fillRect(i, j, 1, 1);
      }
    }
    for (var s = 0; s < M.SITES.length; s++) {
      var S = M.SITES[s];
      x.fillStyle = 'rgba(255,90,60,.5)';
      x.fillRect(M.cx(S.x) - 3, M.cz(S.z) - 3, 6, 6);
    }
  }

  function drawRadar() {
    var ctxr = radarCtx, size = 190, half = size / 2;
    var scale = 0.052;   // 世界单位 → 雷达像素
    ctxr.clearRect(0, 0, size, size);
    ctxr.save();
    ctxr.beginPath(); ctxr.arc(half, half, half - 1, 0, 6.283); ctxr.clip();
    ctxr.fillStyle = 'rgba(6,12,18,.72)';
    ctxr.fillRect(0, 0, size, size);

    var src = (player.dead && spectate && !spectate.dead) ? spectate : player;
    ctxr.translate(half, half);
    ctxr.rotate(src.yaw);
    var M = getMapModule();
    var px = (src.x - M.ORIGIN) / M.GRID, pz = (src.z - M.ORIGIN) / M.GRID;
    var k = M.GRID * scale;
    ctxr.imageSmoothingEnabled = false;
    ctxr.drawImage(radarBase, -px * k, -pz * k, M.N * k, M.N * k);

    function dot(e, color, r) {
      var dx = (e.x - src.x) * scale, dz = (e.z - src.z) * scale;
      ctxr.fillStyle = color;
      ctxr.beginPath(); ctxr.arc(dx, dz, r, 0, 6.283); ctxr.fill();
    }
    var mates = src.team === 'T' ? tList : ctList;
    for (var i = 0; i < mates.length; i++) {
      if (mates[i].dead || mates[i] === src) continue;
      dot(mates[i], '#6ee36e', 3);
    }
    var foes = src.team === 'T' ? ctList : tList;
    for (i = 0; i < foes.length; i++) {
      var f = foes[i];
      if (f.dead) continue;
      var sx = src.x, sy = eyeY(src), sz = src.z;
      var seen = !M.losBlocked(sx, sy, sz, f.x, f.y + 50, f.z) &&
        !NADE.blocked(sx, sy, sz, f.x, f.y + 50, f.z);
      var dist = Math.hypot(f.x - src.x, f.z - src.z);
      if (seen && dist < 3000) dot(f, '#ff5a4a', 3.2);
    }
    if (bomb.planted) {
      var blink = (Math.floor(time * 4) % 2) === 0;
      dot({ x: bomb.pos[0], z: bomb.pos[1] }, blink ? '#ffd24a' : '#ff7a20', 4);
    }
    ctxr.restore();
    ctxr.fillStyle = '#ffffff';
    ctxr.beginPath();
    ctxr.moveTo(half, half - 5); ctxr.lineTo(half - 4, half + 4); ctxr.lineTo(half + 4, half + 4);
    ctxr.closePath(); ctxr.fill();
  }

  /* 放大地图（M 键 / 手机按钮切换） */
  var bigMapOpen = false;
  function toggleBigMap() {
    if (!started) return;
    var el = document.getElementById('bigmap');
    if (!el) return;
    bigMapOpen = !bigMapOpen;
    el.classList.toggle('show', bigMapOpen);
    if (bigMapOpen) { renderBigMap(); }
  }
  function renderBigMap() {
    var cv = document.getElementById('bigmapCanvas');
    if (!cv || !radarBase) return;
    var ctx2 = cv.getContext('2d');
    var S = cv.width;                       // 600
    ctx2.clearRect(0, 0, S, S);
    ctx2.save();
    ctx2.beginPath(); ctx2.arc(S/2, S/2, S/2 - 2, 0, 6.283); ctx2.clip();
    ctx2.fillStyle = 'rgba(6,12,18,.72)';
    ctx2.fillRect(0, 0, S, S);
    var src = (player.dead && spectate && !spectate.dead) ? spectate : player;
    ctx2.translate(S/2, S/2);
    ctx2.rotate(src.yaw);
    var scale = 0.052 * (S / 190);          // 放大到 canvas 尺寸
    var M = getMapModule();
    var px = (src.x - M.ORIGIN) / M.GRID, pz = (src.z - M.ORIGIN) / M.GRID;
    var k = M.GRID * scale;
    ctx2.imageSmoothingEnabled = false;
    ctx2.drawImage(radarBase, -px * k, -pz * k, M.N * k, M.N * k);
    function dot(e, color, r) {
      var dx = (e.x - src.x) * scale, dz = (e.z - src.z) * scale;
      ctx2.fillStyle = color; ctx2.beginPath(); ctx2.arc(dx, dz, r, 0, 6.283); ctx2.fill();
    }
    var mates = src.team === 'T' ? tList : ctList;
    for (var i = 0; i < mates.length; i++) {
      if (mates[i].dead || mates[i] === src) continue;
      dot(mates[i], '#6ee36e', 5);
    }
    var foes = src.team === 'T' ? ctList : tList;
    for (i = 0; i < foes.length; i++) {
      var f = foes[i];
      if (f.dead) continue;
      var sx = src.x, sy = eyeY(src), sz = src.z;
      var seen = !M.losBlocked(sx, sy, sz, f.x, f.y + 50, f.z) &&
        !NADE.blocked(sx, sy, sz, f.x, f.y + 50, f.z);
      var dist = Math.hypot(f.x - src.x, f.z - src.z);
      if (seen && dist < 3000) dot(f, '#ff5a4a', 5.5);
    }
    if (bomb.planted) {
      var blink = (Math.floor(time * 4) % 2) === 0;
      dot({ x: bomb.pos[0], z: bomb.pos[1] }, blink ? '#ffd24a' : '#ff7a20', 6);
    }
    ctx2.restore();
    ctx2.fillStyle = '#ffffff';
    ctx2.beginPath();
    ctx2.moveTo(S/2, S/2 - 8); ctx2.lineTo(S/2 - 6, S/2 + 6); ctx2.lineTo(S/2 + 6, S/2 + 6);
    ctx2.closePath(); ctx2.fill();
  }
  function bigMapEsc() { if (bigMapOpen) toggleBigMap(); }

  /* ================================================================
   *  菜单 / UI 绑定
   * ================================================================ */
  function bindUI() {
    function onQuit() {
      SFX.uiClick();
      running = false; started = false; paused = false;
      resetMatchHud();   // 返回菜单也把上一局的瞬时状态清掉（死亡提示 / 白屏 / 手雷 / 尸体）
      document.getElementById('pause').classList.add('hidden');
      document.getElementById('hud').classList.add('hidden');
      if (netMode) {
        // 联机对局退出 → 干净断开 → 回大厅
        netStop();
        if (VIBE && VIBE.isInRoom()) VIBE.leaveRoom();
        if (typeof LobbyApp !== 'undefined') LobbyApp.showLobby();
      } else {
        document.getElementById('menu').classList.remove('hidden');
      }
      releaseLock();
    }
    document.getElementById('btnStart').addEventListener('click', function () { SFX.init(); SFX.uiClick(); startMatch(); });
    document.getElementById('btnResume').addEventListener('click', function () { SFX.uiClick(); togglePause(false); });
    document.getElementById('btnQuit').addEventListener('click', onQuit);
    document.getElementById('btnAgain').addEventListener('click', function () {
      SFX.uiClick();
      if (netMode) {
        // 联机对局下回到大厅，让房主重建
        resetMatchHud();
        if (typeof LobbyApp !== 'undefined') LobbyApp.showLobby();
        netStop();
      } else {
        startMatch();
      }
    });
    document.getElementById('btnMenu2').addEventListener('click', function () {
      SFX.uiClick();
      onQuit();
    });

    // 放大地图：点击关闭
    var bm = document.getElementById('bigmap');
    if (bm) bm.addEventListener('click', function () { if (bigMapOpen) toggleBigMap(); });

    // 选项按钮组
    document.querySelectorAll('.optrow').forEach(function (row) {
      row.addEventListener('click', function (e) {
        var b = e.target.closest('button');
        if (!b) return;
        SFX.uiClick();
        row.querySelectorAll('button').forEach(function (x) { x.classList.remove('sel'); });
        b.classList.add('sel');
        var key = row.dataset.key, val = b.dataset.val;
        if (key === 'difficulty') SET.difficulty = val;
        if (key === 'teamSize') SET.teamSize = parseInt(val, 10);
        if (key === 'team') SET.team = val;
        if (key === 'maxScore') SET.maxScore = parseInt(val, 10);
        if (key === 'invertStrafe') SET.invertStrafe = (val === 'true');
        if (key === 'gameMode') {
          SET.gameMode = val;
          var show = val === 'teamdm';
          var rl = document.getElementById('rowLives');
          var rlo = document.getElementById('rowLoadout');
          var note = document.getElementById('menuNote');
          var noteT = document.getElementById('menuNoteTeam');
          if (rl) rl.style.display = show ? '' : 'none';
          if (rlo) rlo.style.display = show ? '' : 'none';
          if (note) note.classList.toggle('hidden', show);
          if (noteT) noteT.classList.toggle('hidden', !show);
        }
        if (key === 'map') SET.map = val;
        if (key === 'lives') SET.lives = parseInt(val, 10);
        if (key === 'loadout') SET.loadout = val;
        saveSettings();
      });
    });
    // 滑块
    bindSlider('sens', 'sens', function (v) { SET.sens = v; }, 1);
    bindSlider('fov', 'fov', function (v) { SET.fov = v; if (camera && !scoped) { camera.fov = v; camera.updateProjectionMatrix(); } }, 0);
    bindSlider('vol', 'volume', function (v) { SET.volume = v; SFX.setVolume(v); }, 2);

    // 改名按钮
    var btnRename = document.getElementById('btnRename');
    if (btnRename) {
      btnRename.addEventListener('click', function () {
        var newName = prompt('输入新名字:', player ? player.name : '');
        if (newName === null) return;
        newName = newName.trim();
        if (!newName) return;
        if (player) {
          player.name = newName;
          updatePlayerNameDisplay();
          updateHud();
        }
      });
    }
  }

  function bindSlider(id, key, apply, digits) {
    var el = document.getElementById('sl_' + id);
    var lab = document.getElementById('lb_' + id);
    if (!el) return;
    el.addEventListener('input', function () {
      var v = parseFloat(el.value);
      apply(v);
      lab.textContent = v.toFixed(digits);
      saveSettings();
    });
  }

  function applySettingsToUI() {
    document.querySelectorAll('.optrow').forEach(function (row) {
      var key = row.dataset.key;
      row.querySelectorAll('button').forEach(function (b) {
        var v = b.dataset.val;
        var cur = String(SET[key]);
        b.classList.toggle('sel', v === cur);
      });
    });
    var s;
    if ((s = document.getElementById('sl_sens'))) { s.value = SET.sens; document.getElementById('lb_sens').textContent = SET.sens.toFixed(1); }
    if ((s = document.getElementById('sl_fov'))) { s.value = SET.fov; document.getElementById('lb_fov').textContent = SET.fov.toFixed(0); }
    if ((s = document.getElementById('sl_vol'))) { s.value = SET.volume; document.getElementById('lb_vol').textContent = SET.volume.toFixed(2); }
    // 隐藏/显示团队竞技专属选项行
    var isDM = SET.gameMode === 'teamdm';
    var rl = document.getElementById('rowLives');
    var rlo = document.getElementById('rowLoadout');
    var note = document.getElementById('menuNote');
    var noteT = document.getElementById('menuNoteTeam');
    if (rl) rl.style.display = isDM ? '' : 'none';
    if (rlo) rlo.style.display = isDM ? '' : 'none';
    if (note) note.classList.toggle('hidden', isDM);
    if (noteT) noteT.classList.toggle('hidden', !isDM);
  }

  function togglePause(force) {
    if (!started || matchOver) return;
    paused = force === undefined ? !paused : force;
    document.getElementById('pause').classList.toggle('hidden', !paused);
    // 联机中暂停不会冻结世界，提示语也要如实告知
    var pt = document.querySelector('#pause .title');
    var ps = document.querySelector('#pause .sub');
    if (pt) pt.textContent = paused ? (netMode ? '菜 单' : '已 暂 停') : '已 暂 停';
    if (ps) ps.textContent = paused ? (netMode ? '联机中 · 游戏不会暂停' : '鼠标已释放') : '鼠标已释放';
    if (paused) releaseLock(); else requestLock();
  }

  /* ================================================================
   *  主循环
   * ================================================================ */
  function frame(now) {
    requestAnimationFrame(frame);
    var dt = Math.min(0.05, (now - clock) / 1000);
    clock = now;
    if (!started) { renderer.clear(); return; }
    // 联机模式下暂停只是本地菜单：世界（房主模拟/网络同步）必须继续流动
    if (running && (!paused || netMode)) {
      time += dt;
      step(dt);
    }
    render();
  }

  function step(dt) {
    var auth = netAuthoritative();
    // ========== 团队竞技模式 ==========
    if (SET.gameMode === 'teamdm') {
      if (teamDmRespawning) {
        teamDmRespawnTimer -= dt;
        if (teamDmRespawnTimer <= 0) { teamDmRespawning = false; teamDMRespawn(player); }
      }
      NAV.beginFrame();
      updatePlayer(dt);
      if (auth) { for (var i = 0; i < bots.length; i++) bots[i].update(dt, API); }
      PHYS.separate(all);
      effects.update(dt);
      NADE.update(dt, effects);
      if (netMode) netUpdate(dt);
      updateBlind(dt);
      updateCamera(dt);
      updateClockHud(dt);
      updateNameplates();
      drawRadar();
      if (bigMapOpen) renderBigMap();
      if (!hud.scoreboard.classList.contains('hidden')) { sbTimer -= dt; if (sbTimer <= 0) { sbTimer = 0.3; showScoreboard(true); } }
      return;
    }
    // ========== 爆破模式（原有逻辑） ==========
    // 回合阶段
    if (auth && phase === 'freeze') {
      phaseT -= dt;
      if (phaseT <= 0) { phase = 'live'; }
    } else if (auth && phase === 'live') {
      if (bomb.planted) {
        bomb.timer -= dt;
        bomb.beepT -= dt;
        var fast = bomb.timer < 12;
        if (bomb.beepT <= 0) {
          bomb.beepT = bomb.timer < 5 ? 0.16 : bomb.timer < 12 ? 0.4 : 0.85;
          var bd = Math.hypot(player.x - bomb.pos[0], player.z - bomb.pos[1]);
          if (bd < 2200) SFX.bombBeep(fast);
          if (bomb.led) bomb.led.material.color.setHex(fast ? 0xffff40 : 0xff2020);
        }
        if (bomb.timer <= 0) explodeBomb();
      } else {
        roundClock -= dt;
        if (roundClock <= 0) endRound('CT', '时间到');
      }
    } else if (auth && phase === 'over') {
      phaseT -= dt;
      if (phaseT <= 0 && !matchOver) newRound();
    } else if (!auth && phase === 'live' && bomb.planted) {
      // 客户端不推进倒计时（房主下发），但滴答声还是要本地播
      bomb.beepT -= dt;
      if (bomb.beepT <= 0) {
        var f2 = bomb.timer < 12;
        bomb.beepT = bomb.timer < 5 ? 0.16 : bomb.timer < 12 ? 0.4 : 0.85;
        if (Math.hypot(player.x - bomb.pos[0], player.z - bomb.pos[1]) < 2200) SFX.bombBeep(f2);
        if (bomb.led) bomb.led.material.color.setHex(f2 ? 0xffff40 : 0xff2020);
      }
    }

    botDefuse = 0;
    NAV.beginFrame();          // 重置本帧的 A* 预算
    updatePlayer(dt);
    // bot AI 只在权威端跑；客户端的 bot 是房主下发的插值实体
    if (auth) {
      for (var i = 0; i < bots.length; i++) {
        if (phase === 'freeze') { CHAR.animate(bots[i].model, bots[i], dt); continue; }
        bots[i].update(dt, API);
      }
    }
    PHYS.separate(all);
    effects.update(dt);
    NADE.update(dt, effects);
    if (netMode) netUpdate(dt);
    updateBlind(dt);
    updateCamera(dt);
    updateClockHud(dt);
    updateNameplates();
    drawRadar();
    if (bigMapOpen) renderBigMap();
    if (!hud.scoreboard.classList.contains('hidden')) {
      sbTimer -= dt;
      if (sbTimer <= 0) { sbTimer = 0.3; showScoreboard(true); }
    }
  }

  function render() {
    /* 兜底：活着的 bot 模型被意外隐藏（观战残留 / 状态切换竞态）时强制恢复。
     * 例外：spectateHidden 是「正在观战此人」而故意隐藏的（否则他的身体和枪
     * 糊在镜头上），必须跳过，否则观战视角会冒出被观战者的建模。 */
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (!b.dead && b !== spectateHidden && b.model && !b.model.group.visible) b.model.group.visible = true;
    }
    renderer.clear();
    renderer.render(scene, camera);
    // 观战时也渲染武器模型
    var showVm = vm && vm.root.visible && (!player.dead || (!!spectate && !spectate.dead));
    if (showVm) {
      renderer.clearDepth();
      renderer.render(vmScene, vmCam);
    }
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ================================================================
   *  联机（Stage 2）
   *
   *  同步模型：state-sync + 房主权威。
   *    · 每个客户端 12Hz 上报自己的绝对位姿（可丢，走 sendRealtime）
   *    · 房主 15Hz 广播所有人的位姿快照（可丢）
   *    · 开火/伤害/击杀走可靠有序通道（send），绝不塞进快照
   *    · 命中由房主按 viewTime 回溯判定；血量算术归受害者自己（dmgAck 回报）
   * ================================================================ */

  /* 远程玩家实体：字段刻意和 bot / player 对齐，
   * 这样 hitboxes / fireBullet / 雷达 / CHAR.animate 全都能直接复用 */
  function netMakeRemote(id, team, name) {
    var e = {
      isRemote: true, netId: id, name: name || id.slice(0, 6), team: team || 'CT',
      x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0, pitch: 0,
      health: 100, armor: 0, helmet: false, money: 0,
      dead: false, crouch: false, onGround: true, deadTilt: 0,
      kills: 0, deaths: 0, weapons: ['ak47', 'knife'], wi: 0, ammo: {}, reserve: {},
      lifeId: 0, lastSeen: 0,
      model: CHAR.make(team || 'CT'),
      track: new NET.Track(),                      // 渲染插值（遇到换命/传送会硬切）
      history: new NET.Track({ history: true }),   // 房主回溯用（永不清空）
      delay: NET.makePlayerDelay()
    };
    e.model.group.visible = false;
    scene.add(e.model.group);
    return e;
  }

  function netDisposeRemote(e) {
    if (!e || !e.model) return;
    scene.remove(e.model.group);
    // 参考实现只 scene.remove 不释放资源，反复进出房间会泄漏
    e.model.group.traverse(function (o) {
      if (o.geometry) o.geometry.dispose();
    });
  }

  function netAddRemote(id, team, name) {
    var e = netRemotes.get(id);
    if (e && e.team === team) return e;
    if (e) { netDisposeRemote(e); netRemotes.delete(id); removeFromAll(e); }
    e = netMakeRemote(id, team, name);
    netRemotes.set(id, e);
    all.push(e);
    rebuildTeams();
    return e;
  }

  function netRemoveRemote(id) {
    var e = netRemotes.get(id);
    if (!e) return;
    netDisposeRemote(e);
    netRemotes.delete(id);
    removeFromAll(e);
    rebuildTeams();
    addKillfeed(e.name, '离开了对局', '', false, true);
  }

  function removeFromAll(e) {
    var i = all.indexOf(e);
    if (i >= 0) all.splice(i, 1);
  }

  /* ---------------- 启动 / 停止 ---------------- */
  function netStart(transport, opts) {
    opts = opts || {};
    netStop();
    netT = transport;
    netMode = true;
    netRole = transport.isHost ? 'host' : 'client';
    netClock.reset();
    netSnapSeq = 0; netShotSeq = 0; netMatchSeq = 0;
    netMatchGuard.reset(); netBotDelta.reset();
    netMatchStats = { sentMatch: 0, recvMatch: 0, resync: 0, applied: 0, botRows: 0 };
    netDedupe.reset();
    netPoseTick.reset(); netSnapTick.reset(); netPingTick.reset();
    netMatchTick.reset(); netFullTick.reset();
    netStats = { sentPose: 0, recvPose: 0, sentSnap: 0, recvSnap: 0, fires: 0, hits: 0, rejects: {} };
    // 房主就是时间基准，自己的时钟不需要校正
    if (netIsHost()) { netClock.offsetMs = 0; netClock.ready = true; }

    transport.onMessage(netOnMessage);
    transport.onPeer(function (ev) {
      if (ev.type === 'join') {
        netT.send({ t: NET.P.EV.HELLO, v: NET.P.VERSION, team: (player ? player.team : 'CT'), name: (player ? player.name : 'Player'), host: netIsHost() }, ev.id);
        netPing(ev.id);
      } else if (ev.type === 'leave') {
        netRemoveRemote(ev.id);
      }
    });
    // 已经在房里的人也要打个招呼（注意：netStart 时 player 可能还没创建，不能直接读）
    var ps = transport.peers();
    for (var i = 0; i < ps.length; i++) {
      netT.send({ t: NET.P.EV.HELLO, v: NET.P.VERSION, team: (player ? player.team : 'CT'), name: (player ? player.name : 'Player'), host: netIsHost() }, ps[i].id);
      netPing(ps[i].id);
    }
    banner(netIsHost() ? '联机对局（房主）' : '联机对局（客户端）', 2.2, '#8fdc6a');
    return true;
  }

  function netStop() {
    if (!netMode) return;
    netRemotes.forEach(function (e) { netDisposeRemote(e); removeFromAll(e); });
    netRemotes.clear();
    netBots.forEach(function (e) { netDisposeRemote(e); removeFromAll(e); });
    netBots.clear();
    rebuildTeams();
    netMode = false;
    netRole = 'none';
    netT = null;
    netPending.clear();
    netRemoteHold.clear();
    netMatchGuard.reset();
    netBotDelta.reset();
    netHoldE = false;
    netIsCarrier = false;
    netHostPlantProgress = 0; netHostDefuseProgress = 0;
  }

  /* ---------------- 联机对局：从大厅进入比赛 ---------------- */
  function startOnlineMatch() {
    var backToMenu = function (msg) {
      // 开局失败绝不能停在蓝屏：恢复所有界面并回主菜单
      started = false; running = false; paused = false;
      netStop();
      if (typeof LobbyApp !== 'undefined') LobbyApp.showMenu();
      if (msg) alert(msg);
    };
    try {
      // 取当前传输层；兼容缓存了旧 vibe.js 的浏览器（无 getTransport 时现场创建）
      var transport = (typeof VIBE.getTransport === 'function') ? VIBE.getTransport() : null;
      if (!transport && typeof VIBE.getRoom === 'function' && typeof VIBE.createTransport === 'function') {
        var room0 = VIBE.getRoom();
        if (room0) transport = VIBE.createTransport(room0);
      }
      if (!transport) {
        backToMenu('传输层未就绪：请从大厅创建或加入房间');
        return false;
      }
      // 加入方：从房间元数据应用房主的设置（地图/模式/人数/胜利条件/阵营）
      var meta = (typeof VIBE.getRoomMeta === 'function') ? VIBE.getRoomMeta() : null;
      if (meta) {
        if (meta.map) SET.map = meta.map;
        if (meta.gameMode) SET.gameMode = meta.gameMode;
        if (meta.teamSize) SET.teamSize = Math.max(2, Math.min(10, parseInt(meta.teamSize, 10) || SET.teamSize));
        if (meta.playerSize) SET.playerSize = Math.max(1, Math.min(4, parseInt(meta.playerSize, 10) || SET.playerSize));
        if (SET.gameMode === 'teamdm') { if (meta.win) SET.lives = parseInt(meta.win, 10) || SET.lives; }
        else { if (meta.win) SET.maxScore = parseInt(meta.win, 10) || SET.maxScore; }
        // 阵营：房主用自己选的阵营，加入方自动取对方阵营
        if (meta.hostTeam === 'T' || meta.hostTeam === 'CT') {
          SET.team = transport.isHost ? meta.hostTeam : (meta.hostTeam === 'T' ? 'CT' : 'T');
        }
      }
      if (typeof LobbyApp !== 'undefined') LobbyApp.hideAllOverlays();
      netStart(transport);
      try {
        startMatch();   // 按房间设置（爆破/团队竞技 + 对应地图）开局
      } catch (me) {
        console.error(me);
        backToMenu('开局失败：' + me.message);
        return false;
      }
      return true;
    } catch (e) {
      console.error(e);
      backToMenu('启动联机对局失败: ' + e.message);
      return false;
    }
  }

  function stopOnlineMatch() {
    netStop();
    if (VIBE && typeof VIBE.isInRoom === 'function' && VIBE.isInRoom()) VIBE.leaveRoom();
    if (typeof LobbyApp !== 'undefined') LobbyApp.showMenu();
  }

  /* ---------------- 时钟：ping / pong ---------------- */
  function netPing(to) {
    if (!netT || netIsHost()) return;          // 只有客户端需要对齐房主时钟
    netT.send({ t: NET.P.EV.PING, t0: Date.now() }, to || netT.hostId || undefined);
  }

  /* ---------------- 位姿上行 / 快照下行 ---------------- */
  function netLocalPoseRow() {
    return NET.encodePoseRow({
      id: 0,                                  // 0 = "我自己"，房主收到后换成 peerId
      x: player.x, y: player.y, z: player.z,
      yaw: player.yaw, pitch: player.pitch,
      crouch: player.crouch, alive: !player.dead,
      hp: player.health, team: player.team,
      wep: player.wi, lifeId: netMyLife
    });
  }

  function netSendPose() {
    if (!netT) return;
    var row = netLocalPoseRow();
    // 自己的历史也要记（房主回溯别人打我时要用）
    netPushHistory(player, netNow(), row);
    if (netIsHost()) return;                  // 房主不上报，它直接进快照
    netT.sendRealtime({ t: NET.P.RT.POSE, time: netNow(), r: row });
    netStats.sentPose++;
  }

  /* 把一帧位姿写进实体的历史轨（房主回溯用） */
  function netPushHistory(e, time, row) {
    if (!e.history) e.history = new NET.Track({ history: true });
    var d = NET.decodePoseRow(row);
    e.history.push({
      time: time, x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
      crouch: d.crouch, alive: d.alive, hp: d.hp, lifeId: d.lifeId,
      spawnProtectedUntil: e.spawnProtectedUntil || 0
    });
    e.history.prune(time);
  }

  /* 房主：把所有人（自己 + 远程）打包成一个快照广播 */
  function netBroadcastSnapshot() {
    if (!netT || !netIsHost()) return;
    var now = netNow();
    var rows = [netLocalPoseRow()];
    rows[0][NET.ROW.ID] = 0;                  // 房主自己固定用 0
    var ids = [''];
    netRemotes.forEach(function (e, id) {
      var r = NET.encodePoseRow({
        id: 0, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch,
        crouch: e.crouch, alive: !e.dead, hp: e.health, team: e.team,
        wep: e.wi, lifeId: e.lifeId
      });
      rows.push(r);
      ids.push(id);
    });
    netT.sendRealtime({ t: NET.P.RT.SNAP, time: now, seq: ++netSnapSeq, ids: ids, rows: rows });
    netStats.sentSnap++;
  }

  /* 客户端：应用房主的快照 */
  function netApplySnapshot(msg, fromId) {
    netStats.recvSnap++;
    for (var i = 0; i < msg.rows.length; i++) {
      var id = msg.ids[i] || fromId;          // 空字符串代表房主自己
      if (id === (netT ? netT.peerId : '')) continue;   // 快照里的"我"不用管
      var d = NET.decodePoseRow(msg.rows[i]);
      var e = netAddRemote(id, d.team);
      e.lastSeen = Date.now();
      e.delay.observe();
      var hard = e.track.push({
        time: msg.time, x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
        crouch: d.crouch, alive: d.alive, hp: d.hp, lifeId: d.lifeId
      });
      netPushHistory(e, msg.time, msg.rows[i]);
      e.lifeId = d.lifeId;
      e.health = d.hp;
      e.wi = 0;
      if (hard) { e.x = d.x; e.y = d.y; e.z = d.z; e.yaw = d.yaw; }
    }
  }

  /* ---------------- 开火 → 回溯 → 伤害 → 确认 ---------------- */

  /* 客户端/房主开枪后，把这一发上报（可靠通道，不能丢） */
  function netReportShot(w, ox, oy, oz, dx, dy, dz) {
    if (!netMode || !netT) return;
    var fireTime = netNow();
    var msg = {
      t: NET.P.EV.FIRE, shotId: ++netShotSeq, lifeId: netMyLife,
      x: ox, y: oy, z: oz, dx: dx, dy: dy, dz: dz,
      w: w.id, range: w.range,
      fireTime: fireTime,
      // 关键：回溯到"我屏幕上真正看到对手的那一刻"
      viewTime: fireTime - netPlayerInterpDelay()
    };
    netStats.fires++;
    if (netIsHost()) netResolveShot(msg, netT.peerId, player);   // 房主自己也走同一条判定
    else netT.send(msg, netT.hostId || undefined);
  }

  function netPlayerInterpDelay() {
    var d = NET.P.INTERP_BASE_MS;
    netRemotes.forEach(function (e) { d = Math.max(d, e.delay.delayMs); });
    return d;
  }

  /* 房主：回溯判定一发射击 */
  function netResolveShot(msg, fromId, shooterEnt) {
    if (!netIsHost()) return;
    if (!netDedupe.check(fromId, msg.shotId)) return;            // 同一发不结算两次
    var shooter = shooterEnt || netRemotes.get(fromId);
    if (!shooter) return;
    var candidates = [];
    if (shooter !== player) {
      candidates.push({ id: '', team: player.team, lifeId: netMyLife, alive: !player.dead, track: player.history });
    }
    netRemotes.forEach(function (e, id) {
      if (e === shooter) return;
      candidates.push({ id: id, team: e.team, lifeId: e.lifeId, alive: !e.dead, track: e.history });
    });
    // bot 也必须是候选，否则客户端根本打不到 bot
    for (var bi = 0; bi < bots.length; bi++) {
      var b = bots[bi];
      if (!b.history) continue;
      candidates.push({ id: netBotId(bi), team: b.team, lifeId: b.netLife || 1, alive: !b.dead, track: b.history });
    }

    var res = NET.rewindHit(msg, { lifeId: shooter === player ? netMyLife : shooter.lifeId, track: shooter.history },
      shooter.team, candidates, netNow());
    if (!res.hit) {
      netStats.rejects[res.reason] = (netStats.rejects[res.reason] || 0) + 1;
      return;
    }
    netStats.hits++;
    var wdef = WEAPONS.defs[msg.w] || WEAPONS.defs.ak47;
    var dmg = wdef.dmg * (res.hit.headshot ? wdef.hsMul : 1);
    dmg *= Math.max(0.55, 1 - res.hit.dist / 9000);

    var key = fromId + ':' + msg.shotId;
    netPending.set(key, {
      shooterId: fromId, victimId: res.hit.id, w: msg.w,
      headshot: res.hit.headshot, shotId: msg.shotId
    });

    if (res.hit.id === '') {
      // 打中的是房主自己 → 直接本地结算（血量归受害者自己，这里受害者就是我）
      var before = player.health;
      applyDamage(player, shooter, dmg, res.hit.headshot, wdef);
      netAckDamage(key, player.health, before > 0 && player.dead);
    } else if (res.hit.id.charAt(0) === 'b') {
      // 打中 bot：bot 的血量本来就归房主管，直接结算并把命中确认发回给射击者
      var bi2 = parseInt(res.hit.id.slice(1), 10);
      var bot = bots[bi2];
      if (bot && !bot.dead) {
        var wasAlive = !bot.dead;
        applyDamage(bot, shooter, dmg, res.hit.headshot, wdef);
        netAckDamage(key, bot.health, wasAlive && bot.dead, res.hit.id);
      } else netPending.delete(key);
    } else {
      // 打中远程玩家 → 通知他自己扣血，等 dmgAck
      netT.send({
        t: NET.P.EV.DMG, shooterId: fromId, shotId: msg.shotId, lifeId: netRemotes.get(res.hit.id).lifeId,
        dmg: dmg, headshot: res.hit.headshot, w: msg.w, shooterTeam: shooter.team
      }, res.hit.id);
    }
  }

  /* 受害者：按【本地实际血量】扣血，然后无条件回 ack（即使拒绝也要回，房主才能闭环） */
  function netHandleDamage(msg) {
    var sameLife = Number(msg.lifeId) === netMyLife;
    var wasAlive = !player.dead;
    netStats.dmgRecv = (netStats.dmgRecv || 0) + 1;
    if (sameLife && wasAlive && msg.shooterTeam !== player.team) {
      netStats.dmgApplied = (netStats.dmgApplied || 0) + 1;
      applyDamage(player, null, Number(msg.dmg) || 0, !!msg.headshot, WEAPONS.defs[msg.w] || null);
      if (msg.shooterId) {
        var src = netRemotes.get(msg.shooterId);
        if (src) showDamageDir(src.x, src.z);
      }
    }
    netT.send({
      t: NET.P.EV.DMG_ACK, shooterId: msg.shooterId, shotId: msg.shotId,
      lifeId: msg.lifeId, hp: player.health, killed: sameLife && wasAlive && player.dead
    }, netT.hostId || undefined);
  }

  /* 房主：收到 ack，确认命中反馈与击杀 */
  function netAckDamage(key, hp, killed, victimIdOverride) {
    var p = netPending.get(key);
    if (!p) return;
    netPending.delete(key);
    var victimId = victimIdOverride === undefined ? p.victimId : victimIdOverride;
    var victim = victimId === '' ? player : netRemotes.get(victimId);
    if (victim && victim !== player) victim.health = hp;
    // 给射击者一个"确认命中"的反馈
    if (p.shooterId === netT.peerId) { SFX.hitmark(p.headshot); showHitmarker(p.headshot); }
    else netT.send({ t: NET.P.EV.HIT, headshot: p.headshot, shotId: p.shotId }, p.shooterId);

    if (killed) {
      var shooter = p.shooterId === netT.peerId ? player : netRemotes.get(p.shooterId);
      var vname = victim ? victim.name : '?';
      var sname = shooter ? shooter.name : '?';
      if (victim && victim !== player) { victim.dead = true; victim.deaths++; }
      if (shooter) shooter.kills++;
      var payload = {
        t: NET.P.EV.KILL, killer: sname, victim: vname, w: p.w, headshot: p.headshot,
        kTeam: shooter ? shooter.team : null, vTeam: victim ? victim.team : null
      };
      netT.send(payload);
      netShowKill(payload);
    }
  }

  function netShowKill(m) {
    var wd = WEAPONS.defs[m.w];
    addKillfeed(m.killer, wd ? wd.name : '', m.victim, !!m.headshot, false, m.kTeam, m.vTeam);
  }

  /* 非射线伤害（手雷、C4 爆炸）打到远程玩家：房主同样只通知，不代算血量。
   * 这类伤害没有 shotId，用递增的负数序号占位，保证 ack 能配对。 */
  var netSplashSeq = 0;
  function netSendSplashDamage(victim, attacker, dmg, headshot, w) {
    if (!netT || !netIsHost()) return;
    var id = 'splash' + (++netSplashSeq);
    var vid = null;
    netRemotes.forEach(function (e, k) { if (e === victim) vid = k; });
    if (vid === null) return;
    var key = netT.peerId + ':' + id;
    netPending.set(key, {
      shooterId: attacker && attacker.isPlayer ? netT.peerId : (attacker && attacker.netId) || netT.peerId,
      victimId: vid, w: w ? w.id : 'he', headshot: !!headshot, shotId: id
    });
    netT.send({
      t: NET.P.EV.DMG, shooterId: netT.peerId, shotId: id, lifeId: victim.lifeId,
      dmg: dmg, headshot: !!headshot, w: w ? w.id : 'he',
      shooterTeam: attacker ? attacker.team : (victim.team === 'T' ? 'CT' : 'T')
    }, vid);
  }

  /* ---------------- 消息路由 ---------------- */
  function netOnMessage(msg, fromId) {
    if (!netMode || !msg || typeof msg !== 'object') return;
    var E = NET.P.EV, R = NET.P.RT;
    switch (msg.t) {
      case E.HELLO:
        if (msg.v !== NET.P.VERSION) { addKillfeed('系统', '协议版本不一致，无法同步', '', false, true); return; }
        netAddRemote(fromId, msg.team, msg.name);
        break;
      case E.PING:
        netT.send({ t: E.PONG, t0: msg.t0, now: netNow() }, fromId);
        break;
      case E.PONG:
        netClock.observe(msg.t0, msg.now);
        break;
      case R.POSE:
        if (!netIsHost()) return;                 // 位姿只上报给房主
        netStats.recvPose++;
        var e = netAddRemote(fromId, NET.decodePoseRow(msg.r).team);
        var d = NET.decodePoseRow(msg.r);
        e.lastSeen = Date.now();
        e.delay.observe();
        e.track.push({
          time: msg.time, x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
          crouch: d.crouch, alive: d.alive, hp: d.hp, lifeId: d.lifeId
        });
        netPushHistory(e, msg.time, msg.r);
        e.lifeId = d.lifeId; e.health = d.hp; e.team = d.team;
        e.dead = !d.alive;
        break;
      case R.SNAP:
        if (netIsHost()) return;
        netApplySnapshot(msg, fromId);
        break;
      case E.FIRE:
        netResolveShot(msg, fromId, null);
        break;
      case E.DMG:
        netHandleDamage(msg);
        break;
      case E.DMG_ACK:
        netAckDamage(msg.shooterId + ':' + msg.shotId, Number(msg.hp) || 0, !!msg.killed, fromId);
        break;
      case E.HIT:
        // 本地已经预测过命中反馈，房主的确认就不重复响一遍
        if (time - netLastPredictHit > 0.4) { SFX.hitmark(!!msg.headshot); showHitmarker(!!msg.headshot); }
        break;
      case E.KILL:
        netShowKill(msg);
        break;
      case R.MATCH:
        if (netIsHost()) return;
        netApplyMatch(msg);
        break;
      case E.RESYNC:
        if (netIsHost()) netBroadcastMatch(true);      // 客户端丢了基线 → 立刻补一份全量
        break;
      case E.BUY:
        netHandleBuy(msg, fromId);
        break;
      case E.BUY_RESULT:
        if (msg.ok) {
          if (msg.money !== undefined) player.money = msg.money;
          var it = netFindBuyItem(msg.id);
          if (it) purchaseItem(it, true);              // granted：跳过本地钱/买区校验
        } else { SFX.buyFail(); moneyPop(msg.why || '购买被拒'); }
        break;
      case E.INTERACT:
        if (netIsHost()) netRemoteHold.set(fromId, !!msg.hold);
        break;
      case E.ROUND_START:
        if (!netIsHost()) netApplyRoundStart(msg);
        break;
      case E.ROUND_END:
        if (!netIsHost()) netApplyRoundEnd(msg);
        break;
    }
  }

  /* ================================================================
   *  Stage 3：回合 / 经济 / C4 / bot 同步
   *
   *  房主每 250ms 广播一份 match 状态（每 2 秒强制全量），客户端按序号守卫应用；
   *  出现空洞或断流就请求 resync。bot 走慢车道（260~520ms 插值 + delta 压缩）。
   * ================================================================ */

  /* bot 在网络上的稳定 id */
  function netBotId(i) { return 'b' + i; }

  /* 房主：把本地 bot 的位姿记进历史轨，客户端的射击才能回溯到它们 */
  function netRecordBotHistory(now) {
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      if (!b.history) b.history = new NET.Track({ history: true });
      b.history.push({
        time: now, x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch,
        crouch: !!b.crouch, alive: !b.dead, hp: b.health, lifeId: b.netLife || 1,
        spawnProtectedUntil: 0
      });
      b.history.prune(now);
    }
  }

  /* 房主：组装 match 状态 */
  function netBuildMatch(full) {
    var now = netNow();
    var rows = [];
    for (var i = 0; i < bots.length; i++) {
      var b = bots[i];
      rows.push(NET.encodePoseRow({
        id: i, x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch,
        crouch: !!b.crouch, alive: !b.dead, hp: b.health, team: b.team,
        wep: 0, lifeId: b.netLife || 1
      }));
    }
    var botRows = netBotDelta.build(rows, Date.now(), full);
    netBotDelta.remember(botRows, Date.now(), full);
    netMatchStats.botRows += botRows.length;

    var money = {};
    netRemotes.forEach(function (e, id) { money[id] = e.money || 0; });

    return {
      t: NET.P.RT.MATCH, seq: ++netMatchSeq, full: !!full, time: now,
      ph: phase, pt: phaseT, rc: roundClock, rd: round,
      sc: [score.T, score.CT], ls: [lossStreak.T, lossStreak.CT],
      site: targetSite ? targetSite.name : null,
      bomb: bomb.planted ? [bomb.pos[0], bomb.pos[1], bomb.timer] : null,
      pp: plantProgress, dp: Math.max(defuseProgress, botDefuse),
      money: money,
      bots: botRows, botN: bots.length
    };
  }

  function netBroadcastMatch(full) {
    if (!netT || !netIsHost()) return;
    netT.sendRealtime(netBuildMatch(full));
    netMatchStats.sentMatch++;
  }

  /* 客户端：拿到房主下发的 bot 实体（懒创建） */
  function netGetBot(id, team) {
    var e = netBots.get(id);
    if (e && e.team === team) return e;
    if (e) { netDisposeRemote(e); netBots.delete(id); removeFromAll(e); }
    e = netMakeRemote(id, team, 'BOT');
    e.isNetBot = true;
    e.isBot = true;
    e.delay = NET.makeEntityDelay();          // 慢车道：260~520ms
    netBots.set(id, e);
    all.push(e);
    rebuildTeams();
    return e;
  }

  /* 客户端：应用 match 状态 */
  function netApplyMatch(msg) {
    netMatchStats.recvMatch++;
    var verdict = netMatchGuard.accept(msg.seq, msg.full, false, Date.now());
    if (verdict === 'drop') return;
    if (verdict === 'resync') {
      netRequestResync('gap');
      return;
    }
    netMatchStats.applied++;

    // 回合与比分：客户端不自己推进，只应用
    phase = msg.ph; phaseT = msg.pt;
    roundClock = msg.rc; round = msg.rd;
    score.T = msg.sc[0]; score.CT = msg.sc[1];
    lossStreak.T = msg.ls[0]; lossStreak.CT = msg.ls[1];
    if (msg.site) {
      for (var s = 0; s < getMapModule().SITES.length; s++) if (getMapModule().SITES[s].name === msg.site) targetSite = getMapModule().SITES[s];
    }
    // C4
    if (msg.bomb) {
      if (!bomb.planted) { bomb.planted = true; setBombHud(true); }
      bomb.pos[0] = msg.bomb[0]; bomb.pos[1] = msg.bomb[1];
      bomb.timer = msg.bomb[2];
      if (bomb.mesh) { bomb.mesh.position.set(bomb.pos[0], 2, bomb.pos[1]); bomb.mesh.visible = true; }
    } else if (bomb.planted) {
      bomb.planted = false;
      if (bomb.mesh) bomb.mesh.visible = false;
      setBombHud(false);
    }
    netHostPlantProgress = msg.pp || 0;
    netHostDefuseProgress = msg.dp || 0;
    // 我的钱由房主说了算
    var myId = netT ? netT.peerId : '';
    if (msg.money && msg.money[myId] !== undefined && player.money !== msg.money[myId]) {
      player.money = msg.money[myId];
      updateHud();
    }
    // bot 慢车道
    if (msg.bots && msg.bots.length) {
      for (var i = 0; i < msg.bots.length; i++) {
        var d = NET.decodePoseRow(msg.bots[i]);
        var e = netGetBot(netBotId(d.id), d.team);
        e.delay.observe();
        var hard = e.track.push({
          time: msg.time, x: d.x, y: d.y, z: d.z, yaw: d.yaw, pitch: d.pitch,
          crouch: d.crouch, alive: d.alive, hp: d.hp, lifeId: d.lifeId
        });
        e.health = d.hp; e.lifeId = d.lifeId;
        if (hard) { e.x = d.x; e.y = d.y; e.z = d.z; e.yaw = d.yaw; }
      }
    }
  }
  var netHostPlantProgress = 0, netHostDefuseProgress = 0;

  function netRequestResync(reason) {
    if (!netT || netIsHost()) return;
    if (!netMatchGuard.canRequest(Date.now())) return;
    netMatchGuard.markRequested(Date.now());
    netMatchStats.resync++;
    // 恢复期把插值缓冲加厚一点，避免抖动
    netBots.forEach(function (e) { e.delay.penalize(reason === 'gap' ? 50 : 35); });
    netT.send({ t: NET.P.EV.RESYNC, after: netMatchGuard.lastSeq }, netT.hostId || undefined);
  }

  /* ---------------- 购买：客户端申请，房主校验 ---------------- */
  function netRequestBuy(itemId) {
    if (!netT) return { ok: false, why: '未联机' };
    netT.send({ t: NET.P.EV.BUY, id: itemId }, netT.hostId || undefined);
    return { ok: true, why: '已向房主申请…' };
  }

  function netFindBuyItem(id) {
    for (var c = 0; c < WEAPONS.BUY.length; c++) {
      var items = WEAPONS.BUY[c].items;
      for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    }
    return null;
  }

  /* 房主：校验远程玩家的购买请求（钱 / 买区 / 时间都要过） */
  function netHandleBuy(msg, fromId) {
    if (!netIsHost()) return;
    var e = netRemotes.get(fromId);
    if (!e) { netT.send({ t: NET.P.EV.BUY_RESULT, ok: false, why: '未识别的玩家' }, fromId); return; }
    var item = netFindBuyItem(msg.id);
    var deny = function (why) { netT.send({ t: NET.P.EV.BUY_RESULT, ok: false, why: why, money: e.money || 0 }, fromId); };
    if (!item) return deny('没有这件物品');
    if (!WEAPONS.itemForTeam(item, e.team)) return deny('本阵营不可用');
    if (e.dead) return deny('阵亡后不能购买');
    // 购买窗口：freeze 阶段，或 live 阶段且剩余时间 > roundTime - 20
    var inTime = phase === 'freeze' || (phase === 'live' && roundClock > SET.roundTime - MONEY.buyTime);
    if (!inTime) return deny('购买时间已过');
    if (!getMapModule().inBuyZone(e.team, e.x, e.z)) return deny('必须回到自家出生区');
    var price = WEAPONS.priceOf(item);
    if ((e.money || 0) < price) return deny('钱不够（需要 $' + price + '）');
    // 批准：扣钱。注意 e 是 netRemotes 里的同一个对象，所以 netRemoteMoney 立刻能读到新值
    e.money = Math.max(0, (e.money || 0) - price);
    // 真正把武器发给远程玩家（在 match 通道的下次快照里，他的 wep 字段会更新）
    if (item.equip) {
      if (item.equip === 'kevlar') e.armor = 100;
      else if (item.equip === 'kevhelm') { e.armor = 100; e.helmet = true; }
      else if (item.equip === 'defuser' && e.team === 'CT') e.defuser = true;
    }
    netT.send({ t: NET.P.EV.BUY_RESULT, ok: true, id: msg.id, money: e.money }, fromId);
  }

  /* ---------------- C4：客户端只上报按键，房主推进进度 ---------------- */
  function netSendHold(hold) {
    if (!netT || netIsHost() || hold === netHoldE) return;
    netHoldE = hold;
    netT.send({ t: NET.P.EV.INTERACT, hold: hold }, netT.hostId || undefined);
  }

  /* 房主：替远程玩家推进安放 / 拆除 */
  function netHostAdvanceRemoteBomb(dt) {
    if (!netIsHost()) return;
    netRemotes.forEach(function (e, id) {
      if (!netRemoteHold.get(id) || e.dead) { e.plantT = 0; e.defuseT = 0; return; }
      var moving = Math.hypot(e.vx || 0, e.vz || 0) > 40;
      if (e.team === 'T' && !bomb.planted && carrier === e) {
        var site = getMapModule().siteAt(e.x, e.z);
        if (site && !moving) {
          e.plantT = (e.plantT || 0) + dt;
          plantProgress = Math.min(1, e.plantT / 3.0);
          if (e.plantT >= 3.0) { plantBomb(e); e.plantT = 0; plantProgress = 0; }
        } else e.plantT = 0;
      } else if (e.team === 'CT' && bomb.planted) {
        var d = Math.hypot(e.x - bomb.pos[0], e.z - bomb.pos[1]);
        if (d < 85 && !moving) {
          var need = e.defuser ? 5.0 : 10.0;
          e.defuseT = (e.defuseT || 0) + dt;
          botDefuse = Math.max(botDefuse, e.defuseT / need);
          if (e.defuseT >= need) { defuseBomb(e); e.defuseT = 0; }
        } else e.defuseT = 0;
      }
    });
  }

  /* ---------------- 回合开始 / 结束事件 ---------------- */
  function netBroadcastRoundStart() {
    if (!netT || !netIsHost()) return;
    var spawns = {};
    var taken = [];
    netRemotes.forEach(function (e, id) {
      var list = getMapModule().SPAWNS[e.team].slice();
      shuffle(list);
      var pos = placeEntity(e, list[0], taken);
      e.x = pos[0]; e.y = pos[1]; e.z = pos[2];
      e.dead = false; e.health = 100; e.lifeId = (e.lifeId || 0) + 1;
      spawns[id] = [pos[0], pos[1], pos[2], (e.money || 0)];
    });
    // 指定 C4 携带者（房主自己或某个 T 方远程玩家）
    var carrierId = carrier === player ? '' : null;
    netRemotes.forEach(function (e, id) { if (e === carrier) carrierId = id; });
    netT.send({
      t: NET.P.EV.ROUND_START, round: round, site: targetSite ? targetSite.name : null,
      spawns: spawns, carrier: carrierId, money: (function () {
        var m = {}; netRemotes.forEach(function (e, id) { m[id] = e.money || 0; }); return m;
      })()
    });
  }

  function netBroadcastRoundEnd(winner, reason) {
    if (!netT || !netIsHost()) return;
    var m = {};
    netRemotes.forEach(function (e, id) { m[id] = e.money || 0; });
    netT.send({
      t: NET.P.EV.ROUND_END, winner: winner, reason: reason,
      sc: [score.T, score.CT], money: m
    });
  }

  /* 客户端：应用房主的回合开始 */
  function netApplyRoundStart(msg) {
    var myId = netT ? netT.peerId : '';
    var sp = msg.spawns && msg.spawns[myId];
    netMyLife++;
    player.dead = false; player.health = 100;
    player.shotsInBurst = 0; player.spreadPen = 0;
    player.reloadEnd = 0; player.nextFire = 0;
    if (sp) {
      player.x = sp[0]; player.y = sp[1]; player.z = sp[2];
      player.vx = player.vy = player.vz = 0;
      if (sp[3] !== undefined) player.money = sp[3];
    }
    player.spawnProtectedUntil = netNow() + NET.P.SPAWN_PROTECT_MS;
    if (player.history) player.history.clear();
    netIsCarrier = msg.carrier === myId;
    clearSpectateHidden(); spectate = null; deadT = 0;
    hud.deadmsg.classList.add('hidden');
    effects.clear(); NADE.clear();
    blindT = 0; punch.x = punch.y = 0;
    banner('第 ' + msg.round + ' 回合', 1.6);
    SFX.roundStart();
    updateHud();
  }
  var netIsCarrier = false;

  function netApplyRoundEnd(msg) {
    score.T = msg.sc[0]; score.CT = msg.sc[1];
    var myId = netT ? netT.peerId : '';
    if (msg.money && msg.money[myId] !== undefined) player.money = msg.money[myId];
    var mine = msg.winner === player.team;
    banner((msg.winner === 'T' ? '恐怖分子' : '反恐精英') + '获胜 · ' + msg.reason, 3.4,
      mine ? '#8fdc6a' : '#ff8b6a');
    if (mine) SFX.win(); else SFX.lose();
    updateHud();
  }

  /* ---------------- 每帧 ---------------- */
  function netUpdate(dt) {
    if (!netMode || !netT) return;
    if (netPoseTick.step(dt)) {
      netSendPose();
      if (netIsHost()) netRecordBotHistory(netNow());   // bot 历史，供客户端的射击回溯
    }
    if (netIsHost()) {
      if (netSnapTick.step(dt)) netBroadcastSnapshot();
      var full = netFullTick.step(dt);
      if (netMatchTick.step(dt) || full) netBroadcastMatch(full);
      netHostAdvanceRemoteBomb(dt);
    } else {
      if (netPingTick.step(dt)) netPing();
      if (netMatchGuard.stalled(Date.now())) netRequestResync('stall');   // 断流 → 要全量
    }

    // 远程玩家走快车道，房主下发的 bot 走慢车道（插值延迟不同）
    var renderBase = netNow();
    var interp = function (e) {
      var s = e.track.sample(renderBase - e.delay.delayMs,
        e.isNetBot ? NET.P.ENTITY_EXTRAP_MAX_MS : NET.P.EXTRAP_MAX_MS);
      if (!s) return;
      var pdx = s.x - e.x, pdz = s.z - e.z;
      // 走路摆动需要速度：直接用插值位移反推
      e.vx = dt > 0 ? pdx / dt : 0;
      e.vz = dt > 0 ? pdz / dt : 0;
      e.x = s.x; e.y = s.y; e.z = s.z;
      e.yaw = s.yaw; e.pitch = s.pitch || 0;
      e.crouch = !!s.crouch;
      e.dead = !s.alive;
      e.model.group.visible = true;
      CHAR.animate(e.model, e, dt);
    };
    netRemotes.forEach(interp);
    netBots.forEach(interp);
  }

  /* ================================================================
   *  给 bot 用的接口
   * ================================================================ */
  var API = {
    get time() { return time; },
    get tList() { return tList; },
    get ctList() { return ctList; },
    get bombPlanted() { return bomb.planted; },
    get bombPos() { return bomb.pos; },
    get carrier() { return carrier; },
    get targetSite() { return targetSite; },
    get gameMode() { return SET.gameMode; },
    get defuseProgress() { return botDefuse; },
    set defuseProgress(v) { botDefuse = v; },
    plantBomb: plantBomb,
    defuseBomb: defuseBomb,
    fireBullet: fireBullet,
    meleeAttack: meleeAttack,
    throwNade: function (who, kind, dx, dy, dz, power) {
      return NADE.throwGrenade(who, kind, dx, dy, dz, power === undefined ? 700 : power);
    },
    distToPlayer: function (e) { return Math.hypot(e.x - player.x, e.z - player.z); }
  };

  /* ================================================================
   *  调试 / 自检接口（js/selftest.js 用，正常游戏不受影响）
   * ================================================================ */
  function debugSnapshot() {
    if (!player) return null;
    var w = weaponOf(player);
    return {
      round: round, phase: phase, running: running, paused: paused,
      buyMenuOpenDbg: BUYMENU.isOpen(),

      x: player.x, y: player.y, z: player.z, yaw: player.yaw, pitch: player.pitch,
      vx: player.vx, vz: player.vz,
      punchX: punch.x, punchY: punch.y,
      spread: player.curSpread, spreadPen: player.spreadPen, burst: player.shotsInBurst,
      peakSpread: peak.spread, peakPunch: peak.punch, peakBurst: peak.burst,
      weapon: w.id, baseSpread: w.spread, ammo: player.ammo[w.id], reserve: player.reserve[w.id],
      health: player.health, armor: player.armor, dead: player.dead,
      money: player.money, helmet: !!player.helmet, defuser: !!player.defuser,
      nades: JSON.parse(JSON.stringify(player.nades || {})),
      weapons: player.weapons.slice(),
      buyOk: buyState().ok, buyWhy: buyState().why,
      buyMenuOpen: BUYMENU.isOpen(),
      blind: blindT, nadeCount: NADE.count(),
      bombPlanted: bomb.planted, bombTimer: bomb.timer,
      defuseProgress: defuseProgress, plantProgress: plantProgress,
      progressVisible: !!(hud.progressWrap && !hud.progressWrap.classList.contains('hidden')),
      progressLabel: hud.progressLabel ? hud.progressLabel.textContent : '',

      lossStreak: { T: lossStreak.T, CT: lossStreak.CT },
      botMoney: bots.map(function (b) { return { team: b.team, money: b.money, armor: b.armor, w: b.weapons[0] }; }),
      spectating: spectate ? spectate.name : null,
      mates: (player.team === 'T' ? tList : ctList).map(function (e) {
        return { name: e.name, x: e.x, z: e.z, dead: e.dead, isPlayer: !!e.isPlayer };
      }),
      foes: (player.team === 'T' ? ctList : tList).map(function (e) {
        return { name: e.name, x: e.x, z: e.z, dead: e.dead };
      })
    };
  }

  /* 供 touch.js 使用的接口（不直接暴露内部私有变量，只暴露安全的读写函数） */
  var touchApi = {
    setKey: function (code, down) { keys[code] = !!down; },
    setFire: function (down) { mouse.down = !!down; },
    isActive: function () { return started && running && !paused; },
    hasLivePlayer: function () { return !!(player && !player.dead); },
    applyLook: function (dx, dy) {
      if (!player || player.dead) return;
      var s = SET.sens * 0.00022 * (scoped ? 0.35 : 1);
      player.yaw -= dx * s;
      player.pitch -= dy * s;
      var lim = Math.PI / 2 - 0.02;
      player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
    },
    applyGyroLook: function (dPitch, dYaw) {
      if (!player || player.dead) return;
      player.pitch -= dPitch;
      player.yaw -= dYaw;
      var lim = Math.PI / 2 - 0.02;
      player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
    },
    toggleScope: function () {
      if (player && !player.dead && weaponOf(player).scope) { scoped = !scoped; setScope(scoped); }
    },
    hasScope: function () { return !!(player && !player.dead && weaponOf(player) && weaponOf(player).scope); },
    reload: function () { if (player && !player.dead) startReload(); },
    jump: function () { if (player && !player.dead && !paused && PHYS.jump(player)) SFX.jump(0); },
    /* 快速切刀：切到匕首 → 挥一刀 → 550ms 后自动换回原武器 */
    quickKnife: function () {
      if (!player || player.dead || paused || phase === 'freeze') return;
      var ki = slotIndex(player, 'knife');
      if (ki < 0) return;
      if (player.wi === ki) {                     // 已经拿着刀：直接挥
        var wk = weaponOf(player);
        if (time >= player.nextFire) { player.nextFire = time + 60 / wk.rpm; meleeAttack(player, wk); vmRecoil.z = -3; }
        return;
      }
      var prev = player.wi;
      switchWeapon(ki);
      var w = weaponOf(player);
      player.nextFire = time + 60 / w.rpm;         // 越过切枪延迟，立即挥这一刀
      meleeAttack(player, w);
      vmRecoil.z = -3; vmRecoil.x = -0.1;
      setTimeout(function () {
        if (player && !player.dead && player.wi === ki) switchWeapon(prev);
      }, 550);
    },
    selectSlot: function (slot, gid) { if (player && !player.dead) selectSlot(slot, gid); },
    buyKey: function (code) { return typeof BUYMENU !== 'undefined' ? BUYMENU.key(code) : false; },
    toggleMap: function () { toggleBigMap(); },
    nextSpectate: function () { if (player && player.dead) { nextSpectate(1); updateSpectateHud(); } },
    isDead: function () { return !!(player && player.dead); },
    setFov: function (v) { SET.fov = v; if (camera && !scoped) { camera.fov = v; camera.updateProjectionMatrix(); } },
    setSens: function (v) { SET.sens = v; },
    setVolume: function (v) { SET.volume = v; if (typeof SFX !== 'undefined') SFX.setVolume(v); },
    saveSettings: function () { saveSettings(); }
  };

  var out = { init: init, API: API, SET: SET, debug: debugSnapshot, startOnlineMatch: startOnlineMatch, touch: touchApi };

  // 只有带 ?selftest 参数时才挂出可以改动状态的钩子，避免变成作弊接口
  if (/selftest/.test(location.search)) {
    out.__test = {
      killPlayer: function () { if (player && !player.dead) killEntity(player, null, false, null); },
      revive: function () {
        if (!player) return;
        player.dead = false;
        player.health = 100;
        deadT = 0;
        clearSpectateHidden();
        spectate = null;
        hud.deadmsg.classList.add('hidden');
      },
      invuln: function (on) { testInvuln = !!on; },
      fakeHadLock: function () { hadLock = true; },     // 模拟「鼠标曾经锁定过」
      plantHere: function () {
        // 直接在玩家脚下安放 C4，方便测拆弹流程
        bomb.planted = false;
        plantBomb(player);
        return { x: bomb.pos[0], z: bomb.pos[1], timer: bomb.timer };
      },
      giveDefuser: function (on) { if (player) { player.defuser = !!on; updateHud(); } },

      isPaused: function () { return paused; },
      unpause: function () { togglePause(false); },


      hurtPlayer: function (n) { if (player) applyDamage(player, null, n, false, null); },
      setYaw: function (v) { if (player) player.yaw = v; },
      teleport: function (x, z) { if (player) { player.x = x; player.z = z; player.vx = player.vz = 0; } },
      forceLive: function () { phase = 'live'; phaseT = 0; },
      resetPeaks: function () { peak.spread = 0; peak.punch = 0; peak.burst = 0; },
      setMoney: function (n) { if (player) { player.money = n; updateHud(); } },
      buyById: function (id) {
        // 在所有分类里找这个 id 然后走正常购买流程
        for (var c = 0; c < WEAPONS.BUY.length; c++) {
          var items = WEAPONS.BUY[c].items;
          for (var i = 0; i < items.length; i++) if (items[i].id === id) return purchaseItem(items[i]);
        }
        return { ok: false, why: '菜单里没有 ' + id };
      },
      openBuy: function () { return BUYMENU.key('KeyB'); },
      buyKey: function (code) { return BUYMENU.key(code); },
      nadeCount: function () { return NADE.count(); },
      smokeList: function () { return NADE.smokeList(); },

      smokeBlocked: function (ax, ay, az, bx, by, bz) { return NADE.blocked(ax, ay, az, bx, by, bz); },
      awardRound: function (winner, reason) { awardRoundMoney(winner, reason); },
      richBots: function (n) {
        // 给 bot 一笔钱再跑一次购买，用来验证「有钱就会买主武器」
        for (var i = 0; i < bots.length; i++) { bots[i].money = n; bots[i].buyPhase(); }
        return bots.map(function (b) {
          return { team: b.team, w: b.weapons[0], money: b.money, armor: b.armor, defuser: !!b.defuser };
        });
      },
      /* ---- 联机（Stage 2）自检钩子 ---- */
      netStart: function (transport) { return netStart(transport); },
      netStop: function () { netStop(); },
      netRole: function () { return netMode ? (netIsHost() ? 'host' : 'client') : 'none'; },
      setRoundClock: function (v) { roundClock = v; },
      netMatchInfo: function () {
        var bs = [];
        netBots.forEach(function (e, id) {
          bs.push({ id: id, team: e.team, x: e.x, z: e.z, hp: e.health, dead: e.dead, delayMs: e.delay.delayMs });
        });
        return {
          phase: phase, roundClock: roundClock, round: round,
          score: { T: score.T, CT: score.CT }, lossStreak: { T: lossStreak.T, CT: lossStreak.CT },
          bombPlanted: bomb.planted, bombTimer: bomb.timer,
          hostPlant: netHostPlantProgress, hostDefuse: netHostDefuseProgress,
          netBots: bs, stats: netMatchStats,
          guard: { lastSeq: netMatchGuard.lastSeq, awaitingFull: netMatchGuard.awaitingFull, gaps: netMatchGuard.gapCount },
          money: player ? player.money : 0, isCarrier: netIsCarrier
        };
      },
      netBuildMatch: function (full) { return netBuildMatch(full); },
      netApplyMatch: function (m) { netApplyMatch(m); },
      netRemoteMoney: function (id, n) {
        var e = netRemotes.get(id);
        if (!e) return null;
        if (n !== undefined) e.money = n;
        return e.money || 0;
      },
      netRemotePose: function (id, x, z) {
        var e = netRemotes.get(id);
        if (!e) return false;
        e.x = x; e.z = z; e.vx = 0; e.vz = 0;
        return true;
      },
      netSetCarrierRemote: function (id) {
        var e = netRemotes.get(id);
        if (e) carrier = e;
        return !!e;
      },
      botStates: function () {
        return bots.map(function (b, i) {
          return { id: 'b' + i, team: b.team, hp: b.health, dead: b.dead, history: b.history ? b.history.samples.length : 0 };
        });
      },
      netInfo: function () {
        var rs = [];
        netRemotes.forEach(function (e, id) {
          rs.push({
            id: id, name: e.name, team: e.team, x: e.x, y: e.y, z: e.z, yaw: e.yaw,
            hp: e.health, dead: e.dead, lifeId: e.lifeId,
            samples: e.track.samples.length, history: e.history.samples.length,
            delayMs: e.delay.delayMs, visible: e.model.group.visible
          });
        });
        return {
          on: netMode, isHost: netIsHost(), peerId: netT ? netT.peerId : null,
          clockReady: netClock.ready, offsetMs: netClock.offsetMs, rttMs: netClock.rttMs,
          myLife: netMyLife, remotes: rs, stats: netStats,
          pending: netPending.size, inAll: all.filter(function (e) { return e.isRemote; }).length
        };
      },
      netFire: function () {
        // 模拟本地开火（跳过弹药与射速限制，直接走联机上报路径）
        var w = weaponOf(player);
        var yaw = player.yaw, pit = player.pitch;
        var cp = Math.cos(pit);
        netReportShot(w, player.x, eyeY(player), player.z,
          -Math.sin(yaw) * cp, Math.sin(pit), -Math.cos(yaw) * cp);
      },
      netTick: function (dt) { netUpdate(dt === undefined ? 1 / 60 : dt); },
      setPose: function (x, z, yaw, pitch) {
        if (!player) return;
        player.x = x; player.z = z;
        if (yaw !== undefined) player.yaw = yaw;
        if (pitch !== undefined) player.pitch = pitch;
        player.vx = player.vz = 0;
      },

      giveWeapon: function (id) {
        if (!player || !WEAPONS.defs[id]) return false;
        var list = [id].concat(player.weapons.filter(function (w) { return w !== id; }));
        giveLoadout(player, list);
        setViewModel(player.weapons[0], player.team);
        updateHud();
        return true;
      },
      spreadOf: function () { return spreadOf(player, weaponOf(player), scoped); },
      spawnProbeCheck: function () {
        // 所有出生点经 safeSpawn 处理后是否都不再和地图几何相撞
        var bad = [];
        for (var team in getMapModule().SPAWNS) {
          var list = getMapModule().SPAWNS[team];
          for (var i = 0; i < list.length; i++) {
            var taken = [];
            var probe = makeSpawnProbe(taken);
            var p = getMapModule().safeSpawn(list[i][0], list[i][1], probe);
            if (probe(p[0], p[1])) bad.push({ team: team, from: list[i], to: p });
          }
        }
        return bad;
      }
    };
  }

  return out;
})();

window.addEventListener('load', function () { GAME.init(); });
