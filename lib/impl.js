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
/** JIZURA 在线应用地址。 */
export const JIZURA_URL = 'https://852wa.github.io/JIZURA/';
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
};
/**
 * 根治新手引导浮层：JIZURA 用 `localStorage['jizura.tourDone']` 判断是否首次访问
 * （见 `src/12_ui.js` 启动段）。在页面脚本执行前写入它，浮层根本不会弹出。
 *
 * 实测有效（`#tour` 可见性为 false），比事后点「スキップ」可靠得多。
 */
export const TOUR_DONE_INIT_SCRIPT = () => {
    try {
        localStorage.setItem('jizura.tourDone', '1');
    }
    catch {
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
export const STYLE_PRESETS = {
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
/** 等待导出下载开始的超时（JIZURA 在浏览器内逐帧编码，耗时较长）。 */
const DOWNLOAD_TIMEOUT_MS = 300_000;
/**
 * 低能量行的切分数上限与高能量行的切分数。
 *
 * 用 `overrides[line].cuts` 做段落对比：这是 `08_planner.js` 里**真正生效**的按行控制
 * （`const fixedN = ov.cuts > 0 ? …`）。注意 `cutQuiet` 虽然看起来更合适，但它在
 * planner 与渲染里都没有被读取，是 UI-only 的死数据，用它不会有任何效果。
 */
const DYNAMICS_QUIET_CUTS = 1;
const DYNAMICS_LOUD_CUTS = 3;
/** 低于「中位数 × 该系数」的行算安静行。 */
const DYNAMICS_QUIET_RATIO = 0.7;
/** 使用已解析的绝对输出目录。 */
export function resolveOutputDir(outputDir) {
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
export function uniquePath(dir, filename) {
    const first = join(dir, filename);
    if (!existsSync(first))
        return first;
    const dot = filename.lastIndexOf('.');
    const stem = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    for (let i = 1; i < 1000; i += 1) {
        const candidate = join(dir, `${stem}-${i}${ext}`);
        if (!existsSync(candidate))
            return candidate;
    }
    return first;
}
/** 未生成时的 canonical 结果。 */
export function emptyResult() {
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
        bytes: 0,
        dynamicsApplied: false,
    };
}
/** 定位某个选择器下第一个元素，不存在时返回 `undefined`。 */
async function firstLocator(page, selectors) {
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        let count = 0;
        try {
            count = await locator.count();
        }
        catch {
            count = 0;
        }
        if (count > 0)
            return { selector, locator };
    }
    return undefined;
}
/** 定位并返回第一个**可见**的元素，全部不可见时回退到第一个存在的元素。 */
async function firstVisibleLocator(page, selectors) {
    const present = await firstLocator(page, selectors);
    if (!present)
        return undefined;
    for (const selector of selectors) {
        const locator = page.locator(selector).first();
        let count = 0;
        try {
            count = await locator.count();
        }
        catch {
            count = 0;
        }
        if (count === 0)
            continue;
        try {
            if (await locator.isVisible())
                return { selector, locator };
        }
        catch {
            return { selector, locator };
        }
    }
    return present;
}
/** 等待 JIZURA 的应用对象 `window.J` 及其状态就绪。 */
export async function waitForApp(page) {
    await page.waitForFunction(() => {
        const J = globalThis.J;
        return Boolean(J && J.ui && J.ui.project && J.ui.plan);
    }, undefined, { timeout: APP_READY_TIMEOUT_MS });
}
/**
 * 关闭 JIZURA 首次访问的新手引导浮层（兜底）。
 *
 * 正常路径已由 {@link TOUR_DONE_INIT_SCRIPT} 从源头规避，这里只处理
 * 「localStorage 不可用」或上游改了判定条件的情况。
 *
 * @returns 是否用「スキップ」正常关掉了浮层。
 */
export async function dismissTour(page) {
    const tour = page.locator(SELECTORS.tour[0]).first();
    try {
        await tour.waitFor({ state: 'visible', timeout: TOUR_WAIT_MS });
    }
    catch {
        return false; // 已经不会弹了。
    }
    const skip = page.locator(SELECTORS.tourSkip[0]).first();
    try {
        if ((await skip.count()) > 0) {
            await skip.click({ timeout: ACTION_TIMEOUT_MS });
            return true;
        }
    }
    catch {
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
export async function fillLyrics(page, lyrics) {
    const found = await firstVisibleLocator(page, SELECTORS.lyricsInput);
    if (!found) {
        throw new Error(`未能定位 JIZURA 的歌词输入区域（已尝试：${SELECTORS.lyricsInput.join(', ')}）。` +
            '页面结构可能已变更，请更新 src/impl.ts 的 SELECTORS.lyricsInput。');
    }
    await found.locator.fill(lyrics, { timeout: ACTION_TIMEOUT_MS });
    return found.selector;
}
/** 按需加载背景音乐。返回实际使用的选择器。 */
export async function attachAudio(page, audioPath) {
    const found = await firstLocator(page, SELECTORS.audioInput);
    if (!found) {
        throw new Error(`未能定位 JIZURA 的音频文件输入（已尝试：${SELECTORS.audioInput.join(', ')}）。`);
    }
    await page.setInputFiles(found.selector, audioPath, { timeout: ACTION_TIMEOUT_MS });
    return found.selector;
}
/** 从页面读回音频分析结果。 */
export async function readAudioInfo(page) {
    return page.evaluate(() => {
        const J = globalThis.J;
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
export async function waitForAudioAnalysis(page, timeoutMs = AUDIO_ANALYSIS_TIMEOUT_MS) {
    try {
        await page.waitForFunction(() => {
            const J = globalThis.J;
            return Boolean(J && J.ui && J.ui.audio);
        }, undefined, { timeout: timeoutMs });
    }
    catch {
        throw new Error(`音频加载后 ${Math.round(timeoutMs / 1000)} 秒内没有完成分析。` +
            '请确认文件是浏览器可解码的格式（mp3 / wav / m4a / ogg），且体积不过大。');
    }
    return readAudioInfo(page);
}
/**
 * 把风格/情绪/强度/输出设置一次性写进 JIZURA 并重排。
 *
 * 顺序很重要：先让「おまかせ」打底（它会重掷 style / mood / fx / enabled），
 * 再用显式参数覆盖，最后按情绪区间插值效果强度。反过来会被随机结果盖掉。
 */
export async function configureProject(page, options) {
    return page.evaluate((cfg) => {
        const J = globalThis.J;
        const P = J.ui.project;
        // ---- 输出设置（不受「おまかせ」影响）----
        P['aspect'] = cfg.aspect;
        P['res'] = cfg.resolution;
        P['fps'] = cfg.fps;
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
        if (cfg.style)
            P['style'] = cfg.style;
        if (cfg.mood)
            P['mood'] = cfg.mood;
        // ---- 强度：在该情绪的 fx 区间内插值 ----
        if (cfg.intensity != null) {
            const moodKey = String(P['mood'] ?? '');
            const spec = J.MOODS[moodKey];
            const fx = P['fx'];
            if (spec && spec.fx && fx) {
                for (const key of Object.keys(spec.fx)) {
                    const range = spec.fx[key];
                    if (!range)
                        continue;
                    fx[key] = +(range[0] + (range[1] - range[0]) * cfg.intensity).toFixed(2);
                }
            }
        }
        if (J.uiApi && typeof J.uiApi.replan === 'function')
            J.uiApi.replan();
        if (J.uiApi && typeof J.uiApi.syncUI === 'function')
            J.uiApi.syncUI();
        return {
            style: String(P['style'] ?? ''),
            mood: String(P['mood'] ?? ''),
            seed: Number(P['seed'] ?? 0),
        };
    }, options);
}
/**
 * 用音频能量包络自动做段落对比。
 *
 * 算出每行的平均能量，以中位数为界：明显偏轻的行收敛为单一切分
 * （`overrides[line].cuts = 1`，视觉更静），其余行切成更多刀
 * （`cuts = 3`，节奏更碎）。`cuts` 是 `08_planner.js` 里真正被读取的按行控制。
 *
 * `overrides[line].cutQuiet` 看着更适合做这件事，但它在 planner 与渲染里都没有
 * 被读取，是 UI-only 的死数据，用了不会有任何效果。
 */
export async function applyDynamics(page, quietRatio = DYNAMICS_QUIET_RATIO) {
    return page.evaluate((cfg) => {
        const J = globalThis.J;
        const S = J.ui;
        const empty = { lines: 0, loud: 0, quiet: 0 };
        if (!S.audio || !S.audio.energy || !S.plan || !S.plan.lines.length)
            return empty;
        const rate = S.audio.energyRate || 50;
        const energy = S.audio.energy;
        const energies = S.plan.lines.map((line) => {
            let sum = 0;
            let n = 0;
            for (let t = line.start; t < line.end; t += 1 / rate) {
                const i = Math.round(t * rate);
                if (i >= 0 && i < energy.length) {
                    sum += energy[i];
                    n += 1;
                }
            }
            return n ? sum / n : 0;
        });
        const sorted = energies.slice().sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
        if (!(median > 0))
            return empty;
        // 每行有几刀可用：行内非 special 布局的 cut 数上限
        const overrides = S.project.overrides;
        let loud = 0;
        let quiet = 0;
        S.plan.lines.forEach((line, i) => {
            const value = energies[i] ?? 0;
            const cur = Object.assign({}, overrides[line.index] ?? {});
            if (value < median * cfg.quietRatio) {
                cur['cuts'] = cfg.quietCuts;
                quiet += 1;
            }
            else {
                cur['cuts'] = cfg.loudCuts;
                loud += 1;
            }
            overrides[line.index] = cur;
        });
        if (J.uiApi && typeof J.uiApi.replan === 'function')
            J.uiApi.replan();
        if (J.uiApi && typeof J.uiApi.syncUI === 'function')
            J.uiApi.syncUI();
        return { lines: S.plan.lines.length, loud, quiet };
    }, { quietRatio, quietCuts: DYNAMICS_QUIET_CUTS, loudCuts: DYNAMICS_LOUD_CUTS });
}
/** 触发导出并等待下载事件。 */
export async function triggerExport(page, format) {
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
        page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS }),
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
export async function generateJizuraPv(request) {
    const { signal } = request;
    // 业务非理想结果：歌词为空 → 返回 canonical 空值，不启动浏览器。
    if (request.lyrics.trim() === '')
        return emptyResult();
    signal?.throwIfAborted();
    let browser;
    let context;
    // 取消时立刻关闭浏览器进程，让进行中的 Playwright 操作以 "target closed" 失败。
    const onAbort = () => {
        void context?.close().catch(() => undefined);
        void browser?.close().catch(() => undefined);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        browser = await chromium.launch({ headless: true });
        context = await browser.newContext({ acceptDownloads: true });
        // 从源头规避新手引导浮层（必须在下发页面脚本之前注入）。
        await context.addInitScript(TOUR_DONE_INIT_SCRIPT);
        const page = await context.newPage();
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
        let audio = {
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
            title: request.title ?? '',
            artist: request.artist ?? '',
            keyBg: request.keyBg,
            themeId: request.theme ?? null,
            style: request.stylePreset === 'auto' ? null : (preset?.style ?? null),
            mood: request.mood ?? preset?.mood ?? null,
            intensity: request.intensity ?? preset?.intensity ?? null,
            seed: request.seed ?? null,
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
        const download = await triggerExport(page, request.outputFormat);
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
            bytes: info.size,
            dynamicsApplied,
        };
    }
    finally {
        signal?.removeEventListener('abort', onAbort);
        await context?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
    }
}
