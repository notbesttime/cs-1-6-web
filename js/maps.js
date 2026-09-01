/* ============================================================
 *  maps.js — 地图注册表
 *  两个模式（bomb / teamdm）都可以选择任意一张地图
 * ============================================================ */
'use strict';

var MAPS = (function () {
  var maps = [];

  return {
    register: function (id, name, mod) {
      maps.push({ id: id, name: name, module: mod });
    },
    get: function (id) {
      for (var i = 0; i < maps.length; i++) if (maps[i].id === id) return maps[i];
      return maps[0];
    },
    list: function () { return maps; },
    length: function () { return maps.length; }
  };
})();

// 注册两张地图
if (typeof MAP !== 'undefined') MAPS.register('dust2', 'de_dust2', MAP);
if (typeof MAP2 !== 'undefined') MAPS.register('warehouse', '仓库', MAP2);
