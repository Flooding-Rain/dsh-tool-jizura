/**
 * dsh-tool-jizura — 把歌词交给 JIZURA 在线应用，产出文字 PV。
 *
 * 本模块只做三件事：声明插件身份（`name` / `inject`）、在 `apply` 中注册
 * 唯一的工具 `generate_jizura_pv`，以及把执行体转发给 `./impl.js`。
 *
 * @module dsh-tool-jizura
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { generateJizuraPv } from './impl.js';
/** 插件标识，必须与 package.json 的 name 一致。 */
export const name = 'dsh-tool-jizura';
/** 本插件只依赖 tools 服务。 */
export const inject = ['tools'];
/** 工具名。 */
export const TOOL_NAME = 'generate_jizura_pv';
/** 面向模型的工具描述。 */
export const TOOL_DESCRIPTION = '调用 JIZURA 网页应用，将歌词文本自动生成为文字 PV（MP4 视频或 PNG 序列）。' +
    '适用场景：用户提供歌词，希望快速生成带动态效果的歌词视频。' +
    '注意：执行需要网络访问，渲染耗时可能超过 60 秒。';
/** 歌词为空时返回的 canonical 值。 */
export const EMPTY_RESULT = '';
/**
 * 注册 `generate_jizura_pv` 工具。
 *
 * @param ctx - 已注入 `tools` 服务的插件上下文。
 */
export function apply(ctx) {
    ctx.tools.register(defineTool({
        name: TOOL_NAME,
        description: TOOL_DESCRIPTION,
        parameters: {
            lyrics: {
                type: 'string',
                description: '歌词文本，支持多行。',
                required: true,
            },
            audioPath: {
                type: 'string',
                description: '背景音乐文件的绝对路径。',
            },
            stylePreset: {
                type: 'string',
                enum: ['auto', 'light', 'dark', 'neon'],
                default: 'auto',
                description: '视觉风格预设。',
            },
            aspectRatio: {
                type: 'string',
                enum: ['16:9', '9:16', '1:1'],
                default: '16:9',
                description: '输出画幅比例。',
            },
            outputFormat: {
                type: 'string',
                enum: ['mp4', 'png_sequence'],
                default: 'mp4',
                description: '输出格式。',
            },
            outputDir: {
                type: 'string',
                description: '输出目录的绝对路径。',
            },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => [
                {
                    type: 'text',
                    // `default` 在 dsh 的 schema DSL 中只是注解、不会自动填充，
                    // 因此「歌词为空」这一业务非理想结果由 canonical 空串表达，
                    // 并在渲染层向用户说明，而不是抛异常。
                    text: value === EMPTY_RESULT ? 'PV 未生成：歌词为空，请提供至少一行歌词。' : 'PV 已生成: ' + value,
                },
            ],
        },
        timeoutMs: 120_000,
        execute: (args, exec) => generateJizuraPv({
            lyrics: args.lyrics,
            audioPath: args.audioPath,
            stylePreset: args.stylePreset ?? 'auto',
            aspectRatio: args.aspectRatio ?? '16:9',
            outputFormat: args.outputFormat ?? 'mp4',
            outputDir: args.outputDir,
            signal: exec.signal,
        }),
    }));
}
