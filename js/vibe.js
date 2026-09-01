/* ============================================================
 *  vibe.js — VibeHub SDK v3 集成
 *
 *  SDK v3 API（平台会自动注入 VibeHub 全局对象）:
 *    VibeHub.init({work})     → Promise<VibeSDK>
 *    vibe.login()             → Promise<{id, name, image}>
 *    vibe.onAuthChange(cb)    → () => void (取消监听)
 *    vibe.save.get/set/all()  玩家存档（三层数据之一）
 *    vibe.room.join(rid, opts) → Promise<Room>
 *    room.announce(meta)      发布房间到大厅
 *    room.send(obj, toId?)    可靠有序广播
 *    room.sendRealtime(obj)   可丢无序
 *    room.onMessage(cb)       (msg, fromId) => void
 *    room.onPeer(cb)          ({type, id, ...}) => void
 *    room.leave()             离开房间
 *    room.data.get/set/all()  房间共享数据
 *    room.state.set/get/on()  房主权威状态
 *
 *  消息格式：SDK 内部自动 JSON 序列化，游戏代码发送/接收普通 JS 对象即可。
 *  底层 wire 协议细节（类型 0/1/2/3 envelope、encryption、relay）
 *  全部由 SDK 处理，vibe.js 和 transport.js 无需关心。
 * ============================================================ */
'use strict';

var VIBE = (function () {

  /* ======================== 状态机 ========================
   *  idle → lobby → in-room
   * ======================================================== */
  var _state = 'idle';       // 'idle' | 'lobby' | 'in-room'
  var _sdk = null;           // VibeSDK instance
  var _room = null;          // Room instance
  var _authUnsub = null;     // onAuthChange 取消监听
  var _user = null;          // {id, name, image} | null
  var _onStateCbs = [];      // 状态变化回调
  var _initPromise = null;   // initSDK() 的 Promise
  var _lastRoomId = null;    // 上次 roomId（恢复用）
  var _lastRoomMeta = null;  // 当前/最近房间的设置元数据（地图/模式/人数/胜利条件）
  var _transport = null;     // 当前房间的传输层（game.js 联机入口从这里取）
  var _isCreator = false;    // 当前房间是否由本机创建（离开时要负责 close 下架）

  /* ---------- 持久化 ---------- */
  var SAVE_KEY = 'vibe_save';
  function saveState() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        user: _user,
        lastRoomId: _lastRoomId
      }));
    } catch (e) { /* quota exceeded → 静默 */ }
  }
  function loadSaved() {
    try {
      var s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null');
      if (s && s.user) _lastRoomId = s.lastRoomId || null;
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
   *  SDK 初始化（幂等：重复调用安全）
   * ================================================================ */
  function initSDK() {
    if (_initPromise) return _initPromise;
    if (typeof VibeHub === 'undefined') {
      return Promise.reject(new Error('VibeHub SDK 未注入（平台应在 iframe 中自动注入）'));
    }
    _initPromise = VibeHub.init({ work: 'cs1-6-step-explore' }).then(function (sdk) {
      _sdk = sdk;
      _user = sdk.user || null;
      // 监听登录态变化（包括 token 过期自动刷新）
      _authUnsub = sdk.onAuthChange(function (user) {
        _user = user;
        saveState();
      });
      loadSaved();
      setState('idle');
      return _sdk;
    }).catch(function (err) {
      _initPromise = null;
      console.error('[VIBE] initSDK failed:', err);
      throw err;
    });
    return _initPromise;
  }

  function isSDKReady() { return !!_sdk; }
  function getSDK() { return _sdk; }

  /* ================================================================
   *  登录/退出
   * ================================================================ */
  function isLoggedIn() { return !!(_sdk && _sdk.isLoggedIn()); }
  function getUser() { return _user; }

  function login() {
    if (!_sdk) return Promise.reject(new Error('SDK 未就绪'));
    return _sdk.login().then(function (user) {
      _user = user;
      saveState();
      return user;
    });
  }

  function logout() {
    if (!_sdk) return;
    if (_authUnsub) { _authUnsub(); _authUnsub = null; }
    _sdk.logout();
    _user = null;
    _lastRoomId = null;
    saveState();
    if (_room) leaveRoom();
    setState('idle');
  }

  /* ================================================================
   *  传输桥接：v3 Room → 游戏认识的 VibeTransport
   *
   *  关键差异：
   *    · v3 send()/sendRealtime() 是 fire-and-forget（返回 undefined）
   *    · 消息自动 JSON 序列化，我们发送/接收普通 JS 对象
   *    · 没有 room.hostId — 用 room.state 广播 hostId
   *    · onMessage(msg, fromId) — msg 是反序列化后的对象
   * ================================================================ */
  function createTransport(room) {
    var transport = new VibeTransportV3(room);
    _room = room;
    _transport = transport;
    return transport;
  }

  /* 供 game.js 的联机入口取当前传输层 */
  function getTransport() { return _transport; }

  function VibeTransportV3(room) {
    this.room = room;
    this.kind = 'vibe';
    this._msgCbs = [];
    this._peerCbs = [];
    var self = this;
    room.onMessage(function (msg, fromId) {
      for (var i = 0; i < self._msgCbs.length; i++) self._msgCbs[i](msg, fromId);
    });
    room.onPeer(function (ev) {
      // SDK v3 的 peer 事件格式可能略有不同，做兼容
      var type = ev && ev.type ? ev.type : ev;
      var id = ev && ev.id ? ev.id : '';
      for (var i = 0; i < self._peerCbs.length; i++) self._peerCbs[i]({ type: type, id: id });
    });
    // host 判定直接用 SDK 的原子认领结果（room.isHost / room.hostId）。
    // 不再自己往 room.state 写 _hostId：host-authority 下客户端写 state 会被 SDK 拒绝，
    // 而且 LWW 时序不可靠，是之前联机 host 混乱的根源。
  }

  // v3 send() 是 fire-and-forget，不需返回值
  VibeTransportV3.prototype.send = function (msg, to) { this.room.send(msg, to); };
  VibeTransportV3.prototype.sendRealtime = function (msg, to) { this.room.sendRealtime(msg, to); };
  VibeTransportV3.prototype.onMessage = function (cb) { this._msgCbs.push(cb); return this; };
  VibeTransportV3.prototype.onPeer = function (cb) { this._peerCbs.push(cb); return this; };
  VibeTransportV3.prototype.peers = function () {
    // VibeNet 中继节点（relay:true）不是对局玩家，不能给它们发游戏消息
    var ps = this.room.peers() || [];
    var out = [];
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].relay) continue;
      out.push(ps[i]);
    }
    return out;
  };
  VibeTransportV3.prototype.networkStats = function () { return this.room.networkStats ? this.room.networkStats() : null; };
  VibeTransportV3.prototype.leave = function () { this.room.leave(); };

  // host 判定全部走 SDK 原子认领结果
  Object.defineProperty(VibeTransportV3.prototype, 'isHost', {
    get: function () { return !!this.room.isHost; }
  });
  Object.defineProperty(VibeTransportV3.prototype, 'peerId', { get: function () { return this.room.peerId; } });
  Object.defineProperty(VibeTransportV3.prototype, 'roomId', { get: function () { return this.room.roomId; } });
  Object.defineProperty(VibeTransportV3.prototype, 'hostId', {
    get: function () { return this.room.hostId || this.room.peerId; }
  });

  /* host 由 SDK 服务端原子认领，无需手动宣告；保留空实现兼容旧调用 */
  function announceHost() { }

  /* ================================================================
   *  大厅操作
   * ================================================================ */
  function showLobby() {
    if (!isLoggedIn()) return false;
    setState('lobby');
    refreshRooms();
    return true;
  }

  function hideLobby() {
    setState('idle');
  }

  function refreshRooms() {
    if (!_sdk) return [];
    return _sdk.rooms.list().then(function (rooms) {
      _peers = rooms || [];
      return _peers;
    }).catch(function (e) {
      console.warn('[VIBE] listRooms failed:', e);
      _peers = [];
      return [];
    });
  }

  var _peers = [];
  function getRooms() { return _peers; }

  /* 创建房间：join → announce（SDK v3 没有 room.create） */
  function createRoom(name, opts) {
    opts = opts || {};
    if (!isLoggedIn()) return Promise.reject(new Error('未登录'));
    if (isInRoom()) leaveRoom();

    // 唯一 roomId：名字只做展示，避免同名房间互相串门
    var roomId = 'cs16_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    return _sdk.room.join(roomId, { topology: 'host' }).then(function (room) {
      _lastRoomId = roomId;
      _isCreator = true;
      var transport = createTransport(room);
      setState('in-room');
      saveState();
      // 房间设置随 announce 元数据发布；加入方用 rooms.get 读取并按同一设置开局
      _lastRoomMeta = {
        name: name,
        map: opts.map || 'dust2',
        gameMode: opts.gameMode || 'bomb',
        teamSize: opts.teamSize || 4,
        playerSize: opts.playerSize || 2,
        win: opts.win || null,
        hostTeam: opts.hostTeam || 'CT',
        host: (_user && _user.name) || 'Unknown'
      };
      return room.announce({
        open: true,
        listed: true,
        name: name,
        max: opts.maxPlayers || (_lastRoomMeta.playerSize * 2),
        map: _lastRoomMeta.map,
        gameMode: _lastRoomMeta.gameMode,
        teamSize: _lastRoomMeta.teamSize,
        playerSize: _lastRoomMeta.playerSize,
        win: _lastRoomMeta.win,
        hostTeam: _lastRoomMeta.hostTeam,
        host: _lastRoomMeta.host,
        pass: opts.password || undefined
      }).then(function () {
        return { ok: true, room: room, transport: transport };
      });
    }).catch(function (e) {
      return { ok: false, why: e.message || '创建房间失败' };
    });
  }

  /* 加入房间（密码房先用 rooms.get 校验 pass；元数据缓存供开局设置用） */
  function joinRoom(roomId, password) {
    if (!isLoggedIn()) return Promise.reject(new Error('未登录'));
    if (isInRoom()) leaveRoom();

    var check = _sdk.rooms.get(roomId).then(function (meta) {
      _lastRoomMeta = meta || null;              // 保存房间设置（地图/模式/人数/胜利条件）
      _isCreator = false;                        // 加入的房间，离开时无需 close
      if (meta && meta.pass && meta.pass !== (password || '')) return { bad: true };
      return {};
    }).catch(function () { return {}; });   // 查不到元数据就直接尝试加入

    return check.then(function (v) {
      if (v.bad) return { ok: false, why: '密码错误', needPassword: true };
      return _sdk.room.join(roomId, { topology: 'host' }).then(function (room) {
        _lastRoomId = roomId;
        var transport = createTransport(room);
        setState('in-room');
        saveState();
        return { ok: true, room: room, transport: transport };
      });
    }).catch(function (e) {
      return { ok: false, why: e.message || '加入失败' };
    });
  }

  /* 快速加入 */
  function quickJoin() {
    if (!_sdk) return Promise.resolve({ ok: false, why: 'SDK 未就绪' });
    return _sdk.rooms.quickJoin({ filter: function (r) { return r.open !== false && !r.pass; } }).then(function (roomId) {
      if (!roomId) return { ok: false, why: '没有可用的房间' };
      return joinRoom(roomId, '');
    }).catch(function (e) {
      return { ok: false, why: e.message };
    });
  }

  /* 恢复上次房间 */
  function resumeRoom() {
    if (!_lastRoomId) return Promise.resolve({ ok: false, why: '没有上次的房间记录' });
    return joinRoom(_lastRoomId, '');
  }

  /* 离开房间 */
  function leaveRoom() {
    if (_room) {
      try {
        // 创建者离开时负责把房间从大厅下架，避免遗留幽灵房
        if (_isCreator && _room.close) _room.close();
      } catch (e) { /* 忽略 */ }
      try { _room.leave(); } catch (e) { /* 忽略 */ }
      _room = null;
    }
    _isCreator = false;
    _transport = null;
    setState('lobby');
  }

  /* 页面关闭/刷新时尽力退房，减少遗留房间 */
  window.addEventListener('pagehide', function () {
    try {
      if (_room) {
        if (_isCreator && _room.close) { try { _room.close(); } catch (e) { } }
        _room.leave();
      }
    } catch (e) { }
    _transport = null;
  });

  function isInRoom() { return _state === 'in-room' && _room !== null; }

  function getState() { return _state; }
  function getRoom() { return _room; }

  /* ================================================================
   *  房间列表渲染
   * ================================================================ */
  function renderRoomList(container) {
    if (!container) return;
    if (!_sdk) {
      container.innerHTML = '<div style="padding:14px;color:#ff8a7a;">SDK 未就绪</div>';
      return;
    }
    var rooms = _peers;
    if (!rooms || !rooms.length) {
      container.innerHTML = '<div style="padding:14px;color:#a9a292;">暂无房间，点击「创建房间」来开一局</div>';
      return;
    }
    var html = '';
    var shown = 0;
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      if ((r.players || 0) === 0) continue;   // 0 人的是遗留幽灵房，不显示
      shown++;
      var mapName = r.map === 'warehouse' ? '仓库' : (r.map === 'dust2' ? 'dust2' : (r.map || ''));
      var modeName = r.gameMode === 'teamdm' ? '团队竞技' : (r.gameMode === 'bomb' ? '爆破' : '');
      html += '<div class="roomrow" data-id="' + escapeAttr(r.roomId || r.id) + '">';
      html += '<span class="roomname">' + escapeHtml(r.name || ('房间 ' + (i + 1))) + '</span>';
      html += '<span class="roominfo">';
      if (r.pass) html += '🔒 ';
      if (modeName) html += '【' + modeName + '】';
      if (mapName) html += ' ' + mapName;
      html += ' · ' + (r.players || 0) + '/' + (r.max || 8) + ' 人';
      if (r.host) html += ' · 房主: ' + escapeHtml(r.host);
      html += '</span>';
      html += '<button class="joinybtn">加入</button>';
      html += '</div>';
    }
    container.innerHTML = shown ? html : '<div style="padding:14px;color:#a9a292;">暂无房间，点击「创建房间」来开一局</div>';
    container.querySelectorAll('.joinybtn').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = btn.parentElement.getAttribute('data-id');
        var pw = '';
        for (var k = 0; k < rooms.length; k++) {
          if ((rooms[k].roomId || rooms[k].id) === id && rooms[k].pass) {
            pw = prompt('该房间需要密码：') || '';
            break;
          }
        }
        doJoin(id, pw);
      });
    });
  }

  var _currentJoinId = null;
  function doJoin(id, pw) {
    _currentJoinId = id;
    joinRoom(id, pw || '').then(function (r) {
      if (r && r.needPassword) {
        var pass = prompt('该房间需要密码：');
        if (pass === null) return null;
        return joinRoom(id, pass);
      }
      return r;
    }).then(function (r) {
      if (r) LobbyApp.onJoinResult(r);
    });
  }

  /* ================================================================
   *  工具
   * ================================================================ */
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
    getSDK: getSDK,
    getSDKError: function () { return _sdkError || null; },

    isLoggedIn: isLoggedIn,
    getUser: getUser,
    login: login,
    logout: logout,

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
    getRoom: getRoom,
    getRoomMeta: function () { return _lastRoomMeta; },
    getTransport: function () { return _transport; },

    createTransport: createTransport,
    announceHost: announceHost,

    renderRoomList: renderRoomList
  };

})();
