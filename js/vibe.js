/* ============================================================
 *  vibe.js — VibeHub SDK 集成：登录 / 大厅 / 房间 / 传输桥接
 *
 *  Stage 4 新增文件。
 *  负责：
 *    · SDK 初始化（VibeHub.init）
 *    · 账号登录/退出 UI
 *    · 大厅：创建/浏览/刷新/快速加入/密码房/恢复房间
 *    · 把 VibeHub room 桥接成游戏认识的 VibeTransport
 *    · 设置持久化（localStorage key: "vibe_save"）
 * ============================================================ */
'use strict';

var VIBE = (function () {

  /* ======================== 状态机 ========================
   *  idle → lobby → in-room → (游戏进行中)
   *  in-room 下的 VibeTransport 在 createTransport() 里生成。
   * ======================================================== */
  var _state = 'idle';   // 'idle' | 'lobby' | 'in-room'
  var _user = null;      // { id, username } 或 null
  var _room = null;      // VibeHub SDK room 对象
  var _transport = null; // VibeTransport（包裹 _room）
  var _peers = [];       // 大厅返回的房间列表
  var _lastRoomId = null;// 上次的 roomId（恢复用）
  var _onStateCbs = [];  // 状态变化回调
  var _sdkReady = false;
  var _sdkError = null;

  /* ---------- 持久化 ---------- */
  var SAVE_KEY = 'vibe_save';
  function saveState() {
    try {
      var s = {
        user: _user,
        lastRoomId: _lastRoomId,
        username: _user ? _user.username : null
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(s));
    } catch (e) { /* quota exceeded → 静默 */ }
  }
  function loadSaved() {
    try {
      var s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (s && s.user) {
        _user = s.user;
        _lastRoomId = s.lastRoomId || null;
      }
    } catch (e) { /* corrupt → 忽略 */ }
  }

  /* ---------- 状态机 ---------- */
  function setState(s) {
    if (_state === s) return;
    _state = s;
    for (var i = 0; i < _onStateCbs.length; i++) _onStateCbs[i](s);
  }
  function onStateChange(cb) { _onStateCbs.push(cb); return this; }

  /* ================================================================
   *  SDK 初始化
   * ================================================================ */
  function initSDK() {
    if (typeof VibeHub === 'undefined') {
      _sdkError = 'VibeHub SDK 未加载（检查网络或 CDN 地址）';
      console.warn('[VIBE]', _sdkError);
      return false;
    }
    try {
      VibeHub.init({ work: 'cs1-6-step-explore' });
      _sdkReady = true;
      // SDK 会自己管理登录态，轮询恢复 session
      loadSaved();
      setState('idle');
      return true;
    } catch (e) {
      _sdkError = 'VibeHub.init 失败: ' + e.message;
      console.error('[VIBE]', _sdkError);
      return false;
    }
  }

  function isSDKReady() { return _sdkReady; }
  function getSDKError() { return _sdkError; }

  /* ================================================================
   *  登录/退出（规范强制：大厅进入前必须登录）
   * ================================================================ */
  function isLoggedIn() { return !!(_user && _user.id); }

  function getUser() { return _user; }

  function login(username, password) {
    if (!_sdkReady) return { ok: false, why: 'SDK 未就绪' };
    if (isLoggedIn()) return { ok: false, why: '已登录' };
    try {
      var result = VibeHub.login(username, password);
      if (result && result.ok) {
        _user = { id: result.userId || result.id, username: username };
        saveState();
        setState('idle');
        return { ok: true };
      }
      return { ok: false, why: result.why || '登录失败' };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  function logout() {
    if (!_sdkReady) return;
    try { VibeHub.logout(); } catch (e) { /* 忽略 */ }
    _user = null;
    _lastRoomId = null;
    saveState();
    if (_room) leaveRoom();
    setState('idle');
  }

  /* ================================================================
   *  传输桥接：VibeHub room → VibeTransport
   * ================================================================ */
  function createTransport(room) {
    if (_transport) { _transport = null; }
    _transport = new TRANSPORT.VibeTransport(room);
    _room = room;
    return _transport;
  }

  function getTransport() { return _transport; }

  function getRoom() { return _room; }

  /* ================================================================
   *  大厅操作
   * ================================================================ */
  function showLobby() {
    if (!isLoggedIn()) return false;
    setState('lobby');
    refreshRooms();
    // 如果有上次房间，显示恢复按钮
    return true;
  }

  function hideLobby() {
    setState('idle');
  }

  /* 刷新房间列表 */
  function refreshRooms() {
    if (!_sdkReady) { _peers = []; return []; }
    try {
      _peers = VibeHub.listRooms({ work: 'cs1-6-step-explore' }) || [];
    } catch (e) {
      _peers = [];
      console.warn('[VIBE] listRooms failed:', e.message);
    }
    return _peers;
  }

  function getRooms() { return _peers; }

  /* 创建房间 */
  function createRoom(name, opts) {
    opts = opts || {};
    if (!isLoggedIn()) return { ok: false, why: '未登录' };
    if (isInRoom()) leaveRoom();
    try {
      var room = VibeHub.createRoom(name, {
        work: 'cs1-6-step-explore',
        password: opts.password || null,
        maxPlayers: opts.maxPlayers || 8
      });
      if (room) {
        _lastRoomId = room.roomId || name;
        createTransport(room);
        setState('in-room');
        saveState();
        return { ok: true, room: room };
      }
      return { ok: false, why: '创建房间失败' };
    } catch (e) {
      return { ok: false, why: e.message };
    }
  }

  /* 加入房间 */
  function joinRoom(roomId, password) {
    if (!isLoggedIn()) return { ok: false, why: '未登录' };
    if (isInRoom()) leaveRoom();
    try {
      var room = VibeHub.joinRoom(roomId, password || '');
      if (room) {
        _lastRoomId = room.roomId || roomId;
        createTransport(room);
        setState('in-room');
        saveState();
        return { ok: true, room: room };
      }
      return { ok: false, why: '加入房间失败：密码错误或房间已满' };
    } catch (e) {
      if (e.message && e.message.indexOf('password') >= 0) {
        return { ok: false, why: '密码错误', needPassword: true };
      }
      return { ok: false, why: e.message };
    }
  }

  /* 快速加入：取第一个未满、未加密的房间 */
  function quickJoin() {
    var rooms = refreshRooms();
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      if (r.password) continue;
      if (r.playerCount >= (r.maxPlayers || 8)) continue;
      if (r.work !== 'cs1-6-step-explore') continue;
      return joinRoom(r.roomId || r.id);
    }
    return { ok: false, why: '没有可用的房间，请创建一个' };
  }

  /* 恢复上次房间 */
  function resumeRoom() {
    if (!_lastRoomId) return { ok: false, why: '没有上次的房间记录' };
    if (isInRoom()) leaveRoom();
    try {
      var room = VibeHub.joinRoom(_lastRoomId, '');
      if (room) {
        createTransport(room);
        setState('in-room');
        return { ok: true, room: room };
      }
    } catch (e) {
      // 上次房间可能已经解散
      _lastRoomId = null;
      saveState();
    }
    return { ok: false, why: '无法恢复上次房间' };
  }

  /* 离开房间 */
  function leaveRoom() {
    if (_transport) {
      try { _transport.leave(); } catch (e) { /* 忽略 */ }
      _transport = null;
    }
    _room = null;
    setState('lobby');
  }

  function isInRoom() { return _state === 'in-room' && _room !== null; }

  function getState() { return _state; }

  /* ================================================================
   *  UI 辅助（由 index.html 里的 HTML 元素配合调用）
   * ================================================================ */

  /* 在指定元素里渲染房间列表 */
  function renderRoomList(container) {
    if (!container) return;
    if (!_sdkReady) {
      container.innerHTML = '<div style="padding:14px;color:#ff8a7a;">VibeHub SDK 未加载，无法列出房间。<br>请检查网络连接后刷新页面。</div>';
      return;
    }
    var rooms = getRooms();
    if (!rooms.length) {
      container.innerHTML = '<div style="padding:14px;color:#a9a292;">暂无房间，点击「创建房间」来开一局</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      html += '<div class="roomrow" data-id="' + escapeAttr(r.roomId || r.id) + '"';
      if (r.password) html += ' data-pass="1"';
      html += '>';
      html += '<span class="roomname">' + escapeHtml(r.name || ('房间 ' + (i + 1))) + '</span>';
      html += '<span class="roominfo">';
      if (r.password) html += '🔒 ';
      html += (r.playerCount || 0) + '/' + (r.maxPlayers || 8) + ' 人';
      if (r.hostName) html += ' · 房主: ' + escapeHtml(r.hostName);
      html += '</span>';
      html += '<button class="joinybtn">加入</button>';
      html += '</div>';
    }
    container.innerHTML = html;

    // 绑定点击
    container.querySelectorAll('.joinybtn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var row = btn.parentElement;
        var id = row.getAttribute('data-id');
        if (row.getAttribute('data-pass') === '1') {
          var pw = prompt('该房间需要密码:');
          if (pw !== null) doJoin(id, pw);
        } else {
          doJoin(id, '');
        }
      });
    });
  }

  var _currentJoinId = null;
  function doJoin(id, pw) {
    _currentJoinId = id;
    LobbyApp.onJoinResult(joinRoom(id, pw));
  }

  /* ================================================================
   *  持久化
   * ================================================================ */
  function loadSettings() {
    loadSaved();
  }

  function saveSettings() {
    saveState();
  }

  function getSaveKey() { return SAVE_KEY; }

  /* 工具 */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }
  function escapeAttr(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
    });
  }

  /* 导出 */
  return {
    initSDK: initSDK,
    isSDKReady: isSDKReady,
    getSDKError: getSDKError,

    isLoggedIn: isLoggedIn,
    getUser: getUser,
    login: login,
    logout: logout,
    loadSettings: loadSettings,

    showLobby: showLobby,
    hideLobby: hideLobby,
    refreshRooms: refreshRooms,
    getRooms: getRooms,
    createRoom: createRoom,
    joinRoom: joinRoom,
    quickJoin: quickJoin,
    resumeRoom: resumeRoom,
    leaveRoom: leaveRoom,
    isInRoom: isInRoom,
    getState: getState,

    createTransport: createTransport,
    getTransport: getTransport,
    getRoom: getRoom,

    renderRoomList: renderRoomList,

    saveSettings: saveSettings,
    getSaveKey: getSaveKey
  };

})();
