/**
 * dsh-tool-jizura — 把歌词交给 JIZURA 在线应用，产出文字 PV。
 *
 * 本模块只做三件事：声明插件身份（`name` / `inject`）、在 `apply` 中注册
 * 唯一的工具 `generate_jizura_pv`，以及把执行体转发给 `./impl.js`。
 *
 * @module dsh-tool-jizura
 */
import type { Context } from '@deepseek-ai/cordis';
/** 插件标识，必须与 package.json 的 name 一致。 */
export declare const name = "dsh-tool-jizura";
/** 本插件只依赖 tools 服务。 */
export declare const inject: string[];
/** 工具名。 */
export declare const TOOL_NAME = "generate_jizura_pv";
/** 面向模型的工具描述。 */
export declare const TOOL_DESCRIPTION: string;
/** 歌词为空时返回的 canonical 值。 */
export declare const EMPTY_RESULT = "";
/**
 * 注册 `generate_jizura_pv` 工具。
 *
 * @param ctx - 已注入 `tools` 服务的插件上下文。
 */
export declare function apply(ctx: Context): void;
