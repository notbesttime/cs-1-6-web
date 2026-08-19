/* ============================================================
 *  transport.js — 传输层抽象
 *
 *  net.js 和游戏逻辑都只依赖下面这个接口，不直接碰 SDK：
 *
 *    send(msg, toPeerId?)          可靠有序 —— 开火/伤害/结算等不可丢事件
 *    sendRealtime(msg, toPeerId?)  可丢无序 —— 位姿/快照等可丢状态
 *    onMessage(cb(msg, fromId))
 *    onPeer(cb({type, id}))        'join' | 'leave' | 'reconnecting' | 'relay' | 'error'
 *    peers()                       [{id, latency, jitter, relay, ...}]
 *    isHost / peerId / roomId
 *    leave()
 *
 *  两个实现：
 *    VibeTransport     —— 包 VibeHub SDK 的 room（真实 WebRTC P2P + VibeNet 中继）
 *    LoopbackTransport —— 同一页面内的假传输，可注入延迟/抖动/丢包。
 *                         用它可以在【没有 VibeHub 账号】的情况下把网络代码跑完，
 *                         自检也靠它做端到端验证。
 * ============================================================ */
'use strict';

var TRANSPORT = (function () {

  /* ================================================================
   *  VibeHub SDK 传输
   *
   *  规范要求：可丢状态用 room.sendRealtime()，不可丢事件用 room.send()，
   *  两者绝不混在同一个包里。断线重连、中继选路、心跳由 SDK 内部完成。
   * ================================================================ */
  function VibeTransport(room) {
    this.room = room;
    this.kind = 'vibe';
    this._msgCbs = [];
    this._peerCbs = [];
    var self = this;
    room.onMessage(function (msg, fromId) {
      for (var i = 0; i < self._msgCbs.length; i++) self._msgCbs[i](msg, fromId);
    });
    room.onPeer(function (ev) {
      for (var i = 0; i < self._peerCbs.length; i++) self._peerCbs[i](ev);
    });
  }
  VibeTransport.prototype.send = function (msg, to) { this.room.send(msg, to); };
  VibeTransport.prototype.sendRealtime = function (msg, to) { this.room.sendRealtime(msg, to); };
  VibeTransport.prototype.onMessage = function (cb) { this._msgCbs.push(cb); return this; };
  VibeTransport.prototype.onPeer = function (cb) { this._peerCbs.push(cb); return this; };
  VibeTransport.prototype.peers = function () { return this.room.peers(); };
  VibeTransport.prototype.networkStats = function () { return this.room.networkStats(); };
  VibeTransport.prototype.leave = function () { this.room.leave(); };
  Object.defineProperty(VibeTransport.prototype, 'isHost', { get: function () { return this.room.isHost; } });
  Object.defineProperty(VibeTransport.prototype, 'peerId', { get: function () { return this.room.peerId; } });
  Object.defineProperty(VibeTransport.prototype, 'roomId', { get: function () { return this.room.roomId; } });
  Object.defineProperty(VibeTransport.prototype, 'hostId', { get: function () { return this.room.hostId; } });

  /* ================================================================
   *  Loopback：同页面内的假网络
   *
   *  一个 Hub 里挂多个 endpoint，互发消息时按配置延迟投递。
   *  · latencyMs / jitterMs：单向延迟与抖动
   *  · lossRate：只对 sendRealtime 生效（可靠通道不该丢包）
   *  · reorder：realtime 允许乱序（真实 DataChannel 就是无序的）
   * ================================================================ */
  function LoopbackHub(opts) {
    opts = opts || {};
    this.latencyMs = opts.latencyMs === undefined ? 40 : opts.latencyMs;
    this.jitterMs = opts.jitterMs === undefined ? 10 : opts.jitterMs;
    this.lossRate = opts.lossRate || 0;
    this.clockSkewMs = opts.clockSkewMs || 0;   // 给不同端点制造时钟偏差，用来验证时钟同步
    this.endpoints = new Map();
    this.stats = { sent: 0, delivered: 0, dropped: 0 };
    this._timers = [];
  }

  LoopbackHub.prototype.oneWayMs = function () {
    return Math.max(0, this.latencyMs + (Math.random() * 2 - 1) * this.jitterMs);
  };

  /* 创建一个端点。第一个创建的默认是房主。 */
  LoopbackHub.prototype.createEndpoint = function (peerId, opts) {
    opts = opts || {};
    var ep = new LoopbackTransport(this, peerId, opts);
    this.endpoints.set(peerId, ep);
    // 互相通告 join
    var self = this;
    this.endpoints.forEach(function (other) {
      if (other === ep) return;
      self._later(function () { other._emitPeer({ type: 'join', id: peerId }); }, self.oneWayMs());
      self._later(function () { ep._emitPeer({ type: 'join', id: other.peerId }); }, self.oneWayMs());
    });
    return ep;
  };

  LoopbackHub.prototype.removeEndpoint = function (peerId) {
    var ep = this.endpoints.get(peerId);
    if (!ep) return;
    this.endpoints.delete(peerId);
    var self = this;
    this.endpoints.forEach(function (other) {
      self._later(function () { other._emitPeer({ type: 'leave', id: peerId }); }, self.oneWayMs());
    });
  };

  LoopbackHub.prototype._later = function (fn, ms) {
    var id = setTimeout(fn, ms);
    this._timers.push(id);
  };

  LoopbackHub.prototype.dispatch = function (fromId, msg, to, reliable) {
    var self = this;
    var targets = [];
    if (to) {
      var t = this.endpoints.get(to);
      if (t) targets.push(t);
    } else {
      this.endpoints.forEach(function (ep) { if (ep.peerId !== fromId) targets.push(ep); });
    }
    for (var i = 0; i < targets.length; i++) {
      this.stats.sent++;
      if (!reliable && this.lossRate > 0 && Math.random() < this.lossRate) {
        this.stats.dropped++;
        continue;
      }
      (function (target) {
        // 深拷贝：模拟真实网络的序列化边界，防止两端共享同一个对象引用
        var payload = JSON.parse(JSON.stringify(msg));
        self._later(function () {
          self.stats.delivered++;
          target._emitMessage(payload, fromId);
        }, self.oneWayMs());
      })(targets[i]);
    }
  };

  LoopbackHub.prototype.destroy = function () {
    for (var i = 0; i < this._timers.length; i++) clearTimeout(this._timers[i]);
    this._timers.length = 0;
    this.endpoints.clear();
  };

  function LoopbackTransport(hub, peerId, opts) {
    this.hub = hub;
    this.kind = 'loopback';
    this._peerId = peerId;
    this._isHost = !!opts.isHost;
    this._roomId = opts.roomId || 'loopback';
    this._clockSkewMs = opts.clockSkewMs || 0;
    this._msgCbs = [];
    this._peerCbs = [];
  }
  LoopbackTransport.prototype.send = function (msg, to) { this.hub.dispatch(this._peerId, msg, to, true); };
  LoopbackTransport.prototype.sendRealtime = function (msg, to) { this.hub.dispatch(this._peerId, msg, to, false); };
  LoopbackTransport.prototype.onMessage = function (cb) { this._msgCbs.push(cb); return this; };
  LoopbackTransport.prototype.onPeer = function (cb) { this._peerCbs.push(cb); return this; };
  LoopbackTransport.prototype._emitMessage = function (msg, from) {
    for (var i = 0; i < this._msgCbs.length; i++) this._msgCbs[i](msg, from);
  };
  LoopbackTransport.prototype._emitPeer = function (ev) {
    for (var i = 0; i < this._peerCbs.length; i++) this._peerCbs[i](ev);
  };
  LoopbackTransport.prototype.peers = function () {
    var out = [], self = this;
    this.hub.endpoints.forEach(function (ep) {
      if (ep.peerId === self._peerId) return;
      out.push({
        id: ep.peerId, open: true, relay: false, realtime: true, reconnecting: false,
        latency: self.hub.latencyMs * 2, jitter: self.hub.jitterMs
      });
    });
    return out;
  };
  LoopbackTransport.prototype.networkStats = function () {
    return { state: 'direct', quality: { rttP50Ms: this.hub.latencyMs * 2 } };
  };
  LoopbackTransport.prototype.leave = function () { this.hub.removeEndpoint(this._peerId); };
  /* 本端的"本地时钟"，用 clockSkew 模拟各机器时钟不一致 */
  LoopbackTransport.prototype.localNow = function () { return Date.now() + this._clockSkewMs; };
  Object.defineProperty(LoopbackTransport.prototype, 'isHost', { get: function () { return this._isHost; } });
  Object.defineProperty(LoopbackTransport.prototype, 'peerId', { get: function () { return this._peerId; } });
  Object.defineProperty(LoopbackTransport.prototype, 'roomId', { get: function () { return this._roomId; } });
  Object.defineProperty(LoopbackTransport.prototype, 'hostId', {
    get: function () {
      var host = null;
      this.hub.endpoints.forEach(function (ep) { if (ep.isHost) host = ep.peerId; });
      return host;
    }
  });

  return {
    VibeTransport: VibeTransport,
    LoopbackHub: LoopbackHub,
    LoopbackTransport: LoopbackTransport
  };
})();
