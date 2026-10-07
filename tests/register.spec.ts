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

/** 一份形状完整的 canonical 输出值。 */
function makeValue(overrides: Record<string, unknown> = {}) {
  return {
    path: '/tmp/pv.mp4',
    bpm: 120,
    beatCount: 25,
    audioDuration: 12,
    style: 'noir',
    mood: 'emotional',
    intensity: 0.65,
    seed: 42,
    aspect: '16:9',
    resolution: 1080,
    fps: 24,
    quality: 'high',
    bytes: 20_423_484,
    dynamicsApplied: true,
    ...overrides,
  };
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
    expect(definition['description']).toContain('BPM');
    expect(definition['description']).toContain('网络访问');
  });

  // 全长 1080p / 60fps（一首 3 分半的歌约 13000 帧）在无头软件编码下要几十分钟，
  // 所以这个上限必须明显大于「短视频」量级，否则工具会在下载事件之前就被判超时。
  it('timeoutMs 覆盖浏览器启动 + 音频分析 + 视频编码', () => {
    plugin.apply(makeContext());
    expect(registeredDefinition()['timeoutMs']).toBe(21600000);
  });

  it('parameters 声明的属性完整', () => {
    plugin.apply(makeContext());
    const parameters = registeredDefinition()['parameters'] as Record<string, Record<string, unknown>>;

    expect(Object.keys(parameters).sort()).toEqual(
      [
        'aspectRatio',
        'artist',
        'audioPath',
        'autoDynamics',
        'fps',
        'hideNo',
        'hideTime',
        'intensity',
        'keyBg',
        'lyrics',
        'mood',
        'outputDir',
        'outputFormat',
        'paletteLock',
        'quality',
        'resolution',
        'seed',
        'styleKey',
        'stylePreset',
        'theme',
        'title',
      ].sort(),
    );
  });

  it('只有 lyrics 是必填', () => {
    plugin.apply(makeContext());
    const parameters = registeredDefinition()['parameters'] as Record<string, Record<string, unknown>>;

    expect(parameters['lyrics']).toMatchObject({ type: 'string', required: true });

    for (const key of Object.keys(parameters)) {
      if (key === 'lyrics') continue;
      expect(parameters[key]?.['required']).toBeUndefined();
    }
  });

  it('枚举参数取值与默认值符合契约', () => {
    plugin.apply(makeContext());
    const parameters = registeredDefinition()['parameters'] as Record<string, Record<string, unknown>>;

    expect(parameters['stylePreset']).toMatchObject({
      type: 'string',
      enum: ['auto', 'light', 'dark', 'neon'],
      default: 'auto',
    });
    expect(parameters['mood']).toMatchObject({
      type: 'string',
      enum: ['glitch', 'calm', 'pop', 'graphic', 'editorial', 'emotional', 'horror', 'chaos'],
    });
    expect(parameters['theme']).toMatchObject({
      type: 'string',
      enum: ['lyricpv', 'kinetic', 'wa', 'horror', 'pop', 'ballad'],
    });
    expect(parameters['aspectRatio']).toMatchObject({
      type: 'string',
      enum: ['16:9', '9:16', '1:1'],
      default: '16:9',
    });
    expect(parameters['resolution']).toMatchObject({ type: 'integer', enum: [720, 1080, 1440, 2160], default: 1080 });
    expect(parameters['fps']).toMatchObject({ type: 'integer', enum: [24, 30, 60], default: 24 });
    expect(parameters['quality']).toMatchObject({
      type: 'string',
      enum: ['standard', 'high', 'max'],
      default: 'high',
    });
    expect(parameters['outputFormat']).toMatchObject({
      type: 'string',
      enum: ['mp4', 'png_sequence'],
      default: 'mp4',
    });
    expect(parameters['keyBg']).toMatchObject({ type: 'string', enum: ['off', 'green', 'black'], default: 'off' });
    expect(parameters['autoDynamics']).toMatchObject({ type: 'boolean', default: true });
    expect(parameters['paletteLock']).toMatchObject({ type: 'boolean', default: false });
    expect(parameters['hideNo']).toMatchObject({ type: 'boolean', default: false });
    expect(parameters['hideTime']).toMatchObject({ type: 'boolean', default: false });
    expect(parameters['styleKey']).toMatchObject({ type: 'string' });
    expect(parameters['intensity']).toMatchObject({ type: 'number' });
    expect(parameters['seed']).toMatchObject({ type: 'integer' });
  });

  it('output.schema 是带全字段的对象', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as { schema: Record<string, unknown> };
    const schema = output.schema;

    expect(schema['type']).toBe('object');
    expect(schema['additionalProperties']).toBe(false);

    const properties = schema['properties'] as Record<string, unknown>;
    expect(Object.keys(properties).sort()).toEqual(
      [
        'aspect',
        'audioDuration',
        'bpm',
        'beatCount',
        'bytes',
        'dynamicsApplied',
        'fps',
        'intensity',
        'mood',
        'path',
        'quality',
        'resolution',
        'seed',
        'style',
      ].sort(),
    );

    // 输出字段必须全部 required，否则 InferValue 会把它们推成可选。
    for (const key of Object.keys(properties)) {
      expect((properties[key] as Record<string, unknown>)['required']).toBe(true);
    }
  });

  it('render 把结构化结果整理成可读文本', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      render: (args: unknown, value: unknown) => { type: string; text: string }[];
    };

    const blocks = output.render({}, makeValue());
    expect(blocks).toHaveLength(1);
    const text = blocks[0]?.text ?? '';

    expect(text).toContain('PV 已生成: /tmp/pv.mp4');
    expect(text).toContain('16:9');
    expect(text).toContain('1080p');
    expect(text).toContain('画质 high');
    expect(text).toContain('BPM 120');
    expect(text).toContain('25 拍');
    expect(text).toContain('noir');
    expect(text).toContain('emotional');
    expect(text).toContain('强度 0.65');
    expect(text).toContain('19.5 MB');
    expect(text).toContain('段落对比');
  });

  it('render 在没有音频时说明本次没有踩点', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      render: (args: unknown, value: unknown) => { type: string; text: string }[];
    };

    const text = output.render({}, makeValue({ bpm: 0, beatCount: 0, audioDuration: 0 }))[0]?.text ?? '';
    expect(text).toContain('未提供音频');
    expect(text).not.toContain('BPM');
  });

  it('render 在强度交给随机时不显示强度', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      render: (args: unknown, value: unknown) => { type: string; text: string }[];
    };

    const text = output.render({}, makeValue({ intensity: -1 }))[0]?.text ?? '';
    expect(text).not.toContain('强度');
  });

  it('歌词为空时 render 给出提示而不是声称已生成', () => {
    plugin.apply(makeContext());
    const output = registeredDefinition()['output'] as {
      render: (args: unknown, value: unknown) => { type: string; text: string }[];
    };

    const blocks = output.render({}, makeValue({ path: '' }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.text).toContain('未生成');
    expect(blocks[0]?.text).not.toContain('PV 已生成');
  });

  it('execute 已实现', () => {
    plugin.apply(makeContext());
    expect(typeof registeredDefinition()['execute']).toBe('function');
  });
});
