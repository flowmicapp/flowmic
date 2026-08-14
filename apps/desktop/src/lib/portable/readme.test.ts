// docs/rebuild/16-PORTABLE-RECORD-FORMAT-FPR-V1.md §3:
//   「README.txt 不是装饰：用户三个月后打开这个 zip 要能知道它是什么。内容必须含
//     ① 这是 FlowMic 的记录导出 ② 明文，谁拿到都能看 ③ 导回去的路径（哪个页面）
//     ④ 导出时间与条数」
//   ("README.txt is not decoration: the user opening this zip three months later must be able to tell what it is.
//     The content must include ① this is a FlowMic record export ② plaintext, whoever gets it can read it
//     ③ the path back in (which page) ④ export timestamp and row count")
//
// One assertion per each of the four obligations. Without this test, README turning into a template nobody reads would take just one edit.

import { describe, expect, it } from 'vitest';
import { buildReadme, type ReadmeText } from './readme';
import { PORTABLE_STRINGS } from '../strings/portable';
import type { FprHeader } from './fpr';
import { UI_LOCALES } from '../strings/locale';

const HEADER: FprHeader = {
  fpr: 1,
  kind: 'header',
  exported_at: '2026-08-01T09:12:33.000Z',
  source: { app: 'flowmic', end: 'desktop', version: '0.2.36', device: '开发机' },
  count: 128,
  has_attachments: true,
  scope: { kind: 'all' },
};

function textOf(loc: (typeof UI_LOCALES)[number]): ReadmeText {
  const s = PORTABLE_STRINGS[loc];
  return {
    title: s.pd_readme_title,
    plain: s.pd_readme_plain,
    howto: s.pd_readme_howto,
    files: s.pd_readme_files,
    exportedLabel: s.pd_readme_exported,
    countLabel: s.pd_readme_count,
    deviceLabel: s.pd_readme_device,
    rowsUnit: s.pd_unit_rows,
  };
}

describe('§3 README.txt 的四条义务', () => {
  const out = buildReadme(textOf('zh-CN'), HEADER);

  it('① 说清这是 FlowMic 的记录导出', () => {
    expect(out).toContain('FlowMic');
    expect(out).toContain('FPR v1');
  });

  it('② 明文警示，而且不是「请妥善保管」那种听不出后果的话', () => {
    expect(out).toContain('明文');
    expect(out).toContain('谁拿到');
    // ⛔ The exact sentence doc 16 §7-1 names as forbidden.
    expect(out).not.toContain('妥善保管');
  });

  it('③ 导回去的路径写到页面级', () => {
    expect(out).toContain('导入记录');
    expect(out).toContain('设置');
  });

  it('④ 导出时间与条数，都取自文件头本身', () => {
    expect(out).toContain('2026-08-01T09:12:33.000Z');
    expect(out).toContain('128');
    expect(out).toContain('开发机');
  });

  it('device 为 null 时说明里那一行整行不写，而不是写「导出设备：null」', () => {
    const anon = buildReadme(textOf('zh-CN'), { ...HEADER, source: { ...HEADER.source, device: null } });
    expect(anon).not.toContain('导出设备');
    // Positive control: when there is a name, that line really is present.
    expect(out).toContain('导出设备');
  });

  it('CRLF 换行 —— 读它的是 Windows 记事本', () => {
    expect(out).toContain('\r\n');
  });

  it('四种界面语言都能产出非空、含条数的说明', () => {
    for (const loc of UI_LOCALES) {
      const r = buildReadme(textOf(loc), HEADER);
      expect(r.length, loc).toBeGreaterThan(80);
      expect(r, loc).toContain('128');
      expect(r, loc).toContain('FlowMic');
    }
  });
});
