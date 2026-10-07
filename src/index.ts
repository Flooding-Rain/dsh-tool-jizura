/**
 * dsh-tool-jizura — 把歌词交给 JIZURA 在线应用，产出文字 PV。
 *
 * 本模块只做三件事：声明插件身份（`name` / `inject`）、在 `apply` 中注册
 * 唯一的工具 `generate_jizura_pv`，以及把执行体转发给 `./impl.js`。
 *
 * @module dsh-tool-jizura
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { generateJizuraPv } from './impl.js';

/** 插件标识，必须与 package.json 的 name 一致。 */
export const name = 'dsh-tool-jizura';

/** 本插件只依赖 tools 服务。 */
export const inject = ['tools'];

/** 工具名。 */
export const TOOL_NAME = 'generate_jizura_pv';

/** 面向模型的工具描述。 */
export const TOOL_DESCRIPTION =
  '调用 JIZURA 网页应用，将歌词文本自动生成为文字 PV（MP4 视频或 PNG 序列）。' +
  '提供背景音乐后会自动检测 BPM 并对齐节拍，还可指定情绪与效果强度，' +
  '并按音乐能量包络自动做段落对比（高能量段落切得更碎）。' +
  '适用场景：用户提供歌词（可附音乐），希望快速生成带动态效果的歌词视频。' +
  '注意：执行需要网络访问；渲染在浏览器内逐帧完成 —— 十几秒的短片约 1 分钟，' +
  '而全长 1080p / 60fps 要几十分钟，请预留时间。';

/** 字节数的可读化。 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 注册 `generate_jizura_pv` 工具。
 *
 * @param ctx - 已注入 `tools` 服务的插件上下文。
 */
export function apply(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: TOOL_NAME,
      description: TOOL_DESCRIPTION,
      parameters: {
        lyrics: {
          type: 'string',
          description: '歌词文本，支持多行。支持 JIZURA 记法：`/` 切分、`*强调*`、`[間奏 8]`、LRC 时间戳。',
          required: true,
        },
        audioPath: {
          type: 'string',
          description: '背景音乐文件的绝对路径。提供后 JIZURA 会自动检测 BPM 并把画面切点对齐到节拍。',
        },
        stylePreset: {
          type: 'string',
          enum: ['auto', 'light', 'dark', 'neon'],
          default: 'auto',
          description: '视觉风格预设：light 亮纸底、dark 黑底白字、neon 震撼粉；auto 完全交给随机。',
        },
        mood: {
          type: 'string',
          enum: ['glitch', 'calm', 'pop', 'graphic', 'editorial', 'emotional', 'horror', 'chaos'],
          description:
            '情绪基调，决定动效强度区间与可选手法。指定后覆盖 stylePreset 推断出的情绪。' +
            'glitch 故障感、calm 沉静、pop 活泼、graphic 平面设计感、editorial 排版感、' +
            'emotional 情绪化、horror 恐怖、chaos 全部混用。',
        },
        theme: {
          type: 'string',
          enum: ['lyricpv', 'kinetic', 'wa', 'horror', 'pop', 'ballad'],
          description: '创作主题，限定随机化的取材方向：文字PV、动态字、和风、恐怖、流行、抒情。',
        },
        intensity: {
          type: 'number',
          description:
            '效果强度 0~1，在当前情绪的强度区间内线性取值。0 最克制、1 最激烈。' +
            '省略时由 stylePreset 决定，stylePreset 为 auto 时交由随机。',
        },
        autoDynamics: {
          type: 'boolean',
          default: true,
          description:
            '是否按音乐能量自动做段落对比：能量低于中位数的行收敛为单一切分，其余行切得更碎。' +
            '仅有音频时有效。',
        },
        paletteLock: {
          type: 'boolean',
          default: false,
          description:
            '是否锁定样式的首套配色。JIZURA 的每个样式含 2~4 套配色，画面默认会在行与行之间换色；' +
            '打开后整片维持同一色调，适合需要统一意境的抒情作品。',
        },
        styleKey: {
          type: 'string',
          description:
            '直接指定 JIZURA 的样式 key，优先于 stylePreset。基础 12 个：' +
            'noir, crimson, caution, magenta, paper, hud, mint, specimen, transit, blueprint, rouge, mono；' +
            '扩展 15 个：hrRuin, hrNightRec, hrCurse, sakura, ocean, sunset, forest, vapor, ' +
            'newsprint, synth80, kraft, candy, acid, sumi, gold。key 无效时忽略并沿用 stylePreset。',
        },
        hideNo: {
          type: 'boolean',
          default: false,
          description: '是否隐藏画面上的装饰编号（如 `No.08`），可降低「工程感」。',
        },
        hideTime: {
          type: 'boolean',
          default: false,
          description: '是否隐藏画面上的装饰时间码（如 `LINE 08 · 00:36.52`）。',
        },
        aspectRatio: {
          type: 'string',
          enum: ['16:9', '9:16', '1:1'],
          default: '16:9',
          description: '输出画幅比例。',
        },
        resolution: {
          type: 'integer',
          enum: [720, 1080, 1440, 2160],
          default: 1080,
          description: '输出分辨率高度。越高渲染越慢。',
        },
        fps: {
          type: 'integer',
          enum: [24, 30, 60],
          default: 24,
          description: '输出帧率。',
        },
        quality: {
          type: 'string',
          enum: ['standard', 'high', 'max'],
          default: 'high',
          description:
            '导出画质档位，决定视频码率：按 宽×高×帧率 估算，standard 用 0.16、high 用 0.28、' +
            'max 用 0.42 的系数，再按像素量封顶（约 40~90 Mbps）。档位越高文件越大、编码越慢。',
        },
        outputFormat: {
          type: 'string',
          enum: ['mp4', 'png_sequence'],
          default: 'mp4',
          description:
            '输出格式。png_sequence 得到的是 JIZURA 原生打包的連番 PNG（ZIP），不是散开的图片。',
        },
        outputDir: {
          type: 'string',
          description: '输出目录的绝对路径。省略时落到工作目录下的 jizura-pv-output。',
        },
        title: {
          type: 'string',
          description: '曲名，显示在标题卡与 HUD 上。',
        },
        artist: {
          type: 'string',
          description: '艺术家名。',
        },
        keyBg: {
          type: 'string',
          enum: ['off', 'green', 'black'],
          default: 'off',
          description:
            '合成用背景。green / black 会把背景换成纯色并只保留白色文字与效果，' +
            '便于在剪辑软件里用抠像或滤色叠加到别的画面上。',
        },
        seed: {
          type: 'integer',
          description: '随机种子。给定后同样的输入会得到可复现的结果。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // 输出对象的字段在每次调用中都必然存在，因此全部标注 required，
            // 否则 InferValue 会把它们推断成可选，render 里就得处处判空。
            path: { type: 'string', description: '产物文件的绝对路径；空串表示未生成。', required: true },
            bpm: { type: 'number', description: 'JIZURA 检测到的 BPM；0 表示没有音频。', required: true },
            beatCount: { type: 'number', description: '检测到的拍数。', required: true },
            audioDuration: { type: 'number', description: '音频时长（秒）。', required: true },
            style: { type: 'string', description: '实际生效的样式 key。', required: true },
            mood: { type: 'string', description: '实际生效的情绪 key。', required: true },
            intensity: {
              type: 'number',
              description: '实际生效的效果强度；-1 表示由随机决定。',
              required: true,
            },
            seed: { type: 'number', description: '实际使用的随机种子，可用于复现。', required: true },
            aspect: { type: 'string', description: '画幅。', required: true },
            resolution: { type: 'number', description: '分辨率高度。', required: true },
            fps: { type: 'number', description: '帧率。', required: true },
            quality: { type: 'string', description: '导出画质档位。', required: true },
            bytes: { type: 'number', description: '产物字节数。', required: true },
            dynamicsApplied: {
              type: 'boolean',
              description: '能量驱动的段落对比是否生效。',
              required: true,
            },
          },
        },
        render: (_args, value) => {
          // 歌词为空这类「业务非理想结果」以空路径表达，在这里向用户说明，而不是抛异常。
          if (value.path === '') {
            return [{ type: 'text', text: 'PV 未生成：歌词为空，请提供至少一行歌词。' }];
          }

          const rows: string[] = [`PV 已生成: ${value.path}`];

          rows.push(
            `  画面 ${value.aspect} / ${value.resolution}p / ${value.fps}fps · ` +
              `画质 ${value.quality} · ${formatBytes(value.bytes)}`,
          );

          const look = [`样式 ${value.style}`];
          if (value.mood) look.push(`情绪 ${value.mood}`);
          if (value.intensity >= 0) look.push(`强度 ${value.intensity.toFixed(2)}`);
          rows.push(`  ${look.join(' · ')}`);

          rows.push(
            value.bpm > 0
              ? `  踩点 BPM ${value.bpm} · ${value.beatCount} 拍 · 音频 ${value.audioDuration.toFixed(1)}s`
              : '  未提供音频，本次没有踩点',
          );

          if (value.dynamicsApplied) rows.push('  已按音乐能量做段落对比');

          return [{ type: 'text', text: rows.join('\n') }];
        },
      },
      timeoutMs: 21_600_000,
      execute: (args, exec) =>
        generateJizuraPv({
          lyrics: args.lyrics,
          audioPath: args.audioPath,
          stylePreset: args.stylePreset ?? 'auto',
          mood: args.mood,
          theme: args.theme,
          intensity: args.intensity,
          autoDynamics: args.autoDynamics ?? true,
          paletteLock: args.paletteLock ?? false,
          styleKey: args.styleKey,
          hideNo: args.hideNo ?? false,
          hideTime: args.hideTime ?? false,
          aspectRatio: args.aspectRatio ?? '16:9',
          resolution: args.resolution ?? 1080,
          fps: args.fps ?? 24,
          quality: args.quality ?? 'high',
          outputFormat: args.outputFormat ?? 'mp4',
          outputDir: args.outputDir,
          title: args.title,
          artist: args.artist,
          keyBg: args.keyBg ?? 'off',
          seed: args.seed,
          signal: exec.signal,
        }),
    }),
  );
}
