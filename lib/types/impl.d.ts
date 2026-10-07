/**
 * `generate_jizura_pv` 的浏览器自动化实现。
 *
 * 该模块只负责「驱动 JIZURA 网页 → 产出文件 → 返回绝对路径」这一件事，
 * 不依赖 dsh 运行时，因此可以脱离宿主单独测试。
 *
 * @module dsh-tool-jizura/impl
 */
import type { Download, Page } from 'playwright';
/** JIZURA 在线应用地址。 */
export declare const JIZURA_URL = "https://852wa.github.io/JIZURA/";
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
export declare const SELECTORS: {
    /** 歌词输入框：`#lyrics` 是 JIZURA 的真实 id，其余为通用兜底。 */
    readonly lyricsInput: readonly ['#lyrics', 'textarea', '[contenteditable="true"]', '[aria-label*="歌詞"]', '[aria-label*="歌词"]'];
    /** 音频文件输入。 */
    readonly audioInput: readonly ['#audioFile', 'input[type="file"][accept*="audio"]'];
    /** 切到「かんたん」模式，让 `#btnOmakaseBig` 从 hidden 变为可见。 */
    readonly modeEasy: readonly ['#modeEasy'];
    /** かんたん模式面板；`#btnOmakaseBig` 位于其中且默认 `hidden`。 */
    readonly easyPanel: readonly ['#easyPanel'];
    /** 「おまかせで作る」大按钮（かんたん模式）。 */
    readonly omakasePrimary: readonly ['#btnOmakaseBig'];
    /** 「おまかせ」兜底按钮（詳細模式）。 */
    readonly omakaseFallback: readonly ['#btnOmakase', '#btnOmakaseTop'];
    /** 画幅比例：かんたん模式 / 詳細模式「書き出し」标签页。 */
    readonly aspect: readonly ['#eAspect', '#outAspect'];
    /** 「書き出し」标签页的标签按钮。 */
    readonly outputTab: readonly ['button[role="tab"][data-tab="out"]'];
    /** 「スタイル」标签页的标签按钮。 */
    readonly styleTab: readonly ['button[role="tab"][data-tab="style"]'];
    /** MP4 导出按钮：かんたん模式 / 詳細模式。 */
    readonly exportMp4: readonly ['#eMP4', '#btnMP4'];
    /** 連番 PNG（ZIP）导出按钮：かんたん模式 / 詳細模式。 */
    readonly exportPng: readonly ['#ePNG', '#btnPNG'];
};
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
export declare const STYLE_PRESET_TO_KEY: Readonly<Record<Exclude<StylePreset, 'auto'>, string>>;
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
/**
 * 填入歌词：按优先级探测输入区域。
 *
 * 对 `textarea` 用 `fill`，对 `contenteditable` 用 `fill` 亦可
 * （Playwright 会走 `textContent` + 输入事件），因此两种都兼容。
 */
export declare function fillLyrics(page: Page, lyrics: string): Promise<string>;
/** 按需加载背景音乐。返回实际使用的选择器。 */
export declare function attachAudio(page: Page, audioPath: string): Promise<string>;
/** 在 `<select>` 上选择画幅比例。返回是否成功。 */
export declare function selectAspectRatio(page: Page, aspectRatio: AspectRatio): Promise<boolean>;
/** 点击「おまかせで作る」。返回实际点击到的选择器。 */
export declare function clickOmakase(page: Page): Promise<string>;
/**
 * 应用视觉风格预设。
 *
 * 必须在「おまかせ」**之后**调用：おまかせ会重新随机 `style`，先设会被覆盖。
 */
export declare function applyStylePreset(page: Page, preset: StylePreset): Promise<string | undefined>;
/** 触发导出并等待下载事件。 */
export declare function triggerExport(page: Page, format: OutputFormat): Promise<Download>;
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
export declare function generateJizuraPv(request: JizuraPvRequest): Promise<string>;
