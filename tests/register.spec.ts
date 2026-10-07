/**
 * 注册契约测试。
 *
 * 屏蔽 `@deepseek-ai/dsh-tools`，让 `defineTool` 变成透传的 spy，
 * 从而直接断言插件交给 dsh 的工具定义形状是否符合契约。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const defineToolMock = vi.hoisted(() => vi.fn((options: unknown) => options));

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: defineToolMock,
}));

import * as plugin from '../src/index.js';

/** `ctx.tools.register` 的替身。 */
const register = vi.fn();

/** 构造一个只暴露 tools 服务的最小上下文。 */
function makeContext() {
  return { tools: { register } } as never;
}

/** 取出 `apply` 注册的那一个工具定义。 */
function registeredDefinition(): Record<string, unknown> {
  expect(register).toHaveBeenCalledTimes(1);
  return register.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('dsh-tool-jizura 注册契约', () => {
  beforeEach(() => {
    register.mockClear();
    defineToolMock.mockClear();
  });

  it('暴露 dsh 约定的 name 与 inject', () => {
    expect(plugin.name).toBe('dsh-tool-jizura');
    expect(plugin.inject).toEqual(['tools']);
  });

  it('apply 只通过 defineTool 注册一个工具', () => {
    plugin.apply(makeContext());

    expect(defineToolMock).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('工具名与描述符合契约', () => {
    plugin.apply(makeContext());
    const definition = registeredDefinition();

    expect(definition['name']).toBe('generate_jizura_pv');
    expect(definition['description']).toContain('JIZURA');
    expect(definition['description']).toContain('歌词');
    expect(definition['description']).toContain('网络访问');
  });

  it('timeoutMs 为 120000', () => {
    plugin.apply(makeContext());
    expect(registeredDefinition()['timeoutMs']).toBe(120000);
  });

  it('parameters 声明的属性与必填标记正确', () => {
    plugin.apply(makeContext());
    const parameters = registeredDefinition()['parameters'] as Record<string, Record<string, unknown>>;

    expect(Object.keys(parameters).sort()).toEqual(
      ['aspectRatio', 'audioPath', 'lyrics', 'outputDir', 'outputFormat', 'stylePreset'].sort(),
    );

    expect(parameters['lyrics']).toMatchObject({ type: 'string', required: true });
    expect(parameters['audioPath']).toMatchObject({ type: 'string' });
    expect(parameters['outputDir']).toMatchObject({ type: 'string' });

    // 可选参数不应带 required 标记。
    expect(parameters['audioPath']?.['required']).toBeUndefined();
    expect(parameters['stylePreset']?.['required']).toBeUndefined();
  });

  it('枚举参数取值与默认值符合契约', () => {
    plugin.apply(makeContext());
    const parameters = registeredDefinition()['parameters'] as Record<string, Record<string, unknown>>;

    expect(parameters['stylePreset']).toMatchObject({
      type: 'string',
      enum: ['auto', 'light', 'dark', 'neon'],
      default: 'auto',
    });
    expect(parameters['aspectRatio']).toMatchObject({
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      default: '16:9',
    });
    expect(parameters['outputFormat']).toMatchObject({
      type: 'string',
      enum: ['mp4', 'png_sequence'],
      default: 'mp4',
    });
  });

  it('output.schema 是 string，render 返回 text block', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      schema: unknown;
      render: (args: unknown, value: string) => unknown;
    };

    expect(output.schema).toEqual({ type: 'string' });

    expect(output.render({}, '/tmp/pv.mp4')).toEqual([
      { type: 'text', text: 'PV 已生成: /tmp/pv.mp4' },
    ]);
  });

  it('歌词为空时 render 给出提示而不是声称已生成', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      render: (args: unknown, value: string) => { type: string; text: string }[];
    };

    const blocks = output.render({}, '');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('未生成');
    expect(blocks[0]?.text).not.toContain('PV 已生成');
  });

  it('execute 已实现', () => {
    plugin.apply(makeContext());
    expect(typeof registeredDefinition()['execute']).toBe('function');
  });
});
