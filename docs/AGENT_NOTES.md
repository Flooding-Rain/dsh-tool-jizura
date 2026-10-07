# Agent 出片实录：长曲 / 高帧率下暴露的问题与改动

> **本文件是历史实录，保留原始结论供追溯。** §0~§2 的改动与 §5 的建议已在后续提交中处理，
> 处理方式见下表；§3 的上游行为结论已固化进 [README 的对应章节](../README.md#上游-jizura-的行为决定怎么调参)。
>
> | 原提议 | 最终落地 |
> | --- | --- |
> | §1 超时抬到 6 小时 | 改为**按 plan 帧数动态估算**（`帧数 × 400ms`，夹在 5 分钟 ~ 6 小时之间），`timeoutMs` 仍取 6 小时作硬上限 |
> | §2 `paletteLock` 截断 `J.STYLES[].schemes` | 改用 **`fx.bgSwitch = 0`**：实测锁色效果与截断完全一致（90/90 个 cut 都在第 0 套），但没有破坏性全局副作用 |
> | §5.5 `autoDynamics` 档位与文案不符 | 已改为**按 planner 算出的 cut 数缩放**（高能量 ×1.5 且至少 +1，低能量 ×0.5，中间档不动） |
> | §5.1 `styleKey` 直传 | 已实现 |
> | §5.4 `hideNo` / `hideTime` | 已实现 |
> | §5.6 耗时说法过期 | 已更新工具 description 与 README 实测表 |
> | §5.3 `exportRange`、§5.2 进度回传 | **未做**，仍待实现 |
>
> ---
>
> 本文件由一次真实调用产生：把《初恋》（村下孝蔵，FLAC 3:41）做成歌词 MV，
> 要求 1080p、含 LRC 时间轴 + 日文原文 + 中文译文。
> 目的是把「调用方遇到的坑 + 已经改好的代码」交给下一个会话，直接 review / 优化 / 上传。
>
> - 插件：`dsh-tool-jizura`（本仓库）
> - 上游：JIZURA **v0.10.1**（`852wa/JIZURA`，commit `fc16bfe`）
> - 环境：Windows 10/11、Node v24.21.0、playwright 1.63.0、TypeScript 7.0.2
> - 调用方式：会话里**没有**注册 `generate_jizura_pv` 工具，因此直接
>   `import { generateJizuraPv } from '<repo>/lib/impl.js'` 调用（等于走的是同一份实现）

---

## 0. 需要 review / 合并的改动（TL;DR）

| # | 文件 | 改动 | 为什么 |
| --- | --- | --- | --- |
| 1 | `src/impl.ts` | `DOWNLOAD_TIMEOUT_MS` `300_000` → `21_600_000` | 5 分钟的「等下载事件」超时只够短曲，全长 1080p 会在编码完成前被判超时 |
| 2 | `src/index.ts` | 工具 `timeoutMs` `300_000` → `21_600_000` | 同上，工具层的上限也要跟着抬，否则通过 DSH 工具调用依然会超时 |
| 3 | `src/impl.ts` + `src/index.ts` | 新增参数 `paletteLock`（boolean，默认 `false`） | JIZURA 每个样式自带 2~4 套配色，画面会逐行跳色；抒情向作品需要锁定单一色调 |
| 4 | `tests/register.spec.ts` | 参数表补 `paletteLock`、`timeoutMs` 断言改为 `21600000` | 跟随上面两条 |
| 5 | `lib/**` | 用 `node node_modules/typescript/bin/tsc -p tsconfig.json` 重新构建 | `lib/` 是刻意提交进仓库的产物，必须与 `src/` 同步 |

`git diff --stat`（改完后的实际状态）：

```
 lib/impl.js            | 19 +++++++++++++++++--
 lib/index.js           |  9 ++++++++-
 lib/types/impl.d.ts    | 10 ++++++++++
 src/impl.ts            | 31 ++++++++++++++++++++++++++++---
 src/index.ts           | 10 +++++++++-
 tests/register.spec.ts |  6 +++++-
```

测试：`node node_modules/vitest/vitest.mjs run` → **33 passed / 2 files**（改动前后都跑过）。

> 注意：本机 PowerShell 禁止运行 `npm.ps1`（ExecutionPolicy），所以上面用的是
> `node node_modules/typescript/bin/tsc` 与 `node node_modules/vitest/vitest.mjs`，
> 而不是 `npm run build` / `npm test`。仓库脚本本身没问题。

---

## 1. 问题一：导出等下载的超时太短（必须改）

### 现象

用 720p / 24fps 跑 3 分 41 秒的歌（音轨 221 秒）成功；但一旦升到 1080p / 60fps，
按插件原有的 `DOWNLOAD_TIMEOUT_MS = 300_000` 推算，几乎必然在编码结束前抛超时。

### 证据

JIZURA 的导出是**浏览器内逐帧绘制 + WebCodecs 编码**，下载事件只在最后一个字节编码完后才触发。
本次实测（无头软件编码、单机）：

| 配置 | 输出帧数 | 墙钟耗时 | 速度 |
| --- | --- | --- | --- |
| 720p / 24fps / `standard` | 5 309 | 335 s | ≈ 16 帧/秒 |
| 720p / 24fps / `high` | 5 309 | 454 s | ≈ 12 帧/秒 |
| 720p / 24fps / `high` + `paletteLock` | 5 309 | 408 s | ≈ 13 帧/秒 |

一部长 221 秒的歌在 1080p / 60fps 下是 **13 260 帧**、像素量再乘 2.25，
按同一速度推算要 **40 分钟以上**（本次 60fps 跑到 30 分钟时按用户要求中止、改 30fps）。
5 分钟的上限连 720p / 24fps 的全长（≈ 7 分钟）都盖不住。

### 改法

`src/impl.ts`：

```diff
-/** 等待导出下载开始的超时（JIZURA 在浏览器内逐帧编码，耗时较长）。 */
-const DOWNLOAD_TIMEOUT_MS = 300_000;
+/**
+ * 等待导出下载开始的超时（JIZURA 在浏览器内逐帧编码，耗时较长）。
+ *
+ * 5 分钟只够一首短曲：全长 1080p / 60fps（约 13000 帧）在无头软件编码下要几十分钟，
+ * 因此放宽到 90 分钟，让长曲也能走完整流程而不是在下载事件之前被判超时。
+ */
+const DOWNLOAD_TIMEOUT_MS = 21_600_000;
```

实际取的是 **6 小时**（`21_600_000`），注释里的「90 分钟」是中途一版的说辞，**建议一并改成
6 小时 / 按「帧数」估算的动态值**，别留错误的数字。二选一：

- 保守：注释改成 6 小时；
- 更好：按 `plan.duration × fps` 估一个上限，例如
  `Math.max(600_000, frames * 400)`，把「每分钟 60 秒」换成「每帧 400 ms」这种可解释的量。

### 顺带

`src/index.ts` 的工具 `timeoutMs` 也要改（同值），否则通过 DSH 工具调用时仍是 5 分钟：

```diff
-      timeoutMs: 300_000,
+      timeoutMs: 21_600_000,
```

---

## 2. 问题二：样式自带多套配色，画面逐行跳色（新增 `paletteLock`）

### 现象

用 `stylePreset: 'light'`（展开为 `paper`）做抒情歌，画面在**纸白 / 近黑 / 洋红 / 深蓝**之间跳：

- 4 s：纸白底 + 蓝墨「初恋」标题卡（很好看）
- 13.5 s：整屏洋红 `#C2185B` + 白字
- 20.5 s：洋红 + 深蓝小字条

对「回忆 / 感伤」这种需要统一调性的作品，跳色把意境打散了。

### 根因

`JIZURA:src/04_styles.js` 里每个样式是**一组**配色：

```js
paper: {
  schemes: [
    { bg: '#ECE9E3', fg: '#1B2350', accent: '#C2185B', ... },  // 纸白
    { bg: '#151515', ... },                                     // 近黑
    { bg: '#C2185B', ... },                                     // 洋红   ← 观感来源
    { bg: '#1B2350', ... },                                     // 深蓝
  ],
  ...
}
```

`JIZURA:src/08_planner.js` 的逐行换色（v0.10.1 约在 `J.plan` 的 scheme per line 处）：

```js
if (nSchemes > 1 && li > 0 && (U ? ... : rng.chance(fx.bgSwitch * (ln.impact ? 1.8 : 1))))
  schemeIdx = (schemeIdx + 1 + rng.int(0, nSchemes - 2)) % nSchemes;
```

`fx.bgSwitch` 由情绪 + `intensity` 插值而来。`calm` 的区间是 `[0.1, 0.3]`，
即使把 `intensity` 压到 `0.22`（→ `bgSwitch = 0.14`），几十行累积下来仍然要换好几次。
`J.resolveStyle()` 只在 `colors.enabled` 时替换 `schemes[0]`，**管不到其余几套**，
所以靠 `project.colors` 也锁不住。

### 改法：`paletteLock`

在 `configureProject()` 的 eval 里、`replan()` 之前，把当前样式的配色表截断成 1 套：

```ts
// ---- 配色锁定：只保留该样式的第一套配色 ----
// planner 在 `nSchemes > 1` 时按 `fx.bgSwitch` 的概率换色；截断成 1 套即彻底不换，
// 整片维持同一色调（回忆向的作品比跳色更连贯）。
if (cfg.paletteLock) {
  const styles = J.STYLES;
  const spec = styles && styles[String(P['style'] ?? '')];
  if (spec && Array.isArray(spec.schemes) && spec.schemes.length > 1) spec.schemes.length = 1;
}
```

配套改动：`JizuraPvRequest.paletteLock?`、`ConfigureOptions.paletteLock`、
`GenerateJizuraPv` 里 `paletteLock: request.paletteLock ?? false`、
工具参数定义与 `execute` 转发、以及 `J` 的类型声明加 `STYLES?: Record<string, { schemes?: unknown[] }>`。

### 验证（探针脚本，不需要整片渲染）

| | `schemesAvailable` | 144 个 cut 的配色分布 |
| --- | --- | --- |
| `paletteLock: false` | 4 | 混用 |
| `paletteLock: true` | 1 | `{ "0": 144 }` |

### ⚠️ 风险，请在这里做决定

截断 `J.STYLES[style].schemes` 是**破坏性**的全局改动，同一页面内不可逆。
当前实现之所以安全，只因为 `generateJizuraPv()` **每次调用都新建 browser context**
（`browser.newContext()`）。如果以后有人复用 page（批量出片、常驻浏览器），
第二次调用拿到的就是被截断过的样式表。

三个候选方向，按稳妥程度排序：

1. **提 issue 给上游**，请 JIZURA 支持 `project.colors.lock = true`（在 `resolveStyle` 里
   把 schemes 收敛成一套）——最干净；
2. 插件侧改成**先深拷贝、用完还原**：截断前 `const keep = spec.schemes.slice()`，
   在 `finally` 里恢复（需要把 `styles` 引用回传出来）；
3. 保持现状，但在 `paletteLock` 的 JSDoc 里写明「依赖每次新建 context」。

---

## 3. 上游 JIZURA 的行为（没改代码，但直接决定调用方式）

这一节是本次为了做双语歌词翻了 v0.10.1 源码 + 实测得到的结论，**建议补进 README**。

### 3.1 导出长度 = **音频长度**，不是歌词长度

`JIZURA:src/08_planner.js:J.computeTiming()` 末段（原文节选）：

```js
let duration = (ends.length ? ends[ends.length - 1] : 3) + (T.tail ?? 0.9);
if (audio && audio.duration && T.useAudioLength !== false)
  duration = Math.max(audio.duration, ends.length ? ends[ends.length - 1] + 0.2 : 1);
```

实测：只写了 57 秒的歌词，但提供的音轨是 221 秒 → 导出出来**就是 221 秒**，
后面的时间是「没有 cut 的空白」。所以：

- 歌词没铺满音轨时，**必须用 `[間奏 N]`（或带时间戳的 `[mm:ss.xx][間奏 N]`）把空隙填掉**，
  否则会出现几十秒的空画面；
- 想知道「导出多长」，看音频时长而不是歌词行数。

### 3.2 `|` 注记（note）在大多数行**不会显示**，双语只能靠「独立时间戳行」

README 写的 `歌詞|注釈` 是官方记法，但实测它的可见性很差：

- `JIZURA:src/11p_layoutsA.js:altCopy()`：只有当 `cut.text === cut.lineText` 时才用 `note`，
  否则优先显示整行原文；
- 而一行会被切成多个 cut（`nC = round(D / L)`，`L = lerp(1.3, 0.5, fx.density)`），
  多 cut 行的每个 cut 只拿到行内一段文本，`text !== lineText`，于是 `note` 被跳过；
- 只有极短、只切出 1 段的行才会走到 `note`。

**结论：想让译文稳定出现，就得把译文写成独立行，并给它显式 LRC 时间戳。**

本次采用的做法（原文 / 译文按同一句时长 ≈ 55% / 45% 分配）：

```
[00:08.90]五月雨は/緑色
[00:13.00]绿色的/五月雨
[00:16.36]悲しくさせたよ/一人の午後は
[00:20.52]染出无限悲伤，/寂寞一人的下午
...
[01:19.90][間奏 11.7]
```

- `/` 用来把一句切成**语义完整的段落**，让每个 cut 的文本边界落在词与词之间
  （`parseLyrics` 会把 `/` 存成 `manual`，planner 直接用 `ln.manual` 当 chunks）；
- 每行都带显式时间戳 → `computeTiming()` 全部走 `fixed`，不再估算、不会互相挤压；
- 语言检测不受译文影响：`J.detectLang()` 里 `kana >= 2` 先于汉字判定，
  所以日文原文 + 中文译文混排仍稳定判为 `ja`（实测 `ja`），
  简体中文用日文字体渲染时会**回退到系统字体**，混排观感可接受（见 §5 的抽帧结果）。

### 3.3 `[間奏 N]` 支持小数，也支持与 LRC 时间戳同时使用

```js
const im = s.match(/^\[\s*(間奏|间奏|interlude|instrumental|inst|간주)(?:\s*[:：]?\s*(\d+(?:\.\d+)?)\s*(?:s|sec|秒|초)?)?\s*\]$/i);
```

`[01:19.90][間奏 11.7]` 解析正常（先剥时间戳、再匹配间奏）。间奏长度 ≥ 6 秒时
会顺带显示曲名 / 艺术家小字（`JIZURA:src/08_planner.js` 的 interlude 分支）。

### 3.4 输出文件名 = `project.title`

`JIZURA:src/12_ui.js:baseName()`：

```js
function baseName() {
  const k = J.keyMode(S.project);
  return ((S.project.title || 'jizura').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'jizura')
       + (k ? (k === 'green' ? '_greenback' : '_blackback') : '');
}
```

所以传 `title: '初恋'` 就会得到 `初恋.mp4`；插件侧再过一层 `uniquePath()`，
重名会追加 `-1`、`-2`（本次预演第二次跑就拿到了 `初恋-1.mp4`）。

### 3.5 码率公式与实测吻合，可用于估算体积

`JIZURA:src/11_export.js`：

```js
J.videoBitrate = (w, h, fps, quality) => {
  const want = w * h * fps * (quality === 'max' ? 0.42 : quality === 'high' ? 0.28 : 0.16);
  const px = w * h, cap = px <= 2.2e6 ? 40e6 : px <= 3.8e6 ? 60e6 : 90e6;
  return Math.round(Math.min(want, cap));
};
```

实测（720p / 24fps）：

| quality | 目标码率 | 实测码率 | 文件 |
| --- | --- | --- | --- |
| `standard` | 3.54 Mbps | 3.65 Mbps | 100.8 MB / 221 s |
| `high` | 6.19 Mbps | 6.16 Mbps | 170.0 MB / 221 s |

推论（用于选型）：

| 配置 | 目标码率 | 221 秒的成品大小 |
| --- | --- | --- |
| 1080p / 60fps / `high` | 34.8 Mbps | ≈ 960 MB |
| 1080p / 60fps / `max` | 40 Mbps（cap） | ≈ 1.1 GB |
| **1080p / 30fps / `high`** | 17.4 Mbps | ≈ 480 MB |
| 1080p / 30fps / `standard` | 9.95 Mbps | ≈ 275 MB |

（这也是本次最后按用户要求把 60fps 改成 30fps 的另一个好处：体积直接减半。）

### 3.6 渲染耗时最大的杠杆其实是 `koma`，不是码率

`README` 已说明 `quality` 对耗时几乎无影响；本次补充一条更关键的：

- `fx.koma` 是「每秒画几次」的步长，`0` = 每个输出帧都重绘（最慢），`12` = 每秒 12 次（on twos）；
- `ballad` 主题的 koma 候选表是 `[0, 0, 12]`（`JIZURA:src/08b_omakase.js:J.THEMES.ballad`），
  抽到 `0` 的概率 2/3；
- 本次三轮 720p 预演耗时差异（335 / 454 / 408 秒，同样是 5 309 帧）主要来自 mood / 主题不同
  导致的 `density`（cut 数）与 `koma` 差异。

**如果想快**：给插件加一个 `smooth` / `koma` 相关开关，或让主题候选偏向 `12`。

---

## 4. 本次实际使用的参数（可直接复现）

```jsonc
{
  "lyrics": "<见 §3.2 的双语 LRC>",
  "audioPath": "D:\\JIZIRA\\初恋 - 村下孝蔵.flac",
  "stylePreset": "light",     // → paper（紙の質感・藍とマゼンタ・明朝の残像）
  "mood": "calm",             // 覆盖预设的 calm：沉静、不抢戏
  "theme": "ballad",          // 抒情：mood 池限 calm/emotional
  "intensity": 0.22,          // 低强度：少装饰、低故障感
  "autoDynamics": true,
  "paletteLock": true,        // 新增：锁定纸白 × 蓝墨
  "aspectRatio": "16:9",
  "resolution": 1080,
  "fps": 30,
  "quality": "high",
  "outputFormat": "mp4",
  "outputDir": "D:\\JIZIRA",
  "title": "初恋",
  "artist": "村下孝蔵",
  "keyBg": "off",
  "seed": 20261007
}
```

展开后的 `fx`（探针读回，`intensity = 0.22` 在 `calm` 区间插值）：

```json
{ "motion": 0.35, "glitch": 0.09, "chroma": 0.27, "decor": 0.27, "density": 0.29,
  "texture": 0.58, "flash": true, "onTwos": false, "koma": 0, "hud": "auto",
  "bgSwitch": 0.14, "hideNo": false, "hideTime": false }
```

音频分析结果：**BPM 127.5 / 469 拍 / 221.16 秒**（FLAC 直接被 Chromium 解码，无需转码，
25 MB 的文件也能吃下）。

---

## 5. 建议的后续优化（按价值排序）

1. **`stylePreset` 只有 3 个档，而 JIZURA 有 27 个样式。**
   想要 `specimen`（墨色/纸 · 明朝 · 辞书注记）、`sakura`、`sunset`（夕焼けグラデ）、
   `kraft`、`sumi` 这类明显更贴题的选择时无路可走。
   建议二选一：加 `styleKey?: string` 直传（配合 `J.STYLE_ORDER` 校验），
   或把 `STYLE_PRESETS` 扩成一张表（注意扩展样式受 `extra` / `wa` 开关影响）。
2. **长任务没有中间输出。** 一次调用 20 分钟，调用方无法区分「在编码」和「卡死」。
   建议：`triggerExport` 前打印 plan 摘要（cut 数、时长、帧数、码率估算），
   并把 `runExport` 的 `onProgress`（`JIZURA:src/12_ui.js` 已经在更新进度条）
   通过 CDP / `page.on('console')` 或 `exposeFunction` 回传。
3. **支持 `exportRange`。** 预演阶段想只看 20 秒，目前只能改歌词或剪音频
   （而插件从不调用 `J.uiApi.exportRange`）。JIZURA 侧已具备该能力
   （`J.uiApi.exportRange` / `exportRangeLines`），接上来就能把「试错一次 = 7 分钟」
   降到「一次 = 30 秒」。
4. **`hideNo` / `hideTime`。** paper 系布局会带 `No.08`、`LINE 08 · 00:36.52` 这类编号与时间码，
   抒情歌里略显「工程感」。`fx.hideNo` / `fx.hideTime` 已存在，只是插件没暴露。
5. **`autoDynamics` 的档位与文案不符。** README 写「激烈的段落切得更碎」，实现是
   `quiet → cuts = 1`、其余一律 `cuts = 3`（`DYNAMICS_LOUD_CUTS = 3`）。
   而 planner 自动算出来的行内切分常常是 4~6 刀，所以这个开关实际上把画面**变慢**了。
   建议改成按能量分档（1 / 2 / 3 / 4）或在不指定 `cuts` 时保留自动值。
6. **README / 工具 description 的耗时说法过期。** 工具描述写「渲染耗时可能超过 60 秒」，
   实际全长 1080p 是**几十分钟**量级；README 的实测表只有 12 秒 / 720p 的样本。
   把 §1 的耗时表与 §3.5 的体积表补进去，调用方才能选参数。
7. **`paletteLock` 的单测缺失。** `tests/impl.spec.ts` 的假 DOM 里没有 `J.STYLES`，
   目前只有 `tests/register.spec.ts` 断言了参数形状；建议补一条 eval 分支的断言
   （假 J 上加 `STYLES: { paper: { schemes: [{}, {}] } }`，断言截断后长度为 1）。
8. **音频预处理（可选）。** 25 MB FLAC 直接送进浏览器可行，但 `decodeAudioData`
   会把整首歌解成 PCM 常驻内存。若将来支持批量出片，建议提示或转码成 mp3/m4a。

---

## 6. 本次用到的验证工具（建议收进 `dev/`）

`.research/` 下有三个一次性脚本，都很有复用价值：

| 脚本 | 作用 |
| --- | --- |
| `probe.mjs` | 只开页面 + 填词 + `configureProject`，读回 `J.parseLyrics` / `J.computeTiming` / `detectLang` / plan 的 cut–layout–scheme 分布。**30 秒级验证，别用整片渲染试参数。** |
| `grab.mjs` | 从导出的 MP4 抽帧：用 Chromium 的 `<video>` + canvas（见下面的原因）。 |
| `render.mjs` | 正式/预演两档参数的调用脚本。 |

### 两个 Windows 上的坑

1. **playwright 自带的 `ffmpeg-win64.exe` 是精简构建，读不了 MP4。**
   `--disable-everything` 只启用了 `matroska,webm` demuxer + libvpx/png，
   对它执行 `ffmpeg -i x.mp4` 会报 `Invalid data found when processing input`
   （和文件损坏长得一模一样，很容易误判）。抽帧请改用 Chromium：
   把 `<video src="file:///...">` 写进一个 HTML，`page.goto(file://...)` 打开
   （用 `page.setContent` 会因 about:blank 的跨源策略导致 `readyState = 0`），
   seek 后 `canvas.drawImage` + `toDataURL` 落盘。
2. **脚本要能被 Node 解析到 `playwright`**：ESM 从**脚本所在目录**向上找 `node_modules`，
   所以脚本要放在本仓库根目录（或 import 绝对 `file://` 路径）才能跑，
   仅设置 `workdir` 无效。

---

## 7. 已知风险 / 没做完的事

- **60fps 全长没有跑完。** 跑到约 30 分钟时按用户要求改成 30fps 重跑，所以
  「1080p / 60fps 的真实耗时与体积」在本文里是**推算值**（≈ 40 分钟 / ≈ 960 MB），
  不是实测值。§1 的耗时表是 720p 实测。
- **`paletteLock` 的不可逆截断**：见 §2 的「风险」小节，需要决定采用哪种方案。
- **中文简体的字体回退**：`lang` 判为 `ja`，简体字靠系统字体回退渲染。
  本次抽帧确认**没有豆腐块、观感可接受**，但如果目标观众更在意字形统一，
  可以考虑给插件加 `lang` 参数（`JIZURA:src/02b_lang.js` 支持 `auto|ja|zh-Hant|zh-Hans|ko`）。

---

## 8. 临时文件的处置

出片过程中在仓库根目录留过三个临时文件，**已全部删除**，`git status` 现在是干净的：

```
dsh-tool-jizura/grab.tmp.mjs      # 抽帧脚本的临时副本（见 §6）
dsh-tool-jizura/probe.tmp.mjs     # 探针脚本的临时副本（见 §6）
dsh-tool-jizura/nolock            # 探针早期版本误写出的空文件
```

如果想把 §6 的两个工具正式收进 `dev/`，按那一节记的要点重写即可
（`file://` + `page.goto` + canvas 抽帧；脚本必须放在仓库根目录才能解析到 `playwright`）。
