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
import type { Download, Page } from 'playwright';
/** JIZURA 在线应用地址。 */
export declare const JIZURA_URL = "https://852wa.github.io/JIZURA/";
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
export declare const SELECTORS: {
    /**
     * 首次访问的新手引导浮层。它是 `role="dialog" aria-modal="true"` 的全屏遮罩，
     * 会吞掉整页点击。正常情况下已由 `TOUR_DONE_INIT_SCRIPT` 从源头规避，这里只作兜底。
     */
    readonly tour: readonly ['#tour'];
    /** 引导浮层里的「スキップ」按钮。 */
    readonly tourSkip: readonly ['#tour .tour-skip', '.tour-skip'];
    /** 歌词输入框：`#lyrics` 是 JIZURA 的真实 id，其余为通用兜底。 */
    readonly lyricsInput: readonly ['#lyrics', 'textarea', '[contenteditable="true"]', '[aria-label*="歌詞"]', '[aria-label*="歌词"]'];
    /** 音频文件输入。 */
    readonly audioInput: readonly ['#audioFile', 'input[type="file"][accept*="audio"]'];
    /** MP4 导出按钮：かんたん模式 / 詳細模式。 */
    readonly exportMp4: readonly ['#eMP4', '#btnMP4'];
    /** 連番 PNG（ZIP）导出按钮：かんたん模式 / 詳細模式。 */
    readonly exportPng: readonly ['#ePNG', '#btnPNG'];
    /** 「書き出し」标签页的标签按钮（詳細模式的兜底路径）。 */
    readonly outputTab: readonly ['button[role="tab"][data-tab="out"]'];
};
/**
 * 根治新手引导浮层：JIZURA 用 `localStorage['jizura.tourDone']` 判断是否首次访问
 * （见 `src/12_ui.js` 启动段）。在页面脚本执行前写入它，浮层根本不会弹出。
 *
 * 实测有效（`#tour` 可见性为 false），比事后点「スキップ」可靠得多。
 */
export declare const TOUR_DONE_INIT_SCRIPT: () => void;
/**
 * 风格预设 → 样式 key + 情绪 + 强度。
 *
 * JIZURA 没有 light/dark/neon 这类命名，它用 12 个样式包（`J.STYLES`）乘以
 * 8 种情绪（`J.MOODS`）。这里给出语义最接近的组合；`auto` 不做任何覆盖，
 * 完全交给「おまかせ」。
 */
export declare const STYLE_PRESETS: Readonly<Record<Exclude<StylePreset, 'auto'>, {
    style: string;
    mood: Mood;
    intensity: number;
}>>;
/** 默认输出目录名（相对当前工作目录）。 */
export declare const DEFAULT_OUTPUT_DIR_NAME = "jizura-pv-output";
/** 使用已解析的绝对输出目录。 */
export declare function resolveOutputDir(outputDir?: string | undefined): string;
/**
 * 为一个目标文件挑选不冲突的落盘路径。
 *
 * @param dir - 目标目录（绝对路径）。
 * @param filename - 首选文件名。
 * @returns 若首选名已存在则追加 `-1`、`-2` … 的绝对路径。
 */
export declare function uniquePath(dir: string, filename: string): string;
/** 未生成时的 canonical 结果。 */
export declare function emptyResult(): JizuraPvResult;
/** 等待 JIZURA 的应用对象 `window.J` 及其状态就绪。 */
export declare function waitForApp(page: Page): Promise<void>;
/**
 * 关闭 JIZURA 首次访问的新手引导浮层（兜底）。
 *
 * 正常路径已由 {@link TOUR_DONE_INIT_SCRIPT} 从源头规避，这里只处理
 * 「localStorage 不可用」或上游改了判定条件的情况。
 *
 * @returns 是否用「スキップ」正常关掉了浮层。
 */
export declare function dismissTour(page: Page): Promise<boolean>;
/**
 * 填入歌词：按优先级探测输入区域。
 *
 * 走真实输入路径而不是直接改 `project.lyrics`，这样 JIZURA 自己的 input 处理器
 * 会照常做解析、行列表刷新与重排。
 */
export declare function fillLyrics(page: Page, lyrics: string): Promise<string>;
/** 按需加载背景音乐。返回实际使用的选择器。 */
export declare function attachAudio(page: Page, audioPath: string): Promise<string>;
/** 从页面读回音频分析结果。 */
export declare function readAudioInfo(page: Page): Promise<{
    bpm: number;
    beatCount: number;
    audioDuration: number;
}>;
/**
 * 等待音频的异步分析完成。
 *
 * 这是踩点可靠性的关键：`J.analyzeAudio()` 内部要做 `decodeAudioData`（异步）、
 * 能量包络、onset、自相关求 BPM 与相位。不等待就导出，踩点会静默落空。
 */
export declare function waitForAudioAnalysis(page: Page, timeoutMs?: number): Promise<{
    bpm: number;
    beatCount: number;
    audioDuration: number;
}>;
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
export declare function configureProject(page: Page, options: ConfigureOptions): Promise<ConfigureResult>;
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
export declare function applyDynamics(page: Page): Promise<DynamicsResult>;
/**
 * 估算这次导出需要等多久。
 *
 * 按 plan 的总时长 × 帧率得到帧数，乘单帧预算后夹在区间内。这样短片的失败能很快暴露，
 * 而全长 1080p / 60fps 也不会在编码完成前就被判超时。
 */
export declare function estimateExportBudget(page: Page): Promise<number>;
/** 触发导出并等待下载事件；`timeoutMs` 通常由 {@link estimateExportBudget} 给出。 */
export declare function triggerExport(page: Page, format: OutputFormat, timeoutMs?: number): Promise<Download>;
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
export declare function generateJizuraPv(request: JizuraPvRequest): Promise<JizuraPvResult>;
export {};
