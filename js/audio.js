/* ============================================================
 *  audio.js — WebAudio 程序化音效（不依赖任何音频文件）
 * ============================================================ */
'use strict';

var SFX = (function () {

  var ctx = null, master = null, noiseBuf = null, volume = 0.7, ready = false;

  function init() {
    if (ctx) return;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 20; comp.ratio.value = 8;
    master.connect(comp); comp.connect(ctx.destination);

    // 预生成一段白噪声
    var len = ctx.sampleRate * 2;
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    var d = noiseBuf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    ready = true;
  }

  function resume() { if (ctx && ctx.state === 'suspended') ctx.resume(); }
  function setVolume(v) { volume = v; if (master) master.gain.value = v; }

  function now() { return ctx.currentTime; }

  /* 噪声源 + 滤波 + 包络 */
  function noise(dur, gain, filter, freq, q, decay, dest) {
    var src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = filter || 'lowpass';
    f.frequency.value = freq || 2000;
    f.Q.value = q || 1;
    var g = ctx.createGain();
    var t = now();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0008, t + (decay || dur));
    src.connect(f); f.connect(g); g.connect(dest || master);
    src.start(t); src.stop(t + dur + 0.05);
    return { src: src, gain: g, filter: f };
  }

  /* 正弦/方波音 */
  function tone(type, f0, f1, dur, gain, dest) {
    var o = ctx.createOscillator();
    o.type = type;
    var g = ctx.createGain();
    var t = now();
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g); g.connect(dest || master);
    o.start(t); o.stop(t + dur + 0.02);
    return o;
  }

  /* 距离衰减节点 */
  function distGain(dist) {
    var g = ctx.createGain();
    var d = Math.max(1, dist || 0);
    g.gain.value = Math.min(1, 1600 / (600 + d * 1.15));
    g.connect(master);
    return g;
  }

  /* ---------------- 具体音效 ---------------- */

  // 枪声：低频砰 + 高频爆裂 + 尾音
  function shoot(kind, dist) {
    if (!ready) return;
    var out = distGain(dist);
    if (kind === 'pistol') {
      noise(0.16, 0.55, 'bandpass', 1700, 0.9, 0.12, out);
      tone('square', 320, 90, 0.10, 0.22, out);
      noise(0.28, 0.10, 'highpass', 3000, 1, 0.26, out);
    } else if (kind === 'awp') {
      noise(0.5, 0.85, 'lowpass', 1400, 1.2, 0.42, out);
      tone('sawtooth', 150, 45, 0.35, 0.4, out);
      noise(0.8, 0.16, 'highpass', 2200, 1, 0.75, out);
    } else { // 步枪
      noise(0.22, 0.7, 'bandpass', 1200, 0.8, 0.16, out);
      noise(0.12, 0.35, 'highpass', 3600, 1, 0.1, out);
      tone('square', 260, 70, 0.14, 0.3, out);
      noise(0.42, 0.09, 'lowpass', 900, 1, 0.4, out);
    }
  }

  function knifeSwing(dist) { if (ready) noise(0.14, 0.3, 'bandpass', 2600, 1.4, 0.12, distGain(dist)); }
  function knifeHit(dist) { if (ready) { noise(0.12, 0.5, 'lowpass', 900, 1, 0.1, distGain(dist)); tone('triangle', 420, 160, 0.1, 0.2, distGain(dist)); } }

  // 子弹打墙
  function impact(dist) {
    if (!ready) return;
    var out = distGain(dist);
    noise(0.09, 0.4, 'bandpass', 2400 + Math.random() * 1800, 1.6, 0.08, out);
    tone('triangle', 900 + Math.random() * 600, 200, 0.06, 0.08, out);
  }
  // 打中人
  function fleshHit(dist) {
    if (!ready) return;
    var out = distGain(dist);
    noise(0.12, 0.45, 'lowpass', 700, 1, 0.11, out);
  }
  // 命中提示（自己打中敌人）
  function hitmark(head) {
    if (!ready) return;
    tone('square', head ? 1500 : 1000, head ? 1500 : 1000, 0.05, 0.12);
  }
  // 子弹擦过耳边
  function whiz() { if (ready) noise(0.12, 0.16, 'bandpass', 2200, 6, 0.11); }

  function reload(stage) {
    if (!ready) return;
    if (stage === 0) { noise(0.07, 0.3, 'bandpass', 1500, 3, 0.06); tone('square', 200, 120, 0.05, 0.08); }
    else if (stage === 1) { noise(0.08, 0.34, 'bandpass', 900, 2.5, 0.07); }
    else { noise(0.06, 0.3, 'bandpass', 2200, 3, 0.05); tone('square', 420, 260, 0.05, 0.09); }
  }

  function switchWeapon() { if (ready) { noise(0.07, 0.24, 'bandpass', 1800, 3, 0.06); } }

  function footstep(dist, run) {
    if (!ready) return;
    var out = distGain(dist);
    noise(run ? 0.11 : 0.08, run ? 0.34 : 0.16, 'lowpass', 520 + Math.random() * 250, 1.1, run ? 0.1 : 0.07, out);
    noise(0.05, run ? 0.12 : 0.06, 'highpass', 3800, 1, 0.045, out);
  }
  function jump(dist) { if (ready) noise(0.07, 0.18, 'lowpass', 700, 1, 0.06, distGain(dist)); }
  function land(dist) { if (ready) { noise(0.14, 0.34, 'lowpass', 420, 1, 0.12, distGain(dist)); } }

  function death(dist) {
    if (!ready) return;
    var out = distGain(dist);
    tone('sawtooth', 260, 60, 0.5, 0.18, out);
    noise(0.4, 0.2, 'lowpass', 600, 1, 0.38, out);
  }
  function pain() {
    if (!ready) return;
    tone('sawtooth', 420 + Math.random() * 120, 180, 0.22, 0.16);
    noise(0.16, 0.14, 'bandpass', 800, 1.2, 0.14);
  }

  function bombBeep(fast) {
    if (!ready) return;
    tone('square', fast ? 2100 : 1500, fast ? 2100 : 1500, 0.06, 0.16);
  }
  function bombPlant() { if (ready) { tone('square', 700, 1200, 0.18, 0.14); noise(0.2, 0.2, 'bandpass', 1200, 2, 0.18); } }
  /* 安放 / 拆弹的提示音：音调随进度升高，快完成时明显更急更亮
   * （p 省略时退化成原来的单调「嗒」，bot 调用就是这种） */
  function defuseTick(p) {
    if (!ready) return;
    var k = p === undefined ? 0 : Math.max(0, Math.min(1, p));
    noise(0.06, 0.34, 'bandpass', 2400 + k * 1600, 5, 0.05);
    tone('square', 780 + k * 620, 1180 + k * 900, 0.05, 0.10);
  }
  function explode() {
    if (!ready) return;
    noise(1.6, 0.95, 'lowpass', 500, 1, 1.5);
    tone('sawtooth', 120, 28, 1.2, 0.5);
    noise(0.5, 0.5, 'highpass', 1500, 1, 0.45);
  }

  function roundStart() { if (ready) { tone('square', 700, 700, 0.1, 0.12); setTimeout(function () { tone('square', 1050, 1050, 0.14, 0.13); }, 130); } }  function win() { if (ready) { tone('square', 660, 660, 0.12, 0.13); setTimeout(function () { tone('square', 880, 880, 0.12, 0.13); }, 140); setTimeout(function () { tone('square', 1320, 1320, 0.22, 0.14); }, 290); } }
  function lose() { if (ready) { tone('sawtooth', 400, 400, 0.16, 0.12); setTimeout(function () { tone('sawtooth', 300, 220, 0.34, 0.13); }, 170); } }
  function uiClick() { if (ready) tone('square', 900, 900, 0.03, 0.07); }

  /* ---------------- 投掷物 / 购买 ---------------- */
  function pinPull() { if (ready) { noise(0.08, 0.28, 'bandpass', 2600, 4, 0.07); tone('square', 1400, 900, 0.06, 0.07); } }
  function grenadeThrow() { if (ready) noise(0.12, 0.2, 'highpass', 1800, 1, 0.1); }
  function grenadeBounce(dist) {
    if (!ready) return;
    var out = distGain(dist);
    noise(0.06, 0.35, 'bandpass', 1200 + Math.random() * 900, 3, 0.05, out);
    tone('triangle', 520 + Math.random() * 260, 220, 0.06, 0.1, out);
  }
  function flashBang(near) {
    if (!ready) return;
    noise(0.5, near ? 0.95 : 0.5, 'highpass', 1200, 1, 0.42);
    tone('sawtooth', 220, 60, 0.4, 0.28);
    if (near) { // 耳鸣
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = 4200;
      var t = now();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.10, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 4.2);
      o.connect(g); g.connect(master);
      o.start(t); o.stop(t + 4.4);
    }
  }
  function smokePop(dist) {
    if (!ready) return;
    var out = distGain(dist);
    noise(0.25, 0.5, 'bandpass', 900, 1, 0.2, out);
    noise(2.6, 0.22, 'highpass', 2600, 0.8, 2.5, out);   // 持续嘶嘶声
  }
  function buyOk() { if (ready) { tone('square', 660, 990, 0.09, 0.11); } }
  function buyFail() { if (ready) { tone('square', 300, 190, 0.14, 0.11); } }
  function menuOpen() { if (ready) tone('square', 520, 760, 0.05, 0.08); }

  return {
    init: init, resume: resume, setVolume: setVolume,
    shoot: shoot, knifeSwing: knifeSwing, knifeHit: knifeHit,
    impact: impact, fleshHit: fleshHit, hitmark: hitmark, whiz: whiz,
    reload: reload, switchWeapon: switchWeapon,
    footstep: footstep, jump: jump, land: land,
    death: death, pain: pain,
    bombBeep: bombBeep, bombPlant: bombPlant, defuseTick: defuseTick, explode: explode,
    pinPull: pinPull, grenadeThrow: grenadeThrow, grenadeBounce: grenadeBounce,
    flashBang: flashBang, smokePop: smokePop,
    buyOk: buyOk, buyFail: buyFail, menuOpen: menuOpen,
    roundStart: roundStart, win: win, lose: lose, uiClick: uiClick
  };
})();
