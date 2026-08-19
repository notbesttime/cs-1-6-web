/* ============================================================
 *  buy.js — CS1.6 风格购买菜单（B 键）
 *
 *  只负责菜单的显示与按键路由，真正的扣钱 / 发枪逻辑在 game.js 的
 *  purchaseItem() 里。菜单数据来自 weapons.js 的 WEAPONS.BUY。
 *
 *  操作：B 打开 → 1~5 选分类 → 1~9 选物品 → 0 / Backspace 返回 → B / Esc 关闭
 *  也可以直接用鼠标点（菜单打开时会释放鼠标锁）
 * ============================================================ */
'use strict';

var BUYMENU = (function () {

  var root = null, titleEl = null, listEl = null, footEl = null;
  var open = false, cat = null;
  var H = null;   // game.js 注入的回调

  function init(hooks) {
    H = hooks;
    root = document.getElementById('buymenu');
    titleEl = document.getElementById('buyTitle');
    listEl = document.getElementById('buyList');
    footEl = document.getElementById('buyFoot');
    if (!root) return;
    listEl.addEventListener('click', function (e) {
      var row = e.target.closest('.buyrow');
      if (!row) return;
      pick(parseInt(row.dataset.key, 10));
    });
  }

  function isOpen() { return open; }

  function setOpen(v) {
    open = !!v;
    if (!root) return;
    root.classList.toggle('hidden', !open);
    if (open) { cat = null; render(); SFX.menuOpen(); }
  }

  function toggle() {
    if (open) { setOpen(false); return; }
    var st = H.buyState();
    if (!st.ok) { SFX.buyFail(); H.notify(st.why); return; }
    setOpen(true);
  }

  function close() { if (open) setOpen(false); }

  /* ---------- 渲染 ---------- */
  function render() {
    if (!root || !open) return;
    var team = H.team();
    var money = H.money();
    titleEl.innerHTML = '购买菜单 <span style="color:#8fdc6a">$' + money + '</span>' +
      '<span style="float:right;color:#9a927e;font-size:12px">' + (team === 'T' ? '恐怖分子' : '反恐精英') + '</span>';

    var html = '';
    if (cat === null) {
      WEAPONS.BUY.forEach(function (c, i) {
        html += '<div class="buyrow" data-key="' + (i + 1) + '">' +
          '<b>' + (i + 1) + '</b><span class="nm">' + c.label + '</span>' +
          '<span class="pr">▸</span></div>';
      });
      footEl.textContent = '数字键选择分类 · [B]/[Esc] 关闭';
    } else {
      var items = cat.items.filter(function (it) { return WEAPONS.itemForTeam(it, team); });
      items.forEach(function (it, i) {
        var price = WEAPONS.priceOf(it);
        var afford = money >= price;
        var own = H.owned(it);
        html += '<div class="buyrow' + (afford ? '' : ' poor') + '" data-key="' + (i + 1) + '">' +
          '<b>' + (i + 1) + '</b>' +
          '<span class="nm">' + WEAPONS.nameOf(it) + (own ? ' <i>' + own + '</i>' : '') + '</span>' +
          '<span class="pr">$' + price + '</span></div>';
      });
      footEl.textContent = '数字键购买 · [0]/[退格] 返回 · [B]/[Esc] 关闭';
    }
    listEl.innerHTML = html;
  }

  /* ---------- 选择 ---------- */
  function pick(n) {
    if (!open || !n) return;
    if (cat === null) {
      var c = WEAPONS.BUY[n - 1];
      if (!c) { SFX.buyFail(); return; }
      cat = c; SFX.uiClick(); render();
      return;
    }
    var items = cat.items.filter(function (it) { return WEAPONS.itemForTeam(it, H.team()); });
    var item = items[n - 1];
    if (!item) { SFX.buyFail(); return; }
    var r = H.buy(item);
    H.notify(r.why);
    if (!r.ok) SFX.buyFail();
    render();
  }

  /* ---------- 键盘路由：返回 true 表示这次按键被菜单吃掉了 ---------- */
  function key(code) {
    if (code === 'KeyB') { toggle(); return true; }
    if (!open) return false;
    if (code === 'Escape') { close(); return true; }
    if (code === 'Backspace' || code === 'Digit0' || code === 'Numpad0') {
      if (cat === null) close(); else { cat = null; SFX.uiClick(); render(); }
      return true;
    }
    var m = /^(?:Digit|Numpad)([1-9])$/.exec(code);
    if (m) { pick(parseInt(m[1], 10)); return true; }
    return false;
  }

  return { init: init, key: key, close: close, isOpen: isOpen, render: render };
})();
