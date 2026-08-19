/* ============================================================
 *  net.js — 联机地基（协议 / 时钟 / 插值 / 回溯命中 / delta）
 *
 *  同步模型：state-sync + 房主权威（host 拓扑）
 *    · 房主：回合与计时、比分、经济、C4、bot AI、命中判定、出生点
 *    · 客户端：自己的位姿（12Hz 绝对状态上行）、自己的血量算术（dmgAck 回报）
 *
 *  这一层【不依赖】任何传输实现，也不碰渲染和游戏状态，
 *  所以可以用 js/transport.js 里的 LoopbackTransport 完全离线跑测试。
 *
 *  单位：全部用 CS unit（1 m ≈ 39.37 unit，玩家眼高 64 unit ≈ 1.63 m）。
 *  参考实现是米制的，凡是长度阈值都已换算，角度/时间原样沿用。
 * ============================================================ */
'use strict';

var NET = (function () {

  /* ================================================================
   *  一、协议常量
   * ================================================================ */
  var P = {
    VERSION: 1,

    /* --- 频率 --- */
    POSE_HZ: 12,             // 自己的位姿上行（注意用 acc -= interval，不要 acc = 0）
    SNAPSHOT_HZ: 15,         // 房主广播玩家快照
    MATCH_MS: 250,           // 房主广播回合/经济/C4 状态
    FULL_MATCH_MS: 2000,     // 每 2 秒强制一次全量快照（丢了 delta 也能自愈）
    PING_MS: 1000,           // 时钟采样（比参考实现的 15s 密得多，因为我们要靠它做回溯）

    /* --- 插值：两条独立车道，不能合并 --- */
    // 真人（快车道）：由 15Hz 快照驱动
    INTERP_BASE_MS: 85,
    INTERP_MIN_MS: 70,
    INTERP_MAX_MS: 120,
    INTERP_JITTER_ALPHA: 0.15,
    EXTRAP_MAX_MS: 100,
    // bot（慢车道）：由 250ms match 通道驱动
    ENTITY_INTERP_MIN_MS: 260,
    ENTITY_INTERP_MAX_MS: 520,
    ENTITY_INTERP_ALPHA: 0.18,
    ENTITY_EXTRAP_MAX_MS: 120,
    RECOVERY_PENALTY_MAX_MS: 100,
    RECOVERY_DECAY_MS: 8,

    /* --- 缓冲与阈值（长度单位 = CS unit） --- */
    SNAP_BUFFER: 10,         // 快照环形缓冲条数（15Hz 下约 0.66 秒）
    TELEPORT_DIST: 470,      // ≈12 m：超过就认为是传送，清缓冲硬切
    POS_EPSILON: 8,          // ≈0.2 m：delta 判定"动了"的阈值
    ANG_EPSILON: 0.08,       // rad
    POS_QUANT: 4,            // ≈0.1 m：量化步长（比 epsilon 细，故意的）
    ANG_QUANT: 0.01,         // rad

    /* --- 命中回溯 --- */
    MAX_REWIND_MS: 200,      // 最多回溯这么久，防止客户端报很老的 fireTime
    HISTORY_MS: 450,         // 每个实体保留的位姿历史长度
    ORIGIN_TOLERANCE: 98,    // ≈2.5 m：客户端自报枪口位置与其历史位置的最大偏差
    HULL_RADIUS: 16,         // 与 phys.js 的 HULL_R 一致
    STAND_HEIGHT: 72,
    CROUCH_HEIGHT: 36,
    HEAD_FRACTION: 0.82,     // 命中高度 > 身高 * 这个比例 → 算爆头

    /* --- 房间与健康度 --- */
    MAX_ROOM_PLAYERS: 4,
    MATCH_STALL_MS: 1500,    // match 通道断流这么久 → 请求 resync
    RESYNC_COOLDOWN_MS: 2000,
    SPAWN_PROTECT_MS: 1200,

    /* --- 消息类型 ---
     * 可丢状态走 sendRealtime，不可丢事件走 send，两者绝不混在一个包里 */
    RT: { POSE: 'p', SNAP: 's', MATCH: 'm' },
    EV: {
      HELLO: 'hello', PING: 'ping', PONG: 'pong',
      FIRE: 'fire', MELEE: 'melee', NADE: 'nade',
      DMG: 'dmg', DMG_ACK: 'dmgAck', HIT: 'hit', KILL: 'kill', DEATH: 'death',
      BUY: 'buy', BUY_RESULT: 'buyResult',
      INTERACT: 'interact', BOMB: 'bomb',
      ROUND_START: 'roundStart', ROUND_END: 'roundEnd',
      RESYNC: 'resync', CHAT: 'chat'
    }
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  /* 角度按最短弧插值（alpha 允许 >1 用于外推） */
  function lerpAngle(a, b, t) {
    return a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
  }
  function quant(v, step) { return Math.round(v / step) * step; }

  /* ================================================================
   *  二、时钟同步
   *
   *  参考实现只取 max(remoteTime - Date.now())，既没减单向延迟、
   *  又会被单个离群样本永久污染。这里改成：
   *    · ping/pong 量出真实 RTT
   *    · 只采信 RTT 最小的那批样本（最小 RTT 时刻的时钟偏移最准）
   *    · offset = remoteTime + rtt/2 - localRecvTime
   * ================================================================ */
  function Clock() {
    this.samples = [];        // {offset, rtt}
    this.offsetMs = 0;
        this.rttMs = 0;
    this.ready = false;
  }
  Clock.prototype.SAMPLE_MAX = 16;

  /* 收到 pong：t0 = 我发出的时间，remote = 对方回包时它的本地时间 */
  Clock.prototype.observe = function (t0, remoteTime, now) {
    now = now === undefined ? Date.now() : now;
    var rtt = Math.max(0, now - t0);
    // 对方生成 remoteTime 的时刻 ≈ 单程之后，所以补回 rtt/2
    var offset = remoteTime + rtt / 2 - now;
    this.samples.push({ offset: offset, rtt: rtt });
    if (this.samples.length > this.SAMPLE_MAX) this.samples.shift();
    // 取 RTT 最小的 1/3 样本求均值，抗抖动又不被离群值锁死
    var sorted = this.samples.slice().sort(function (a, b) { return a.rtt - b.rtt; });
    var take = Math.max(1, Math.floor(sorted.length / 3));
    var sum = 0, rsum = 0;
    for (var i = 0; i < take; i++) { sum += sorted[i].offset; rsum += sorted[i].rtt; }
    this.offsetMs = sum / take;
    this.rttMs = rsum / take;
    this.ready = true;
    return { rtt: rtt, offset: offset };
  };

  /* 换算成"房主时间轴"上的当前时刻 */
  Clock.prototype.now = function (localNow) {
    localNow = localNow === undefined ? Date.now() : localNow;
    return localNow + (this.ready ? this.offsetMs : 0);
  };
  Clock.prototype.reset = function () {
    this.samples.length = 0; this.offsetMs = 0; this.rttMs = 0; this.ready = false;
  };

  /* ================================================================
   *  三、自适应插值延迟
   *
   *  到包间隔越不稳，缓冲就要留得越厚。两条车道各用一个实例。
   * ================================================================ */
  function InterpDelay(baseMs, minMs, maxMs, alpha, biasMs) {
    this.base = baseMs;              // 车道基准延迟
    this.bias = biasMs || 0;         // 慢车道额外留的余量
    this.expected = baseMs;          // 期望到包间隔（用于算抖动）
    this.min = minMs; this.max = maxMs; this.alpha = alpha;
    this.jitterMs = 0;
    this.lastArrival = 0;
    this.penaltyMs = 0;
    this.delayMs = clamp(this.base + this.bias, minMs, maxMs);
  }
  /* 每收到一个驱动包调用一次：delay = clamp(base + bias + 抖动*2 + 恢复惩罚) */
  InterpDelay.prototype.observe = function (now) {
    now = now === undefined ? Date.now() : now;
    if (this.lastArrival) {
      var jitter = Math.abs((now - this.lastArrival) - this.expected);
      this.jitterMs = lerp(this.jitterMs, jitter, this.alpha);
    }
    this.lastArrival = now;
    this.penaltyMs = Math.max(0, this.penaltyMs - P.RECOVERY_DECAY_MS);
    this.delayMs = clamp(this.base + this.bias + this.jitterMs * 2 + this.penaltyMs, this.min, this.max);
    return this.delayMs;
  };
  /* resync / 断流后临时加厚缓冲，避免恢复期抖动 */
  InterpDelay.prototype.penalize = function (ms) {
    this.penaltyMs = Math.min(P.RECOVERY_PENALTY_MAX_MS, this.penaltyMs + ms);
  };
  InterpDelay.prototype.reset = function () {
    this.jitterMs = 0; this.lastArrival = 0; this.penaltyMs = 0;
    this.delayMs = clamp(this.base + this.bias, this.min, this.max);
  };

  /* 快车道（真人）：base 85ms，期望到包间隔 = 快照间隔，clamp[70,120] */
  function makePlayerDelay() {
    var d = new InterpDelay(P.INTERP_BASE_MS, P.INTERP_MIN_MS, P.INTERP_MAX_MS, P.INTERP_JITTER_ALPHA, 0);
    d.expected = 1000 / P.SNAPSHOT_HZ;
    return d;
  }
  /* 慢车道（bot）：base = match 间隔，额外 +20ms，clamp[260,520] */
  function makeEntityDelay() {
    var d = new InterpDelay(P.MATCH_MS, P.ENTITY_INTERP_MIN_MS, P.ENTITY_INTERP_MAX_MS, P.ENTITY_INTERP_ALPHA, 20);
    d.expected = P.MATCH_MS;
    return d;
  }

  /* ================================================================
   *  四、位姿历史 + 插值
   *
   *  一个 Track 对应一个远程实体。写入用房主时间轴的时间戳。
   * ================================================================ */
  /* 一个 Track 对应一个远程实体。写入用房主时间轴的时间戳。
   *
   * 两种模式，别混用（参考实现是两个独立缓冲，我一开始合并成一个，被自检抓出来了）：
   *   · 渲染模式（默认）：遇到换命/生死变化/传送 → 清空缓冲硬切，
   *     否则会把"死前"和"复活后"插成一团。
   *   · 历史模式（history: true）：永不清空，房主用它做命中回溯 ——
   *     必须保留跨死亡的样本，否则回溯不到"他死前那一刻其实被打中了"。
   *     边界不插值的处理放在 at() 里。
   */
  function Track(opts) {
    opts = opts || {};
    this.samples = [];
    this.limit = opts.limit || P.SNAP_BUFFER;
    this.teleportDist = opts.teleportDist || P.TELEPORT_DIST;
    this.historyMs = opts.historyMs || P.HISTORY_MS;
    this.isHistory = !!opts.history;
    if (this.isHistory) this.limit = opts.limit || 64;   // 450ms @ 12~15Hz 够用，留足余量
    this.snapped = false;
  }

  /* 追加一帧位姿。返回 true 表示发生了硬切（渲染模式下调用方应把位置直接对齐） */
  Track.prototype.push = function (s) {
    var last = this.samples[this.samples.length - 1];
    var hard = false;
    if (!last) hard = true;
    else if (!this.isHistory) {
      // 生命/存活变化或位移超过传送阈值 → 之前的样本不能再用来插值
      var jumped = Math.hypot((s.x - last.x), (s.z - last.z)) > this.teleportDist;
      if (last.lifeId !== s.lifeId || last.alive !== s.alive || jumped) {
        this.samples.length = 0;
        hard = true;
      }
    }

    var cur = this.samples[this.samples.length - 1];
    if (cur && cur.time === s.time) this.samples[this.samples.length - 1] = s;   // 同一时刻去重
    else if (cur && s.time < cur.time) return hard;                              // 迟到的旧包直接丢
    else this.samples.push(s);

    while (this.samples.length > this.limit) this.samples.shift();
    this.snapped = hard;
    return hard;
  };

  /* 渲染插值：renderTime = clock.now() - interpDelay */
  Track.prototype.sample = function (renderTime, extrapMaxMs) {
    var n = this.samples.length;
    if (!n) return null;
    if (n === 1) return this.samples[0];

    // 丢掉已经用不到的旧样本，但至少留两个
    while (this.samples.length > 2 && this.samples[1].time <= renderTime) this.samples.shift();

    var a = this.samples[0], b = this.samples[1];
    if (renderTime <= a.time) return a;                       // 缓冲还没喂饱：保持最旧的一帧

    var span = Math.max(1, b.time - a.time);
    if (renderTime <= b.time) {
      var t = clamp((renderTime - a.time) / span, 0, 1);
      return this.blend(a, b, t);
    }
    // 外推：只在上限内按最后一段速度线性延伸
    var extra = Math.min(extrapMaxMs === undefined ? P.EXTRAP_MAX_MS : extrapMaxMs, renderTime - b.time);
    return this.blend(a, b, 1 + extra / span);
  };

  Track.prototype.blend = function (a, b, t) {
    return {
      time: lerp(a.time, b.time, t),
      x: lerp(a.x, b.x, t),
      y: lerp(a.y, b.y, t),
      z: lerp(a.z, b.z, t),
      yaw: lerpAngle(a.yaw, b.yaw, t),
      pitch: lerp(a.pitch || 0, b.pitch || 0, clamp(t, 0, 1)),
      // 这些是离散状态，不插值，取靠后的那帧
      crouch: (t >= 0.5 ? b : a).crouch,
      alive: (t >= 0.5 ? b : a).alive,
      lifeId: b.lifeId,
      hp: (t >= 0.5 ? b : a).hp,
      wep: (t >= 0.5 ? b : a).wep,
      extrapolated: t > 1
    };
  };

  /* 命中回溯用：取某个历史时刻的状态（不外推，且不跨越生命边界插值） */
  Track.prototype.at = function (wantedTime) {
    var h = this.samples, n = h.length;
    if (!n) return null;
    if (wantedTime <= h[0].time) return h[0];
    var last = h[n - 1];
    if (wantedTime >= last.time) return last;
    for (var i = 1; i < n; i++) {
      var b = h[i];
      if (b.time < wantedTime) continue;
      var a = h[i - 1];
      if (a.lifeId !== b.lifeId || a.alive !== b.alive) return wantedTime < b.time ? a : b;
      var t = clamp((wantedTime - a.time) / Math.max(1, b.time - a.time), 0, 1);
      return this.blend(a, b, t);
    }
    return last;
  };

  Track.prototype.prune = function (now) {
    var cutoff = now - this.historyMs;
    while (this.samples.length > 2 && this.samples[1].time < cutoff) this.samples.shift();
  };
  Track.prototype.clear = function () { this.samples.length = 0; this.snapped = false; };

  /* ================================================================
   *  五、回溯命中判定（只在房主端跑）
   * ================================================================ */

  /* 线段 vs 竖直胶囊（圆柱 + 上下各留一点余量）。命中返回 {t, y}，否则 null */
  function segmentHitsCapsule(from, to, cx, footY, cz, radius, height) {
    var ax = to.x - from.x, ay = to.y - from.y, az = to.z - from.z;
    var yLo = footY - 5, yHi = footY + height + 6;
    var fx = from.x - cx, fz = from.z - cz;
    var t0, t1;
    var a = ax * ax + az * az;
    if (a < 1e-8) {
      if (fx * fx + fz * fz > radius * radius) return null;
      t0 = 0; t1 = 1;
    } else {
      var b = fx * ax + fz * az;
      var c = fx * fx + fz * fz - radius * radius;
      var disc = b * b - a * c;
      if (disc < 0) return null;
      var sq = Math.sqrt(disc);
      t0 = (-b - sq) / a;
      t1 = (-b + sq) / a;
      if (t1 < 0 || t0 > 1) return null;
      t0 = Math.max(0, t0); t1 = Math.min(1, t1);
    }
    if (Math.abs(ay) < 1e-8) {
      if (from.y < yLo || from.y > yHi) return null;
    } else {
      var ta = (yLo - from.y) / ay, tb = (yHi - from.y) / ay;
      if (ta > tb) { var sw = ta; ta = tb; tb = sw; }
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    return { t: t0, y: from.y + ay * t0 };
  }

  /* 回溯判定一次射击。
   * shot: {x,y,z, dx,dy,dz, range, lifeId, fireTime, viewTime, originTolerance}
   * shooter: {lifeId, track}
   * candidates: [{id, team, lifeId, alive, spawnProtectedUntil, track}]
   * 返回 {id, headshot, dist, point} 或 null（并在 reason 里说明为什么没中）
   */
  function rewindHit(shot, shooter, shooterTeam, candidates, now) {
    var out = { hit: null, reason: '' };
    if (!shot || !shooter || !shooter.track) { out.reason = 'no-shooter'; return out; }
    // 用上一条命的射击不算（防止死后补刀 / 重放）
    if (!shot.lifeId || shot.lifeId !== shooter.lifeId) { out.reason = 'stale-life'; return out; }

    var fireTime = Math.max(now - P.MAX_REWIND_MS, Math.min(now, isFinite(shot.fireTime) ? shot.fireTime : now));
    var hs = shooter.track.at(fireTime);
    if (!hs || !hs.alive) { out.reason = 'shooter-not-alive'; return out; }
    // 客户端自报的枪口位置必须和它当时真实位置吻合（防瞬移/远程作弊）
    var tol = shot.originTolerance || P.ORIGIN_TOLERANCE;
    if (Math.hypot(shot.x - hs.x, shot.y - (hs.y + 64), shot.z - hs.z) > tol) {
      out.reason = 'origin-mismatch';
      return out;
    }

    // 关键：回溯到"射击者屏幕上真正看到的那一帧"
    var viewTime = Math.max(now - P.MAX_REWIND_MS,
      Math.min(fireTime, isFinite(shot.viewTime) ? shot.viewTime : fireTime));

    var from = { x: shot.x, y: shot.y, z: shot.z };
    var range = Math.min(shot.range || 8192, 12000);
    var to = { x: shot.x + shot.dx * range, y: shot.y + shot.dy * range, z: shot.z + shot.dz * range };

    var best = null;
    for (var i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      if (!c.track || c.team === shooterTeam) continue;
      var st = c.track.at(viewTime);
      if (!st || !st.alive) continue;
      if ((st.spawnProtectedUntil || c.spawnProtectedUntil || 0) > viewTime) continue;
      var h = st.crouch ? P.CROUCH_HEIGHT : P.STAND_HEIGHT;
      var r = segmentHitsCapsule(from, to, st.x, st.y, st.z, P.HULL_RADIUS, h);
      if (!r) continue;
      if (!best || r.t < best.t) {
        best = { id: c.id, t: r.t, headshot: (r.y - st.y) > h * P.HEAD_FRACTION, point: r.y };
      }
    }
    if (!best) { out.reason = 'miss'; return out; }
    out.hit = { id: best.id, headshot: best.headshot, dist: best.t * range, y: best.point };
    return out;
  }

  /* ================================================================
   *  六、delta 行编码
   *
   *  行是扁平数值数组，位置/角度先量化，天然适合以后换二进制。
   *  critical 字段（存活、血量、武器…）一变就立刻发，不受限流约束 ——
   *  参考实现踩过的坑：把状态转移压在限流后面会让重生请求被吞掉。
   * ================================================================ */
  function encodePoseRow(e) {
    return [
      e.id,
      quant(e.x, P.POS_QUANT), quant(e.y, P.POS_QUANT), quant(e.z, P.POS_QUANT),
      quant(e.yaw, P.ANG_QUANT), quant(e.pitch || 0, P.ANG_QUANT),
      e.crouch ? 1 : 0, e.alive ? 1 : 0,
      Math.max(0, Math.round(e.hp || 0)),
      e.team === 'T' ? 0 : 1,
      e.wep || 0,
      e.lifeId || 0
    ];
  }
  var ROW = { ID: 0, X: 1, Y: 2, Z: 3, YAW: 4, PITCH: 5, CROUCH: 6, ALIVE: 7, HP: 8, TEAM: 9, WEP: 10, LIFE: 11 };
  var POS_FIELDS = [ROW.X, ROW.Y, ROW.Z];
  var ANG_FIELDS = [ROW.YAW, ROW.PITCH];
  var CRITICAL_FIELDS = [ROW.ALIVE, ROW.HP, ROW.TEAM, ROW.WEP, ROW.LIFE];

  function decodePoseRow(row) {
    return {
      id: row[ROW.ID],
      x: row[ROW.X], y: row[ROW.Y], z: row[ROW.Z],
      yaw: row[ROW.YAW], pitch: row[ROW.PITCH],
      crouch: !!row[ROW.CROUCH], alive: !!row[ROW.ALIVE],
      hp: row[ROW.HP], team: row[ROW.TEAM] === 0 ? 'T' : 'CT',
      wep: row[ROW.WEP], lifeId: row[ROW.LIFE]
    };
  }

  /* 行是否"变化到值得发"了 */
  function rowChanged(prev, row) {
    if (!prev || prev.length !== row.length) return true;
    for (var i = 0; i < row.length; i++) {
      var eps = POS_FIELDS.indexOf(i) >= 0 ? P.POS_EPSILON : (ANG_FIELDS.indexOf(i) >= 0 ? P.ANG_EPSILON : 0);
      if (eps > 0) { if (Math.abs((row[i] || 0) - (prev[i] || 0)) >= eps) return true; }
      else if (row[i] !== prev[i]) return true;
    }
    return false;
  }
  /* critical 字段变了吗（这类变化必须立刻发） */
  function rowCriticalChanged(prev, row) {
    if (!prev) return true;
    for (var k = 0; k < CRITICAL_FIELDS.length; k++) {
      var i = CRITICAL_FIELDS[k];
      if (prev[i] !== row[i]) return true;
    }
    return false;
  }

  /* delta 构建器：记住上次发出去的行，按 critical / 变化 + 间隔决定这次发谁 */
  function DeltaTracker(intervalMs) {
    this.prev = new Map();       // id → row（必须存副本）
    this.sentAt = new Map();
    this.intervalMs = intervalMs || P.MATCH_MS;
  }
  DeltaTracker.prototype.build = function (rows, now, full) {
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i], id = row[ROW.ID];
      var prev = this.prev.get(id);
      if (full) { out.push(row); continue; }
      var critical = rowCriticalChanged(prev, row);
      var changed = rowChanged(prev, row);
      var due = (now - (this.sentAt.get(id) || 0)) >= this.intervalMs;
      if (critical || (changed && due)) out.push(row);
    }
    return out;
  };
  /* 只把"真正发出去的行"记为基线；full 时先清空 */
  DeltaTracker.prototype.remember = function (rows, now, full) {
    if (full) { this.prev.clear(); this.sentAt.clear(); }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      this.prev.set(row[ROW.ID], row.slice());   // slice 是必须的，行每帧会被重建
      this.sentAt.set(row[ROW.ID], now);
    }
  };
  DeltaTracker.prototype.forget = function (id) { this.prev.delete(id); this.sentAt.delete(id); };
  DeltaTracker.prototype.reset = function () { this.prev.clear(); this.sentAt.clear(); };

  /* ================================================================
   *  七、序号 / 去重
   * ================================================================ */
  /* 射击去重：P2P 下每个客户端的 shotId 都从 0 开始，必须带上 peerId 才不会撞 */
  function ShotDedupe(limit) {
    this.seen = new Set();
    this.order = [];
    this.limit = limit || 128;
  }
  ShotDedupe.prototype.check = function (peerId, shotId) {
    var key = peerId + ':' + shotId;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.order.push(key);
    while (this.order.length > this.limit) this.seen.delete(this.order.shift());
    return true;
  };
  ShotDedupe.prototype.reset = function () { this.seen.clear(); this.order.length = 0; };

  /* match 通道的序号 / 断流 / resync 判定 */
  function SeqGuard() {
    this.lastSeq = -1;
    this.awaitingFull = true;
    this.gapCount = 0;
    this.lastArrival = 0;
    this.resyncUntil = 0;
  }
  /* 返回 'apply' | 'drop' | 'resync' */
  SeqGuard.prototype.accept = function (seq, isFull, isResync, now) {
    now = now === undefined ? Date.now() : now;
    this.lastArrival = now;
    if (seq < this.lastSeq) return 'drop';
    if (seq === this.lastSeq && !(isResync && isFull)) return 'drop';
    if (!isFull && (this.awaitingFull || (this.lastSeq >= 0 && seq > this.lastSeq + 1))) {
      if (this.lastSeq >= 0 && seq > this.lastSeq + 1) this.gapCount++;
      return 'resync';                       // 没有连续基线，delta 无法应用
    }
    this.lastSeq = seq;
    if (isFull) this.awaitingFull = false;
    return 'apply';
  };
  SeqGuard.prototype.stalled = function (now) {
    now = now === undefined ? Date.now() : now;
    return this.lastArrival > 0 && (now - this.lastArrival) > P.MATCH_STALL_MS;
  };
  SeqGuard.prototype.canRequest = function (now) {
    now = now === undefined ? Date.now() : now;
    return now >= this.resyncUntil;
  };
  SeqGuard.prototype.markRequested = function (now) {
    now = now === undefined ? Date.now() : now;
    this.resyncUntil = now + P.RESYNC_COOLDOWN_MS;
    this.awaitingFull = true;
  };
  SeqGuard.prototype.reset = function () {
    this.lastSeq = -1; this.awaitingFull = true; this.gapCount = 0;
    this.lastArrival = 0; this.resyncUntil = 0;
  };

  /* ================================================================
   *  八、固定频率节拍器（修掉参考实现 acc = 0 导致实际频率偏低的问题）
   * ================================================================ */
  function Ticker(hzOrMs, isMs) {
    this.intervalMs = isMs ? hzOrMs : 1000 / hzOrMs;
    this.acc = 0;
  }
  Ticker.prototype.step = function (dtSeconds) {
    this.acc += dtSeconds * 1000;
    if (this.acc < this.intervalMs) return false;
    this.acc -= this.intervalMs;                 // 关键：减去间隔而不是清零
    if (this.acc > this.intervalMs * 3) this.acc = 0;   // 长时间卡顿后别补发一堆
    return true;
  };
  Ticker.prototype.reset = function () { this.acc = 0; };

  return {
    P: P, ROW: ROW,
    clamp: clamp, lerp: lerp, lerpAngle: lerpAngle, quant: quant,
    Clock: Clock,
    InterpDelay: InterpDelay, makePlayerDelay: makePlayerDelay, makeEntityDelay: makeEntityDelay,
    Track: Track,
    segmentHitsCapsule: segmentHitsCapsule, rewindHit: rewindHit,
    encodePoseRow: encodePoseRow, decodePoseRow: decodePoseRow,
    rowChanged: rowChanged, rowCriticalChanged: rowCriticalChanged,
    DeltaTracker: DeltaTracker,
    ShotDedupe: ShotDedupe, SeqGuard: SeqGuard, Ticker: Ticker
  };
})();
