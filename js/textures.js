/* ============================================================
 *  textures.js — 程序化生成贴图（无外部资源，纯 Canvas 绘制）
 *  风格参考 CS1.6 de_dust2：沙黄砖墙、沙地、木箱、铁皮门
 * ============================================================ */
'use strict';

var TEX = (function () {

  var rndSeed = 20030401;
  function rnd() { // 固定种子随机，保证每次生成的贴图一致
    rndSeed = (rndSeed * 1103515245 + 12345) & 0x7fffffff;
    return rndSeed / 0x7fffffff;
  }

  function makeCanvas(size) {
    var c = document.createElement('canvas');
    c.width = c.height = size;
    return c;
  }

  /* 叠加颗粒噪点，让平面不那么“塑料” */
  function grain(ctx, size, amount, alpha) {
    var img = ctx.getImageData(0, 0, size, size), d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (rnd() - 0.5) * amount;
      d[i] = clamp(d[i] + n); d[i + 1] = clamp(d[i + 1] + n); d[i + 2] = clamp(d[i + 2] + n);
      if (alpha) d[i + 3] = clamp(d[i + 3]);
    }
    ctx.putImageData(img, 0, 0);
  }
  function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v | 0; }

  /* 随机斑块，模拟污渍/风化 */
  function blotches(ctx, size, count, color, rmin, rmax, a) {
    for (var i = 0; i < count; i++) {
      var x = rnd() * size, y = rnd() * size, r = rmin + rnd() * (rmax - rmin);
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(' + color + ',' + (a * (0.5 + rnd() * 0.5)).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + color + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    }
  }

  function toTexture(canvas, repeat, nearest) {
    var t = new THREE.CanvasTexture(canvas);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = nearest === false ? THREE.LinearFilter : THREE.NearestFilter;
    t.minFilter = THREE.LinearMipMapLinearFilter;
    t.anisotropy = 4;
    if (repeat) t.repeat.set(repeat, repeat);
    return t;
  }

  /* ---------- 沙岩砖墙（dust2 主墙体） ---------- */
  function sandWall(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#c2a776';
    x.fillRect(0, 0, size, size);
    var rows = 8, h = size / rows;
    for (var r = 0; r < rows; r++) {
      var off = (r % 2) ? h * 1.0 : 0;
      var cols = 4, w = size / cols;
      for (var i = -1; i < cols + 1; i++) {
        var bx = i * w + off, by = r * h;
        var v = 0.86 + rnd() * 0.26;
        x.fillStyle = 'rgb(' + (194 * v | 0) + ',' + (167 * v | 0) + ',' + (118 * v | 0) + ')';
        x.fillRect(bx + 1.5, by + 1.5, w - 3, h - 3);
        // 砖块高光/阴影边
        x.fillStyle = 'rgba(255,240,200,.20)';
        x.fillRect(bx + 1.5, by + 1.5, w - 3, 1.5);
        x.fillStyle = 'rgba(60,42,20,.28)';
        x.fillRect(bx + 1.5, by + h - 3, w - 3, 1.5);
      }
    }
    blotches(x, size, 26, '92,72,40', size * 0.03, size * 0.14, 0.22);
    blotches(x, size, 10, '235,220,180', size * 0.04, size * 0.16, 0.14);
    grain(x, size, 26);
    return c;
  }

  /* ---------- 沙地地面 ---------- */
  function sandFloor(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#bda372';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 46, '146,122,80', size * 0.05, size * 0.22, 0.38);
    blotches(x, size, 26, '224,208,168', size * 0.04, size * 0.18, 0.26);
    // 碎石
    for (var i = 0; i < 320; i++) {
      var px = rnd() * size, py = rnd() * size, s = 1 + rnd() * 2.6;
      x.fillStyle = rnd() > 0.5 ? 'rgba(104,84,56,.62)' : 'rgba(240,232,206,.5)';
      x.fillRect(px, py, s, s);
    }
    grain(x, size, 40);
    return c;
  }

  /* ---------- 石板地（中路/A点铺装） ---------- */
  function stoneFloor(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#b7a487';
    x.fillRect(0, 0, size, size);
    var n = 4, s = size / n;
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
      var v = 0.88 + rnd() * 0.22;
      x.fillStyle = 'rgb(' + (183 * v | 0) + ',' + (164 * v | 0) + ',' + (135 * v | 0) + ')';
      x.fillRect(i * s + 1, j * s + 1, s - 2, s - 2);
    }
    x.strokeStyle = 'rgba(70,58,40,.45)'; x.lineWidth = 2;
    for (i = 0; i <= n; i++) {
      x.beginPath(); x.moveTo(i * s, 0); x.lineTo(i * s, size); x.stroke();
      x.beginPath(); x.moveTo(0, i * s); x.lineTo(size, i * s); x.stroke();
    }
    blotches(x, size, 18, '110,92,64', size * 0.05, size * 0.2, 0.20);
    grain(x, size, 22);
    return c;
  }

  /* ---------- 木箱 ---------- */
  function woodCrate(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#9c6f3a';
    x.fillRect(0, 0, size, size);
    // 竖向木纹
    for (var i = 0; i < 60; i++) {
      var px = rnd() * size;
      x.strokeStyle = 'rgba(' + (rnd() > .5 ? '70,44,18,.28' : '210,170,110,.20') + ')';
      x.lineWidth = 1 + rnd() * 3;
      x.beginPath(); x.moveTo(px, 0); x.lineTo(px + (rnd() - .5) * 8, size); x.stroke();
    }
    // 外框
    var b = size * 0.09;
    x.fillStyle = '#7d5527';
    x.fillRect(0, 0, size, b); x.fillRect(0, size - b, size, b);
    x.fillRect(0, 0, b, size); x.fillRect(size - b, 0, b, size);
    // 斜撑
    x.strokeStyle = '#7d5527'; x.lineWidth = b * 0.9;
    x.beginPath(); x.moveTo(b, b); x.lineTo(size - b, size - b); x.stroke();
    x.beginPath(); x.moveTo(size - b, b); x.lineTo(b, size - b); x.stroke();
    // 钉子
    x.fillStyle = 'rgba(40,30,16,.6)';
    for (i = 0; i < 8; i++) x.fillRect(b * .5 + rnd() * (size - b), b * .3 + rnd() * (size - b), 2, 2);
    x.strokeStyle = 'rgba(30,20,8,.55)'; x.lineWidth = 2;
    x.strokeRect(1, 1, size - 2, size - 2);
    grain(x, size, 20);
    return c;
  }

  /* ---------- 铁皮集装箱 ---------- */
  function metalBox(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#6d7278';
    x.fillRect(0, 0, size, size);
    for (var i = 0; i < size; i += 16) {
      x.fillStyle = 'rgba(255,255,255,.09)'; x.fillRect(i, 0, 6, size);
      x.fillStyle = 'rgba(0,0,0,.22)'; x.fillRect(i + 8, 0, 6, size);
    }
    blotches(x, size, 22, '130,74,32', size * 0.02, size * 0.1, 0.35); // 铁锈
    x.strokeStyle = 'rgba(20,24,28,.7)'; x.lineWidth = 4;
    x.strokeRect(2, 2, size - 4, size - 4);
    grain(x, size, 18);
    return c;
  }

  /* ---------- 双开铁门（长通道/中门） ---------- */
  function doorMetal(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#8a7b5e';
    x.fillRect(0, 0, size, size);
    x.fillStyle = '#6f6248';
    x.fillRect(size * .04, size * .04, size * .44, size * .92);
    x.fillRect(size * .52, size * .04, size * .44, size * .92);
    x.strokeStyle = 'rgba(30,26,16,.7)'; x.lineWidth = 3;
    x.strokeRect(size * .04, size * .04, size * .44, size * .92);
    x.strokeRect(size * .52, size * .04, size * .44, size * .92);
    // 横向加强筋
    for (var i = 1; i < 5; i++) {
      x.fillStyle = 'rgba(255,250,225,.12)';
      x.fillRect(size * .04, size * (.04 + i * .18), size * .92, 3);
      x.fillStyle = 'rgba(0,0,0,.25)';
      x.fillRect(size * .04, size * (.04 + i * .18) + 3, size * .92, 3);
    }
    blotches(x, size, 14, '120,70,30', size * .02, size * .09, 0.4);
    grain(x, size, 16);
    return c;
  }

  /* ---------- 顶部/台沿的深色沙岩 ---------- */
  function sandTop(size) {
    var c = makeCanvas(size), x = c.getContext('2d');
    x.fillStyle = '#a8905f';
    x.fillRect(0, 0, size, size);
    blotches(x, size, 30, '120,100,64', size * .04, size * .2, 0.35);
    blotches(x, size, 12, '215,196,150', size * .04, size * .16, 0.2);
    grain(x, size, 26);
    return c;
  }

  /* ---------- 天空渐变 ---------- */
  function skyGradient() {
    var c = makeCanvas(256), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0.00, '#3f74b8');
    g.addColorStop(0.42, '#8fb6db');
    g.addColorStop(0.58, '#dfd6b4');
    g.addColorStop(1.00, '#c9b489');
    x.fillStyle = g; x.fillRect(0, 0, 256, 256);
    // 几缕薄云
    for (var i = 0; i < 26; i++) {
      var y = 10 + rnd() * 90, w = 30 + rnd() * 120, h = 4 + rnd() * 10;
      x.fillStyle = 'rgba(255,255,255,' + (0.05 + rnd() * 0.13).toFixed(3) + ')';
      x.beginPath();
      if (x.ellipse) x.ellipse(rnd() * 256, y, w, h, 0, 0, 6.2832); else x.arc(rnd() * 256, y, h, 0, 6.2832);
      x.fill();
    }
    return c;
  }

  /* ---------- 弹孔贴花（带 alpha） ---------- */
  function bulletHole() {
    var s = 64, c = makeCanvas(s), x = c.getContext('2d');
    x.clearRect(0, 0, s, s);
    var g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0.00, 'rgba(12,10,8,.95)');
    g.addColorStop(0.30, 'rgba(30,26,20,.80)');
    g.addColorStop(0.55, 'rgba(70,60,44,.35)');
    g.addColorStop(1.00, 'rgba(90,80,60,0)');
    x.fillStyle = g; x.beginPath(); x.arc(s / 2, s / 2, s / 2, 0, 6.2832); x.fill();
    // 边缘碎裂
    x.strokeStyle = 'rgba(20,16,10,.5)'; x.lineWidth = 1.5;
    for (var i = 0; i < 9; i++) {
      var a = rnd() * 6.2832, r0 = s * .16, r1 = s * (.2 + rnd() * .22);
      x.beginPath();
      x.moveTo(s / 2 + Math.cos(a) * r0, s / 2 + Math.sin(a) * r0);
      x.lineTo(s / 2 + Math.cos(a) * r1, s / 2 + Math.sin(a) * r1);
      x.stroke();
    }
    return c;
  }

  /* ---------- 通用柔光点（火花/烟尘/血/枪火） ---------- */
  function softDot(rgb) {
    var s = 64, c = makeCanvas(s), x = c.getContext('2d');
    var g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(' + rgb + ',1)');
    g.addColorStop(0.4, 'rgba(' + rgb + ',.55)');
    g.addColorStop(1, 'rgba(' + rgb + ',0)');
    x.fillStyle = g; x.fillRect(0, 0, s, s);
    return c;
  }

  /* ---------- 枪口焰（星形） ---------- */
  function muzzleFlash() {
    var s = 128, c = makeCanvas(s), x = c.getContext('2d');
    var g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s * .34);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(.35, 'rgba(255,225,130,.9)');
    g.addColorStop(1, 'rgba(255,150,40,0)');
    x.fillStyle = g; x.beginPath(); x.arc(s / 2, s / 2, s * .34, 0, 6.2832); x.fill();
    x.strokeStyle = 'rgba(255,235,170,.85)';
    for (var i = 0; i < 7; i++) {
      var a = rnd() * 6.2832, len = s * (.2 + rnd() * .28);
      x.lineWidth = 2 + rnd() * 5;
      x.beginPath(); x.moveTo(s / 2, s / 2);
      x.lineTo(s / 2 + Math.cos(a) * len, s / 2 + Math.sin(a) * len); x.stroke();
    }
    return c;
  }

  /* ---------- 炸弹箱体贴图 ---------- */
  function c4Tex() {
    var s = 64, c = makeCanvas(s), x = c.getContext('2d');
    x.fillStyle = '#3b3f33'; x.fillRect(0, 0, s, s);
    x.fillStyle = '#22251c'; x.fillRect(4, 4, s - 8, s - 8);
    x.fillStyle = '#c8b070'; x.fillRect(8, 10, s - 16, 10);
    x.fillStyle = '#d02020'; x.fillRect(10, 30, 12, 8);
    x.fillStyle = '#20c040'; x.fillRect(28, 30, 12, 8);
    grain(x, s, 14);
    return c;
  }

  /* ============ 对外接口：一次性生成全部贴图 ============ */
  var built = null;
  function build() {
    if (built) return built;
    built = {
      wall: toTexture(sandWall(256), 1),
      floor: toTexture(sandFloor(256), 1),
      stone: toTexture(stoneFloor(256), 1),
      crate: toTexture(woodCrate(256), 1),
      metal: toTexture(metalBox(256), 1),
      door: toTexture(doorMetal(256), 1),
      top: toTexture(sandTop(256), 1),
      sky: toTexture(skyGradient(), 0, false),
      hole: toTexture(bulletHole(), 0, false),
      smoke: toTexture(softDot('190,175,140'), 0, false),
      blood: toTexture(softDot('150,10,10'), 0, false),
      spark: toTexture(softDot('255,210,120'), 0, false),
      flash: toTexture(muzzleFlash(), 0, false),
      c4: toTexture(c4Tex(), 0, false)
    };
    built.sky.wrapS = built.sky.wrapT = THREE.ClampToEdgeWrapping;
    return built;
  }

  return { build: build };
})();
