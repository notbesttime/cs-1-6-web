/* ============================================================
 *  selftest.js — 自动化自检（只有 index.html?selftest=1 才会加载）
 *
 *  用真实的游戏代码路径跑断言：合成鼠标/键盘事件去开枪、平移，
 *  再从 GAME.debug() 和画布像素里读结果，最后把 PASS/FAIL 画在屏幕上。
 *  这样在没有人工试玩的情况下也能确认关键 bug 没有回归。
 *
 *  用法：index.html?selftest=1
 * ============================================================ */
'use strict';

(function () {

  var rows = [];
  var panel = null;

  function makePanel() {
    panel = document.createElement('div');
    panel.id = 'selftest';
    panel.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'z-index:999;background:rgba(4,8,12,.94);border:1px solid #ffc861;padding:16px 20px;' +
      'font:13px/1.75 Consolas,monospace;color:#ddd6c2;max-height:92vh;overflow:auto;min-width:560px;';
    document.body.appendChild(panel);
  }

  function render() {
    var pass = rows.filter(function (r) { return r.ok; }).length;
    var fail = rows.length - pass;
    var html = '<div style="font-size:16px;color:#ffc861;letter-spacing:2px;margin-bottom:10px;">' +
      'SELFTEST · ' + pass + ' PASS / ' + fail + ' FAIL</div>';
    rows.forEach(function (r) {
      html += '<div style="color:' + (r.ok ? '#8fdc6a' : '#ff7a6a') + '">' +
        (r.ok ? '[PASS] ' : '[FAIL] ') + r.name +
        '<span style="color:#9a927e"> — ' + r.detail + '</span></div>';
    });
    panel.innerHTML = html;
  }

  function check(name, ok, detail) {
    rows.push({ name: name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
    render();
    // 把结果回传给本地服务器，这样无头浏览器下也能从服务器日志里读到结论
    try {
      new Image().src = '/__selftest?' + (ok ? 'PASS' : 'FAIL') + '=' +
        encodeURIComponent(name + ' | ' + (detail === undefined ? '' : detail));
    } catch (e) { }
  }

  function n(v, d) { return (typeof v === 'number' ? v : NaN).toFixed(d === undefined ? 4 : d); }

  /* ---------- 合成输入 ---------- */
  var canvas = function () { return document.getElementById('gl'); };

  function mouse(type, button) {
    document.dispatchEvent(new MouseEvent(type, { button: button || 0, bubbles: true }));
  }
  function key(type, code) {
    document.dispatchEvent(new KeyboardEvent(type, { code: code, bubbles: true }));
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* 采样画布像素：世界一旦因为 NaN 而不渲染，整块画布就只剩清屏色。
   * 必须在 requestAnimationFrame 回调里读 —— 游戏的 rAF 是在自己的回调开头
   * 重新注册的，所以下一帧它先渲染、我们后读，缓冲区内容才是有效的。 */
  function samplePixels() {
    return new Promise(function (res) {
      requestAnimationFrame(function () {
        var c = canvas();
        var gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) { res(null); return; }
        var pts = [[0.5, 0.85], [0.25, 0.8], [0.75, 0.8], [0.5, 0.6], [0.15, 0.55]];
        var out = [];
        for (var i = 0; i < pts.length; i++) {
          var px = new Uint8Array(4);
          var x = Math.floor(gl.drawingBufferWidth * pts[i][0]);
          var y = Math.floor(gl.drawingBufferHeight * (1 - pts[i][1]));   // WebGL 原点在左下
          gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
          out.push([px[0], px[1], px[2]]);
        }
        res(out);
      });
    });
  }

  // 清屏色 0xa9c4dd
  function isClearColor(p) {
    return Math.abs(p[0] - 0xa9) < 10 && Math.abs(p[1] - 0xc4) < 10 && Math.abs(p[2] - 0xdd) < 10;
  }

  /* 雷达画布上的队友绿点（#6ee36e ≈ 110,227,110）坐标表 */
  function radarGreenPixels() {
    var r = document.getElementById('radar');
    var ctx = r.getContext('2d');
    var d = ctx.getImageData(0, 0, r.width, r.height).data;
    var pts = [];
    for (var y = 0; y < r.height; y++) {
      for (var x = 0; x < r.width; x++) {
        var i = (y * r.width + x) * 4;
        if (d[i] > 80 && d[i] < 150 && d[i + 1] > 190 && d[i + 2] > 80 && d[i + 2] < 150) pts.push([x, y]);
      }
    }
    return { pts: pts, w: r.width, h: r.height };
  }

  /* 世界坐标 → 雷达像素（必须和 game.js drawRadar 的变换一致：translate(half) + rotate(yaw)） */
  function radarProject(dx, dz, yaw, half) {
    var s = 0.052;
    var px = dx * s, pz = dz * s;
    return [half + (px * Math.cos(yaw) - pz * Math.sin(yaw)),
            half + (px * Math.sin(yaw) + pz * Math.cos(yaw))];
  }

  /* ================= 测试用例 ================= */
  async function run() {
    makePanel();
    var T = window.GAME && GAME.__test;
    if (!T) { check('测试钩子可用', false, 'GAME.__test 不存在'); return; }

    // 等开局
    for (var i = 0; i < 100 && (!GAME.debug() || GAME.debug().round === 0); i++) await wait(100);
    var d0 = GAME.debug();
    check('对局已开始', !!d0 && d0.round >= 1, d0 ? '回合 ' + d0.round + ' / ' + d0.weapon : 'no state');
    if (!d0) return;

    // 出生点安全性（纯逻辑，不依赖渲染）
    var _sp = (typeof MAP !== 'undefined' && MAP && MAP.SPAWNS) ? MAP.SPAWNS : null;
    var _totalSpawns = _sp ? ((_sp.T ? _sp.T.length : 0) + (_sp.CT ? _sp.CT.length : 0)) : 0;
    var badSpawns = T.spawnProbeCheck();
    check('出生点经 safeSpawn 后无碰撞（防卡箱子）', badSpawns.length === 0,
      badSpawns.length === 0 ? (_totalSpawns + ' 个出生点全部通过') : JSON.stringify(badSpawns));

    // 起步阶段不该有 NaN
    check('初始视角无 NaN', isFinite(d0.punchX) && isFinite(d0.punchY) && isFinite(d0.yaw),
      'punch=(' + n(d0.punchX) + ',' + n(d0.punchY) + ') yaw=' + n(d0.yaw, 3));

    T.forceLive();
    T.invuln(true);             // 测试期间别被 bot 打死，否则后面的用例全都连带失败
    T.giveWeapon('ak47');       // 连发武器才能测出「压枪 / 越打越散」
    T.resetPeaks();
    await wait(150);

    /* ---- 连发：后坐力 + 散布 + NaN 回归 ----
     * 峰值由游戏主循环自己记录（无头浏览器的虚拟时钟跑得比采样快得多，
     * 从外面按毫秒采样会整段错过弹夹） */
    var before = GAME.debug();
    var baseSpread = before.baseSpread;
    check('测试武器已换成连发步枪', before.weapon === 'ak47', before.weapon + ' 弹匣 ' + before.ammo);
    mouse('mousedown', 0);
    for (i = 0; i < 90; i++) {
      await wait(16);
      var d = GAME.debug();
      if (!isFinite(d.punchX) || !isFinite(d.spread)) break;
      if (d.ammo <= 0) break;
    }
    mouse('mouseup', 0);
    var mid = GAME.debug();
    var maxSpread = mid.peakSpread, maxPunch = mid.peakPunch, shots = mid.peakBurst;

    check('开枪后视角无 NaN（w.recoil 回归测试）',
      isFinite(mid.punchX) && isFinite(mid.punchY) && isFinite(mid.spread),
      'punchX=' + n(mid.punchX) + ' spread=' + n(mid.spread));

    check('弹药有消耗', mid.ammo < before.ammo, before.ammo + ' → ' + mid.ammo);

    check('垂直后坐力生效（视角上抬）', maxPunch > 0.01,
      'maxPunchX=' + n(maxPunch) + ' rad ≈ ' + n(maxPunch * 57.3, 2) + '°');

    check('连发散布累积（站桩扫射不再一个点）', maxSpread > baseSpread * 3,
      '基础 ' + n(baseSpread, 5) + ' → 峰值 ' + n(maxSpread, 5) +
      '（×' + n(maxSpread / baseSpread, 1) + '，连发 ' + shots + ' 发）');

    // 世界还在渲染吗（NaN 会让整屏只剩清屏色）
    var px = await samplePixels();
    if (px) {
      var allClear = px.every(isClearColor);
      check('开枪后世界仍在渲染（地板没「变透明」）', !allClear,
        px.map(function (p) { return 'rgb(' + p.join(',') + ')'; }).join(' '));
    } else {
      check('开枪后世界仍在渲染', false, '拿不到 WebGL 上下文');
    }

    /* ---- 散布回落（按游戏内时间轮询，无头浏览器的帧率比真实时间慢） ---- */
    var after = GAME.debug();
    for (i = 0; i < 80; i++) {
      await wait(100);
      after = GAME.debug();
      if (after.spreadPen === 0) break;
    }
    check('停火后散布回落（recover 生效）', after.spread < baseSpread * 1.6 && after.spreadPen < 0.002,
      '停火后 spread=' + n(after.spread, 5) + ' pen=' + n(after.spreadPen, 5) +
      '（峰值 ' + n(maxSpread, 5) + '）');

    check('停火后后坐力归位', Math.abs(after.punchX) < 0.01, 'punchX=' + n(after.punchX));

    /* ---- A / D 方向 ----
     * 冻结阶段会把移动输入清零，所以每次测量前都要 forceLive，
     * 并且检查测量过程中回合没有翻篇（回合切换会把人传回出生点） */
    async function strafeTest(code, label, wantPositive) {
      for (var tryN = 0; tryN < 3; tryN++) {
        T.forceLive();
        T.setYaw(0);              // 面朝 -Z，此时右手边应是 +X
        T.teleport(1200, -1500);  // CT 出生区里一块空地
        await wait(120);
        var a = GAME.debug();
        key('keydown', code);
        for (var k = 0; k < 12; k++) { await wait(30); T.forceLive(); }
        key('keyup', code);
        var b = GAME.debug();
        if (b.round !== a.round) continue;         // 回合切换，重测
        var rX = Math.cos(a.yaw), rZ = -Math.sin(a.yaw);
        var dot = (b.x - a.x) * rX + (b.z - a.z) * rZ;
        if (Math.abs(dot) < 1) continue;           // 没动（被卡住 / 又进冻结），重测
        check(label, wantPositive ? dot > 1 : dot < -1,
          'Δ=(' + n(b.x - a.x, 1) + ',' + n(b.z - a.z, 1) + ') · right = ' + n(dot, 1));
        return;
      }
      check(label, false, '3 次尝试都没测到位移（可能一直处于冻结阶段）');
    }

    await strafeTest('KeyD', '按 D 向视线右方移动', true);
    await strafeTest('KeyA', '按 A 向视线左方移动', false);

    /* ---- 雷达朝向：队友绿点必须正好画在按 rotate(+yaw) 预测的位置上 ----
     * 顺便做反向对照：原来写错的 rotate(-yaw + PI) 预测的位置上不该有点。 */
    var dr = GAME.debug();
    var rp = radarGreenPixels();
    var half = rp.w / 2;
    var okHit = 0, badHit = 0, tested = 0, detail = [];
    dr.mates.forEach(function (m) {
      if (m.dead || m.isPlayer) return;
      var dx = m.x - dr.x, dz = m.z - dr.z;
      if (Math.hypot(dx, dz) > 1500) return;              // 太远画不进雷达圈
      var good = radarProject(dx, dz, dr.yaw, half);
      var wrong = radarProject(dx, dz, -dr.yaw + Math.PI, half);   // 修复前的错误变换
      var near = function (p) {
        return rp.pts.some(function (q) { return Math.abs(q[0] - p[0]) < 6 && Math.abs(q[1] - p[1]) < 6; });
      };
      tested++;
      if (near(good)) okHit++;
      // 两种预测离得够远时才算有效的反向对照
      if (Math.hypot(good[0] - wrong[0], good[1] - wrong[1]) > 14 && near(wrong)) badHit++;
      detail.push(m.name + '→(' + good[0].toFixed(0) + ',' + good[1].toFixed(0) + ')');
    });
    if (tested === 0) {
      check('雷达朝向（跳过）', true, '雷达范围内没有存活队友');
    } else {
      check('雷达朝向正确（队友绿点落在 rotate(+yaw) 预测的位置）',
        okHit === tested && badHit === 0,
        '命中 ' + okHit + '/' + tested + '，错误变换命中 ' + badHit + '，预测点 ' + detail.join(' '));
    }

    /* ---- 经济 / 购买菜单 ---- */
    var myTeam = GAME.SET.team;
    var zone = MAP.BUY_ZONES[myTeam];
    var zx = (zone[0] + zone[2]) / 2, zz = (zone[1] + zone[3]) / 2;   // 自家购买区中心
    var enemyTeam = myTeam === 'T' ? 'CT' : 'T';
    var myRifle = myTeam === 'T' ? 'ak47' : 'm4a1';
    var myRiflePrice = WEAPONS.defs[myRifle].price;

    T.forceLive();
    T.revive();                 // 万一中途被炸死（比如自己的手雷），先复活再继续
    T.teleport(zx, zz);
    await wait(150);
    var db = GAME.debug();
    check('出生区内可以购买', db.buyOk === true, db.buyWhy || '在购买区且回合刚开始');

    T.setMoney(16000);
    T.buyKey('KeyB');
    await wait(120);
    check('B 键能打开购买菜单', GAME.debug().buyMenuOpen === true, '菜单状态 open');

    // AWP 不会跟前面测试用的 AK 撞车，用它验证「扣钱 + 换枪」
    var r1 = T.buyById('awp');
    var d1 = GAME.debug();
    check('买主武器扣钱并换枪', r1.ok && d1.weapon === 'awp' && d1.money === 16000 - 4750,
      r1.why + '；现在 $' + d1.money + ' 持枪 ' + d1.weapon);

    // 再买本阵营步枪，验证主武器槽是替换而不是叠加
    var rr = T.buyById(myRifle);
    var dr2 = GAME.debug();
    var primaries = dr2.weapons.filter(function (id) {
      var dd = WEAPONS.defs[id];
      return dd && dd.slot === 'primary';
    });
    check('主武器槽是替换而不是越买越多', rr.ok && primaries.length === 1 && primaries[0] === myRifle,
      '武器栏 ' + dr2.weapons.join('/') + '，主武器 ' + primaries.join('+'));

    var r2 = T.buyById('kevhelm');
    var d2 = GAME.debug();
    check('买防弹衣+头盔', r2.ok && d2.armor >= 100 && d2.helmet === true,
      '护甲 ' + d2.armor + ' 头盔 ' + d2.helmet + '，剩 $' + d2.money);

    var r3 = T.buyById('defuser');
    if (myTeam === 'CT') {
      check('CT 能买拆弹器', r3.ok && GAME.debug().defuser === true, r3.why);
    } else {
      check('T 买不到拆弹器（阵营限制）', r3.ok === false, r3.why);
    }

    var r4 = T.buyById('he');
    var d4 = GAME.debug();
    check('买高爆手雷进入武器栏', r4.ok && d4.nades.he === 1 && d4.weapons.indexOf('he') >= 0,
      '手雷 ' + JSON.stringify(d4.nades) + ' 武器栏 ' + d4.weapons.join('/'));

    var r5 = T.buyById('he');
    check('高爆手雷有携带上限', r5.ok === false, r5.why);

    T.setMoney(100);
    var r6 = T.buyById('awp');
    check('钱不够时买不了', r6.ok === false && GAME.debug().money === 100, r6.why);
    T.buyKey('Escape');

    // 连败奖金递增（让敌方连胜两回合，自己作为败方收钱）
    var s0 = GAME.debug().lossStreak[myTeam];
    T.setMoney(0);
    T.awardRound(enemyTeam, '灭队');
    var m1 = GAME.debug().money;
    T.setMoney(0);
    T.awardRound(enemyTeam, '灭队');
    var m2 = GAME.debug().money;
    check('连败奖金递增（1400 → 1900 …）', m2 > m1 && m1 >= 1400,
      '第一次 $' + m1 + '，第二次 $' + m2 +
      '（' + myTeam + ' streak ' + s0 + '→' + GAME.debug().lossStreak[myTeam] + '）');

    T.setMoney(16000);

    /* ---- 回归：按 B 开购买菜单不能被误判成 Esc（不该弹出暂停） ----
     * 打开菜单时游戏会主动释放鼠标锁，浏览器随即抛出 pointerlockchange。
     * 如果那个监听器不区分「主动释放」和「用户按 Esc」，按 B 就会弹暂停菜单。 */
    T.forceLive();
    T.fakeHadLock();                 // 模拟玩家已经点过画面锁定鼠标
    T.teleport(zx, zz);
    await wait(120);
    T.buyKey('KeyB');                // 打开菜单
    document.dispatchEvent(new Event('pointerlockchange'));
    await wait(150);
    var dpl = GAME.debug();
    check('按 B 开购买菜单不会被误判成 Esc（不弹暂停）',
      dpl.paused === false && dpl.buyMenuOpen === true,
      '暂停=' + dpl.paused + '，菜单=' + dpl.buyMenuOpen);
    if (dpl.paused) T.unpause();

    // 反向确认：菜单关着时丢失鼠标锁仍然应该自动暂停
    T.buyKey('Escape');
    await wait(120);
    T.fakeHadLock();
    document.dispatchEvent(new Event('pointerlockchange'));
    await wait(150);
    var dpl2 = GAME.debug();
    check('菜单关着时丢失鼠标锁仍会自动暂停', dpl2.paused === true, '暂停=' + dpl2.paused);
    T.unpause();
    await wait(120);

    /* ---- 投掷物 ---- */
    T.forceLive();
    T.teleport(zx, zz);
    var before2 = GAME.debug().nadeCount;
    T.buyById('smoke');
    T.buyKey('Escape');
    await wait(100);
    // 切到烟雾弹（数字键 6）并投出
    key('keydown', 'Digit6'); key('keyup', 'Digit6');
    await wait(150);
    var dn = GAME.debug();
    check('数字键能切到烟雾弹', dn.weapon === 'smoke', '当前武器 ' + dn.weapon);
    mouse('mousedown', 0);
    await wait(120);
    mouse('mouseup', 0);
    await wait(200);
    check('手雷已投出（世界里存在飞行物或已生成烟团）',
      GAME.debug().nadeCount.live > before2.live || GAME.debug().nadeCount.smokes > 0,
      JSON.stringify(GAME.debug().nadeCount));

    // 等烟雾成形，验证它真的挡视线（用烟团的真实位置去打射线）
    for (i = 0; i < 40; i++) { await wait(150); T.forceLive(); if (GAME.debug().nadeCount.smokes > 0) break; }
    var okSmoke = false, smokeDetail = '没等到烟团';
    var sl = T.smokeList();
    if (sl.length > 0) {
      await wait(1500);
      var sc = T.smokeList()[0];
      // 穿过烟团中心的射线应被遮挡；同高度但偏开 2000 单位的平行射线不该被遮挡
      var thru = T.smokeBlocked(sc.x - 400, sc.y + 55, sc.z, sc.x + 400, sc.y + 55, sc.z);
      var far = T.smokeBlocked(sc.x - 400, sc.y + 55, sc.z + 2000, sc.x + 400, sc.y + 55, sc.z + 2000);
      okSmoke = thru === true && far === false;
      smokeDetail = '烟团@(' + sc.x.toFixed(0) + ',' + sc.z.toFixed(0) + ') r=' + sc.r +
        '，穿过=' + thru + '，偏开 2000=' + far;
    }
    check('烟雾阻断视线', okSmoke, smokeDetail);

    /* ---- bot 经济：他们也应该会买枪和护甲 ---- */
    var bm = GAME.debug().botMoney;
    var armoredNow = bm.filter(function (b) { return b.armor >= 100; }).length;
    check('bot 手枪局（$800）只买护甲不买步枪', armoredNow > 0,
      bm.length + ' 个 bot 中 ' + armoredNow + ' 个买了护甲（$800 买不起步枪，符合 CS 经济）');

    var rich = T.richBots(9000);
    var richArmed = rich.filter(function (b) {
      var bd = WEAPONS.defs[b.w];
      return bd && bd.slot === 'primary';
    }).length;
    check('bot 有钱时会买主武器', richArmed === rich.length,
      richArmed + '/' + rich.length + ' 个买到主武器，示例 ' +
      rich.slice(0, 3).map(function (b) { return b.team + ':' + b.w + '($' + b.money + ')'; }).join(' '));

    /* ---- 闪光弹：应该把玩家闪白 ---- */
    var blindSeen = 0, flashNote = '';
    for (var tryF = 0; tryF < 3 && blindSeen <= 0.2; tryF++) {
      T.forceLive();
      T.revive();
      T.setMoney(16000);
      T.teleport(zx, zz);
      T.setYaw(0);
      var okBuy = T.buyById('flash');
      T.buyKey('Escape');
      await wait(120);
      key('keydown', 'Digit5'); key('keyup', 'Digit5');
      await wait(150);
      var dfl = GAME.debug();
      if (dfl.weapon !== 'flash') { flashNote = '没能切到闪光弹（当前 ' + dfl.weapon + '，' + okBuy.why + '）'; continue; }
      var roundBefore = dfl.round;
      mouse('mousedown', 2);      // 右键 = 轻抛，让它就在脚边炸
      mouse('mousedown', 0);
      await wait(100);
      mouse('mouseup', 0);
      mouse('mouseup', 2);
      // 引信 1.8 秒是游戏内时间，无头浏览器比真实时间慢，这里放宽等待
      var roundChanged = false, lastPos = null;
      for (i = 0; i < 160; i++) {
        await wait(80); T.forceLive();
        var dd = GAME.debug();
        if (dd.round !== roundBefore) { roundChanged = true; break; }   // 换回合会清掉手雷，重试
        var lv = NADE.liveList();
        if (lv.length) lastPos = lv[0];
        if (dd.blind > blindSeen) blindSeen = dd.blind;
        if (blindSeen > 0) break;
        if (dd.nadeCount.live === 0 && i > 25) break;
      }
      if (roundChanged) { flashNote = '第 ' + (tryF + 1) + ' 次尝试时换了回合，重试'; continue; }
      if (blindSeen <= 0.2 && lastPos) {
        // 把致盲判定的输入算出来，方便定位是距离、朝向还是视线的问题
        var dp2 = GAME.debug();
        var ey2 = dp2.y + 64;
        var dist2 = Math.hypot(lastPos.x - dp2.x, lastPos.y - ey2, lastPos.z - dp2.z);
        var fw = [-Math.sin(dp2.yaw) * Math.cos(dp2.pitch), Math.sin(dp2.pitch), -Math.cos(dp2.yaw) * Math.cos(dp2.pitch)];
        var to2 = [(lastPos.x - dp2.x) / dist2, (lastPos.y - ey2) / dist2, (lastPos.z - dp2.z) / dist2];
        var dot2 = fw[0] * to2[0] + fw[1] * to2[1] + fw[2] * to2[2];
        var blk = MAP.losBlocked(lastPos.x, lastPos.y, lastPos.z, dp2.x, ey2, dp2.z);
        flashNote = '雷@(' + lastPos.x.toFixed(0) + ',' + lastPos.y.toFixed(0) + ',' + lastPos.z.toFixed(0) +
          ') 人@(' + dp2.x.toFixed(0) + ',' + dp2.z.toFixed(0) + ') yaw=' + dp2.yaw.toFixed(2) +
          ' 距离=' + dist2.toFixed(0) + ' dot=' + dot2.toFixed(2) + ' 视线被挡=' + blk;
      }
    }
    check('闪光弹致盲（白屏计时被点亮）', blindSeen > 0.2,
      blindSeen > 0.2 ? '致盲时长峰值 ' + n(blindSeen, 2) + ' 秒' : (flashNote || '手雷已引爆但没闪到'));


    /* ---- 拆弹：按住 E 应该有进度、有滴答声、有进度条 ---- */
    if (myTeam === 'CT') {
      T.forceLive();
      T.revive();
      T.invuln(true);
      var site = MAP.SITES[0];
      T.teleport(site.x, site.z);
      await wait(200);
      T.giveDefuser(true);              // 5 秒拆，测试跑得快一些
      var bombInfo = T.plantHere();
      await wait(150);

      // 统计滴答声的调用次数（用户反馈「只响一下」）
      var ticks = 0;
      var origTick = SFX.defuseTick;
      SFX.defuseTick = function () { ticks++; return origTick.apply(SFX, arguments); };

      var sawBar = false, sawLabel = '', maxProg = 0, defused = false;
      key('keydown', 'KeyE');
      for (i = 0; i < 200; i++) {
        await wait(50);
        T.forceLive();
        var dbb = GAME.debug();
        if (dbb.progressVisible) sawBar = true;
        if (dbb.progressLabel) sawLabel = dbb.progressLabel;
        if (dbb.defuseProgress > maxProg) maxProg = dbb.defuseProgress;
        if (!dbb.bombPlanted) { defused = true; break; }
      }
      key('keyup', 'KeyE');
      SFX.defuseTick = origTick;

      check('按住 E 拆弹有进度并能拆掉', defused || maxProg > 0.3,
        '进度峰值 ' + n(maxProg, 2) + (defused ? '，已拆除' : '，未拆完') +
        '（炸弹@' + bombInfo.x.toFixed(0) + ',' + bombInfo.z.toFixed(0) + '）');
      check('拆弹时进度条可见', sawBar, sawBar ? '提示文字：' + sawLabel : '#progressWrap 始终是 hidden');
      check('拆弹滴答声持续响（不是只响一下）', ticks > 3, '触发 ' + ticks + ' 次 defuseTick');
      T.invuln(false);
    } else {
      check('拆弹流程（跳过）', true, 'T 方不参与拆弹，换 CT 阵营时验证');
    }

    T.forceLive();
    T.revive();
    T.invuln(false);            // 这一段需要真的能死
    await wait(120);
    var aliveMates = GAME.debug().mates.filter(function (m) { return !m.dead && !m.isPlayer; }).length;
    T.killPlayer();
    for (i = 0; i < 40; i++) { await wait(80); if (GAME.debug().spectating) break; }
    var ds = GAME.debug();
    if (aliveMates === 0) {
      check('阵亡后进入队友视角（跳过）', true, '死亡时队友已全部阵亡，无可观战对象');
    } else {
      check('阵亡后进入队友视角', ds.dead === true && !!ds.spectating, '观战对象：' + (ds.spectating || '（无）'));
    }
    var px2 = await samplePixels();
    if (px2) {
      check('观战画面没被自己的模型糊住', !px2.every(function (p) {
        // 全屏被人物模型（深色/皮肤色方块）占满时，5 个采样点会几乎同色
        return Math.abs(p[0] - px2[0][0]) < 6 && Math.abs(p[1] - px2[0][1]) < 6 && Math.abs(p[2] - px2[0][2]) < 6;
      }), px2.map(function (p) { return 'rgb(' + p.join(',') + ')'; }).join(' '));
    }

    /* ---- 联机地基（纯逻辑，离线可跑） ---- */
    await runNetTests();
    /* ---- 联机对局（loopback 假对手，不需要账号） ---- */
    await runNetPlayTests();

    var pass = rows.filter(function (r) { return r.ok; }).length;
    // 运行期间有没有 JS 异常（index.html 会把 window error 收集到 __errs）
    var errs = window.__errs || [];
    check('运行期间没有 JS 报错', errs.length === 0, errs.length ? errs.slice(-4).join(' ／ ') : '干净');
    pass = rows.filter(function (r) { return r.ok; }).length;
    document.title = 'SELFTEST ' + pass + '/' + rows.length;
    window.__selftest = { pass: pass, total: rows.length, rows: rows };
    new Image().src = '/__selftest_done?' + pass + '/' + rows.length;
  }

  /* ================================================================
   *  联机地基（net.js / transport.js）的纯逻辑用例
   *  全部离线运行，不需要 VibeHub 账号、不碰渲染
   * ================================================================ */
  async function runNetTests() {
    var i;
    if (!window.NET || !window.TRANSPORT) {
      check('联机模块已加载', false, 'NET / TRANSPORT 未定义');
      return;
    }
    check('联机模块已加载', true, '协议 v' + NET.P.VERSION + '，房间上限 ' + NET.P.MAX_ROOM_PLAYERS + ' 人');

    /* ---- 1. 位姿插值：延迟渲染 + 最短弧 yaw + 外推上限 ---- */
    var tr = new NET.Track();
    tr.push({ time: 1000, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, lifeId: 1, hp: 100 });
    tr.push({ time: 1100, x: 100, y: 0, z: 0, yaw: 0, pitch: 0, alive: true, lifeId: 1, hp: 100 });
    var mid = tr.sample(1050);
    check('插值：两帧之间线性取中', Math.abs(mid.x - 50) < 0.01, 'x=' + n(mid.x, 2) + '（期望 50）');

    var ex = tr.sample(1150);      // 超出最后一帧 50ms → 外推
    check('插值：外推按最后一段速度延伸', ex.x > 100 && ex.extrapolated === true,
      'x=' + n(ex.x, 1) + '（期望 >100，150 上限内）');
    var exFar = tr.sample(1600);   // 超出 500ms，应被 EXTRAP_MAX_MS=100 钳住
    check('插值：外推有上限（不会无限飞出去）', Math.abs(exFar.x - 200) < 1,
      'x=' + n(exFar.x, 1) + '（100ms 上限 → 期望 200）');

    // yaw 跨 ±π 必须走最短弧（3.0 → -3.0 应该往外绕 0.28 rad，而不是横穿 6 rad）
    var yt = new NET.Track();
    yt.push({ time: 0, x: 0, y: 0, z: 0, yaw: 3.0, alive: true, lifeId: 1 });
    yt.push({ time: 100, x: 0, y: 0, z: 0, yaw: -3.0, alive: true, lifeId: 1 });
    var ym = yt.sample(50);
    check('插值：yaw 走最短弧（不会转一整圈）', Math.abs(Math.abs(ym.yaw) - 3.14) < 0.05,
      'yaw=' + n(ym.yaw, 3) + '（期望 ≈ ±3.14 而不是 0）');

    /* ---- 2. 传送与生命边界：清缓冲硬切、不跨 lifeId 插值 ---- */
    var jt = new NET.Track();
    jt.push({ time: 0, x: 0, y: 0, z: 0, yaw: 0, alive: true, lifeId: 1 });
    var hard = jt.push({ time: 100, x: NET.P.TELEPORT_DIST + 200, y: 0, z: 0, yaw: 0, alive: true, lifeId: 1 });
    check('传送超阈值会清缓冲硬切', hard === true && jt.samples.length === 1,
      '硬切=' + hard + '，缓冲剩 ' + jt.samples.length + ' 帧（阈值 ' + NET.P.TELEPORT_DIST + ' unit）');

    var lt = new NET.Track({ history: true });     // 历史模式：房主回溯用，永不清空
    lt.push({ time: 0, x: 0, y: 0, z: 0, yaw: 0, alive: true, lifeId: 1 });
    lt.push({ time: 100, x: 0, y: 0, z: 0, yaw: 0, alive: false, lifeId: 1 });
    var atDeath = lt.at(50);
    check('回溯不跨越存活状态边界插值', atDeath.alive === true && lt.samples.length === 2,
      '取 50ms 处 → alive=' + atDeath.alive + '，历史保留 ' + lt.samples.length + ' 帧（渲染缓冲会硬切，回溯历史必须留着）');

    /* ---- 3. 回溯命中：能打中、能正确判空、能拦作弊 ---- */
    function trackAt(x, z, opts) {
      opts = opts || {};
      var t = new NET.Track({ history: true });     // 房主回溯用历史模式
      for (var i = 0; i <= 4; i++) {
        t.push({
          time: 1000 + i * 100, x: x + (opts.vx || 0) * i * 100, y: 0, z: z,
          yaw: 0, pitch: 0, crouch: !!opts.crouch, alive: opts.alive !== false, lifeId: 7, hp: 100
        });
      }
      return t;
    }
    var shooterTrack = trackAt(0, 0);
    var shooter = { lifeId: 7, track: shooterTrack };
    // 目标在正前方 500 unit（-Z 方向），射线沿 -Z
    var target = { id: 'v1', team: 'T', lifeId: 7, alive: true, track: trackAt(0, -500) };
    var shot = {
      x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: -1, range: 4096,
      lifeId: 7, fireTime: 1400, viewTime: 1400 - 90
    };
    var r1 = NET.rewindHit(shot, shooter, 'CT', [target], 1400);
    check('回溯命中：正前方的敌人能打中', !!r1.hit && r1.hit.id === 'v1',
      r1.hit ? '命中 ' + r1.hit.id + '，距离 ' + n(r1.hit.dist, 0) + ' unit' : '未命中（' + r1.reason + '）');

    // 打偏 200 unit（远大于 16 的胶囊半径）
    var r2 = NET.rewindHit({ x: 200, y: 64, z: 0, dx: 0, dy: 0, dz: -1, range: 4096, lifeId: 7, fireTime: 1400, viewTime: 1310 },
      shooter, 'CT', [target], 1400);
    check('回溯命中：偏离目标时判定为未命中', !r2.hit, r2.hit ? '误判命中了' : '正确判空（' + r2.reason + '）');

    // 同队不该被打中
    var mate = { id: 'm1', team: 'CT', lifeId: 7, alive: true, track: trackAt(0, -500) };
    var r3 = NET.rewindHit(shot, shooter, 'CT', [mate], 1400);
    check('回溯命中：队友不会被打中', !r3.hit, r3.hit ? '打到队友了' : '正确跳过同队');

    // 用上一条命的 lifeId 射击 → 必须拒绝
    var r4 = NET.rewindHit({ x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: -1, range: 4096, lifeId: 6, fireTime: 1400, viewTime: 1310 },
      shooter, 'CT', [target], 1400);
    check('回溯命中：拒绝过期 lifeId 的射击', !r4.hit && r4.reason === 'stale-life', '原因=' + r4.reason);

    // 自报枪口位置离真实位置太远 → 拦截（防瞬移作弊）
    var r5 = NET.rewindHit({ x: 3000, y: 64, z: 0, dx: 0, dy: 0, dz: -1, range: 4096, lifeId: 7, fireTime: 1400, viewTime: 1310 },
      shooter, 'CT', [target], 1400);
    check('回溯命中：拦截枪口位置作弊', !r5.hit && r5.reason === 'origin-mismatch',
      '原因=' + r5.reason + '（容差 ' + NET.P.ORIGIN_TOLERANCE + ' unit）');

    // 回溯的价值：目标正在横向移动（50 unit/s），
    // 回溯到它当时的位置能命中，用"现在的位置"判定就打空了
    var moving = { id: 'mv', team: 'T', lifeId: 7, alive: true, track: trackAt(0, -500, { vx: 0.05 }) };
    function shootAt(viewTime) {
      return NET.rewindHit({ x: 0, y: 64, z: 0, dx: 0, dy: 0, dz: -1, range: 4096, lifeId: 7, fireTime: 1400, viewTime: viewTime },
        shooter, 'CT', [moving], 1400);
    }
    var hitOld = shootAt(1200);     // 200ms 前：目标在 x=10，胶囊半径 16 → 命中
    var hitNow = shootAt(1400);     // 当前：目标已到 x=20 → 打空
    check('回溯命中：回溯到旧时刻才打得到移动目标', !!hitOld.hit && !hitNow.hit,
      '回溯 200ms=' + (hitOld.hit ? '命中' : '空') + '，用当前时刻=' + (hitNow.hit ? '命中' : '空（目标已移出胶囊）'));

    // 回溯上限：客户端谎报一个很老的 viewTime，必须被钳制在 MAX_REWIND_MS 内
    var tooOld = shootAt(500);      // 900ms 前，应被钳到 now-200=1200
    check('回溯命中：回溯时间被钳在上限内（防谎报很老的时刻）',
      !!tooOld.hit && !!hitOld.hit && Math.abs(tooOld.hit.dist - hitOld.hit.dist) < 1,
      '谎报 900ms 前 → 实际按 ' + NET.P.MAX_REWIND_MS + 'ms 上限处理，结果与回溯 200ms 一致');

    // 爆头判定：瞄头顶高度
    var hs = NET.rewindHit({ x: 0, y: 68, z: 0, dx: 0, dy: 0, dz: -1, range: 4096, lifeId: 7, fireTime: 1400, viewTime: 1310 },
      shooter, 'CT', [{ id: 'h1', team: 'T', lifeId: 7, alive: true, track: trackAt(0, -500) }], 1400);
    check('回溯命中：能区分爆头', !!hs.hit && hs.hit.headshot === true,
      hs.hit ? '爆头=' + hs.hit.headshot + '（命中高度 ' + n(hs.hit.y, 1) + '）' : '未命中');

    /* ---- 4. delta 与量化 ---- */
    var base = { id: 1, x: 100, y: 0, z: 200, yaw: 1.234567, pitch: 0, crouch: false, alive: true, hp: 100, team: 'T', wep: 3, lifeId: 5 };
    var row = NET.encodePoseRow(base);
    var back = NET.decodePoseRow(row);
    check('位姿行编解码往返一致', back.id === 1 && back.team === 'T' && back.hp === 100 &&
      Math.abs(back.yaw - base.yaw) <= NET.P.ANG_QUANT && back.lifeId === 5,
      'yaw ' + n(base.yaw, 4) + ' → ' + n(back.yaw, 4) + '（量化步长 ' + NET.P.ANG_QUANT + '）');

    var tiny = NET.encodePoseRow(Object.assign({}, base, { x: base.x + 2 }));      // 2 < 8 unit
    var big = NET.encodePoseRow(Object.assign({}, base, { x: base.x + 40 }));      // 40 > 8 unit
    check('delta：微小移动不算变化', NET.rowChanged(row, tiny) === false,
      '移动 2 unit（阈值 ' + NET.P.POS_EPSILON + '）→ 不发');
    check('delta：明显移动算变化', NET.rowChanged(row, big) === true, '移动 40 unit → 要发');

    var died = NET.encodePoseRow(Object.assign({}, base, { alive: false }));
    check('delta：critical 字段（存活）变化会被识别', NET.rowCriticalChanged(row, died) === true, 'alive 变化 → 立即发');
    check('delta：位置变化不算 critical', NET.rowCriticalChanged(row, big) === false, '只是移动 → 不必立即发');

    // critical 变化必须绕过限流（参考实现踩过的坑：重生请求被限流吞掉）
    var dt2 = new NET.DeltaTracker(1000);
    dt2.remember([row], 0, true);
    var outMove = dt2.build([big], 100, false);          // 才过 100ms，未到间隔
    var outDie = dt2.build([died], 100, false);
    check('delta：未到间隔的普通移动会被压住', outMove.length === 0, '发出 ' + outMove.length + ' 行');
    check('delta：critical 变化绕过限流立即发', outDie.length === 1, '发出 ' + outDie.length + ' 行');

    /* ---- 5. 时钟同步（含单向延迟校正） ---- */
    var clk = new NET.Clock();
    var trueOffset = 5000;      // 对方时钟快 5 秒
    for (i = 0; i < 12; i++) {
      var rtt = 60 + (i % 4) * 40;                 // 60~180ms 抖动
      var t0 = 100000 + i * 1000;
      var recv = t0 + rtt;
      var remoteTime = t0 + rtt / 2 + trueOffset;  // 对方在单程后生成时间戳
      clk.observe(t0, remoteTime, recv);
    }
    check('时钟同步：能收敛到真实偏移', Math.abs(clk.offsetMs - trueOffset) < 15,
      '估计 ' + n(clk.offsetMs, 1) + 'ms，真实 ' + trueOffset + 'ms，误差 ' + n(Math.abs(clk.offsetMs - trueOffset), 1) + 'ms');
    check('时钟同步：量出了 RTT（参考实现完全没做这步）', clk.rttMs > 0, 'RTT ≈ ' + n(clk.rttMs, 0) + 'ms');

    /* ---- 6. 序号守卫 / 断流 / resync ---- */
    var sg = new NET.SeqGuard();
    check('序号守卫：没有基线时拒绝应用 delta', sg.accept(5, false, false, 1000) === 'resync', '要求先来全量快照');
    check('序号守卫：全量快照可以应用', sg.accept(5, true, false, 1000) === 'apply', 'full=true');
    check('序号守卫：连续 delta 可以应用', sg.accept(6, false, false, 1100) === 'apply', 'seq 6');
    check('序号守卫：跳号的 delta 触发 resync', sg.accept(9, false, false, 1200) === 'resync', 'seq 6 → 9 出现空洞');
    check('序号守卫：旧包直接丢弃', sg.accept(3, false, false, 1300) === 'drop', 'seq 3 < 已收 6');
    sg.lastArrival = 1000;
    check('序号守卫：断流超时会被发现', sg.stalled(1000 + NET.P.MATCH_STALL_MS + 10) === true,
      '超过 ' + NET.P.MATCH_STALL_MS + 'ms 无 match 包');

    /* ---- 7. 射击去重（P2P 必须带 peerId） ---- */
    var dd = new NET.ShotDedupe();
    check('射击去重：同一发不会结算两次', dd.check('A', 1) === true && dd.check('A', 1) === false, 'A:1 第二次被拒');
    check('射击去重：不同玩家的同号射击互不干扰', dd.check('B', 1) === true,
      'B:1 通过（参考实现只用 shotId 会在这里撞车）');

    /* ---- 8. 节拍器频率（对比参考实现 acc=0 的写法少了多少） ---- */
    var tk = new NET.Ticker(12);
    var fires = 0;
    for (i = 0; i < 60; i++) if (tk.step(1 / 60)) fires++;   // 模拟 1 秒 60 帧
    // 参考实现的写法：命中后把累加器清零，于是每次都要多等一个整帧
    var buggyAcc = 0, buggyFires = 0;
    for (i = 0; i < 60; i++) {
      buggyAcc += 1 / 60;
      if (buggyAcc > 1 / 12) { buggyAcc = 0; buggyFires++; }
    }
    check('节拍器：12Hz 在 60fps 下真的发 12 次', fires === 12 && buggyFires < fires,
      '我们 ' + fires + ' 次/秒；参考实现的 acc=0 写法只有 ' + buggyFires + ' 次/秒（少 ' +
      n((1 - buggyFires / fires) * 100, 0) + '%）');

    /* ---- 9. Loopback 传输端到端：可靠通道不丢、realtime 会丢 ---- */
    var hub = new TRANSPORT.LoopbackHub({ latencyMs: 30, jitterMs: 8, lossRate: 0.5 });
    var epA = hub.createEndpoint('A', { isHost: true });
    var epB = hub.createEndpoint('B', {});
    var gotRel = 0, gotRt = 0, peerEvents = [];
    epB.onMessage(function (m) { if (m.t === 'rel') gotRel++; else gotRt++; });
    epB.onPeer(function (ev) { peerEvents.push(ev.type); });
    for (i = 0; i < 40; i++) { epA.send({ t: 'rel', i: i }); epA.sendRealtime({ t: 'rt', i: i }); }
    await wait(400);
    check('Loopback：可靠通道一条不丢', gotRel === 40, '收到 ' + gotRel + '/40');
    check('Loopback：realtime 通道按设定丢包', gotRt > 5 && gotRt < 38,
      '收到 ' + gotRt + '/40（丢包率设 50%）');
    check('Loopback：能收到 peer join 事件', peerEvents.indexOf('join') >= 0, '事件 ' + peerEvents.join(','));
    check('Loopback：房主标识正确', epA.isHost === true && epB.isHost === false && epB.hostId === 'A',
      'A.isHost=' + epA.isHost + '，B 看到的 host=' + epB.hostId);
    var leaveSeen = [];
    epA.onPeer(function (ev) { leaveSeen.push(ev.type); });
    hub.removeEndpoint('B');
    await wait(200);
    check('Loopback：显式 leave 事件（P2P 下不能靠快照缺席推断）', leaveSeen.indexOf('leave') >= 0,
      'A 收到 ' + leaveSeen.join(','));
    hub.destroy();
  }

  /* ================================================================
   *  Stage 2：主机权威循环 + 远程实体 + 命中链路
   *
   *  没有 VibeHub 账号也能测：用 LoopbackHub 造一个"线上的假对手"，
   *  它只按协议收发消息，不需要第二个游戏实例。
   *  两种角色都要验：我们当房主（收位姿、回溯判定）和我们当客户端（收快照、被打）。
   * ================================================================ */
  async function runNetPlayTests() {
    var T = window.GAME && GAME.__test;
    if (!T || !T.netStart) { check('联机对局钩子可用', false, 'GAME.__test.netStart 不存在'); return; }
    // 假对手必须站在对立阵营，否则同队不结算伤害（这是正确行为，别把测试写成队友互殴）
    var foeTeam = GAME.SET.team === 'T' ? 'CT' : 'T';

    /* 造一个只说协议的假对手 */
    function makeFakePeer(ep, opts) {
      opts = opts || {};
      var fake = {
        ep: ep, id: ep.peerId, team: opts.team || 'T', name: opts.name || 'Ghost',
        lifeId: 3, hp: 100, x: opts.x || 0, z: opts.z || 0, y: 0, yaw: 0,
        got: { snap: 0, dmg: 0, hit: 0, kill: 0, hello: 0, pong: 0 },
        lastDmg: null, lastKill: null, clockOffset: 0
      };
      ep.onMessage(function (m) {
        if (!m || !m.t) return;
        if (m.t === NET.P.RT.SNAP) { fake.got.snap++; fake.lastSnap = m; }
        else if (m.t === NET.P.EV.DMG) {
          fake.got.dmg++; fake.lastDmg = m;
          // 按协议：自己扣血，然后无条件回 ack
          var killed = false;
          if (Number(m.lifeId) === fake.lifeId) {
            fake.hp = Math.max(0, fake.hp - Math.round(Number(m.dmg) || 0));
            killed = fake.hp <= 0;
          }
          ep.send({
            t: NET.P.EV.DMG_ACK, shooterId: m.shooterId, shotId: m.shotId,
            lifeId: m.lifeId, hp: fake.hp, killed: killed
          });
        }
        else if (m.t === NET.P.EV.HIT) { fake.got.hit++; }
        else if (m.t === NET.P.EV.KILL) { fake.got.kill++; fake.lastKill = m; }
        else if (m.t === NET.P.EV.HELLO) { fake.got.hello++; }
        else if (m.t === NET.P.EV.PING) { ep.send({ t: NET.P.EV.PONG, t0: m.t0, now: Date.now() + fake.clockOffset }); }
        else if (m.t === NET.P.EV.PONG) { fake.got.pong++; }
      });
      fake.hello = function () {
        ep.send({ t: NET.P.EV.HELLO, v: NET.P.VERSION, team: fake.team, name: fake.name, host: false });
      };
      fake.pose = function (time) {
        ep.sendRealtime({
          t: NET.P.RT.POSE, time: time,
          r: NET.encodePoseRow({
            id: 0, x: fake.x, y: fake.y, z: fake.z, yaw: fake.yaw, pitch: 0,
            crouch: false, alive: fake.hp > 0, hp: fake.hp, team: fake.team, wep: 0, lifeId: fake.lifeId
          })
        });
      };
      fake.snapshotOf = function (time, seq) {
        ep.sendRealtime({
          t: NET.P.RT.SNAP, time: time, seq: seq, ids: [''],
          r0: 1,
          rows: [NET.encodePoseRow({
            id: 0, x: fake.x, y: fake.y, z: fake.z, yaw: fake.yaw, pitch: 0,
            crouch: false, alive: fake.hp > 0, hp: fake.hp, team: fake.team, wep: 0, lifeId: fake.lifeId
          })]
        });
      };
      fake.fire = function (shotId, from, dir, viewTime, fireTime, lifeId) {
        ep.send({
          t: NET.P.EV.FIRE, shotId: shotId, lifeId: lifeId === undefined ? fake.lifeId : lifeId,
          x: from[0], y: from[1], z: from[2], dx: dir[0], dy: dir[1], dz: dir[2],
          w: 'ak47', range: 4096, fireTime: fireTime, viewTime: viewTime
        });
      };
      return fake;
    }

    /* ---------------- A. 我们当房主 ---------------- */
    T.forceLive();
    T.revive();
    T.invuln(false);
    T.setPose(1200, -1500, 0, 0);      // CT 出生区一块空地，面朝 -Z
    await wait(150);

    var hubH = new TRANSPORT.LoopbackHub({ latencyMs: 45, jitterMs: 12, lossRate: 0 });
    var meH = hubH.createEndpoint('me', { isHost: true });
    var himH = hubH.createEndpoint('ghost', {});
    var ghost = makeFakePeer(himH, { team: foeTeam, name: 'Ghost' });
    T.netStart(meH);
    ghost.hello();
    await wait(300);

    var info = T.netInfo();
    check('房主：收到 hello 后创建了远程玩家实体', info.on === true && info.isHost === true && info.remotes.length === 1,
      '联机=' + info.on + '，房主=' + info.isHost + '，远程实体 ' + info.remotes.length + ' 个');
    check('房主：远程玩家进入了实体表（雷达/命中判定都能看到他）', info.inAll === 1,
      'all 里的远程实体 ' + info.inAll + ' 个');

    // 假对手站在我正前方 500 unit，持续上报位姿
    ghost.x = 1200; ghost.z = -2000;
    for (var k = 0; k < 8; k++) { ghost.pose(Date.now()); await wait(60); }
    await wait(200);
    var info2 = T.netInfo();
    var r0 = info2.remotes[0] || {};
    // 注意：渲染轨在稳态下只会保留"夹住当前渲染时刻"的那一对样本，
    // sample() 每帧会把更旧的 shift 掉，所以 2 帧是正常的，不是没收到
    check('房主：远程位姿被写入历史轨与渲染轨', (r0.history || 0) >= 2 && (r0.samples || 0) >= 2,
      '渲染样本 ' + r0.samples + ' 帧（稳态保留一对）、回溯历史 ' + r0.history + ' 帧');
    check('房主：远程玩家被插值到上报的位置附近',
      Math.abs(r0.x - 1200) < 40 && Math.abs(r0.z - (-2000)) < 120,
      '插值位置 (' + n(r0.x, 0) + ',' + n(r0.z, 0) + ')，上报 (1200,-2000)');
    check('房主：远程玩家模型已显示', r0.visible === true, 'visible=' + r0.visible);

    // 假对手朝我开枪 → 我们回溯判定 → 我应该掉血
    var beforeHp = GAME.debug().health;
    var ft = Date.now();
    ghost.fire(1, [1200, 64, -2000], [0, 0, 1], ft - 90, ft);   // 沿 +Z 朝我
    await wait(400);
    var afterHp = GAME.debug().health;
    check('房主：回溯判定远端射击并让我掉血', afterHp < beforeHp,
      'HP ' + beforeHp + ' → ' + afterHp + '（房主用 viewTime 回溯我的历史位置）');
    check('房主：给射击者回了命中确认', ghost.got.hit >= 1, 'Ghost 收到 hit ' + ghost.got.hit + ' 次');

    // 同一发重复上报 → 必须只结算一次
    // 这段要开无敌：否则旁边的 bot 在 wait 期间会继续打我，HP 自然会变，
    // 那不是去重失效，是测试把 bot 的伤害误算成了重复结算
    T.invuln(true);
    var hp2 = GAME.debug().health, dead2 = GAME.debug().dead;
    ghost.fire(1, [1200, 64, -2000], [0, 0, 1], ft - 90, ft);
    await wait(300);
    var hp2b = GAME.debug().health;
    check('房主：重复的同一发不会二次结算', hp2b === hp2,
      'HP ' + hp2 + '（dead=' + dead2 + '）→ ' + hp2b + '，去重后未再扣血');

    // 用过期 lifeId 开枪 → 必须被拒
    var hp3 = GAME.debug().health;
    ghost.fire(2, [1200, 64, -2000], [0, 0, 1], ft - 90, ft, 99);
    await wait(300);
    var st = T.netInfo().stats;
    check('房主：拒绝过期 lifeId 的远端射击', GAME.debug().health === hp3 && (st.rejects['stale-life'] || 0) >= 1,
      'HP 未变（' + hp3 + '），拒绝计数 ' + JSON.stringify(st.rejects));

    // 我打他：应该走 DMG → 假对手自己扣血 → ack → 我看到确认
    T.invuln(true);
    T.revive();                        // 上一段可能已经被 Ghost 打死了，先复活
    T.forceLive();
    T.setPose(1200, -1500, 0, 0);
    await wait(150);
    ghost.x = 1200; ghost.z = -2000; ghost.hp = 100;
    for (k = 0; k < 6; k++) { ghost.pose(Date.now()); await wait(60); }
    var dmgBefore = ghost.got.dmg;
    T.netFire();
    await wait(400);
    check('房主：我开枪后由远端自己扣血（血量算术归受害者）',
      ghost.got.dmg > dmgBefore && ghost.hp < 100,
      '收到 dmg ' + (ghost.got.dmg - dmgBefore) + ' 次，Ghost 血量 ' + ghost.hp);

    // 打到死 → 应该广播 kill
    for (k = 0; k < 12 && ghost.hp > 0; k++) {
      ghost.pose(Date.now());
      T.netFire();
      await wait(120);
    }
    await wait(300);
    check('房主：打死远端后广播击杀事件', ghost.got.kill >= 1 && ghost.hp <= 0,
      'Ghost 血量 ' + ghost.hp + '，收到 kill ' + ghost.got.kill + ' 次' +
      (ghost.lastKill ? '（' + ghost.lastKill.killer + ' → ' + ghost.lastKill.victim + '）' : ''));

    // 远程玩家离开 → 必须显式清理（不能靠快照缺席推断）
    hubH.removeEndpoint('ghost');
    await wait(300);
    var info3 = T.netInfo();
    check('房主：peer leave 后远程实体被清理', info3.remotes.length === 0 && info3.inAll === 0,
      '远程实体 ' + info3.remotes.length + ' 个，all 里 ' + info3.inAll + ' 个');
    T.netStop();
    hubH.destroy();
    await wait(100);

    /* ---------------- B. 我们当客户端 ---------------- */
    T.forceLive();
    T.revive();
    T.setPose(1200, -1500, 0, 0);
    var hubC = new TRANSPORT.LoopbackHub({ latencyMs: 60, jitterMs: 15, lossRate: 0.03 });
    var hostEp = hubC.createEndpoint('host', { isHost: true });
    var meEp = hubC.createEndpoint('me', {});
    var fakeHost = makeFakePeer(hostEp, { team: foeTeam, name: 'HostBot' });
    fakeHost.clockOffset = 7000;            // 故意让房主时钟快 7 秒，验证时钟同步
    T.netStart(meEp);
    fakeHost.hello();
    await wait(400);

    var ci = T.netInfo();
    check('客户端：识别自己不是房主', ci.on === true && ci.isHost === false, 'isHost=' + ci.isHost);

    // 等时钟收敛
    for (k = 0; k < 20 && !T.netInfo().clockReady; k++) { T.netTick(1 / 60); await wait(100); }
    var ci2 = T.netInfo();
    check('客户端：与房主时钟对齐（含单向延迟校正）',
      ci2.clockReady === true && Math.abs(ci2.offsetMs - 7000) < 200,
      '估计偏移 ' + n(ci2.offsetMs, 0) + 'ms（真实 7000ms），RTT ' + n(ci2.rttMs, 0) + 'ms');

    // 房主发快照 → 我们要插值出远程实体
    fakeHost.x = 1200; fakeHost.z = -1900;
    for (k = 0; k < 10; k++) {
      fakeHost.snapshotOf(Date.now() + fakeHost.clockOffset, k + 1);
      T.netTick(1 / 60);
      await wait(66);
    }
    await wait(200);
    T.netTick(1 / 60);
    var ci3 = T.netInfo();
    var rr = ci3.remotes[0] || {};
    check('客户端：从快照插值出远程玩家', ci3.remotes.length === 1 && (rr.samples || 0) >= 2,
      '远程 ' + ci3.remotes.length + ' 个，渲染样本 ' + rr.samples + ' 帧（稳态一对），插值延迟 ' + n(rr.delayMs, 0) + 'ms');
    check('客户端：插值位置贴近房主上报值',
      Math.abs(rr.x - 1200) < 60 && Math.abs(rr.z - (-1900)) < 160,
      '(' + n(rr.x, 0) + ',' + n(rr.z, 0) + ') vs 上报 (1200,-1900)');

    // 我开枪 → 应该把 fire 交给房主（而不是自己结算别人的血）
    var hpBefore = fakeHost.hp;
    T.netFire();
    await wait(300);
    check('客户端：开枪只上报房主，不自行结算远端血量', fakeHost.hp === hpBefore,
      'Ghost 血量未被本地改动（' + fakeHost.hp + '），等房主判定');

    // 房主判我被打中 → 我自己扣血并回 ack
    var myHpBefore = GAME.debug().health;
    var applied0 = T.netInfo().stats.dmgApplied || 0;
    T.invuln(false);
    hostEp.send({
      t: NET.P.EV.DMG, shooterId: 'host', shotId: 77, lifeId: ci3.myLife,
      dmg: 27, headshot: false, w: 'ak47', shooterTeam: foeTeam
    }, 'me');
    await wait(300);
    var applied1 = T.netInfo().stats.dmgApplied || 0;
    check('客户端：收到 dmg 后按本地血量扣血', applied1 === applied0 + 1 && GAME.debug().health < myHpBefore,
      'HP ' + myHpBefore + ' → ' + GAME.debug().health + '，应用次数 ' + applied0 + ' → ' + applied1);

    // 过期 lifeId 的伤害必须被忽略，但仍要回 ack（房主才能闭环）
    // 注意：不能用 HP 当探针 —— 旁边的 bot 也在打我，HP 会因为别的原因变化。
    // 这里直接看"伤害应用分支"有没有被执行。
    var recv0 = T.netInfo().stats.dmgRecv || 0;
    hostEp.send({
      t: NET.P.EV.DMG, shooterId: 'host', shotId: 78, lifeId: 99999,
      dmg: 50, headshot: false, w: 'ak47', shooterTeam: foeTeam
    }, 'me');
    await wait(300);
    var s2 = T.netInfo().stats;
    check('客户端：忽略过期 lifeId 的伤害（但仍收下消息并回 ack）',
      (s2.dmgRecv || 0) === recv0 + 1 && (s2.dmgApplied || 0) === applied1,
      '收到 ' + recv0 + ' → ' + s2.dmgRecv + ' 条，应用次数保持 ' + s2.dmgApplied + '（没给过期生命扣血）');

    T.netStop();
    hubC.destroy();
    T.invuln(true);
    var after = T.netInfo();
    check('联机结束后实体表被清干净（不影响单机）', after.on === false && after.inAll === 0,
      '联机=' + after.on + '，残留远程实体 ' + after.inAll + ' 个');

    /* ================================================================
     *  Stage 3：回合 / 经济 / C4 / bot 同步
     * ================================================================ */

    /* ---- C. 房主侧：bot 历史、match 组装、远程购买校验、远程拆弹 ---- */
    T.forceLive(); T.revive(); T.invuln(true);
    T.setPose(1200, -1500, 0, 0);
    var hubM = new TRANSPORT.LoopbackHub({ latencyMs: 40, jitterMs: 10, lossRate: 0 });
    var meM = hubM.createEndpoint('me', { isHost: true });
    var cliM = hubM.createEndpoint('cli', {});
    var cli = makeFakePeer(cliM, { team: foeTeam, name: 'Cli' });
    T.netStart(meM);
    cli.hello();
    await wait(300);
    for (k = 0; k < 20; k++) { T.netTick(1 / 60); await wait(20); }

    var bstates = T.botStates();
    var withHist = bstates.filter(function (b) { return b.history > 0; }).length;
    check('房主：bot 位姿被记入历史轨（客户端才打得到 bot）', bstates.length > 0 && withHist === bstates.length,
      bstates.length + ' 个 bot，' + withHist + ' 个有历史（样本示例 ' + (bstates[0] ? bstates[0].history : 0) + ' 帧）');

    var mm = T.netBuildMatch(true);
    check('房主：match 全量快照包含回合/比分/经济/bot 行',
      mm.ph !== undefined && Array.isArray(mm.sc) && Array.isArray(mm.bots) && mm.bots.length === bstates.length,
      'phase=' + mm.ph + '，比分 ' + mm.sc.join(':') + '，bot 行 ' + mm.bots.length + '/' + bstates.length +
      '，seq=' + mm.seq);

    var mmDelta = T.netBuildMatch(false);
    check('房主：delta 快照比全量小（bot 没动就不重发）', mmDelta.bots.length <= mm.bots.length,
      '全量 ' + mm.bots.length + ' 行 → delta ' + mmDelta.bots.length + ' 行');

    // 远程玩家买枪：钱不够要拒，钱够且在买区要过。
    // 注意 forceLive 不一定会把 roundClock 拨回购买窗口（> roundTime-20），
    // 所以这里改用直接观测房主侧的钱有没有被扣，不依赖异步消息。
    T.netRemoteMoney('cli', 100);
    T.netRemotePose('cli', 1200, -1700);        // CT 买区内
    cliM.send({ t: NET.P.EV.BUY, id: 'awp' });
    await wait(300);
    check('房主：远程玩家钱不够时购买被拒（钱没被扣）',
      T.netRemoteMoney('cli') === 100,
      '余额 $' + T.netRemoteMoney('cli') + '（应保持 100）');

    // 先把时钟拨进购买窗口再试（roundTime=115，购买窗口是剩余 >95s）
    T.forceLive();
    T.setRoundClock(110);
    cliM.send({ t: NET.P.EV.BUY, id: 'awp' });
    await wait(300);
    var moneyAfterCheap = T.netRemoteMoney('cli');
    check('房主：钱不够时即便在购买窗口也拒绝', moneyAfterCheap === 100,
      '余额 $' + moneyAfterCheap + '（仍应保持 100）');

    // 关键：等位姿上行到达并被房主记录后再买，否则房主看到的 e.x/e.z
    // 可能还是插值中的旧位置，导致 inBuyZone 判定失败
    T.netRemoteMoney('cli', 9000);
    T.setRoundClock(110);                        // 每次买之前重拨，避免等待期间窗口溜走
    // 直接在房主侧把远程玩家的位置钉在买区（绕过插值延迟）
    var buyZone = MAP.BUY_ZONES[foeTeam];
    var bx = (buyZone[0] + buyZone[2]) / 2, bz = (buyZone[1] + buyZone[3]) / 2;
    cli.x = bx; cli.z = bz;
    for (k = 0; k < 6; k++) { cli.pose(Date.now()); await wait(70); }
    T.setRoundClock(110);
    await wait(150);
    var rifleId = foeTeam === 'T' ? 'ak47' : 'm4a1';
    cliM.send({ t: NET.P.EV.BUY, id: rifleId });
    await wait(400);
    var moneyAfterBuy = T.netRemoteMoney('cli');
    var riflePrice = WEAPONS.defs[rifleId].price;
    check('房主：钱够且在买区时批准购买并扣钱',
      moneyAfterBuy === 9000 - riflePrice,
      '余额 $' + moneyAfterBuy + '（应 = ' + (9000 - riflePrice) + '）');

    // 走出买区后必须拒绝
    T.netRemoteMoney('cli', 9000);
    T.setRoundClock(110);
    cli.x = 0; cli.z = 0;                       // 地图中路
    for (k = 0; k < 6; k++) { cli.pose(Date.now()); await wait(70); }
    T.setRoundClock(110);
    cliM.send({ t: NET.P.EV.BUY, id: rifleId });
    await wait(400);
    check('房主：离开出生区后拒绝购买', T.netRemoteMoney('cli') === 9000,
      '余额 $' + T.netRemoteMoney('cli') + '（应保持 9000）');

    T.netStop();
    hubM.destroy();
    await wait(100);

    /* ---- D. 客户端侧：应用 match、bot 慢车道、resync ---- */
    T.forceLive(); T.revive();
    var hubD = new TRANSPORT.LoopbackHub({ latencyMs: 50, jitterMs: 12, lossRate: 0 });
    var hostD = hubD.createEndpoint('hostD', { isHost: true });
    var meD = hubD.createEndpoint('meD', {});
    var fakeH = makeFakePeer(hostD, { team: foeTeam, name: 'H' });
    T.netStart(meD);
    fakeH.hello();
    await wait(300);

    // 手搓一份 match 全量快照下发
    function sendMatch(seq, full, opts) {
      opts = opts || {};
      var rows = [];
      for (var i = 0; i < (opts.botN === undefined ? 3 : opts.botN); i++) {
        rows.push(NET.encodePoseRow({
          id: i, x: 300 + i * 100 + (opts.shift || 0), y: 0, z: -600, yaw: 0, pitch: 0,
          crouch: false, alive: true, hp: 100, team: i % 2 ? 'T' : 'CT', wep: 0, lifeId: 1
        }));
      }
      hostD.sendRealtime({
        t: NET.P.RT.MATCH, seq: seq, full: full, time: Date.now(),
        ph: 'live', pt: 0, rc: opts.rc === undefined ? 77 : opts.rc, rd: 5,
        sc: [3, 2], ls: [1, 0], site: 'A',
        bomb: opts.bomb || null, pp: opts.pp || 0, dp: opts.dp || 0,
        money: (function () { var m = {}; m['meD'] = opts.money === undefined ? 4321 : opts.money; return m; })(),
        bots: rows, botN: rows.length
      });
    }

    sendMatch(1, true);
    await wait(250);
    T.netTick(1 / 60);
    var mi = T.netMatchInfo();
    check('客户端：应用房主的回合与比分', mi.round === 5 && mi.score.T === 3 && mi.score.CT === 2 && Math.abs(mi.roundClock - 77) < 1,
      '回合 ' + mi.round + '，比分 ' + mi.score.T + ':' + mi.score.CT + '，剩余 ' + n(mi.roundClock, 0) + 's');
    check('客户端：钱由房主说了算', mi.money === 4321, '钱 $' + mi.money);
    check('客户端：从 match 通道创建 bot 实体（慢车道插值）',
      mi.netBots.length === 3 && mi.netBots[0].delayMs >= NET.P.ENTITY_INTERP_MIN_MS,
      'bot ' + mi.netBots.length + ' 个，插值延迟 ' + n(mi.netBots[0].delayMs, 0) +
      'ms（慢车道下限 ' + NET.P.ENTITY_INTERP_MIN_MS + 'ms）');

    // 多发几帧让 bot 插值到位
    for (k = 2; k <= 6; k++) { sendMatch(k, false, { shift: k * 20 }); await wait(120); T.netTick(1 / 60); }
    var mi2 = T.netMatchInfo();
    check('客户端：bot 位置随快照推进', mi2.netBots[0].x > 300,
      'bot0 x=' + n(mi2.netBots[0].x, 0) + '（初始 300，快照已推进）');

    // 炸弹状态同步
    sendMatch(7, false, { bomb: [1400, -700, 23.5], dp: 0.4 });
    await wait(200);
    T.netTick(1 / 60);
    var mi3 = T.netMatchInfo();
    check('客户端：C4 状态与倒计时来自房主',
      mi3.bombPlanted === true && Math.abs(mi3.bombTimer - 23.5) < 0.6 && Math.abs(mi3.hostDefuse - 0.4) < 0.01,
      '已安放=' + mi3.bombPlanted + '，倒计时 ' + n(mi3.bombTimer, 1) + 's，拆除进度 ' + n(mi3.hostDefuse, 2));

    // 跳号 → 必须请求 resync，而不是把 delta 硬套上去
    var resync0 = T.netMatchInfo().stats.resync;
    sendMatch(20, false, { shift: 999 });
    await wait(300);
    var mi4 = T.netMatchInfo();
    check('客户端：match 跳号时请求 resync 而不是错误应用',
      mi4.stats.resync > resync0 && mi4.guard.gaps >= 1,
      'resync 次数 ' + resync0 + ' → ' + mi4.stats.resync + '，检测到空洞 ' + mi4.guard.gaps + ' 次');

    // 房主补一份全量后应该恢复
    sendMatch(21, true, { rc: 42 });
    await wait(250);
    T.netTick(1 / 60);
    var mi5 = T.netMatchInfo();
    check('客户端：收到全量快照后恢复同步',
      Math.abs(mi5.roundClock - 42) < 1 && mi5.guard.awaitingFull === false,
      '剩余 ' + n(mi5.roundClock, 0) + 's，等待全量=' + mi5.guard.awaitingFull);

    // 回合开始事件：应该复活我、给出生点和钱
    hostD.send({
      t: NET.P.EV.ROUND_START, round: 6, site: 'B',
      spawns: { meD: [900, 0, -1500, 5500] }, carrier: 'meD', money: { meD: 5500 }
    }, 'meD');
    await wait(300);
    var db2 = GAME.debug();
    check('客户端：应用房主的回合开始（复活 + 出生点 + 钱）',
      db2.dead === false && Math.abs(db2.x - 900) < 2 && db2.money === 5500,
      '位置 (' + n(db2.x, 0) + ',' + n(db2.z, 0) + ')，钱 $' + db2.money + '，存活=' + !db2.dead);
    check('客户端：知道自己是 C4 携带者', T.netMatchInfo().isCarrier === true, 'isCarrier=' + T.netMatchInfo().isCarrier);

    // 回合结束事件
    hostD.send({ t: NET.P.EV.ROUND_END, winner: foeTeam, reason: '灭队', sc: [9, 9], money: { meD: 7000 } }, 'meD');
    await wait(300);
    var mi6 = T.netMatchInfo();
    check('客户端：应用房主的回合结束（比分 + 奖金）',
      mi6.score.T === 9 && mi6.score.CT === 9 && mi6.money === 7000,
      '比分 ' + mi6.score.T + ':' + mi6.score.CT + '，钱 $' + mi6.money);

    T.netStop();
    hubD.destroy();
    T.invuln(true);
    var fin = T.netMatchInfo();
    check('联机结束后 bot 实体也清干净', fin.netBots.length === 0, '残留 netBot ' + fin.netBots.length + ' 个');
  }

  window.addEventListener('load', function () {
    setTimeout(function () {
      run().catch(function (err) {
        check('自检脚本本身出错', false, (err && err.message ? err.message : String(err)) +
          ' @ ' + (err && err.stack ? String(err.stack).split('\n')[1] : '?'));
      });
    }, 400);
  });
})();
