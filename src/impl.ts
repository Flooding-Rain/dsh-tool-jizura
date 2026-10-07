/**
 * `generate_jizura_pv` 的浏览器自动化实现。
 *
 * 该模块只负责「驱动 JIZURA 网页 → 产出文件 → 返回绝对路径」这一件事，
 * 不依赖 dsh 运行时，因此可以脱离宿主单独测试。
 *
 * @module dsh-tool-jizura/impl
 */

import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium } from 'playwright';
import type { Browser, BrowserContext, Download, Page } from 'playwright';

/** JIZURA 在线应用地址。 */
export const JIZURA_URL = 'https://852wa.github.io/JIZURA/';

/** 视觉风格预设。 */
export type StylePreset = 'auto' | 'light' | 'dark' | 'neon';

/** 输出画幅比例。 */
export type AspectRatio = '16:9' | '9:16' | '1:1';

/** 输出格式。 */
export type OutputFormat = 'mp4' | 'png_sequence';

/** 一次 PV 生成请求。 */
export interface JizuraPvRequest {
  /** 歌词文本，支持多行。 */
  readonly lyrics: string;
  /** 背景音乐文件的绝对路径。 */
  readonly audioPath?: string | undefined;
  /** 视觉风格预设。 */
  readonly stylePreset: StylePreset;
  /** 输出画幅比例。 */
  readonly aspectRatio: AspectRatio;
  /** 输出格式。 */
  readonly outputFormat: OutputFormat;
  /** 输出目录的绝对路径；省略时使用工作目录下的 `jizura-pv-output`。 */
  readonly outputDir?: string | undefined;
  /** 取消信号；触发时立即关闭浏览器进程。 */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 页面选择器表。
 *
 * JIZURA 的界面由 `src/12_ui.js` 在运行时绘制，下面每一项都按
 * 「优先精确 id，其次通用特征」排序；探测时逐个尝试，命中第一个可用的。
 *
 * 维护方式见 README「JIZURA 界面选择器维护说明」。
 */
export const SELECTORS = {
  /**
   * 首次访问的新手引导浮层。它是 `role="dialog" aria-modal="true"` 的全屏遮罩，
   * 会吞掉整页的点击事件，必须在任何交互前关掉。
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
  /** 切到「かんたん」模式，让 `#btnOmakaseBig` 从 hidden 变为可见。 */
  modeEasy: ['#modeEasy'],
  /** かんたん模式面板；`#btnOmakaseBig` 位于其中且默认 `hidden`。 */
  easyPanel: ['#easyPanel'],
  /** 「おまかせで作る」大按钮（かんたん模式）。 */
  omakasePrimary: ['#btnOmakaseBig'],
  /** 「おまかせ」兜底按钮（詳細模式）。 */
  omakaseFallback: ['#btnOmakase', '#btnOmakaseTop'],
  /** 画幅比例：かんたん模式 / 詳細模式「書き出し」标签页。 */
  aspect: ['#eAspect', '#outAspect'],
  /** 「書き出し」标签页的标签按钮。 */
  outputTab: ['button[role="tab"][data-tab="out"]'],
  /** 「スタイル」标签页的标签按钮。 */
  styleTab: ['button[role="tab"][data-tab="style"]'],
  /** MP4 导出按钮：かんたん模式 / 詳細模式。 */
  exportMp4: ['#eMP4', '#btnMP4'],
  /** 連番 PNG（ZIP）导出按钮：かんたん模式 / 詳細模式。 */
  exportPng: ['#ePNG', '#btnPNG'],
} as const;

/**
 * `stylePreset` → JIZURA 样式包 key 的映射。
 *
 * JIZURA 没有 light/dark/neon 这样命名的预设，它的 12 个样式包定义在
 * `src/04_styles.js` 的 `J.STYLES` / `J.STYLE_ORDER`，每个包由若干配色
 * scheme 组成。这里挑选语义最贴近的包：
 *
 * - `light` → `paper`   （ペーパー・インク：`#ECE9E3` 亮纸底）
 * - `dark`  → `noir`    （ノワール・クロマ：`#060607` 黑底白字）
 * - `neon`  → `magenta` （ポップ・マゼンタ：`#FF0A8C` 震撼粉）
 *
 * `auto` 不做干预，完全交给「おまかせ」随机。
 */
export const STYLE_PRESET_TO_KEY: Readonly<Record<Exclude<StylePreset, 'auto'>, string>> = {
  light: 'paper',
  dark: 'noir',
  neon: 'magenta',
};

/** 默认输出目录名（相对当前工作目录）。 */
export const DEFAULT_OUTPUT_DIR_NAME = 'jizura-pv-output';

/** 页面导航超时。 */
const NAVIGATION_TIMEOUT_MS = 60_000;

/** 单次 UI 交互超时。 */
const ACTION_TIMEOUT_MS = 20_000;

/** 等待导出下载开始的超时（JIZURA 在浏览器内编码，耗时较长）。 */
const DOWNLOAD_TIMEOUT_MS = 110_000;

/** 等待新手引导浮层出现的超时；它若不出现，说明这次不是首次访问。 */
const TOUR_WAIT_MS = 4_000;

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

/** 等待下一个宏任务，给浏览器事件循环一个推进的机会。 */
function tick(): Promise<void> {
  return new Promise((r) => {
    setTimeout(r, 0);
  });
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

/** 在候选选择器中依次尝试点击，全部失败时静默返回 `false`。 */
async function clickFirst(page: Page, selectors: readonly string[]): Promise<boolean> {
  const found = await firstVisibleLocator(page, selectors);
  if (!found) return false;
  try {
    await found.locator.click({ timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * 关闭 JIZURA 首次访问的新手引导浮层。
 *
 * 该浮层是 `aria-modal="true"` 的全屏 dialog，只要它在，页面上任何点击都会被它
 * 拦截（Playwright 报 `... intercepts pointer events`）。每次新建浏览器上下文
 * 都算「首次访问」，所以这一步不能省。
 *
 * @returns 是否用「スキップ」正常关掉了浮层。
 */
export async function dismissTour(page: Page): Promise<boolean> {
  const tour = page.locator(SELECTORS.tour[0]).first();

  try {
    await tour.waitFor({ state: 'visible', timeout: TOUR_WAIT_MS });
  } catch {
    return false; // 不是首次访问，没有引导浮层。
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

  // 兜底：用样式把浮层藏掉 —— display:none 的元素不再接收指针事件，因此不会
  // 继续吞掉后续点击。（这里不用 page.evaluate 是为了不把 DOM lib 拉进编译目标。）
  await page
    .addStyleTag({ content: '#tour{display:none !important;}' })
    .catch(() => undefined);
  return false;
}

/**
 * 填入歌词：按优先级探测输入区域。
 *
 * 对 `textarea` 用 `fill`，对 `contenteditable` 用 `fill` 亦可
 * （Playwright 会走 `textContent` + 输入事件），因此两种都兼容。
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
    throw new Error(
      `未能定位 JIZURA 的音频文件输入（已尝试：${SELECTORS.audioInput.join(', ')}）。`,
    );
  }
  await page.setInputFiles(found.selector, audioPath, { timeout: ACTION_TIMEOUT_MS });
  return found.selector;
}

/** 在 `<select>` 上选择画幅比例。返回是否成功。 */
export async function selectAspectRatio(page: Page, aspectRatio: AspectRatio): Promise<boolean> {
  const found = await firstVisibleLocator(page, SELECTORS.aspect);
  if (!found) return false;
  try {
    await found.locator.selectOption(aspectRatio, { timeout: ACTION_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** 点击「おまかせで作る」。返回实际点击到的选择器。 */
export async function clickOmakase(page: Page): Promise<string> {
  // 实测 JIZURA 启动后默认处于「かんたん」模式（`#easyPanel` 可见、`#btnOmakaseBig`
  // 可见），因此先直接尝试大按钮；只有在「詳細」模式下它位于 hidden 面板内时，
  // 才需要先切模式。注意静态模板 app/body.html 的写法与实际运行时状态相反。
  let primary = await firstVisibleLocator(page, SELECTORS.omakasePrimary);

  if (!primary) {
    if (await clickFirst(page, SELECTORS.modeEasy)) {
      const panel = await firstLocator(page, SELECTORS.easyPanel);
      if (panel) {
        try {
          await panel.locator.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT_MS });
        } catch {
          /* 面板未出现则继续走兜底按钮 */
        }
      }
    }
    primary = await firstVisibleLocator(page, SELECTORS.omakasePrimary);
  }

  if (primary) {
    await primary.locator.click({ timeout: ACTION_TIMEOUT_MS });
    return primary.selector;
  }

  const fallback = await firstVisibleLocator(page, SELECTORS.omakaseFallback);
  if (fallback) {
    await fallback.locator.click({ timeout: ACTION_TIMEOUT_MS });
    return fallback.selector;
  }

  throw new Error(
    '未能点击 JIZURA 的「おまかせで作る」按钮（已尝试：' +
      [...SELECTORS.omakasePrimary, ...SELECTORS.omakaseFallback].join(', ') +
      '）。',
  );
}

/**
 * 应用视觉风格预设。
 *
 * 必须在「おまかせ」**之后**调用：おまかせ会重新随机 `style`，先设会被覆盖。
 */
export async function applyStylePreset(page: Page, preset: StylePreset): Promise<string | undefined> {
  if (preset === 'auto') return undefined;
  const styleKey = STYLE_PRESET_TO_KEY[preset];

  await clickFirst(page, SELECTORS.styleTab);

  const card = page.locator(`#styleGrid button[data-k="${styleKey}"]`).first();
  let count = 0;
  try {
    count = await card.count();
  } catch {
    count = 0;
  }
  if (count === 0) return undefined;

  try {
    await card.click({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    return undefined;
  }
  return styleKey;
}

/** 触发导出并等待下载事件。 */
export async function triggerExport(page: Page, format: OutputFormat): Promise<Download> {
  const candidates = format === 'mp4' ? SELECTORS.exportMp4 : SELECTORS.exportPng;

  // かんたん模式下导出按钮直接在面板里；否则先切到「書き出し」标签页。
  let target = await firstVisibleLocator(page, candidates);
  if (!target) {
    await clickFirst(page, SELECTORS.outputTab);
    target = await firstVisibleLocator(page, candidates);
  }
  if (!target) {
    // 再等一拍：标签页切换后 DOM 可能刚变为可见。
    await tick();
    target = await firstVisibleLocator(page, candidates);
  }
  if (!target) {
    throw new Error(`未能定位导出按钮（已尝试：${candidates.join(', ')}）。`);
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
    target.locator.click({ timeout: ACTION_TIMEOUT_MS }),
  ]);
  return download;
}

/**
 * 驱动 JIZURA 生成文字 PV，并把产物保存到本地。
 *
 * 行为约定：
 * - **基础设施故障**（浏览器启动失败、页面加载超时、页面结构无法识别）直接抛出。
 * - **业务非理想结果**（歌词为空）不抛异常，返回空字符串作为 canonical 值，
 *   由调用方的 `render` 负责向用户说明。
 *
 * @param request - 生成请求。
 * @returns 产物文件的绝对路径；歌词为空时返回空字符串。
 */
export async function generateJizuraPv(request: JizuraPvRequest): Promise<string> {
  const { signal } = request;

  // 业务非理想结果：歌词为空 → 返回 canonical 空值，不启动浏览器。
  if (request.lyrics.trim() === '') return '';

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
    const page: Page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);

    signal?.throwIfAborted();

    await page.goto(JIZURA_URL, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
    signal?.throwIfAborted();

    // 必须先关掉首次访问的引导浮层，否则它会拦截后续所有点击。
    await dismissTour(page);

    await fillLyrics(page, request.lyrics);

    if (request.audioPath) {
      await attachAudio(page, resolve(request.audioPath));
    }

    await selectAspectRatio(page, request.aspectRatio);

    // おまかせ会重掷 style / mood / 配色，因此风格预设在它之后应用才有效。
    await clickOmakase(page);
    await applyStylePreset(page, request.stylePreset);

    signal?.throwIfAborted();

    const download = await triggerExport(page, request.outputFormat);
    signal?.throwIfAborted();

    const dir = resolveOutputDir(request.outputDir);
    await mkdir(dir, { recursive: true });

    const target = uniquePath(dir, download.suggestedFilename());
    await download.saveAs(target);
    return target;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await context?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
