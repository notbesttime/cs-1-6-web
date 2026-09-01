/* ============================================================
 *  touch.js — 手机触控输入模块
 *
 *  检测移动设备 → 显示虚拟按键 → 直接设置 keys[]/mouse 状态
 *  不模拟键盘/鼠标事件，而是操作游戏代码已经读取的同一份状态变量。
 *
 *  布局结构（从左到右）：
 *    ┌──────────────────────────────────────┐
 *    │  [设置]                              │
 *    │       ┌────────┐   ┌──┐  ┌────┐    │
 *    │       │ 视角区  │   │跳│  │换弹│    │
 *    │       │ (右半屏)│   │跃│  │    │    │
 *    │       │        │   └──┘  ├────┤    │
 *    │ ┌───┐ │        │   ┌──┐  │瞄准│    │
 *    │ │摇杆│ │        │   │蹲│  │    │    │
 *    │ │区域│ │        │   │下│  └────┘    │
 *    │ │(左半│ │        │   └──┘  ┌──┐     │
 *    │ │ 屏)│ │        │   ┌──┐  │开│     │
 *    │ └───┘ │        │   │投│  │火│     │
 *    │       │        │   │弹│  │  │     │
 *    │       │        │   └──┘  └──┘     │
 *    │ ┌────┐│        │                   │
 *    │ │武器││        │   ┌──────────┐      │
 *    │ │栏  ││        │   │ 购买/B   │      │
 *    │ └────┘│        │   └──────────┘      │
 *    └──────────────────────────────────────┘
 * ============================================================ */
'use strict';

var TOUCH = (function () {

  /* ======================== 状态 ======================== */
  var enabled = false;             // 触控是否启用
  var touchMode = 'auto';         // 'auto' | 'touch' | 'keyboard'
  var gyroEnabled = false;
  var gyroSensitivity = 0.5;      // 0-1
  var layoutMode = 'default';     // 'default' | 'custom'
  var layoutDirty = false;
  var editing = false;

  /* 摇杆状态 */
  var moveStick = { x: 0, y: 0, active: false, touchId: null, originX: 0, originY: 0 };
  var STICK_MAX = 42;             // 摇杆最大偏移 px

  /* 视角触摸状态 */
  var lookState = { active: false, touchId: null, lastX: 0, lastY: 0 };

  /* 开火来源计数：左/右开火键任一按下即开火（松开最后一个才停火） */
  var fireSources = {};

  /* 陀螺仪上一帧角度（用增量而非绝对角度，否则会漂移/无感） */
  var gyroLast = null;

  /* 布局编辑：编辑中临时布局 */
  var workingLayout = null;

  /* 按钮持久化 touch 状态 */
  var touchButtons = {};

  /* 布局配置（百分比位置，按横屏设计，避免重叠） */
  var DEFAULT_LAYOUT = {
    stickMove:   { x: 14, y: 74, s: 1.0 },
    btnFire:     { x: 84, y: 84, s: 1.0 },
    btnFireLeft: { x: 27, y: 17, s: 1.0 },
    btnReload:   { x: 94, y: 74, s: 1.0 },
    btnCrouch:   { x: 94, y: 56, s: 1.0 },
    btnJump:     { x: 94, y: 38, s: 1.0 },
    btnGrenade:  { x: 74, y: 80, s: 1.0 },
    btnMelee:    { x: 67, y: 89, s: 1.0 },
    btnPlant:    { x: 84, y: 64, s: 1.0 },
    btnAim:      { x: 74, y: 61, s: 1.0 },
    btnBuy:      { x: 88, y: 11, s: 1.0 },
    btnMap:      { x: 76, y: 10, s: 1.0 },
    btnSettings: { x: 96, y: 9, s: 1.0 },
    weaponSlots: { x: 44, y: 94, s: 1.0 }
  };

  var LAYOUT_KEY = 'touch_layout_v2';
  var savedLayout = null;

  /* ======================== 移动端检测 ======================== */
  function isMobileDevice() {
    var ua = navigator.userAgent;
    return /Android|iPhone|iPad|iPod|Mobi/i.test(ua) ||
      (navigator.maxTouchPoints > 0 && Math.min(innerWidth, innerHeight) < 900);
  }

  function detectAndApply() {
    loadSettings();
    var mobile = isMobileDevice();
    var pref = localStorage.getItem('inputModePreference');
    if (pref === 'keyboard') touchMode = 'keyboard';
    else if (pref === 'touch') touchMode = 'touch';
    else touchMode = mobile ? 'touch' : 'keyboard';

    if (touchMode === 'touch' || (touchMode === 'auto' && mobile)) {
      enable();
    } else {
      disable();
    }
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    document.body.classList.add('mobile');
    if (localStorage.getItem('touch_ui_hidden') === '1') document.body.classList.add('touch-hidden');
    buildUI();
    loadLayout();
    applyLayout();
    bindEvents();
    // 横屏检测
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);
    checkOrientation();
    // 轮询游戏状态：只有对局进行时才显示触控层（首页菜单/大厅不显示）
    startStatePoll();
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    document.body.classList.remove('mobile');
    document.body.classList.remove('in-game');
    document.body.classList.remove('scope-avail');
    var ui = document.getElementById('touchUI');
    if (ui) ui.style.display = 'none';
    var rp = document.getElementById('rotatePrompt');
    if (rp) rp.style.display = 'none';
    window.removeEventListener('resize', checkOrientation);
    window.removeEventListener('orientationchange', checkOrientation);
    stopStatePoll();
    document.body.removeEventListener('touchend', onGlobalTouchEnd);
    document.body.removeEventListener('touchcancel', onGlobalTouchEnd);
  }

  function toggle() {
    if (enabled) disable(); else enable();
    localStorage.setItem('inputModePreference', enabled ? 'touch' : 'keyboard');
  }

  /* ======================== UI 构建 ======================== */
  function buildUI() {
    // 防重复：若已存在（例如再次 enable）先移除旧的，避免出现两个 touchUI 堆叠
    var oldUI = document.getElementById('touchUI');
    if (oldUI && oldUI.parentNode) oldUI.parentNode.removeChild(oldUI);
    var oldS = document.getElementById('touchSettings');
    if (oldS && oldS.parentNode) oldS.parentNode.removeChild(oldS);

    var ui = document.createElement('div');
    ui.id = 'touchUI';
    ui.innerHTML = buildHTML();
    document.body.appendChild(ui);
    var settings = document.getElementById('touchSettings');
    if (settings) document.body.appendChild(settings);
    cacheButtons();
    buildWeaponSlots();
  }

  /* ======================== 游戏状态轮询 ======================== */
  var _statePoll = null;
  function startStatePoll() {
    if (_statePoll) return;
    _statePoll = setInterval(function () {
      var active = GAME.touch && GAME.touch.isActive();
      document.body.classList.toggle('in-game', !!active);
      // 瞄准键只在持狙时出现
      document.body.classList.toggle('scope-avail', !!(active && GAME.touch.hasScope && GAME.touch.hasScope()));
      checkOrientation();
    }, 250);
  }
  function stopStatePoll() {
    if (_statePoll) { clearInterval(_statePoll); _statePoll = null; }
  }

  function buildHTML() {
    var h = '<div id="stickMove" class="touch-ctrl" data-id="stickMove">' +
              '<div class="stick-base"><div class="stick-knob" id="moveKnob"></div></div>' +
            '</div>' +
            '<div id="lookPad" class="touch-ctrl" data-id="lookPad"></div>' +
            '<button id="btnFire" class="tbtn fire" data-id="btnFire">' +
              '<i></i>' +
            '</button>' +
            '<button id="btnFireLeft" class="tbtn fire fire-left" data-id="btnFireLeft">' +
              '<i></i>' +
            '</button>' +
            '<button id="btnAim" class="tbtn" data-id="btnAim">' +
              '<i class="aim-icon"></i>' +
            '</button>' +
            '<button id="btnJump" class="tbtn" data-id="btnJump">' +
              '<i class="jump-icon">&#x2191;</i>' +
            '</button>' +
            '<button id="btnCrouch" class="tbtn" data-id="btnCrouch">' +
              '<i class="crouch-icon">蹲</i>' +
            '</button>' +
            '<button id="btnReload" class="tbtn" data-id="btnReload">' +
              '<i class="reload-icon">&#x21BB;</i>' +
            '</button>' +
            '<button id="btnGrenade" class="tbtn" data-id="btnGrenade">' +
              '<i class="grenade-icon"></i>' +
            '</button>' +
            '<button id="btnMelee" class="tbtn" data-id="btnMelee">' +
              '<i class="melee-icon"></i>' +
            '</button>' +
            '<button id="btnPlant" class="tbtn" data-id="btnPlant">' +
              '<i class="plant-icon">E</i>' +
            '</button>' +
            '<button id="btnBuy" class="tbtn" data-id="btnBuy">' +
              '<i class="buy-icon">$</i>' +
            '</button>' +
            '<button id="btnMap" class="tbtn map-btn" data-id="btnMap">' +
              '<i class="map-icon">&#x1f9ed;</i>' +
            '</button>' +
            '<div id="weaponSlots" class="touch-ctrl" data-id="weaponSlots">' +
              '<button class="tbtn wsbtn" data-slot="0"><span>1</span></button>' +
              '<button class="tbtn wsbtn" data-slot="1"><span>2</span></button>' +
              '<button class="tbtn wsbtn" data-slot="2"><span>3</span></button>' +
            '</div>' +
            '<button id="btnSettings" class="tbtn settings-btn" data-id="btnSettings">' +
              '<i class="settings-icon">&#x2699;</i>' +
            '</button>' +
            // 设置面板
            '<div id="touchSettings" class="touch-settings hidden">' +
              '<div class="ts-header">设置 <span id="tsClose">&times;</span></div>' +
              '<div class="ts-tabs">' +
                '<button class="ts-tab sel" data-tab="basic">基础</button>' +
                '<button class="ts-tab" data-tab="layout">按键</button>' +
              '</div>' +
              '<div class="ts-body">' +
                '<div class="ts-panel" id="tsBasic">' +
                  '<div class="ts-row"><label>触屏灵敏度</label>' +
                    '<input type="range" id="tsSens" min="1" max="15" step="0.1" value="' + (GAME && GAME.SET ? GAME.SET.sens : 2.2) + '">' +
                    '<span class="ts-val" id="tsSensV">' + (GAME && GAME.SET ? GAME.SET.sens : 2.2) + '</span>' +
                  '</div>' +
                  '<div class="ts-row"><label>视野 FOV</label>' +
                    '<input type="range" id="tsFov" min="70" max="110" step="1" value="' + (GAME && GAME.SET ? GAME.SET.fov : 90) + '">' +
                    '<span class="ts-val" id="tsFovV">' + (GAME && GAME.SET ? GAME.SET.fov : 90) + '</span>' +
                  '</div>' +
                  '<div class="ts-row"><label>音量</label>' +
                    '<input type="range" id="tsVol" min="0" max="1" step="0.05" value="' + (GAME && GAME.SET ? GAME.SET.volume : 0.7) + '">' +
                    '<span class="ts-val" id="tsVolV">' + ((GAME && GAME.SET ? GAME.SET.volume : 0.7) * 100).toFixed(0) + '%</span>' +
                  '</div>' +
                  '<div class="ts-row"><label>陀螺仪</label>' +
                    '<label class="ts-switch"><input type="checkbox" id="tsGyro" ' + (gyroEnabled ? 'checked' : '') + '><span></span></label>' +
                  '</div>' +
                  '<div class="ts-row" id="tsGyroRow"><label>陀螺仪灵敏度</label>' +
                    '<input type="range" id="tsGyroSens" min="0.1" max="2" step="0.05" value="' + (gyroSensitivity * 2) + '">' +
                    '<span class="ts-val" id="tsGyroSensV">' + (gyroSensitivity * 100).toFixed(0) + '%</span>' +
                  '</div>' +
                  '<div class="ts-row"><label>按键布局</label>' +
                    '<select id="tsLayoutMode">' +
                      '<option value="default"' + (layoutMode === 'default' ? ' selected' : '') + '>默认</option>' +
                      '<option value="custom"' + (layoutMode === 'custom' ? ' selected' : '') + '>自定义</option>' +
                    '</select>' +
                  '</div>' +
                  (layoutMode === 'custom' ? '<div class="ts-row"><button class="ts-action" id="tsEditLayout">✎ 编辑布局</button><button class="ts-action" id="tsResetLayout">↺ 重置</button></div>' : '') +
                  '<div class="ts-row">' +
                    '<button class="ts-action" id="tsToggleTouch">' + (typeof document !== 'undefined' && document.body && document.body.classList.contains('touch-hidden') ? '显示触控' : '隐藏触控') + '</button>' +
                  '</div>' +
                '</div>' +
                '<div class="ts-panel hidden" id="tsLayout">' +
                  '<div style="padding:10px 4px;font-size:13px;color:#cfc6ad;line-height:1.7;">点击下方按钮进入<b style="color:#ffc861;">全屏编辑</b>：直接用手指拖动任意按钮到你想要的位置，完成后点「保存」。</div>' +
                  '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;">' +
                    '<button class="ts-action" id="tsEditLayout" style="background:rgba(70,140,255,.2);border-color:rgba(120,170,255,.5);color:#8fd4ff;">✎ 进入全屏编辑</button>' +
                    '<button class="ts-action" id="tsResetLayout">↺ 恢复默认布局</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>';
    return h;
  }

  function buildWeaponSlots() {
    // Slots already in HTML, just ensure they exist
  }

  /* ======================== 缓存按钮 ======================== */
  var btnMap = {};
  function cacheButtons() {
    ['btnFire', 'btnFireLeft', 'btnAim', 'btnJump', 'btnCrouch', 'btnReload', 'btnGrenade',
     'btnMelee', 'btnPlant', 'btnBuy', 'btnSettings'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) btnMap[id] = el;
    });
  }

  /* ======================== 事件绑定 ======================== */
  function bindEvents() {
    // 不再全局 preventDefault touchmove（那会阻止菜单滚动）；
    // 滚动锁定交给 CSS 的 canvas#gl{touch-action:none}，各控件自己 preventDefault。
    document.body.addEventListener('touchend', onGlobalTouchEnd);
    document.body.addEventListener('touchcancel', onGlobalTouchEnd);

    // 摇杆区域
    var stick = document.getElementById('stickMove');
    if (stick) {
      stick.addEventListener('touchstart', onStickStart, { passive: false });
      stick.addEventListener('touchmove', onStickMove, { passive: false });
      stick.addEventListener('touchend', onStickEnd);
      stick.addEventListener('touchcancel', onStickEnd);
    }

    // 视角区域
    var look = document.getElementById('lookPad');
    if (look) {
      look.addEventListener('touchstart', onLookStart, { passive: false });
      look.addEventListener('touchmove', onLookMove, { passive: false });
      look.addEventListener('touchend', onLookEnd);
      look.addEventListener('touchcancel', onLookEnd);
    }

    // 开火键：右侧主开火支持"按住滑动压枪"，左侧开火纯射击；两者独立计数
    bindFireButton(document.getElementById('btnFire'), true);
    bindFireButton(document.getElementById('btnFireLeft'), false);

    // 各按钮 —— 全部通过 GAME.touch 接口操作，不直接碰内部变量
    var T = GAME.touch;
    var actions = {
      btnAim:    { tap: function () { T.toggleScope(); } },
      btnJump:   { tap: function () { T.jump(); } },
      btnCrouch: { keyDown: function () { T.setKey('ControlLeft', true); }, keyUp: function () { T.setKey('ControlLeft', false); } },
      btnReload: { tap: function () { T.reload(); } },
      btnGrenade:{ tap: function () { T.selectSlot('grenade', 'he'); } },
      btnMelee:  { tap: function () { T.quickKnife(); } },
      btnPlant:  { keyDown: function () { T.setKey('KeyE', true); }, keyUp: function () { T.setKey('KeyE', false); } },
      btnBuy:    { tap: function () { T.buyKey('KeyB'); } },
      btnMap:    { tap: function () { T.toggleMap(); } }
    };

    Object.keys(actions).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var a = actions[id];
      el.addEventListener('touchstart', function (e) {
        if (editing) return;              // 编辑布局时不触发游戏动作
        e.preventDefault();
        e.stopPropagation();
        if (a.tap) a.tap();
        if (a.keyDown) a.keyDown();
        el.classList.add('on');
      }, { passive: false });
      el.addEventListener('touchend', function (e) {
        if (editing) return;
        e.preventDefault();
        el.classList.remove('on');
        if (a.keyUp) a.keyUp();
      });
      el.addEventListener('touchcancel', function (e) {
        el.classList.remove('on');
        if (a.keyUp) a.keyUp();
      });
    });

    // 武器栏 1/2/3 → 主武器 / 手枪 / 匕首
    var ws = document.getElementById('weaponSlots');
    if (ws) {
      var slots = ['primary', 'secondary', 'knife'];
      ws.querySelectorAll('.wsbtn').forEach(function (btn, idx) {
        btn.addEventListener('touchstart', function (e) {
          if (editing) return;
          e.preventDefault();
          e.stopPropagation();
          GAME.touch.selectSlot(slots[idx]);
        });
      });
    }

    // 设置按钮
    var bs = document.getElementById('btnSettings');
    if (bs) {
      bs.addEventListener('touchstart', function (e) {
        if (editing) return;
        e.preventDefault();
        e.stopPropagation();
        toggleSettingsPanel();
      });
    }

    // 设置面板内事件
    bindSettingsEvents();

    // 阵亡后点击屏幕切换观战对象（手机端没有空格/左键）
    document.addEventListener('touchstart', function (e) {
      if (!enabled || !GAME.touch || !GAME.touch.isActive()) return;
      // 只在实际游戏画布区域响应（排除设置面板、按钮等）
      var t = e.touches[0];
      var target = e.target;
      if (target && (target.id === 'touchSettings' || target.closest && target.closest('#touchSettings'))) return;
      if (target && (target.id === 'bigmap' || target.closest && target.closest('#bigmap'))) return;
      if (typeof GAME.touch.isDead !== 'function' || !GAME.touch.isDead()) return;
      e.preventDefault();
      GAME.touch.nextSpectate();
    }, { passive: false });
  }

  /* ======================== 开火键（支持按住滑动压枪） ======================== */
  function fireOn(id) { fireSources[id] = true; GAME.touch.setFire(true); }
  function fireOff(id) {
    delete fireSources[id];
    var any = false;
    for (var k in fireSources) { any = true; break; }
    if (!any) GAME.touch.setFire(false);
  }

  /* look=true：按住后手指滑动可控制视角（压枪）；false：纯开火 */
  function bindFireButton(el, look) {
    if (!el) return;
    var id = el.id;
    var tid = null, lastX = 0, lastY = 0;
    el.addEventListener('touchstart', function (e) {
      if (editing) return;
      e.preventDefault();
      e.stopPropagation();
      var t = e.changedTouches[0];
      tid = t.identifier;
      lastX = t.clientX; lastY = t.clientY;
      fireOn(id);
      el.classList.add('on');
    }, { passive: false });
    el.addEventListener('touchmove', function (e) {
      if (editing || tid === null) return;
      e.preventDefault();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== tid) continue;
        if (look) GAME.touch.applyLook(t.clientX - lastX, t.clientY - lastY);
        lastX = t.clientX; lastY = t.clientY;
      }
    }, { passive: false });
    function end(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === tid) {
          tid = null;
          fireOff(id);
          el.classList.remove('on');
          return;
        }
      }
    }
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  /* ======================== 摇杆 ======================== */
  function onStickStart(e) {
    e.preventDefault();
    var touch = e.changedTouches[0];
    moveStick.touchId = touch.identifier;
    moveStick.active = true;
    var rect = e.currentTarget.getBoundingClientRect();
    moveStick.originX = rect.left + rect.width / 2;
    moveStick.originY = rect.top + rect.height / 2;
    updateStick(touch.clientX, touch.clientY);
  }

  function onStickMove(e) {
    if (!moveStick.active) return;
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === moveStick.touchId) {
        updateStick(e.changedTouches[i].clientX, e.changedTouches[i].clientY);
        break;
      }
    }
  }

  function onStickEnd(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === moveStick.touchId) {
        moveStick.active = false;
        moveStick.x = 0;
        moveStick.y = 0;
        moveStick.touchId = null;
        releaseMoveKeys();
        resetKnob();
        break;
      }
    }
  }

  function updateStick(cx, cy) {
    var dx = cx - moveStick.originX;
    var dy = cy - moveStick.originY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > STICK_MAX) { dx = dx / dist * STICK_MAX; dy = dy / dist * STICK_MAX; }
    // 移动摇杆
    var knob = document.getElementById('moveKnob');
    if (knob) knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
    // 标准化到 [-1, 1]
    moveStick.x = dx / STICK_MAX;
    moveStick.y = dy / STICK_MAX;
    applyMoveKeys();
  }

  function resetKnob() {
    var knob = document.getElementById('moveKnob');
    if (knob) knob.style.transform = 'translate(0,0)';
  }

  function applyMoveKeys() {
    var threshold = 0.25;
    var T = GAME.touch;
    T.setKey('KeyW', moveStick.y < -threshold);
    T.setKey('KeyS', moveStick.y > threshold);
    T.setKey('KeyA', moveStick.x < -threshold);
    T.setKey('KeyD', moveStick.x > threshold);
    // 触控模式默认不静步
    T.setKey('ShiftLeft', false);
  }

  function releaseMoveKeys() {
    var T = GAME.touch;
    T.setKey('KeyW', false);
    T.setKey('KeyS', false);
    T.setKey('KeyA', false);
    T.setKey('KeyD', false);
    T.setKey('ShiftLeft', false);
  }

  /* ======================== 视角触摸 ======================== */
  function onLookStart(e) {
    e.preventDefault();
    var touch = e.changedTouches[0];
    lookState.touchId = touch.identifier;
    lookState.active = true;
    lookState.lastX = touch.clientX;
    lookState.lastY = touch.clientY;
  }

  function onLookMove(e) {
    if (!lookState.active) return;
    e.preventDefault();
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === lookState.touchId) {
        var t = e.changedTouches[i];
        var dx = t.clientX - lookState.lastX;
        var dy = t.clientY - lookState.lastY;
        lookState.lastX = t.clientX;
        lookState.lastY = t.clientY;
        applyLookDelta(dx, dy);
        break;
      }
    }
  }

  function onLookEnd(e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === lookState.touchId) {
        lookState.active = false;
        lookState.touchId = null;
        break;
      }
    }
  }

  function applyLookDelta(dx, dy) {
    GAME.touch.applyLook(dx, dy);
  }

  /* 陀螺仪：用角度【增量】映射成视角滑动（绝对角度当增量会漂移/无感） */
  function applyGyro(e) {
    if (!gyroEnabled) return;
    var beta = e.beta;    // 前后倾斜
    var gamma = e.gamma;  // 左右倾斜
    if (beta === null || beta === undefined) return;
    if (gyroLast === null) { gyroLast = { beta: beta, gamma: gamma }; return; }
    var dBeta = beta - gyroLast.beta;
    var dGamma = gamma - gyroLast.gamma;
    gyroLast.beta = beta; gyroLast.gamma = gamma;
    // 越界跳变（±180 环绕）忽略
    if (Math.abs(dBeta) > 45 || Math.abs(dGamma) > 45) return;
    // 每 1° 角度变化 → 若干"像素"，乘灵敏度；横屏握持下 gamma≈左右转、beta≈俯仰
    var k = 14 * gyroSensitivity;
    GAME.touch.applyLook(dGamma * k, dBeta * k);
  }
  function resetGyro() { gyroLast = null; }

  /* ======================== 全局事件 ======================== */
  function onGlobalTouchEnd(e) {
    // 清除所有已经结束的 touch 对应的状态
    onStickEnd(e);
    onLookEnd(e);
  }

  /* ======================== 设置面板 ======================== */
  var settingsPanel = null;

  function toggleSettingsPanel() {
    if (!settingsPanel) settingsPanel = document.getElementById('touchSettings');
    if (!settingsPanel) return;
    settingsPanel.classList.toggle('hidden');
  }

  function bindSettingsEvents() {
    var close = document.getElementById('tsClose');
    if (close) close.addEventListener('click', toggleSettingsPanel);

    // Tab 切换
    document.querySelectorAll('.ts-tab').forEach(function (tab) {
      tab.addEventListener('click', function () {
        document.querySelectorAll('.ts-tab').forEach(function (t) { t.classList.remove('sel'); });
        tab.classList.add('sel');
        var target = tab.dataset.tab;
        document.getElementById('tsBasic').classList.toggle('hidden', target !== 'basic');
        document.getElementById('tsLayout').classList.toggle('hidden', target !== 'layout');
      });
    });

    // 灵敏度
    bindSlider('tsSens', 'sens', 1, function (v) { GAME.touch.setSens(v); saveSettings(); });
    bindSlider('tsFov', 'fov', 0, function (v) {
      GAME.touch.setFov(v);
      saveSettings();
    });
    bindSlider('tsVol', 'volume', 2, function (v) {
      GAME.touch.setVolume(v);
      document.getElementById('tsVolV').textContent = (v * 100).toFixed(0) + '%';
      saveSettings();
    });

    // 陀螺仪
    var gyroCheck = document.getElementById('tsGyro');
    if (gyroCheck) {
      gyroCheck.addEventListener('change', function () {
        gyroEnabled = gyroCheck.checked;
        document.getElementById('tsGyroRow').style.display = gyroEnabled ? 'flex' : 'none';
        if (gyroEnabled) {
          resetGyro();
          if (typeof DeviceOrientationEvent !== 'undefined' &&
              typeof DeviceOrientationEvent.requestPermission === 'function') {
            // iOS 13+ 必须在用户手势里请求权限
            DeviceOrientationEvent.requestPermission().then(function (state) {
              if (state === 'granted') { resetGyro(); window.addEventListener('deviceorientation', applyGyro); }
              else { gyroEnabled = false; gyroCheck.checked = false; alert('陀螺仪权限被拒绝'); }
            }).catch(function () {
              gyroEnabled = false; gyroCheck.checked = false;
              alert('无法开启陀螺仪');
            });
          } else {
            window.addEventListener('deviceorientation', applyGyro);
          }
        } else {
          window.removeEventListener('deviceorientation', applyGyro);
        }
        saveSettings();
      });
    }

    var gyroSens = document.getElementById('tsGyroSens');
    if (gyroSens) {
      gyroSens.addEventListener('input', function () {
        gyroSensitivity = parseFloat(gyroSens.value) / 2;
        document.getElementById('tsGyroSensV').textContent = (gyroSensitivity * 100).toFixed(0) + '%';
        saveSettings();
      });
    }

    // 布局模式切换（default/custom）
    var layoutSel = document.getElementById('tsLayoutMode');
    if (layoutSel) {
      layoutSel.addEventListener('change', function () {
        layoutMode = layoutSel.value;
        localStorage.setItem('touch_layout_mode', layoutMode);
        saveSettings();
        applyLayout();
      });
    }

    // 进入全屏布局编辑
    var editBtn = document.getElementById('tsEditLayout');
    if (editBtn) editBtn.addEventListener('click', enterLayoutEdit);

    // 恢复默认布局
    var resetBtn = document.getElementById('tsResetLayout');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        savedLayout = null;
        layoutMode = 'default';
        localStorage.removeItem(LAYOUT_KEY);
        localStorage.setItem('touch_layout_mode', 'default');
        applyLayout();
        var sel = document.getElementById('tsLayoutMode');
        if (sel) sel.value = 'default';
      });
    }

    // 显示/隐藏触控（只切 body.touch-hidden，不销毁重建；也不影响雷达缩放）
    var toggleBtn = document.getElementById('tsToggleTouch');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var hidden = document.body.classList.toggle('touch-hidden');
        toggleBtn.textContent = hidden ? '显示触控' : '隐藏触控';
        try { localStorage.setItem('touch_ui_hidden', hidden ? '1' : '0'); } catch (e) {}
      });
    }
  }

  function bindSlider(id, key, digits, cb) {
    var el = document.getElementById(id);
    if (!el) return;
    var valEl = document.getElementById(id + 'V');
    el.addEventListener('input', function () {
      var v = parseFloat(el.value);
      if (valEl) valEl.textContent = key === 'volume' ? (v * 100).toFixed(0) + '%' : v.toFixed(digits);
      cb(v);
    });
  }

  /* ======================== 全屏布局编辑器 ========================
   *  直接在真实屏幕上拖动每个按钮，所见即所得。
   * ================================================================ */
  var _editDrag = [];
  var _prevLayoutMode = 'default';
  function enterLayoutEdit() {
    editing = true;
    _prevLayoutMode = layoutMode;
    var panel = document.getElementById('touchSettings');
    if (panel) panel.classList.add('hidden');
    layoutMode = 'custom';
    workingLayout = cloneLayout(getCurrentLayoutBase());
    applyWorking();
    document.body.classList.add('touch-layout-editing');
    showEditToolbar();
    Object.keys(workingLayout).forEach(function (id) {
      if (id === 'btnSettings') return;
      var el = document.getElementById(id);
      if (!el) return;
      el.classList.add('editing-target');
      bindEditDrag(el, id);
    });
  }

  function exitLayoutEdit(save) {
    if (save) {
      savedLayout = cloneLayout(workingLayout);
      try { localStorage.setItem(LAYOUT_KEY, JSON.stringify({ _schema: 1, layout: savedLayout })); } catch (e) {}
      layoutMode = 'custom';
      localStorage.setItem('touch_layout_mode', 'custom');
    } else {
      layoutMode = _prevLayoutMode;   // 取消：恢复进入前的模式
    }
    editing = false;
    document.body.classList.remove('touch-layout-editing');
    Object.keys(workingLayout || {}).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove('editing-target', 'editing-sel');
    });
    removeEditToolbar();
    workingLayout = null;
    applyLayout();
    var panel = document.getElementById('touchSettings');
    if (panel) panel.classList.remove('hidden');
    var sel = document.getElementById('tsLayoutMode');
    if (sel) sel.value = layoutMode;
  }

  function getCurrentLayoutBase() {
    return (savedLayout ? savedLayout : DEFAULT_LAYOUT);
  }
  function cloneLayout(src) {
    var o = {};
    Object.keys(src).forEach(function (k) { o[k] = { x: src[k].x, y: src[k].y, s: src[k].s || 1 }; });
    // 确保新增控件（如 btnFireLeft）也在
    Object.keys(DEFAULT_LAYOUT).forEach(function (k) { if (!o[k]) o[k] = { x: DEFAULT_LAYOUT[k].x, y: DEFAULT_LAYOUT[k].y, s: 1 }; });
    return o;
  }
  function applyWorking() {
    document.body.classList.add('touch-layout-custom');
    Object.keys(workingLayout).forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var c = workingLayout[id];
      el.style.left = c.x + '%';
      el.style.top = c.y + '%';
      el.style.transform = 'translate(-50%,-50%) scale(' + (c.s || 1) + ')';
    });
  }

  function bindEditDrag(el, id) {
    if (el._editBound) return;   // 避免重复进入编辑时叠加监听
    el._editBound = true;
    var tid = null, sx = 0, sy = 0, ox = 0, oy = 0;
    el.addEventListener('touchstart', function (e) {
      if (!editing) return;
      e.preventDefault(); e.stopPropagation();
      var t = e.changedTouches[0];
      tid = t.identifier; sx = t.clientX; sy = t.clientY;
      ox = workingLayout[id].x; oy = workingLayout[id].y;
      el.classList.add('editing-sel');
    }, { passive: false, capture: true });
    el.addEventListener('touchmove', function (e) {
      if (!editing || tid === null) return;
      e.preventDefault(); e.stopPropagation();
      for (var i = 0; i < e.changedTouches.length; i++) {
        var t = e.changedTouches[i];
        if (t.identifier !== tid) continue;
        var nx = ox + (t.clientX - sx) / window.innerWidth * 100;
        var ny = oy + (t.clientY - sy) / window.innerHeight * 100;
        nx = Math.max(3, Math.min(97, nx));
        ny = Math.max(3, Math.min(97, ny));
        workingLayout[id].x = nx; workingLayout[id].y = ny;
        el.style.left = nx + '%'; el.style.top = ny + '%';
      }
    }, { passive: false, capture: true });
    function end(e) {
      for (var i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === tid) { tid = null; el.classList.remove('editing-sel'); return; }
      }
    }
    el.addEventListener('touchend', end, { capture: true });
    el.addEventListener('touchcancel', end, { capture: true });
  }

  function showEditToolbar() {
    removeEditToolbar();
    var bar = document.createElement('div');
    bar.id = 'editToolbar';
    bar.innerHTML =
      '<span class="et-hint">拖动任意按钮调整位置</span>' +
      '<button class="ts-action" id="etReset">↺ 默认</button>' +
      '<button class="ts-action" id="etCancel">取消</button>' +
      '<button class="ts-action" id="etSave" style="background:rgba(70,200,140,.25);border-color:#6fe8a8;color:#6fe8a8;">保存</button>';
    document.body.appendChild(bar);
    document.getElementById('etSave').addEventListener('click', function () { exitLayoutEdit(true); });
    document.getElementById('etCancel').addEventListener('click', function () { exitLayoutEdit(false); });
    document.getElementById('etReset').addEventListener('click', function () {
      workingLayout = cloneLayout(DEFAULT_LAYOUT);
      applyWorking();
    });
  }
  function removeEditToolbar() {
    var bar = document.getElementById('editToolbar');
    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
  }

  function loadLayout() {
    try {
      var raw = localStorage.getItem(LAYOUT_KEY);
      if (raw) {
        var data = JSON.parse(raw);
        if (data && data.layout) savedLayout = data.layout;
      }
    } catch (e) { savedLayout = null; }
    var lm = localStorage.getItem('touch_layout_mode');
    if (lm) layoutMode = lm;
  }

  function getCurrentLayout() {
    return (savedLayout && layoutMode === 'custom') ? savedLayout : DEFAULT_LAYOUT;
  }

  function applyLayout() {
    var layout = getCurrentLayout();
    document.body.classList.toggle('touch-layout-custom', layoutMode === 'custom');
    Object.keys(layout).forEach(function (id) {
      var btn = document.getElementById(id);
      if (!btn) return;
      var c = layout[id];
      if (c) {
        btn.style.left = c.x + '%';
        btn.style.top = c.y + '%';
        btn.style.transform = 'translate(-50%,-50%) scale(' + (c.s || 1) + ')';
      }
    });
  }

  function getControlLabel(id) {
    var map = {
      stickMove: '移动摇杆', btnFire: '开火', btnFireLeft: '左开火', btnAim: '瞄准', btnJump: '跳跃',
      btnCrouch: '蹲下', btnReload: '换弹', btnGrenade: '投弹', btnMelee: '近战',
      btnPlant: '安放/拆除', btnBuy: '购买', btnMap: '地图', weaponSlots: '武器栏', btnSettings: '设置'
    };
    return map[id] || id;
  }

  /* ======================== 设置持久化 ======================== */
  function saveSettings() {
    try {
      localStorage.setItem('touch_settings', JSON.stringify({
        sens: GAME.SET.sens, fov: GAME.SET.fov, volume: GAME.SET.volume,
        gyroEnabled: gyroEnabled, gyroSensitivity: gyroSensitivity,
        layoutMode: layoutMode
      }));
    } catch (e) {}
  }

  /* ======================== 主循环中调用 ======================== */

  function loadSettings() {
    try {
      var s = JSON.parse(localStorage.getItem('touch_settings') || '{}');
      if (s.sens !== undefined) GAME.SET.sens = s.sens;
      if (s.fov !== undefined) GAME.SET.fov = s.fov;
      if (s.volume !== undefined) GAME.SET.volume = s.volume;
      if (s.gyroEnabled !== undefined) gyroEnabled = s.gyroEnabled;
      if (s.gyroSensitivity !== undefined) gyroSensitivity = s.gyroSensitivity;
      if (s.layoutMode) layoutMode = s.layoutMode;
    } catch (e) {}
  }

  /* ======================== 主循环中调用（可选） ======================== */
  function update(dt) {
    if (!enabled) return;
    if (!GAME.touch || !GAME.touch.isActive()) return;
    // 触控模式下隐藏鼠标指针
    if (document.getElementById('gl') && touchMode === 'touch') {
      document.getElementById('gl').style.cursor = 'none';
    }
  }

  /* ======================== 横屏检测 ======================== */
  function checkOrientation() {
    var prompt = document.getElementById('rotatePrompt');
    if (!prompt) return;
    var portrait = window.innerHeight > window.innerWidth;
    // 只有对局进行中且竖屏时才提示旋转（菜单可竖屏浏览）
    var inGame = GAME.touch && GAME.touch.isActive();
    prompt.style.display = (enabled && inGame && portrait) ? 'flex' : 'none';
  }

  /* ======================== 导出 ======================== */
  return {
    isEnabled: function () { return enabled; },
    isTouchMode: function () { return touchMode === 'touch'; },
    detect: detectAndApply,
    enable: enable,
    disable: disable,
    toggle: toggle,
    loadSettings: loadSettings,
    saveSettings: saveSettings,
    update: update
  };

})();
