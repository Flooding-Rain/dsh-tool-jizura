/**
 * 逻辑测试。
 *
 * 用 `vi.mock('playwright')` 替换整个浏览器层，因此不需要真实 Chromium：
 * 既验证「生成 → 落盘 → 返回存在路径」的主链路，也验证取消信号下的进程清理。
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { generateJizuraPv, resolveOutputDir, uniquePath } from '../src/impl.js';

/** Playwright 替身共享的状态；`vi.hoisted` 保证在 `vi.mock` 工厂之前完成初始化。 */
const m = vi.hoisted(() => ({
  launch: vi.fn(),
  goto: vi.fn(),
  fill: vi.fn(),
  setInputFiles: vi.fn(),
  selectOption: vi.fn(),
  click: vi.fn(),
  setDefaultTimeout: vi.fn(),
  waitForEvent: vi.fn(),
  browserClose: vi.fn(),
  contextClose: vi.fn(),
  /** 选择器 → 是否存在。 */
  present: new Set<string>(),
  /** 选择器 → 是否可见。 */
  visible: new Set<string>(),
  /** 被点击过的选择器，按顺序。 */
  clicked: [] as string[],
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
      m.click(selector);
    },
    selectOption: async (value: string) => {
      m.selectOption(value);
    },
    waitFor: async () => undefined,
  };
}

/** 当前测试使用的 page / context / browser 替身。 */
const page = {
  setDefaultTimeout: m.setDefaultTimeout,
  goto: m.goto,
  locator: (selector: string) => locatorFor(selector),
  setInputFiles: m.setInputFiles,
  waitForEvent: m.waitForEvent,
};

const context = {
  close: m.contextClose,
  newPage: async () => page,
};

const browser = {
  close: m.browserClose,
  newContext: async () => context,
};

/** 让页面像真实 JIZURA 那样拥有主流程需要的元素。 */
function seedDefaultDom(): void {
  for (const selector of [
    '#lyrics',
    '#audioFile',
    '#eAspect',
    '#modeEasy',
    '#easyPanel',
    '#btnOmakaseBig',
    '#eMP4',
    '#ePNG',
  ]) {
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

/** 等待一个微任务轮次之外的推进，让被测代码走到下一步。 */
const flush = () => new Promise((r) => {
  setTimeout(r, 0);
});

describe('generate_jizura_pv 实现', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.present.clear();
    m.visible.clear();
    m.clicked.length = 0;
    seedDefaultDom();

    m.launch.mockResolvedValue(browser);
    m.goto.mockResolvedValue(null);
    m.browserClose.mockResolvedValue(undefined);
    m.contextClose.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });

  it('生成 PV 后返回一个真实存在的文件路径', async () => {
    const outputDir = await makeTempDir();
    const lyrics = '夜明けの色を/覚えてる\n*透明*';

    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'jizura-pv.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'fake-mp4-bytes');
      },
    });

    const result = await generateJizuraPv({
      lyrics,
      stylePreset: 'auto',
      aspectRatio: '16:9',
      outputFormat: 'mp4',
      outputDir,
    });

    // 返回的是绝对路径，且文件确实落盘了。
    expect(result).toBe(join(outputDir, 'jizura-pv.mp4'));
    expect(existsSync(result)).toBe(true);

    // 歌词确实被写进了输入区。
    expect(m.fill).toHaveBeenCalledWith(lyrics);

    // 画幅比例被选中。
    expect(m.selectOption).toHaveBeenCalledWith('16:9');

    // 点到了「おまかせで作る」。
    expect(m.clicked).toContain('#btnOmakaseBig');

    // 浏览器进程在 finally 中被关闭。
    expect(m.browserClose).toHaveBeenCalled();
    expect(m.contextClose).toHaveBeenCalled();
  });

  it('audioPath 存在时通过 setInputFiles 加载音频', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'with-audio.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    await generateJizuraPv({
      lyrics: '一行的歌词',
      audioPath: join(outputDir, 'song.mp3'),
      stylePreset: 'auto',
      aspectRatio: '9:16',
      outputFormat: 'mp4',
      outputDir,
    });

    expect(m.setInputFiles).toHaveBeenCalledTimes(1);
    expect(m.setInputFiles.mock.calls[0]?.[1]).toBe(join(outputDir, 'song.mp3'));
    expect(m.selectOption).toHaveBeenCalledWith('9:16');
  });

  it('非 auto 的风格预设会点击对应样式卡片', async () => {
    const outputDir = await makeTempDir();
    for (const selector of ['button[role="tab"][data-tab="style"]', '#styleGrid button[data-k="noir"]']) {
      m.present.add(selector);
      m.visible.add(selector);
    }
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'dark.mp4',
      saveAs: async (target: string) => {
        await writeFile(target, 'x');
      },
    });

    await generateJizuraPv({
      lyrics: '暗い夜',
      stylePreset: 'dark',
      aspectRatio: '1:1',
      outputFormat: 'mp4',
      outputDir,
    });

    expect(m.clicked).toContain('#styleGrid button[data-k="noir"]');
    // 样式必须在「おまかせ」之后应用，否则会被重掷覆盖。
    expect(m.clicked.indexOf('#btnOmakaseBig')).toBeLessThan(
      m.clicked.indexOf('#styleGrid button[data-k="noir"]'),
    );
  });

  it('png_sequence 走連番 PNG 导出按钮', async () => {
    const outputDir = await makeTempDir();
    m.waitForEvent.mockResolvedValue({
      suggestedFilename: () => 'frames.zip',
      saveAs: async (target: string) => {
        await writeFile(target, 'zip');
      },
    });

    const result = await generateJizuraPv({
      lyrics: '連番',
      stylePreset: 'auto',
      aspectRatio: '16:9',
      outputFormat: 'png_sequence',
      outputDir,
    });

    expect(m.clicked).toContain('#ePNG');
    expect(result.endsWith('frames.zip')).toBe(true);
  });

  it('取消信号触发时关闭浏览器进程', async () => {
    const outputDir = await makeTempDir();
    const controller = new AbortController();

    // 页面导航永不自行完成，只在取消时以 "target closed" 失败，
    // 模拟 Playwright 在浏览器被关闭后的真实表现。
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

    const pending = generateJizuraPv({
      lyrics: 'キャンセル',
      stylePreset: 'auto',
      aspectRatio: '16:9',
      outputFormat: 'mp4',
      outputDir,
      signal: controller.signal,
    });

    // 等流程真正走到导航，再触发取消。
    await vi.waitFor(() => {
      expect(m.goto).toHaveBeenCalled();
    });
    await flush();

    controller.abort();

    await expect(pending).rejects.toThrow();

    // 取消处理器立刻关闭进程，finally 再兜底一次。
    expect(m.browserClose).toHaveBeenCalled();
    expect(m.contextClose).toHaveBeenCalled();
  });

  it('歌词为空时返回空串且不启动浏览器', async () => {
    const result = await generateJizuraPv({
      lyrics: '   \n  ',
      stylePreset: 'auto',
      aspectRatio: '16:9',
      outputFormat: 'mp4',
    });

    expect(result).toBe('');
    expect(m.launch).not.toHaveBeenCalled();
  });

  it('页面加载失败时直接抛出并清理浏览器', async () => {
    m.goto.mockRejectedValue(new Error('net::ERR_NAME_NOT_RESOLVED'));

    await expect(
      generateJizuraPv({
        lyrics: '失敗',
        stylePreset: 'auto',
        aspectRatio: '16:9',
        outputFormat: 'mp4',
      }),
    ).rejects.toThrow('ERR_NAME_NOT_RESOLVED');

    expect(m.browserClose).toHaveBeenCalled();
  });
});

describe('路径辅助函数', () => {
  it('resolveOutputDir 省略时回退到工作目录下的默认子目录', () => {
    expect(resolveOutputDir(undefined)).toBe(join(process.cwd(), 'jizura-pv-output'));
    expect(resolveOutputDir('')).toBe(join(process.cwd(), 'jizura-pv-output'));
  });

  it('resolveOutputDir 把相对路径解析为绝对路径', () => {
    const resolved = resolveOutputDir('out');
    expect(resolved.startsWith(process.cwd())).toBe(true);
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
