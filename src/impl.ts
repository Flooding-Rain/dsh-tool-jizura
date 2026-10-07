/**
 * `generate_jizura_pv` 的浏览器自动化实现。
 *
 * 设计取向：**通过 JIZURA 暴露的宿主 API 精确控制，而不是模拟点击界面按钮。**
 * JIZURA 把内部状态和算法都挂在 `window.J` 上（`J.ui.project` / `J.uiApi` /
 * `J.MOODS` / `J.omakase` / `J.analyzeAudio` …），直接操作它们比点 UI 更精确、
 * 更少竞态，也能拿到 BPM、命中样式等可验证的结果。
 *
 * 该模块不依赖 dsh 运行时，可以脱离宿主单独测试。
 *
 * @module dsh-tool-jizura/impl
 */

import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Download, Page } from 'playwright';

/** JIZURA 在线应用地址。 */
export const JIZURA_URL = 'https://852wa.github.io/JIZURA/';

/** 视觉风格预设（与本插件原有的向后兼容参数）。 */
export type StylePreset = 'auto' | 'light' | 'dark' | 'neon';

/** 情绪，对应 JIZURA 的 `J.MOODS`。 */
export type Mood = 'glitch' | 'calm' | 'pop' | 'graphic' | 'editorial' | 'emotional' | 'horror' | 'chaos';

/** 主题，对应 JIZURA 的 `J.THEMES`。 */
export type Theme = 'lyricpv' | 'kinetic' | 'wa' | 'horror' | 'pop' | 'ballad';

/** 输出画幅比例。 */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/** 输出分辨率（高度）。 */
export type Resolution = 720 | 1080 | 1440 | 2160;

/** 输出帧率。 */
export type Fps = 24 | 30 | 60;

/** 输出格式。 */
export type OutputFormat = 'mp4' | 'png_sequence';

/** 合成用背景。 */
export type KeyBackground = 'off' | 'green' | 'black';

/**
 * 导出画质档位，决定视频码率。
 *
 * JIZURA 按 `宽 × 高 × 帧率 × 系数` 估算目标码率（standard 0.16 / high 0.28 / max 0.42），
 * 再按像素量封顶（≤2.2MP 时 40 Mbps、≤3.8MP 时 60 Mbps、更大 90 Mbps）——因为硬件编码器
 * 常常拒绝过高码率。所以 1080p60 选 `max` 实际会落在 40 Mbps 而不是 52 Mbps。
 */
export type ExportQuality = 'standard' | 'high' | 'max';

/** 一次 PV 生成请求。 */
export interface JizuraPvRequest {
  /** 歌词文本，支持多行。 */
  readonly lyrics: string;
  /** 背景音乐文件的绝对路径。提供后会自动踩点。 */
  readonly audioPath?: string | undefined;
  /** 视觉风格预设。 */
  readonly stylePreset: StylePreset;
  /** 情绪；显式指定时覆盖「おまかせ」抽到的情绪。 */
  readonly mood?: Mood | undefined;
  /** 主题；交给 JIZURA 的 `J.omakase` 使用，限定抽取方向。 */
  readonly theme?: Theme | undefined;
  /** 效果强度 0..1，在该情绪的 `fx` 区间内插值；省略则由「おまかせ」决定。 */
  readonly intensity?: number | undefined;
  /** 是否用音频能量包络自动做段落对比（高能量行切得更碎）。 */
  readonly autoDynamics: boolean;
  /**
   * 是否锁定样式的**首套配色**。
   *
   * JIZURA 的每个样式含 2~4 套配色，画面默认会在行与行之间换色（由 `fx.bgSwitch` 控制概率）。
   * 打开后把 `fx.bgSwitch` 压到 0，整片维持同一色调，适合需要统一意境的抒情作品。
   *
   * 实测 `bgSwitch = 0` 与「截断 `J.STYLES[style].schemes`」得到的 scheme 分布完全一致
   * （90 个 cut 全部落在第 0 套），但前者是非破坏性的 —— 截断会永久改写页面内的全局样式表，
   * 一旦复用 page（批量出片）就会污染后续调用。
   */
  readonly paletteLock?: boolean | undefined;
  /**
   * 直接指定 JIZURA 的样式 key（如 `specimen` / `sakura` / `sumi`），优先于 `stylePreset`。
   *
   * `stylePreset` 只覆盖 3 个常用样式，而 JIZURA 内置 27 个。key 无效时忽略并沿用预设。
   */
  readonly styleKey?: string | undefined;
  /** 是否隐藏画面上的装饰编号（`No.08` 之类）。 */
  readonly hideNo: boolean;
  /** 是否隐藏画面上的装饰时间码（`LINE 08 · 00:36.52` 之类）。 */
  readonly hideTime: boolean;
  /** 输出画幅比例。 */
  readonly aspectRatio: AspectRatio;
  /** 输出分辨率。 */
  readonly resolution: Resolution;
  /** 输出帧率。 */
  readonly fps: Fps;
  /** 导出画质档位。 */
  readonly quality: ExportQuality;
  /** 输出格式。 */
  readonly outputFormat: OutputFormat;
  /** 输出目录的绝对路径；省略时使用工作目录下的 `jizura-pv-output`。 */
  readonly outputDir?: string | undefined;
  /** 曲名，显示在标题卡 / HUD。 */
  readonly title?: string | undefined;
  /** 艺术家名。 */
  readonly artist?: string | undefined;
  /** 合成用背景。 */
  readonly keyBg: KeyBackground;
  /** 随机种子；给定后同一份输入会得到可复现的结果。 */
  readonly seed?: number | undefined;
  /** 取消信号；触发时立即关闭浏览器进程。 */
  readonly signal?: AbortSignal | undefined;
}

/** 一次 PV 生成的结果。 */
export interface JizuraPvResult {
  /** 产物文件的绝对路径；空串表示未生成（如歌词为空）。 */
  readonly path: string;
  /** JIZURA 检测到的 BPM；无音频时为 0。确认踩点是否真的生效看这个。 */
  readonly bpm: number;
  /** 检测到的拍数。 */
  readonly beatCount: number;
  /** 音频时长（秒）；无音频时为 0。 */
  readonly audioDuration: number;
  /** 实际生效的样式 key。 */
  readonly style: string;
  /** 实际生效的情绪 key。 */
  readonly mood: string;
  /** 实际生效的强度 0..1；-1 表示交由「おまかせ」决定。 */
  readonly intensity: number;
  /** 实际使用的随机种子。 */
  readonly seed: number;
  /** 画幅。 */
  readonly aspect: string;
  /** 分辨率高度。 */
  readonly resolution: number;
  /** 帧率。 */
  readonly fps: number;
  /** 导出画质档位；空串表示未生成。 */
  readonly quality: string;
  /** 产物字节数；未生成时为 0。 */
  readonly bytes: number;
  /** 能量包络驱动的段落对比是否生效。 */
  readonly dynamicsApplied: boolean;
}

/**
 * 页面选择器表（只保留真正需要走 DOM 的部分）。
 *
 * JIZURA 的界面由 `src/12_ui.js` 在运行时绘制，下面每项按「优先精确 id，其次通用特征」
 * 排序；探测时逐个尝试。维护方式见 README。
 */
export const SELECTORS = {
  /**
   * 首次访问的新手引导浮层。它是 `role="dialog" aria-modal="true"` 的全屏遮罩，
   * 会吞掉整页点击。正常情况下已由 `TOUR_DONE_INIT_SCRIPT` 从源头规避，这里只作兜底。
   */
  tour: ['#tour'],
  /** 引导浮层里的「スキップ」按钮。 */
  tourSkip: ['#tour .tour-skip', '.tour-skip'],
  /** 歌词输入框：`#lyrics` 是 JIZURA 的真实 id，其余为通用兜底。 */
  lyricsInput: [
    '#lyrics',
    'textarea',
    '[contenteditable="true"]',
    '[aria-label*="歌詞"]',
    '[aria-label*="歌词"]',
  ],
  /** 音频文件输入。 */
  audioInput: ['#audioFile', 'input[type="file"][accept*="audio"]'],
  /** MP4 导出按钮：かんたん模式 / 詳細模式。 */
  exportMp4: ['#eMP4', '#btnMP4'],
  /** 連番 PNG（ZIP）导出按钮：かんたん模式 / 詳細模式。 */
  exportPng: ['#ePNG', '#btnPNG'],
  /** 「書き出し」标签页的标签按钮（詳細模式的兜底路径）。 */
  outputTab: ['button[role="tab"][data-tab="out"]'],
} as const;

/**
 * 根治新手引导浮层：JIZURA 用 `localStorage['jizura.tourDone']` 判断是否首次访问
 * （见 `src/12_ui.js` 启动段）。在页面脚本执行前写入它，浮层根本不会弹出。
 *
 * 实测有效（`#tour` 可见性为 false），比事后点「スキップ」可靠得多。
 */
export const TOUR_DONE_INIT_SCRIPT = (): void => {
  try {
    localStorage.setItem('jizura.tourDone', '1');
  } catch {
    /* 隐私模式下 localStorage 可能不可用，交给 dismissTour 兜底 */
  }
};

/**
 * 风格预设 → 样式 key + 情绪 + 强度。
 *
 * JIZURA 没有 light/dark/neon 这类命名，它用 12 个样式包（`J.STYLES`）乘以
 * 8 种情绪（`J.MOODS`）。这里给出语义最接近的组合；`auto` 不做任何覆盖，
 * 完全交给「おまかせ」。
 */
export const STYLE_PRESETS: Readonly<
  Record<Exclude<StylePreset, 'auto'>, { style: string; mood: Mood; intensity: number }>
> = {
  light: { style: 'paper', mood: 'calm', intensity: 0.35 },
  dark: { style: 'noir', mood: 'emotional', intensity: 0.65 },
  neon: { style: 'magenta', mood: 'pop', intensity: 0.85 },
};

/** 默认输出目录名（相对当前工作目录）。 */
export const DEFAULT_OUTPUT_DIR_NAME = 'jizura-pv-output';

/** 页面导航超时。 */
const NAVIGATION_TIMEOUT_MS = 60_000;

/** 单次 UI 交互超时。 */
const ACTION_TIMEOUT_MS = 20_000;

/** 等待 JIZURA 应用对象就绪的超时。 */
const APP_READY_TIMEOUT_MS = 60_000;

/** 等待音频异步解码 + BPM/beat 检测完成的超时。 */
const AUDIO_ANALYSIS_TIMEOUT_MS = 90_000;

/** 等待新手引导浮层出现的超时；它若不出现，说明这次不是首次访问。 */
const TOUR_WAIT_MS = 4_000;

/**
 * 等待导出下载开始的超时预算。
 *
 * JIZURA 在浏览器内逐帧绘制 + WebCodecs 编码，下载事件只在最后一个字节编码完后才触发。
 * 固定值两头都不讨好：5 分钟盖不住全长 1080p（一首 3 分半的歌在 60fps 下约 13000 帧，
 * 无头软件编码要几十分钟），而固定 6 小时会让短片的失败也等 6 小时才暴露。
 *
 * 因此按 plan 的帧数估算 `帧数 × EXPORT_MS_PER_FRAME`，再夹在下面的区间内。
 * 单帧预算取自实测（720p / 24fps、无头软件编码约 63~86 ms/帧），取 400 ms 留足余量。
 */
const EXPORT_MS_PER_FRAME = 400;
/** 下限：短视频与改动前的 5 分钟行为一致。 */
const MIN_EXPORT_BUDGET_MS = 300_000;
/** 上限：全长 1080p / 60fps 的兜底（工具层 timeoutMs 取同值）。 */
const MAX_EXPORT_BUDGET_MS = 21_600_000;

/**
 * 段落对比的缩放系数。
 *
 * 以 planner **自动算出的**行内 cut 数为基准：低于 Q1 的行 ×0.5（收敛），
 * 高于 Q3 的行 ×1.5 且至少 +1（切得更碎），中间档保持自动值。
 *
 * 之所以按基准缩放而不是写死刀数：planner 依 `fx.density` 与行时长算出的切分常在 4~6 刀，
 * 写死 `cuts = 3` 会把激烈的段落反而**改慢**，与「高能量切得更碎」的说法相反。
 *
 * 用 `overrides[line].cuts` 做段落对比，是因为它是 `08_planner.js` 里**真正生效**的按行控制
 * （`const fixedN = ov.cuts > 0 ? …`）。`cutQuiet` 看着更合适，但 planner 与渲染都不读它。
 */
const DYNAMICS_QUIET_FACTOR = 0.5;
const DYNAMICS_LOUD_FACTOR = 1.5;
/** 单行切分数的上限，避免长行被拆得过碎。 */
const DYNAMICS_MAX_CUTS = 8;

/** 使用已解析的绝对输出目录。 */
export function resolveOutputDir(outputDir?: string | undefined): string {
  return outputDir && outputDir.trim() !== ''
    ? resolve(outputDir)
    : resolve(process.cwd(), DEFAULT_OUTPUT_DIR_NAME);
}

/**
 * 为一个目标文件挑选不冲突的落盘路径。
 *
 * @param dir - 目标目录（绝对路径）。
 * @param filename - 首选文件名。
 * @returns 若首选名已存在则追加 `-1`、`-2` … 的绝对路径。
 */
export function uniquePath(dir: string, filename: string): string {
  const first = join(dir, filename);
  if (!existsSync(first)) return first;
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let i = 1; i < 1000; i += 1) {
    const candidate = join(dir, `${stem}-${i}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return first;
}

/** 未生成时的 canonical 结果。 */
export function emptyResult(): JizuraPvResult {
  return {
    path: '',
    bpm: 0,
    beatCount: 0,
    audioDuration: 0,
    style: '',
    mood: '',
    intensity: -1,
    seed: 0,
    aspect: '',
    resolution: 0,
    fps: 0,
    quality: '',
    bytes: 0,
    dynamicsApplied: false,
  };
}

/** 定位某个选择器下第一个元素，不存在时返回 `undefined`。 */
async function firstLocator(page: Page, selectors: readonly string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      count = 0;
    }
    if (count > 0) return { selector, locator };
  }
  return undefined;
}

/** 定位并返回第一个**可见**的元素，全部不可见时回退到第一个存在的元素。 */
async function firstVisibleLocator(page: Page, selectors: readonly string[]) {
  const present = await firstLocator(page, selectors);
  if (!present) return undefined;
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      count = 0;
    }
    if (count === 0) continue;
    try {
      if (await locator.isVisible()) return { selector, locator };
    } catch {
      return { selector, locator };
    }
  }
  return present;
}

/** 等待 JIZURA 的应用对象 `window.J` 及其状态就绪。 */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const J = (globalThis as unknown as { J?: { ui?: { project?: unknown; plan?: unknown } } }).J;
      return Boolean(J && J.ui && J.ui.project && J.ui.plan);
    },
    undefined,
    { timeout: APP_READY_TIMEOUT_MS },
  );
}

/**
 * 关闭 JIZURA 首次访问的新手引导浮层（兜底）。
 *
 * 正常路径已由 {@link TOUR_DONE_INIT_SCRIPT} 从源头规避，这里只处理
 * 「localStorage 不可用」或上游改了判定条件的情况。
 *
 * @returns 是否用「スキップ」正常关掉了浮层。
 */
export async function dismissTour(page: Page): Promise<boolean> {
  const tour = page.locator(SELECTORS.tour[0]).first();

  try {
    await tour.waitFor({ state: 'visible', timeout: TOUR_WAIT_MS });
  } catch {
    return false; // 已经不会弹了。
  }

  const skip = page.locator(SELECTORS.tourSkip[0]).first();
  try {
    if ((await skip.count()) > 0) {
      await skip.click({ timeout: ACTION_TIMEOUT_MS });
      return true;
    }
  } catch {
    /* 点不到就落到下面的强制隐藏 */
  }

  // 兜底：用样式把浮层藏掉 —— display:none 的元素不再接收指针事件。
  // （不用 page.evaluate 是为了不把 DOM lib 拉进编译目标。）
  await page
    .addStyleTag({ content: '#tour{display:none !important;}' })
    .catch(() => undefined);
  return false;
}

/**
 * 填入歌词：按优先级探测输入区域。
 *
 * 走真实输入路径而不是直接改 `project.lyrics`，这样 JIZURA 自己的 input 处理器
 * 会照常做解析、行列表刷新与重排。
 */
export async function fillLyrics(page: Page, lyrics: string): Promise<string> {
  const found = await firstVisibleLocator(page, SELECTORS.lyricsInput);
  if (!found) {
    throw new Error(
      `未能定位 JIZURA 的歌词输入区域（已尝试：${SELECTORS.lyricsInput.join(', ')}）。` +
        '页面结构可能已变更，请更新 src/impl.ts 的 SELECTORS.lyricsInput。',
    );
  }
  await found.locator.fill(lyrics, { timeout: ACTION_TIMEOUT_MS });
  return found.selector;
}

/** 按需加载背景音乐。返回实际使用的选择器。 */
export async function attachAudio(page: Page, audioPath: string): Promise<string> {
  const found = await firstLocator(page, SELECTORS.audioInput);
  if (!found) {
    throw new Error(`未能定位 JIZURA 的音频文件输入（已尝试：${SELECTORS.audioInput.join(', ')}）。`);
  }
  await page.setInputFiles(found.selector, audioPath, { timeout: ACTION_TIMEOUT_MS });
  return found.selector;
}

/** 从页面读回音频分析结果。 */
export async function readAudioInfo(
  page: Page,
): Promise<{ bpm: number; beatCount: number; audioDuration: number }> {
  return page.evaluate(() => {
    const J = (globalThis as unknown as {
      J: { ui: { audio: { bpm: number; beats: unknown[]; duration: number } } };
    }).J;
    const a = J.ui.audio;
    return { bpm: a.bpm, beatCount: a.beats.length, audioDuration: a.duration };
  });
}

/**
 * 等待音频的异步分析完成。
 *
 * 这是踩点可靠性的关键：`J.analyzeAudio()` 内部要做 `decodeAudioData`（异步）、
 * 能量包络、onset、自相关求 BPM 与相位。不等待就导出，踩点会静默落空。
 */
export async function waitForAudioAnalysis(
  page: Page,
  timeoutMs: number = AUDIO_ANALYSIS_TIMEOUT_MS,
): Promise<{ bpm: number; beatCount: number; audioDuration: number }> {
  try {
    await page.waitForFunction(
      () => {
        const J = (globalThis as unknown as { J?: { ui?: { audio?: unknown } } }).J;
        return Boolean(J && J.ui && J.ui.audio);
      },
      undefined,
      { timeout: timeoutMs },
    );
  } catch {
    throw new Error(
      `音频加载后 ${Math.round(timeoutMs / 1000)} 秒内没有完成分析。` +
        '请确认文件是浏览器可解码的格式（mp3 / wav / m4a / ogg），且体积不过大。',
    );
  }
  return readAudioInfo(page);
}

/** 一次配置注入所需的全部参数。 */
interface ConfigureOptions {
  readonly aspect: AspectRatio;
  readonly resolution: Resolution;
  readonly fps: Fps;
  readonly quality: ExportQuality;
  readonly title: string;
  readonly artist: string;
  readonly keyBg: KeyBackground;
  readonly themeId: string | null;
  readonly style: string | null;
  readonly mood: Mood | null;
  readonly intensity: number | null;
  readonly seed: number | null;
  /** 是否把 `fx.bgSwitch` 压到 0 以锁定首套配色。 */
  readonly paletteLock: boolean;
  /** 直接指定的样式 key；无效时忽略并沿用预设。 */
  readonly styleKey: string | null;
  /** 是否隐藏装饰编号。 */
  readonly hideNo: boolean;
  /** 是否隐藏装饰时间码。 */
  readonly hideTime: boolean;
}

/** 配置注入后从页面读回的实际生效值。 */
interface ConfigureResult {
  readonly style: string;
  readonly mood: string;
  readonly seed: number;
}

/**
 * 把风格/情绪/强度/输出设置一次性写进 JIZURA 并重排。
 *
 * 顺序很重要：先让「おまかせ」打底（它会重掷 style / mood / fx / enabled），
 * 再用显式参数覆盖，最后按情绪区间插值效果强度。反过来会被随机结果盖掉。
 */
export async function configureProject(page: Page, options: ConfigureOptions): Promise<ConfigureResult> {
  return page.evaluate((cfg) => {
    interface MoodSpec {
      fx?: Record<string, [number, number]>;
    }
    const J = (globalThis as unknown as {
      J: {
        ui: { project: Record<string, unknown> };
        uiApi?: { replan?: () => void; syncUI?: () => void };
        MOODS: Record<string, MoodSpec>;
        STYLES?: Record<string, unknown>;
        rng?: (seed: number) => () => number;
        omakase?: (project: unknown, rnd: () => number, themeId: string | null) => Record<string, unknown>;
      };
    }).J;
    const P = J.ui.project;

    // ---- 输出设置（不受「おまかせ」影响）----
    P['aspect'] = cfg.aspect;
    P['res'] = cfg.resolution;
    P['fps'] = cfg.fps;
    // quality 不在 J.defaultProject() 里，但界面读的是 `S.project.quality || 'high'`，
    // 导出时也把它作为码率档位传下去，所以直接写这个字段即可生效。
    P['quality'] = cfg.quality;
    P['title'] = cfg.title;
    P['artist'] = cfg.artist;
    P['keyBg'] = cfg.keyBg;
    P['themeId'] = cfg.themeId;

    // ---- 「おまかせ」打底；给了 seed 就用可复现的随机流 ----
    if (typeof J.omakase === 'function') {
      const rnd = cfg.seed != null && typeof J.rng === 'function' ? J.rng(cfg.seed) : Math.random;
      Object.assign(P, J.omakase(P, rnd, cfg.themeId));
    }

    // ---- 显式参数覆盖 ----
    if (cfg.style) P['style'] = cfg.style;
    if (cfg.mood) P['mood'] = cfg.mood;
    // styleKey 直传：JIZURA 内置 27 个样式，而 stylePreset 只展开 3 个。
    // key 无效时保持预设结果、不抛错 —— 调用方可以从返回值的 style 看到实际生效值。
    if (cfg.styleKey && J.STYLES && Object.prototype.hasOwnProperty.call(J.STYLES, cfg.styleKey)) {
      P['style'] = cfg.styleKey;
    }

    // ---- 强度：在该情绪的 fx 区间内插值 ----
    if (cfg.intensity != null) {
      const moodKey = String(P['mood'] ?? '');
      const spec = J.MOODS[moodKey];
      const fx = P['fx'] as Record<string, unknown> | undefined;
      if (spec && spec.fx && fx) {
        for (const key of Object.keys(spec.fx)) {
          const range = spec.fx[key];
          if (!range) continue;
          fx[key] = +(range[0] + (range[1] - range[0]) * cfg.intensity).toFixed(2);
        }
      }
    }

    // ---- 配色锁定与装饰开关 ----
    // 两件都要放在 intensity 插值之后，否则会被情绪区间算出来的值盖掉。
    // planner 只有在 `fx.bgSwitch > 0` 时才可能换色（`rng.chance(fx.bgSwitch * …)`），
    // 压到 0 即整片维持该样式的第一套配色。实测与「截断 schemes」的 scheme 分布一致
    // （90 个 cut 全部落在第 0 套），但不像截断那样永久改写页面内的全局样式表。
    const fxPatch = P['fx'] as Record<string, unknown> | undefined;
    if (fxPatch) {
      if (cfg.paletteLock) fxPatch['bgSwitch'] = 0;
      if (cfg.hideNo) fxPatch['hideNo'] = true;
      if (cfg.hideTime) fxPatch['hideTime'] = true;
    }

    if (J.uiApi && typeof J.uiApi.replan === 'function') J.uiApi.replan();
    if (J.uiApi && typeof J.uiApi.syncUI === 'function') J.uiApi.syncUI();

    return {
      style: String(P['style'] ?? ''),
      mood: String(P['mood'] ?? ''),
      seed: Number(P['seed'] ?? 0),
    };
  }, options);
}
/** 段落对比的结果。 */
interface DynamicsResult {
  /** 参与判定的行数。 */
  readonly lines: number;
  /** 被判为「响」的行数（切得更碎）。 */
  readonly loud: number;
  /** 被判为「轻」的行数（收敛）。 */
  readonly quiet: number;
  /** 保持 planner 自动切分的行数。 */
  readonly mid: number;
}

/**
 * 用音频能量包络自动做段落对比。
 *
 * 先算每行平均能量与其四分位，再以 **planner 自己算出的 cut 数**为基准缩放：
 * 高能量行 ×1.5（至少 +1，切得更碎），低能量行 ×0.5（收敛），中间档保持自动值。
 * 频谱没有起伏（Q1 == Q3）时整体跳过。
 *
 * `overrides[line].cutQuiet` 看着更适合做这件事，但它在 planner 与渲染里都没有被读取，
 * 是 UI-only 的死数据，用了不会有任何效果。
 */
export async function applyDynamics(page: Page): Promise<DynamicsResult> {
  return page.evaluate(
    (cfg) => {
      const J = (globalThis as unknown as {
        J: {
          ui: {
            audio: { energy: ArrayLike<number>; energyRate: number } | null;
            plan: {
              cuts: { line: number }[];
              lines: { index: number; start: number; end: number }[];
            };
            project: { overrides: Record<string, Record<string, unknown>> };
          };
          uiApi?: { replan?: () => void; syncUI?: () => void };
        };
      }).J;
      const S = J.ui;
      const empty = { lines: 0, loud: 0, quiet: 0, mid: 0 };
      if (!S.audio || !S.audio.energy || !S.plan || !S.plan.lines.length) return empty;

      const rate = S.audio.energyRate || 50;
      const energy = S.audio.energy;

      // 1) 每行的平均能量
      const energies = S.plan.lines.map((line) => {
        let sum = 0;
        let n = 0;
        for (let t = line.start; t < line.end; t += 1 / rate) {
          const i = Math.round(t * rate);
          if (i >= 0 && i < energy.length) {
            sum += energy[i] as number;
            n += 1;
          }
        }
        return n ? sum / n : 0;
      });

      // 2) 四分位 —— 比「中位数 × 系数」更能反映动态范围
      const sorted = energies.slice().sort((a, b) => a - b);
      const quantile = (p: number): number =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      const q1 = quantile(0.25);
      const q3 = quantile(0.75);
      if (!(q3 > q1)) return empty; // 能量没有起伏，不值得分档

      // 3) planner 自动算出的每行 cut 数 —— 缩放基准
      const baseline = new Map<number, number>();
      for (const cut of S.plan.cuts) {
        if (cut.line < 0) continue;
        baseline.set(cut.line, (baseline.get(cut.line) ?? 0) + 1);
      }

      const overrides = S.project.overrides;
      let loud = 0;
      let quiet = 0;
      let mid = 0;

      S.plan.lines.forEach((line, i) => {
        const value = energies[i] ?? 0;
        const base = baseline.get(line.index) ?? 1;
        const cur = Object.assign({}, overrides[line.index] ?? {});

        if (value > q3) {
          cur['cuts'] = Math.min(cfg.maxCuts, Math.max(base + 1, Math.round(base * cfg.loudFactor)));
          loud += 1;
        } else if (value < q1) {
          cur['cuts'] = Math.max(1, Math.round(base * cfg.quietFactor));
          quiet += 1;
        } else {
          delete cur['cuts']; // 中间档保留 planner 的自动值
          mid += 1;
        }

        if (Object.keys(cur).length > 0) overrides[line.index] = cur;
        else delete overrides[line.index];
      });

      if (J.uiApi && typeof J.uiApi.replan === 'function') J.uiApi.replan();
      if (J.uiApi && typeof J.uiApi.syncUI === 'function') J.uiApi.syncUI();

      return { lines: S.plan.lines.length, loud, quiet, mid };
    },
    { quietFactor: DYNAMICS_QUIET_FACTOR, loudFactor: DYNAMICS_LOUD_FACTOR, maxCuts: DYNAMICS_MAX_CUTS },
  );
}

/**
 * 估算这次导出需要等多久。
 *
 * 按 plan 的总时长 × 帧率得到帧数，乘单帧预算后夹在区间内。这样短片的失败能很快暴露，
 * 而全长 1080p / 60fps 也不会在编码完成前就被判超时。
 */
export async function estimateExportBudget(page: Page): Promise<number> {
  const info = await page.evaluate(() => {
    const S = (globalThis as unknown as {
      J: {
        ui: {
          plan?: { cuts?: { start?: number; dur?: number }[] };
          project?: { fps?: number };
        };
      };
    }).J.ui;

    let seconds = 0;
    for (const cut of S.plan?.cuts ?? []) {
      const end = (cut.start ?? 0) + (cut.dur ?? 0);
      if (end > seconds) seconds = end;
    }
    return { seconds, fps: S.project?.fps ?? 24 };
  });

  const frames = Math.max(1, Math.ceil(info.seconds * info.fps));
  const budget = frames * EXPORT_MS_PER_FRAME;
  return Math.min(MAX_EXPORT_BUDGET_MS, Math.max(MIN_EXPORT_BUDGET_MS, Math.round(budget)));
}

/** 触发导出并等待下载事件；`timeoutMs` 通常由 {@link estimateExportBudget} 给出。 */
export async function triggerExport(
  page: Page,
  format: OutputFormat,
  timeoutMs: number = MAX_EXPORT_BUDGET_MS,
): Promise<Download> {
  const candidates = format === 'mp4' ? SELECTORS.exportMp4 : SELECTORS.exportPng;

  // かんたん模式下导出按钮直接在面板里；否则先切到「書き出し」标签页。
  let target = await firstVisibleLocator(page, candidates);
  if (!target) {
    const tab = await firstVisibleLocator(page, SELECTORS.outputTab);
    if (tab) {
      await tab.locator.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
    }
    target = await firstVisibleLocator(page, candidates);
  }
  if (!target) {
    throw new Error(`未能定位导出按钮（已尝试：${candidates.join(', ')}）。`);
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: timeoutMs }),
    target.locator.click({ timeout: ACTION_TIMEOUT_MS }),
  ]);
  return download;
}

/**
 * 驱动 JIZURA 生成文字 PV，并把产物保存到本地。
 *
 * 行为约定：
 * - **基础设施故障**（浏览器启动失败、页面加载超时、页面结构无法识别、音频分析超时）直接抛出。
 * - **业务非理想结果**（歌词为空）不抛异常，返回 {@link emptyResult}，
 *   由调用方的 `render` 负责向用户说明。
 *
 * @param request - 生成请求。
 * @returns 结构化结果；歌词为空时 `path` 为空串。
 */
export async function generateJizuraPv(request: JizuraPvRequest): Promise<JizuraPvResult> {
  const { signal } = request;

  // 业务非理想结果：歌词为空 → 返回 canonical 空值，不启动浏览器。
  if (request.lyrics.trim() === '') return emptyResult();

  signal?.throwIfAborted();

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  // 取消时立刻关闭浏览器进程，让进行中的 Playwright 操作以 "target closed" 失败。
  const onAbort = (): void => {
    void context?.close().catch(() => undefined);
    void browser?.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({ acceptDownloads: true });

    // 从源头规避新手引导浮层（必须在下发页面脚本之前注入）。
    await context.addInitScript(TOUR_DONE_INIT_SCRIPT);

    const page: Page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    signal?.throwIfAborted();

    await page.goto(JIZURA_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    signal?.throwIfAborted();

    // 等 window.J 就绪，后续所有操作都基于它；顺带兜底关掉引导浮层。
    await waitForApp(page);
    await dismissTour(page);

    await fillLyrics(page, request.lyrics);
    signal?.throwIfAborted();

    // ---- 音频：加载 + 等异步分析完成，拿到踩点证据 ----
    let audio: { bpm: number; beatCount: number; audioDuration: number } = {
      bpm: 0,
      beatCount: 0,
      audioDuration: 0,
    };
    if (request.audioPath) {
      await attachAudio(page, resolve(request.audioPath));
      audio = await waitForAudioAnalysis(page);
      signal?.throwIfAborted();
    }

    // ---- 风格 / 情绪 / 强度 / 输出设置 ----
    const preset = request.stylePreset === 'auto' ? null : STYLE_PRESETS[request.stylePreset];
    const configured = await configureProject(page, {
      aspect: request.aspectRatio,
      resolution: request.resolution,
      fps: request.fps,
      quality: request.quality,
      title: request.title ?? '',
      artist: request.artist ?? '',
      keyBg: request.keyBg,
      themeId: request.theme ?? null,
      style: request.stylePreset === 'auto' ? null : (preset?.style ?? null),
      mood: request.mood ?? preset?.mood ?? null,
      intensity: request.intensity ?? preset?.intensity ?? null,
      seed: request.seed ?? null,
      paletteLock: request.paletteLock ?? false,
      styleKey: request.styleKey ?? null,
      hideNo: request.hideNo,
      hideTime: request.hideTime,
    });
    signal?.throwIfAborted();

    // ---- 段落对比（信号驱动）----
    let dynamicsApplied = false;
    if (request.autoDynamics && audio.beatCount > 0) {
      const dynamics = await applyDynamics(page);
      dynamicsApplied = dynamics.lines > 0;
      signal?.throwIfAborted();
    }

    // ---- 导出 ----
    // ---- 导出（等待预算按 plan 帧数估算）----
    const exportBudgetMs = await estimateExportBudget(page);
    const download = await triggerExport(page, request.outputFormat, exportBudgetMs);
    signal?.throwIfAborted();

    const dir = resolveOutputDir(request.outputDir);
    await mkdir(dir, { recursive: true });

    const target = uniquePath(dir, download.suggestedFilename());
    await download.saveAs(target);

    const info = await stat(target);

    return {
      path: target,
      bpm: audio.bpm,
      beatCount: audio.beatCount,
      audioDuration: audio.audioDuration,
      style: configured.style,
      mood: configured.mood,
      intensity: request.intensity ?? preset?.intensity ?? -1,
      // 显式传入的 seed 才是「复现键」：omakase 会派生自己的 seed 并覆盖 project.seed，
      // 但派生所用的随机流完全由传入的 seed 决定，所以同样的输入仍然得到同样的结果。
      seed: request.seed ?? configured.seed,
      aspect: request.aspectRatio,
      resolution: request.resolution,
      fps: request.fps,
      quality: request.quality,
      bytes: info.size,
      dynamicsApplied,
    };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
