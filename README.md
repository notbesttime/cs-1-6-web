# Counter-Strike 1.6 · 网页版重制

纯前端 3D 射击游戏，浏览器即开即玩，无需安装、无需构建工具。用 Three.js 渲染，
地图、贴图、音效全部由代码程序化生成，不依赖任何外部素材文件。

## 特性

- **爆破模式**：经典 C4 安放/拆除，回合制经济系统，先赢 16 回合获胜。
- **团队竞技**：无限经济，死亡 3 秒后重生，20 秒重生购买窗口，第 3 人称死亡观战。
- **两张地图**：`de_dust2`（经典）和 `仓库`（symmetric 对称布局，4 个包点）。
- **本地多人**：同一台电脑开两个浏览器标签即可分屏对战（LoopbackTransport）。
- **在线联机**：通过 [VibeHub](https://vibe.lumigrav.space) 平台实现 P2P 多人联机，
  支持创建/加入房间、大厅列表、密码保护、跨设备对战。
- **手机适配**：全触屏操作（虚拟摇杆 + 触摸板瞄准 + 开火拖拽压枪），
  可自定义按键布局，支持陀螺仪辅助瞄准。
- **机器人 AI**：A* 寻路 + 视线检测 + 状态机，四档难度，自动按队伍人数补齐。

## 运行（本地）

直接双击 `index.html` 即可（Chrome / Edge / Firefox 等现代浏览器）。
进入主菜单后点「进入战场」，然后点击画面锁定鼠标。

## 在线联机

游戏内置 VibeHub SDK（v3），所有网络逻辑集中在 `js/vibe.js` 和 `js/transport.js`：

1. 首次进入大厅会自动加载 VibeHub SDK（CDN：`vibe.lumigrav.space/sdk/v3/vibehub.js`）。
2. 点击「登录 VibeHub」授权登录（OAuth，无需密码）。
3. 登录后可在大厅**创建房间**（选地图/模式/队伍/人数）或**加入已有房间**。
4. 房间元数据（地图、模式、人数上限、房主）通过 VibeHub `room.announce` 广播到大厅。
5. 进入房间后通过 `room.join` 建立 P2P 连接，房主运行权威模拟，
   每帧广播 15Hz 快照，客户端以 12Hz 回传位姿。

**SDK 初始化方式**：

```javascript
VibeHub.init({ work: 'cs1-6-step-explore' })
```

> 详见 [VibeHub LLMs 文档](https://vibe.lumigrav.space/llms.txt)
> 和 [API Skill](https://vibe.lumigrav.space/api/skill)。

## 玩法

### 爆破模式

- T 进攻：把 C4 安放在包点，守住 40 秒。
- CT 防守：阻止安放或在爆炸前拆除（按住 E；有拆弹器 5 秒，没有 10 秒）。
- 消灭对方全部成员同样赢下回合。先赢到设定回合数获胜。

### 团队竞技

- 无回合限制，死亡 3 秒后自动重生。
- 重生后 20 秒内可购买装备。
- 死亡后切到第 3 人称视角查看尸体，3 秒后重生。
- 同队玩家头顶显示名字（近距离清晰，远距离渐隐），敌方不显示。

## 操作

| 按键 | 功能 | 按键 | 功能 |
|---|---|---|---|
| W A S D | 移动 | 鼠标左键 | 射击 / 投掷手雷 |
| 鼠标 | 瞄准 | 鼠标右键 | AWP 开镜 / 轻抛手雷 |
| Shift | 静步 | Ctrl / C | 下蹲 |
| Space | 跳跃 | R | 换弹 |
| **B** | **购买菜单** | 1 / 2 / 3 | 主武器 / 手枪 / 匕首 |
| **4 / 5 / 6** | **高爆 / 闪光 / 烟雾** | Q、滚轮 | 快速换枪 |
| E | 安放 / 拆除 C4 | Tab | 计分板 |
| Esc | 暂停并释放鼠标 | 阵亡后 左键/空格 | 切换观战对象 |

主菜单里有「左右移动」开关，可以把 A / D 方向对调。

手机端：左侧虚拟摇杆移动，右侧触摸板瞄准，开火按钮支持拖拽控制后坐力方向。
长按「地图」按钮可展开小地图，「设置」可调整灵敏度和触控布局。

## 经济与购买

起始 $800，上限 $16000。回合开始 20 秒内、站在自家出生区且存活时按 `B` 打开购买菜单。

| 收入 | 金额 |
|---|---|
| 击杀 | 步枪 $300 / AWP $100 / 霰弹枪 $900 / 匕首 $1500 |
| 灭队取胜 | $3250 |
| 炸弹爆炸 / 成功拆弹 | $3500 |
| 时间到（CT 守住） | $3250 |
| 输掉回合（连败递增） | $1400 → $1900 → $2400 → $2900 → $3400 |

**活着过回合会保留武器、护甲和拆弹器**，阵亡后下回合回到手枪 + 匕首。

## 机器人

`js/bots.js` 中的机器人使用栅格 A* 寻路 + 视线检测 + 状态机
（推进 / 交火 / 守点 / 安放 / 拆弹 / 听声侦查）。四档难度只改反应时间、
瞄准误差、转身速度、压枪能力与听觉范围。机器人和玩家共用同一套经济与散布模型。

## 文件结构

```
index.html        页面、HUD、购买菜单、大厅/UI、样式
three.min.js      Three.js（本地副本，离线可用）
js/textures.js    程序化贴图（沙墙、沙地、木箱、铁门、弹孔、火焰…）
js/map.js         de_dust2 布局、栅格化建墙、碰撞、射线检测
js/map2.js        仓库地图（对称布局，4 包点）
js/maps.js        地图注册表（dust2 + warehouse）
js/game.js        主循环、玩家、回合/经济、命中判定、特效、HUD、雷达、网络
js/vibe.js        VibeHub SDK 集成层（登录、大厅、房间、announce）
js/net.js         网络同步协议（快照广播、位姿插值、状态机）
js/transport.js   传输层抽象（VibeTransport + LoopbackTransport）
js/bots.js        A* 寻路、角色模型与动画、机器人 AI 与购买决策
js/touch.js       移动端触控（摇杆、触摸板、陀螺仪、布局编辑器）
js/phys.js        角色物理（AABB 碰撞、台阶、加减速与跳跃）
js/audio.js       WebAudio 合成音效
js/weapons.js     武器数值 + 购买表 + 第一人称手部/枪械模型
js/buy.js         购买菜单
js/nade.js        投掷物（抛物线 + 反弹 + 引信）
js/selftest.js    自动化自检
```

## 调试用参数

`index.html?autostart=1&max=3&diff=hard&team=T&size=5` 可跳过菜单直接开局。

`index.html?selftest=1` 会自动开局并跑一遍自检，把 PASS / FAIL 显示在屏幕中央。

## 版本管理

每次部署前打 tag 标记版本，出错时可回退到指定版本再重新部署：

```bash
git tag -a v1.0 -m "仓库地图 + 团队竞技 + 移动端上线"
git push origin v1.0
```

回退到指定版本：

```bash
git checkout v1.0
# 修改完重新部署到 VibeHub
```

## 项目平台

本项目开发时使用了 [VibeHub](https://vibe.lumigrav.space) 平台：
- **代码托管**：VibeHub Workspace（本地协作）
- **在线部署**：VibeHub Deploy（浏览器直接访问）
- **P2P 联机**：VibeHub SDK（WebRTC + 中继）
- **源码备份**：[GitHub](https://github.com/notbesttime/cs-1-6-web)

## License

仅供学习交流，请勿用于商业用途。