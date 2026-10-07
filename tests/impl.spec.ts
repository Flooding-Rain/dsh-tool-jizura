/**
 * 逻辑测试。
 *
 * 用 `vi.mock('playwright')` 替换整个浏览器层，因此不需要真实 Chromium。
 * 覆盖：引导浮层根治、音频异步分析等待、风格/情绪/强度注入、能量驱动的段落对比、
 * 结构化返回、取消信号清理、空歌词短路、导航失败与音频超时。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyDynamics,
  configureProject,
  emptyResult,
  generateJizuraPv,
  resolveOutputDir,
  uniquePath,
} from '../src/impl.js';

/** Playwright 替身共享的状态；`vi.hoisted` 保证在 `vi.mock` 工厂之前完成初始化。 */
const m = vi.hoisted(() => ({
  launch: vi.fn(),
  goto: vi.fn(),
  fill: vi.fn(),
  setInputFiles: vi.fn(),
  setDefaultTimeout: vi.fn(),
  waitForFunction: vi.fn(),
  waitForEvent: vi.fn(),
  evaluate: vi.fn(),
  addStyleTag: vi.fn(),
  addInitScript: vi.fn(),
  browserClose: vi.fn(),
  contextClose: vi.fn(),
  /** 选择器 → 是否存在。 */
  present: new Set<string>(),
  /** 选择器 → 是否可见。 */
  visible: new Set<string>(),
  /** 传给 `page.evaluate` 的第二参数，按调用顺序。 */
  evaluateArgs: [] as unknown[],
  /** 被点击过的选择器，按顺序。 */
  clicked: [] as string[],
  /** 音频分析的假结果。 */
  audioInfo: { bpm: 120, beatCount: 25, audioDuration: 12 },
  /** 配置注入的假结果。 */
  configureResult: { style: 'noir', mood: 'emotional', seed: 42 },
  /** 段落对比的假结果。 */
  dynamicsResult: { lines: 4, loud: 3, quiet: 1 },
  /** 是否让音频分析超时。 */
  audioAnalysisFails: false,
}));

vi.mock('playwright', () => ({
  chromium: { launch: m.launch },
}));

/** 构造一个由 `m.present` / `m.visible` 驱动的 locator 替身。 */
function locatorFor(selector: string) {
  return {
    first: () => locatorFor(selector),
    count: async () => (m.present.has(selector) ? 1 : 0),
    isVisible: async () => m.visible.has(selector),
    fill: async (value: string) => {
      m.fill(value);
    },
    click: async () => {
      m.clicked.push(selector);
    },
    waitFor: async () => {
      // 与真实 Playwright 一致：元素不存在时等待会超时失败。
      if (!m.present.has(selector)) throw new Error(`Timeout waiting for ${selector}`);
      return undefined;
    },
  };
}

const page = {
  setDefaultTimeout: m.setDefaultTimeout,
  goto: m.goto,
  locator: (selector: string) => locatorFor(selector),
  setInputFiles: m.setInputFiles,
  waitForFunction: m.waitForFunction,
  waitForEvent: m.waitForEvent,
  evaluate: m.evaluate,
  addStyleTag: m.addStyleTag,
};

const context = {
  close: m.contextClose,
  newPage: async () => page,
  addInitScript: m.addInitScript,
};

const browser = {
  close: m.browserClose,
  newContext: async () => context,
};

/** 让页面像真实 JIZURA 那样拥有主流程需要的元素。 */
function seedDefaultDom(): void {
  for (const selector of ['#lyrics', '#audioFile', '#eMP4', '#ePNG']) {
    m.present.add(selector);
    m.visible.add(selector);
  }
}

/** 每轮测试创建的临时输出目录。 */
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-tool-jizura-'));
  tempDirs.push(dir);
  return dir;
}

/** 取出传给 evaluate 的那个配置对象。 */
function configureArg(): Record<string, unknown> | undefined {
  return m.evaluateArgs.find(
    (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && 'aspect' in a,
  );
}

/** 一个最小可用的请求。 */
function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    lyrics: '夜明けの色を/覚えてる\n*透明*なままの街',
    stylePreset: 'auto' as const,
    autoDynamics: true,
    aspectRatio: '16:9' as const,
    resolution: 1080 as const,
    fps: 24 as const,
    outputFormat: 'mp4' as const,
    keyBg: 'off' as const,
    ...overrides,
  };
}

describe('generate_jizura_pv 实现', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.present.clear();
    m.visible.clear();
    m.clicked.length = 0;
    m.evaluateArgs.length = 0;
    m.audioAnalysisFails = false;
    seedDefaultDom();

    m.launch.mockResolvedValue(browser);
    m.goto.mockResolvedValue(null);
    m.browserClose.mockResolvedValue(undefined);
    m.contextClose.mockResolvedValue(undefined);
    m.addInitScript.mockResolvedValue(undefined);
    m.addStyleTag.mockResolvedValue(undefined);

    // 等待逻辑按传入函数的特征分流，而不是依赖调用次数。
    m.waitForFunction.mockImplementation(async (fn: unknown) => {
      const src = typeof fn === 'function' ? fn.toString() : '';
      if (src.includes('J.ui.audio') && m.audioAnalysisFails) {
        throw new Error('Timeout waiting for audio');
      }
      return undefined;
    });

    // evaluate 同样按函数特征分流。
    m.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) => {
      m.evaluateArgs.push(arg);
      const src = typeof fn === 'function' ? fn.toString() : '';
      if (src.includes('a.bpm')) return m.audioInfo;
      if (src.includes('cfg.aspect')) return m.configureResult;
      if (src.includes('quietRatio')) return m.dynamicsResult;
      return {};
    });
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('从源头注入 localStorage 来规避新手引导浮层', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'pv.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'fake-mp4-bytes');
      },
    });

    await generateJizuraPv(makeRequest({ outputDir }));

    // addInitScript 必须在下发页面脚本前注册，且写入的是 tourDone 标记。
    expect(m.addInitScript).toHaveBeenCalledTimes(1);
    const script = m.addInitScript.mock.calls[0]?.[0];
    expect(typeof script).toBe('function');
    expect(String(script)).toContain('jizura.tourDone');
  });

  it('生成 PV 后返回结构化结果，且路径指向真实存在的文件', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'jizura-pv.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'fake-mp4-bytes');
      },
    });

    const result = await generateJizuraPv(
      makeRequest({ outputDir, audioPath: join(outputDir, 'song.mp3') }),
    );

    expect(result.path).toBe(join(outputDir, 'jizura-pv.mp4'));
    expect(existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.aspect).toBe('16:9');
    expect(result.resolution).toBe(1080);
    expect(result.fps).toBe(24);
    expect(result.style).toBe('noir');
    expect(result.mood).toBe('emotional');
    expect(result.seed).toBe(42);
    // 给了音频，所以踩点与段落对比都应当生效。
    expect(result.bpm).toBe(120);
    expect(result.dynamicsApplied).toBe(true);

    // 浏览器进程在 finally 中被关闭。
    expect(m.browserClose).toHaveBeenCalled();
    expect(m.contextClose).toHaveBeenCalled();
  });

  it('提供音频时会等待异步分析完成并读回 BPM 证据', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'beat.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    const result = await generateJizuraPv(
      makeRequest({ outputDir, audioPath: join(outputDir, 'song.mp3') }),
    );

    // 等待函数里出现了对 J.ui.audio 的探测 —— 这就是"等踩点完成"的依据。
    const waitedForAudio = m.waitForFunction.mock.calls.some((call) =>
      String(call[0]).includes('J.ui.audio'),
    );
    expect(waitedForAudio).toBe(true);

    expect(result.bpm).toBe(120);
    expect(result.beatCount).toBe(25);
    expect(result.audioDuration).toBe(12);

    expect(m.setInputFiles).toHaveBeenCalledTimes(1);
    expect(m.setInputFiles.mock.calls[0]?.[1]).toBe(join(outputDir, 'song.mp3'));
  });

  it('stylePreset 会展开成 style + mood + intensity 注入页面', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'preset.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    await generateJizuraPv(makeRequest({ outputDir, stylePreset: 'dark' }));

    expect(configureArg()).toMatchObject({
      style: 'noir',
      mood: 'emotional',
      intensity: 0.65,
      aspect: '16:9',
      resolution: 1080,
      fps: 24,
      keyBg: 'off',
    });
  });

  it('显式 mood / intensity / theme / seed 会覆盖预设推断值', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'explicit.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    await generateJizuraPv(
      makeRequest({
        outputDir,
        stylePreset: 'dark',
        mood: 'calm',
        intensity: 0.2,
        theme: 'ballad',
        seed: 1234,
        title: '曲名',
        artist: '歌手',
        keyBg: 'green',
      }),
    );

    expect(configureArg()).toMatchObject({
      style: 'noir',
      mood: 'calm',
      intensity: 0.2,
      themeId: 'ballad',
      seed: 1234,
      title: '曲名',
      artist: '歌手',
      keyBg: 'green',
    });
  });

  it('显式传入 seed 时返回该 seed，便于复现', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'seeded.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    const result = await generateJizuraPv(makeRequest({ outputDir, seed: 20261007 }));

    // configureProject 返回的是 omakase 派生的 seed，但对外应当是调用方给的复现键。
    expect(result.seed).toBe(20261007);
  });

  it('stylePreset 为 auto 时不覆盖样式，交给随机', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'auto.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    await generateJizuraPv(makeRequest({ outputDir, stylePreset: 'auto' }));

    expect(configureArg()).toMatchObject({ style: null, mood: null, intensity: null });
  });

  it('有音频且 autoDynamics 开启时应用能量段落对比', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'dyn.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    const result = await generateJizuraPv(
      makeRequest({ outputDir, audioPath: join(outputDir, 'a.mp3') }),
    );

    const dynamicsArg = m.evaluateArgs.find(
      (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && 'quietRatio' in a,
    );
    expect(dynamicsArg).toBeDefined();
    expect(dynamicsArg?.['quietCuts']).toBe(1);
    expect(dynamicsArg?.['loudCuts']).toBe(3);
    expect(result.dynamicsApplied).toBe(true);
  });

  it('autoDynamics 关闭时不应用段落对比', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'nodyn.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    const result = await generateJizuraPv(
      makeRequest({ outputDir, audioPath: join(outputDir, 'a.mp3'), autoDynamics: false }),
    );

    const dynamicsArg = m.evaluateArgs.find(
      (a): a is Record<string, unknown> => typeof a === 'object' && a !== null && 'quietRatio' in a,
    );
    expect(dynamicsArg).toBeUndefined();
    expect(result.dynamicsApplied).toBe(false);
  });

  it('没有音频时不做段落对比', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'noaudio.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    const result = await generateJizuraPv(makeRequest({ outputDir }));

    expect(result.bpm).toBe(0);
    expect(result.beatCount).toBe(0);
    expect(result.dynamicsApplied).toBe(false);
  });

  it('png_sequence 走連番 PNG 导出按钮', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'frames.zip',
      saveAs: async (target: string) => {
        await writeFile(target, 'zip');
      },
    });

    const result = await generateJizuraPv(makeRequest({ outputDir, outputFormat: 'png_sequence' }));

    expect(m.clicked).toContain('#ePNG');
    expect(result.path.endsWith('frames.zip')).toBe(true);
  });

  it('取消信号触发时关闭浏览器进程', async () => {
    const outputDir = await makeTempDir();
    const controller = new AbortController();

    // 页面导航永不自行完成，只在取消时以 "target closed" 失败。
    m.goto.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Target page, context or browser has been closed')),
            { once: true },
          );
        }),
    );

    const pending = generateJizuraPv(makeRequest({ outputDir, signal: controller.signal }));

    await vi.waitFor(() => {
      expect(m.goto).toHaveBeenCalled();
    });

    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(m.browserClose).toHaveBeenCalled();
    expect(m.contextClose).toHaveBeenCalled();
  });

  it('歌词为空时返回 canonical 空结果且不启动浏览器', async () => {
    const result = await generateJizuraPv(makeRequest({ lyrics: '   \n  ' }));

    expect(result).toEqual(emptyResult());
    expect(result.path).toBe('');
    expect(m.launch).not.toHaveBeenCalled();
  });

  it('音频分析超时时抛错并清理浏览器', async () => {
    const outputDir = await makeTempDir();
    m.audioAnalysisFails = true;

    await expect(
      generateJizuraPv(makeRequest({ outputDir, audioPath: join(outputDir, 'bad.flac') })),
    ).rejects.toThrow(/没有完成分析/);

    expect(m.browserClose).toHaveBeenCalled();
  });

  it('页面加载失败时直接抛出并清理浏览器', async () => {
    m.goto.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await expect(generateJizuraPv(makeRequest())).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
    expect(m.browserClose).toHaveBeenCalled();
  });
});

describe('可单独调用的页面操作', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.evaluateArgs.length = 0;
    m.evaluate.mockImplementation(async (fn: unknown, arg?: unknown) => {
      m.evaluateArgs.push(arg);
      const src = typeof fn === 'function' ? fn.toString() : '';
      if (src.includes('cfg.aspect')) return m.configureResult;
      if (src.includes('quietRatio')) return m.dynamicsResult;
      return {};
    });
  });

  it('configureProject 会把 omakase 与显式覆盖一起下发，并返回实际生效值', async () => {
    const result = await configureProject(page as never, {
      aspect: '9:16',
      resolution: 2160,
      fps: 60,
      title: 't',
      artist: 'a',
      keyBg: 'black',
      themeId: 'wa',
      style: 'paper',
      mood: 'calm',
      intensity: 0.4,
      seed: 7,
    });

    expect(result).toEqual({ style: 'noir', mood: 'emotional', seed: 42 });
    expect(configureArg()).toMatchObject({ aspect: '9:16', resolution: 2160, fps: 60, themeId: 'wa' });
  });

  it('applyDynamics 返回行数统计', async () => {
    const result = await applyDynamics(page as never);
    expect(result).toEqual({ lines: 4, loud: 3, quiet: 1 });
  });
});

describe('路径辅助函数', () => {
  it('resolveOutputDir 省略时回退到工作目录下的默认子目录', () => {
    expect(resolveOutputDir(undefined)).toBe(join(process.cwd(), 'jizura-pv-output'));
    expect(resolveOutputDir('')).toBe(join(process.cwd(), 'jizura-pv-output'));
  });

  it('resolveOutputDir 把相对路径解析为绝对路径', () => {
    expect(resolveOutputDir('out').startsWith(process.cwd())).toBe(true);
  });

  it('uniquePath 在文件已存在时追加序号', async () => {
    const dir = await makeTempDir();
    const first = join(dir, 'pv.mp4');
    await writeFile(first, 'x');

    const second = uniquePath(dir, 'pv.mp4');
    expect(second).toBe(join(dir, 'pv-1.mp4'));

    await writeFile(second, 'x');
    expect(uniquePath(dir, 'pv.mp4')).toBe(join(dir, 'pv-2.mp4'));
  });
});
