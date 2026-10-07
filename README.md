# dsh-tool-jizura

> 给 [DSH](https://github.com/deepseek-ai/deepseek-harness) 用的工具插件：把一段歌词（可附音乐）交给
> [JIZURA](https://852wa.github.io/JIZURA/) 在线应用，自动产出**文字 PV**（MP4 视频或連番 PNG）。

![插件驱动 JIZURA 生成文字 PV](docs/demo.png)

上图是插件实际驱动 JIZURA 之后的界面（无头 Chromium 跑真实流程截取）：
曲名 / 艺术家已填入；音频显示为 `test-beat-120.wav (00:12.00 ・ 約120BPM)`——**BPM 是 JIZURA 检测出来的**；
各行起始时间 0.48 / 2.99 / 4.89 / 7.85 全部咬在 0.5 秒的拍网格上，即**踩点生效**；
右侧「いまの案」显示 スタイル＝ノワール・クロマ、雰囲気＝エモーショナル，
正是 `stylePreset: "dark"` 展开成的样子；構成为 10 カット / レイアウト 9 種。

## 功能

- **自动踩点**：提供背景音乐后，插件会**等待 JIZURA 完成异步 BPM 检测**，让画面切点咬在节拍上，
  并把检测到的 `bpm` / 拍数 / 音频时长回传，方便确认踩点真的生效（而不是以为生效）。
- **情绪 + 强度**：可指定 8 种情绪（`J.MOODS`）与 0~1 的强度，强度会在该情绪自带的区间内线性插值，
  直接驱动 JIZURA 的 13 个效果强度参数（motion / glitch / chroma / texture / density …）。
- **自动段落对比**：按音乐能量包络自动判定每一行的响度，让安静的段落收敛、激烈的段落切得更碎。
- **画质 / 帧率 / 分辨率 / 画幅**：`quality` 决定视频码率（`standard` / `high` / `max`），
  `fps` 可选 24 / 30 / 60，`resolution` 可选 720 / 1080 / 1440 / 2160。
- **主题 / 曲名 / 艺术家 / 绿幕背景 / 随机种子**，以及可复现的确定性输出。
- 遵守 DSH 的取消信号：调用被中止时立即关闭浏览器进程。

## 安装

```bash
dsh plugin --profile web add github:Flooding-Rain/dsh-tool-jizura
```

### 前置依赖

插件依赖 Node.js 侧的 Playwright，**首次使用前请确保浏览器已就绪**：

```bash
npx playwright install chromium
```

## 使用示例

只要歌词：

```jsonc
{ "lyrics": "夜明けの色を/覚えてる\n*透明*なままの街" }
```

带音乐、定向情绪、竖屏：

```jsonc
{
  "lyrics": "夜明けの色を/覚えてる\n*透明*なままの街\n君の名前を呼んだ",
  "audioPath": "D:\\music\\song.mp3",
  "mood": "emotional",
  "theme": "ballad",
  "intensity": 0.7,
  "aspectRatio": "9:16",
  "resolution": 1080,
  "outputDir": "D:\\output\\pv",
  "title": "夜明け",
  "seed": 20261007
}
```

一次完整的手工验证（`dsh` 会话里）：

> 用 generate_jizura_pv 把下面这段歌词做成 16:9 的 MP4，情绪用 emotional，强度 0.7，
> 配上 D:\music\song.mp3，输出到 D:\output\pv
> ```
> 夜明けの色を/覚えてる
> *透明*なままの街
> ```

## 参数

| 参数 | 类型 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `lyrics` | string | ✅ | — | 歌词文本，支持多行。JIZURA 记法（`/` 切分、`*强调*`、`[間奏 8]`、LRC 时间戳）原样可用。 |
| `audioPath` | string | | — | 背景音乐绝对路径。**提供后才会自动踩点。** |
| `title` | string | | — | 曲名，显示在标题卡 / HUD；也会用作输出文件名。 |
| `artist` | string | | — | 艺术家名。 |
| `stylePreset` | string | | `auto` | `auto` \| `light` \| `dark` \| `neon`，展开为 style + mood + intensity 三项。 |
| `styleKey` | string | | — | **直传 JIZURA 的样式 key，优先于 `stylePreset`。**共 27 个，见下节。 |
| `mood` | string | | 随预设 | `glitch` \| `calm` \| `pop` \| `graphic` \| `editorial` \| `emotional` \| `horror` \| `chaos` |
| `theme` | string | | — | `lyricpv` \| `kinetic` \| `wa` \| `horror` \| `pop` \| `ballad`，限定随机取材方向。 |
| `intensity` | number | | 随预设 | `0`~`1`，在该情绪的强度区间内插值。 |
| `paletteLock` | boolean | | `false` | 锁定样式的首套配色，整片不换色。 |
| `autoDynamics` | boolean | | `true` | 按音乐能量做段落对比。仅有音频时有效。 |
| `hideNo` | boolean | | `false` | 隐藏装饰编号（`No.08` 之类）。 |
| `hideTime` | boolean | | `false` | 隐藏装饰时间码（`LINE 08 · 00:36.52` 之类）。 |
| `aspectRatio` | string | | `16:9` | `16:9` \| `9:16` \| `1:1` |
| `resolution` | integer | | `1080` | `720` \| `1080` \| `1440` \| `2160` |
| `fps` | integer | | `24` | `24` \| `30` \| `60`。 |
| `quality` | string | | `high` | `standard` \| `high` \| `max`，决定视频码率。 |
| `outputFormat` | string | | `mp4` | `mp4` \| `png_sequence` |
| `outputDir` | string | | `./jizura-pv-output` | 输出目录绝对路径，不存在会自动创建。 |
| `keyBg` | string | | `off` | `off` \| `green` \| `black`，合成用纯色背景。 |
| `seed` | integer | | — | 随机种子。给定后同样的输入得到可复现的结果。 |

### 预设展开表

| `stylePreset` | JIZURA 样式包 | 情绪 | 强度 |
| --- | --- | --- | --- |
| `light` | `paper`（ペーパー・インク，`#ECE9E3` 亮纸底） | `calm` | 0.35 |
| `dark` | `noir`（ノワール・クロマ，`#060607` 黑底白字） | `emotional` | 0.65 |
| `neon` | `magenta`（ポップ・マゼンタ，`#FF0A8C` 震撼粉） | `pop` | 0.85 |
| `auto` | 不覆盖 | 不覆盖 | 不覆盖 |

`mood` / `intensity` 显式给出时会覆盖上表的推断值。

### 全部 27 个样式（`styleKey`）

`stylePreset` 只展开 3 个常用样式；想用别的就直接传 `styleKey`。基础 12 个：

`noir` `crimson` `caution` `magenta` `paper` `hud` `mint` `specimen` `transit` `blueprint` `rouge` `mono`

扩展 15 个：

`hrRuin` `hrNightRec` `hrCurse` `sakura` `ocean` `sunset` `forest` `vapor` `newsprint` `synth80` `kraft` `candy` `acid` `sumi` `gold`

扩展样式受「追加分 / 和風」开关影响、平时不会被随机选中，但**直传不受限制**。
`styleKey` 无效时忽略并沿用 `stylePreset`；实际生效值可从返回值的 `style` 读到。

### `intensity` 到底调了什么

它在**当前情绪的强度区间**内线性插值，一次驱动 13 个参数。以 `calm` 为例，
`intensity: 0.22` 会得到：

```json
{ "motion": 0.35, "glitch": 0.09, "chroma": 0.27, "decor": 0.27, "density": 0.29,
  "texture": 0.58, "bgSwitch": 0.14 }
```

即 `下限 + (上限 − 下限) × intensity`。同一个 `intensity` 在不同 `mood` 下观感不同。

### `paletteLock` 与 `autoDynamics` 做了什么

- **`paletteLock`**：每个样式含 2~4 套配色，planner 会按 `fx.bgSwitch` 的概率逐行换色
  （`calm` 的区间是 `[0.1, 0.3]`，几十行累积下来仍会跳好几次）。打开后把 `fx.bgSwitch`
  压到 `0`，整片维持首套配色。实测：不锁时 90 个 cut 分属 4 套配色，锁后 **90/90 全在第 0 套**。
- **`autoDynamics`**：算每行平均能量与四分位，以 **planner 自己算出的 cut 数**为基准缩放 ——
  高于 Q3 的行 ×1.5（至少 +1，切得更碎），低于 Q1 的行 ×0.5（收敛），中间档不动。
  能量没有起伏（Q1 == Q3）时整体跳过。

> 早期实现把高低两档写死成 `cuts = 3` / `cuts = 1`，而 planner 依 `fx.density` 与行时长算出的
> 切分常在 4~6 刀 —— **那等于把激烈的段落改慢了**，与「切得更碎」的说法相反。现已改为按基准缩放。

## 返回值

`execute` 返回一个结构化对象（而不是只返回路径），让模型能判断踩点等关键步骤是否真的生效：

```jsonc
{
  "path": "D:\\output\\pv\\夜明け.mp4",
  "bpm": 120,              // JIZURA 检测到的 BPM；0 表示没有音频
  "beatCount": 25,         // 检测到的拍数
  "audioDuration": 12,     // 音频时长（秒）
  "style": "noir",         // 实际生效的样式
  "mood": "emotional",     // 实际生效的情绪
  "intensity": 0.7,        // 实际生效的强度；-1 表示由随机决定
  "seed": 20261007,        // 复现键（回显调用方传入的 seed）
  "aspect": "16:9",
  "resolution": 1080,
  "fps": 24,
  "quality": "high",       // 导出画质档位
  "bytes": 7111804,        // 产物字节数
  "dynamicsApplied": true  // 能量驱动的段落对比是否生效
}
```

界面卡片上会显示成：

```
PV 已生成: D:\output\pv\夜明け.mp4
  画面 16:9 / 1080p / 24fps · 画质 high · 6.8 MB
  样式 noir · 情绪 emotional · 强度 0.70
  踩点 BPM 120 · 25 拍 · 音频 12.0s
  已按音乐能量做段落对比
```

### 非理想结果

| 情况 | 行为 |
| --- | --- |
| 歌词为空 / 纯空白 | 不启动浏览器，返回各字段为零值（`path: ''`），卡片提示「PV 未生成：歌词为空」。 |
| 没有 `audioPath` | 正常出片，但 `bpm: 0`、`dynamicsApplied: false`，卡片显示「未提供音频，本次没有踩点」。 |
| 浏览器启动失败 / 导航超时 / 音频分析超时 / 找不到关键元素 | 抛异常，工具以错误卡片呈现。 |

## 关于 `outputFormat`

- `mp4`：点 JIZURA 的「MP4 を書き出す」，得到单个 `.mp4`。
- `png_sequence`：点「連番PNG（ZIP）」。注意 JIZURA 原生只会打包成**一个 ZIP**，
  因此产物是 `.zip` 而非一堆裸 PNG；需要逐帧图片时自行解压。

## 实现原理：调 API，而不是点 UI

这是本插件与"用 Playwright 点按钮"最本质的区别。JIZURA 把内部状态与算法都挂在 `window.J` 上，
`src/12_ui.js` 结尾处还专门为嵌入式宿主导出了 `J.uiApi`：

```js
J.ui = S;                    // 完整状态对象，S.project 即全部设置
J.uiApi = { toast, replan, syncUI, pause, seek, flushSave, loadAudioFile, restartPreview, exportRange, exportRangeLines };
```

插件用到的接口：

| 接口 | 用途 |
| --- | --- |
| `J.ui.project` | 31 个可读写字段：`style` `mood` `seed` `aspect` `res` `fps` `title` `artist` `keyBg` `themeId` `fx` `timing` `overrides` `enabled` … |
| `J.uiApi.replan()` / `syncUI()` | 改完状态后重排并同步界面 |
| `J.omakase(project, rnd, themeId)` | 「おまかせ」本体；传入自定义 `rnd` 即可用 `seed` 复现 |
| `J.MOODS[mood].fx` | 每种情绪的效果强度**区间**，用于把 `intensity` 插值成 13 个参数 |
| `J.THEMES` | 主题 → 情绪池的映射 |
| `J.analyzeAudio(file)` | 异步解码 + 能量包络 + onset + 自相关求 BPM 与相位 |
| `J.rng(seed)` | mulberry32 随机流，供可复现的 `omakase` 使用 |

只有三件事必须走 DOM：**填歌词**（走真实输入路径，让 JIZURA 自己的处理器刷新行列表）、
**塞音频文件**（文件不适合经 `evaluate` 传递）、**点导出按钮**（导出是 UI 驱动的下载）。

## 上游 JIZURA 的行为（决定怎么调参）

以下结论来自对 JIZURA v0.10.1 读源码 + 实测（一次 3 分 41 秒 FLAC / 1080p 的真实出片），直接影响调用方式。

### 导出长度 = **音频长度**，不是歌词长度

`J.computeTiming()` 末段：提供了音频时，`duration` 取 `max(音频时长, 最后一行结束 + 0.2)`。
所以只写了 57 秒歌词、却给了 221 秒音轨时，导出就是 **221 秒**，后面全是没有 cut 的空白。

**对策**：歌词没铺满音轨时用 `[間奏 N]` 把空隙填掉，否则会出现几十秒空画面。
想知道导出多长，看音频时长而不是歌词行数。

### `|` 注记（note）在多数行不会显示 —— 双语歌词要写成独立时间戳行

`歌詞|注釈` 是官方记法，但 `11p_layoutsA.js:altCopy()` 只在 `cut.text === cut.lineText` 时才用
`note`；而一行通常会被切成多个 cut，每个 cut 只拿到行内一段文本，于是 `note` 被跳过。
**想让译文稳定出现，就得把译文写成独立行并给它显式 LRC 时间戳。**

实测可用的写法（原文 / 译文按 ≈55% / 45% 分配同一句的时长）：

```
[00:08.90]五月雨は/緑色
[00:13.00]绿色的/五月雨
[01:19.90][間奏 11.7]
```

顺带：`J.detectLang()` 里 `kana >= 2` 先于汉字判定，所以日文原文 + 中文译文混排仍判为 `ja`；
简体字会回退到系统字体渲染（实测无豆腐块，观感可接受）。

### `[間奏 N]` 支持小数，也可与 LRC 时间戳同时使用

`[01:19.90][間奏 11.7]` 解析正常（先剥时间戳、再匹配间奏）。间奏 ≥ 6 秒时会顺带显示曲名 / 艺术家小字。

### 输出文件名 = `project.title`

`12_ui.js:baseName()` 用 `title`（非法字符替换为 `_`、截断 60 字），`keyBg` 不为 `off` 时追加
`_greenback` / `_blackback`。插件侧再过一层 `uniquePath()`，重名会追加 `-1`、`-2`。

### 渲染耗时最大的杠杆是 `fx.koma`，不是码率

`fx.koma` 是「每秒画几次」：`0` = 每个输出帧都重绘（最慢），`12` = 每秒 12 次（on twos）。
`ballad` 主题的候选表是 `[0, 0, 12]`，抽到 `0` 的概率 2/3。同样 5309 帧，实测耗时在
335s ~ 454s 之间浮动，主要就来自 mood / 主题决定的 `density` 与 `koma`。

## JIZURA 界面/接口维护说明

上游一旦改动，插件需要跟着改。所有 DOM 依赖集中在 **`src/impl.ts` 的 `SELECTORS`**，
所有内部 API 依赖集中在 **`configureProject()` / `applyDynamics()` 两个 `page.evaluate`** 里。

### 当前依赖的 DOM 选择器

| 用途 | 候选选择器（按优先级） | 来源 |
| --- | --- | --- |
| 引导浮层（兜底） | `#tour` | `<div id="tour" role="dialog" aria-modal="true">` |
| 引导层「スキップ」 | `#tour .tour-skip` → `.tour-skip` | 引导层导航里的跳过按钮 |
| 歌词输入 | `#lyrics` → `textarea` → `[contenteditable="true"]` → `[aria-label*="歌詞"]` → `[aria-label*="歌词"]` | `<textarea id="lyrics">` |
| 音频文件 | `#audioFile` → `input[type="file"][accept*="audio"]` | `<input id="audioFile" type="file">` |
| MP4 导出 | `#eMP4` → `#btnMP4` | `<button id="eMP4">MP4 を書き出す</button>` |
| PNG 序列导出 | `#ePNG` → `#btnPNG` | `<button id="ePNG">連番PNG（ZIP）</button>` |
| 「書き出し」标签页 | `button[role="tab"][data-tab="out"]` | 詳細模式的兜底路径 |

### 四个必须知道的坑

1. **静态模板与实际运行时状态相反。**
   `app/body.html` 里 `#easyPanel` 带 `hidden`、`#modePro` 带 `aria-pressed="true"`，
   看起来默认是「詳細」模式；但实测页面加载完成后 JS 会把默认模式设为**「かんたん」**
   （`#modeEasy[aria-pressed="true"]`、`#easyPanel` 不含 `hidden`），
   此时 `#outAspect` / `#btnMP4` / `#btnPNG` 与各标签页反而是隐藏的。
   **不要照抄 `body.html` 推断初始可见性。**
   本插件因此优先用 `#eMP4` / `#ePNG`，只在找不到时才回退到詳細模式 + 切标签页。

2. **首次访问有全屏引导浮层，会吞掉所有点击。**
   `#tour` 是 `role="dialog" aria-modal="true"` 的遮罩，每次新建浏览器上下文都算首次访问，
   所以**每次调用都会遇到**。不处理它，第一次点击就会失败并报 `... intercepts pointer events`。
   本插件用 `context.addInitScript()` 在页面脚本执行前写入 `localStorage['jizura.tourDone'] = '1'`
   （`12_ui.js` 启动段据此判断），**从源头规避**；点「スキップ」与 `addStyleTag` 只作为兜底。

3. **风格必须在「おまかせ」之后应用。**
   `おまかせ` 会重掷 `style`、`mood`、`fx`、`enabled`（见 `src/08b_omakase.js`）。
   若先设样式再 `omakase`，样式会被随机覆盖。因此 `configureProject()` 的顺序恒为
   「输出设置 → `omakase` 打底 → 显式 style/mood 覆盖 → intensity 插值 → replan」。
   画幅 / 分辨率 / 帧率属于输出设置，不受 `おまかせ` 影响，可以先设。

4. **`overrides[line].cutQuiet` 是死数据，不要用它做按行控制。**
   它看起来正是「让这一行安静下来」的开关，但全仓库只有 `12_ui.js` 读它来渲染一个 `forced`
   标记，**`08_planner.js` 与渲染流程从不读取**，写进去不会有任何效果。
   真正生效的按行控制是 `overrides[line].cuts`（`08_planner.js` 里 `const fixedN = ov.cuts > 0 ? …`）
   与 `overrides[line].single` / `seed` / `lock`。段落对比因此基于 `cuts` 实现。

### 页面/接口变更后的修法

1. 打开 <https://852wa.github.io/JIZURA/>，用开发者工具确认新元素或新 API。
2. **DOM 变了** → 更新 `SELECTORS`（尽量追加候选而非替换，保留兜底）。
3. **API 变了** → 改 `configureProject()` / `applyDynamics()`，注意 `J.ui.project` 的字段名。
4. 若是样式包改名，同步更新 `STYLE_PRESETS`。当前 `#styleGrid` 渲染 **27** 张卡片：
   基础 12 个（`noir` `crimson` `caution` `magenta` `paper` `hud` `mint` `specimen` `transit` `blueprint` `rouge` `mono`）
   加扩展 15 个（`hrRuin` `hrNightRec` `hrCurse` `sakura` `ocean` `sunset` `forest` `vapor` `newsprint` `synth80` `kraft` `candy` `acid` `sumi` `gold`）。
   本插件用到的三个都在基础 12 个内，不受「追加分」开关影响。
5. 跑 `npm test`（用例里的假 DOM 是手写的，不受真实页面影响，仍应全绿）。
6. 用真实页面做一次端到端验证（见下）。

### 端到端自检

```bash
node --input-type=module -e "
import { generateJizuraPv } from './lib/impl.js';
const r = await generateJizuraPv({
  lyrics: '夜明けの色を/覚えてる\n*透明*なままの街',
  audioPath: 'D:/path/to/song.mp3',
  stylePreset: 'dark', mood: 'emotional', intensity: 0.7, autoDynamics: true,
  aspectRatio: '16:9', resolution: 720, fps: 24, outputFormat: 'mp4',
  outputDir: './tmp-verify', keyBg: 'off', seed: 20261007,
});
console.log(r);
if (r.bpm === 0 && r.audioDuration === 0) throw new Error('踩点没有生效，检查音频格式');
"
```

## 开发

```bash
npm install          # 安装开发依赖
npm run build        # tsc -p tsconfig.json → lib/
npm test             # vitest run tests
```

构建产物布局与 `exports` 严格对应：

```
lib/index.js             ← main / exports["."].default
lib/types/index.d.ts     ← types / exports["."].types
lib/impl.js
lib/types/impl.d.ts
```

测试分两层：

- `tests/register.spec.ts` —— 屏蔽 `@deepseek-ai/dsh-tools`，断言 `name`、`inject`
  与工具定义形状（**21 个参数**、枚举与默认值、`output.schema` 的 13 个全 required 字段、
  `render` 的四种分支、`timeoutMs`）符合 dsh 契约。
- `tests/impl.spec.ts` —— 屏蔽 `playwright`，用假 DOM 覆盖：引导浮层的 `addInitScript` 注入、
  等待音频异步分析、预设展开为 style+mood+intensity、显式参数覆盖（含 `styleKey` /
  `paletteLock` / `hideNo` / `hideTime`）、段落对比的开关与缩放系数、结构化返回、
  取消信号清理、空歌词短路、音频超时、导航失败，以及路径辅助函数。

共 **33** 个用例。

## 实测记录

**（一）无音频基线** —— Windows + Chrome Headless Shell 153：

```
SUCCESS (94.1s)
  path: <outputDir>/jizura.mp4
  size: 20423484 bytes      # ftyp isom / isomavc1mp41（H.264）
```

**（二）带音频 + 情绪/强度/段落对比** —— 用合成的 120 BPM 音频（12 秒）：

```
SUCCESS (28.7s)
{
  "bpm": 120,               // 合成源是 120 BPM，检测完全准确
  "beatCount": 25,
  "audioDuration": 12,
  "style": "noir",          // stylePreset: dark → noir
  "mood": "emotional",
  "intensity": 0.7,
  "aspect": "16:9", "resolution": 720, "fps": 24,
  "bytes": 7111804,
  "dynamicsApplied": true
}
```

即「载入音频 → 等 BPM 检测 → 注入样式/情绪/强度 → 按能量做段落对比 → 导出」全程无人工干预。

**（三）画质与帧率的实际影响** —— 同一段素材、同一个 `seed`，只改 `quality` 与 `fps`：

| 配置 | 产物大小 | 编码耗时 |
| --- | --- | --- |
| 720p / 24fps / `standard` | 4,523,934 B | 23.1s |
| 720p / 24fps / `max` | 10,094,872 B（**2.23×**） | 23.8s（1.03×） |
| 720p / 60fps / `max` | 19,931,162 B（**1.97×**） | 45.0s（**1.89×**） |

结论：`quality` 确实改变码率（`max` 约为 `standard` 的 2.2 倍，接近系数比 0.42/0.16），
且对编码耗时几乎无影响；`fps` 翻倍会让体积与耗时都接近翻倍。

> `quality` 并不在 `J.defaultProject()` 里，界面读的是 `S.project.quality || 'high'`。
> 它之所以能用，是因为导出路径把它作为码率档位传给了 `J.videoBitrate()`。上面这组实测就是
> 为了确认"写了真的生效"，而不是只写进了一个没人读的字段。

**（四）全长曲子的真实量级** —— 3 分 41 秒（音轨 221 秒）、720p / 24fps、无头软件编码：

| quality | 目标码率 | 实测码率 | 产物 |
| --- | --- | --- | --- |
| `standard` | 3.54 Mbps | 3.65 Mbps | 100.8 MB |
| `high` | 6.19 Mbps | 6.16 Mbps | 170.0 MB |

同一首曲子 5309 帧的墙钟耗时：**335s ~ 454s**（≈12~16 帧/秒），差异主要来自 mood / 主题决定的
`density` 与 `koma`。由此推算其他配置：

| 配置 | 目标码率 | 221 秒成品 |
| --- | --- | --- |
| 1080p / 30fps / `high` | 17.4 Mbps | ≈ 480 MB |
| 1080p / 30fps / `standard` | 9.95 Mbps | ≈ 275 MB |
| 1080p / 60fps / `high` | 34.8 Mbps | ≈ 960 MB |
| 1080p / 60fps / `max` | 40 Mbps（被 cap） | ≈ 1.1 GB |

一部长 221 秒的歌在 1080p / 60fps 下是 **13 260 帧**、像素量再乘 2.25，按同一速度推算要
**40 分钟以上**（本次 60fps 跑到 30 分钟时中止改 30fps，所以这一行是推算值）。

**这正是把导出等待预算改成按帧数动态估算的原因**：固定 5 分钟连 720p / 24fps 的全长
（≈7 分钟）都盖不住。

## 致谢与许可

- [JIZURA](https://github.com/852wa/JIZURA) 由 **852wa (hakoniwa)** 开发，MIT 许可。
  本插件只是它的自动化外壳，不含其任何代码。
- 本插件以 **MIT** 许可发布，见 [LICENSE](./LICENSE)。
