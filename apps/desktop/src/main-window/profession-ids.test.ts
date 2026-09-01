// W-i18n-B — profession id alphabet. The mapping table is the only author
// of Chinese→slug; these cases pin what it must and must not do.
//
// Reverse control of the READ mapping lives in profession-id-migration.test.ts
// (a stored 软件开发 must light the software-development chip). This file is
// the table itself.

import { describe, expect, it } from 'vitest';
import { S_BY_LOCALE, UI_LOCALES, setLocale } from '../lib/strings';
import {
  PROFESSION_LABELS,
  PROFESSION_LEGACY_ZH_TO_SLUG,
  PROFESSION_OPTIONS,
  migrateProfessionId,
  migrateProfessionList,
} from './profession-ids';

describe('migrateProfessionId / migrateProfessionList', () => {
  it('is idempotent: a slug in is a slug out, byte-identical', () => {
    for (const id of PROFESSION_OPTIONS) {
      expect(migrateProfessionId(id)).toBe(id);
    }
    expect(migrateProfessionList([...PROFESSION_OPTIONS])).toEqual([...PROFESSION_OPTIONS]);
  });

  it('maps every legacy Chinese id onto its slug', () => {
    expect(migrateProfessionId('软件开发')).toBe('software development');
    expect(migrateProfessionId('云原生 / 运维')).toBe('devops / SRE');
    expect(migrateProfessionId('产品设计')).toBe('product design');
    expect(migrateProfessionId('金融')).toBe('finance');
    expect(migrateProfessionId('医疗')).toBe('medicine');
    expect(migrateProfessionId('法律')).toBe('law');
    expect(migrateProfessionId('教育')).toBe('teaching');
    expect(migrateProfessionId('科研')).toBe('research');
  });

  it('unknown / custom values pass through untouched (never dropped, never translated)', () => {
    expect(migrateProfessionId('程序员')).toBe('程序员');
    expect(migrateProfessionId('my custom job')).toBe('my custom job');
    expect(migrateProfessionId('')).toBe('');
    expect(migrateProfessionList(['程序员', '软件开发', 'my custom job'])).toEqual([
      '程序员',
      'software development',
      'my custom job',
    ]);
  });

  it('a mixed Chinese+slug list dedupes to one slug, preserving first-seen order', () => {
    expect(
      migrateProfessionList(['软件开发', 'software development', '法律', '程序员']),
    ).toEqual(['software development', 'law', '程序员']);
  });

  it('the mapping table has exactly one author and covers only the old desktop alphabet', () => {
    expect(new Set(Object.keys(PROFESSION_LEGACY_ZH_TO_SLUG))).toEqual(new Set([
      '软件开发',
      '云原生 / 运维',
      '产品设计',
      '金融',
      '医疗',
      '法律',
      '教育',
      '科研',
    ]));
    for (const slug of Object.values(PROFESSION_LEGACY_ZH_TO_SLUG)) {
      expect(PROFESSION_OPTIONS, `mapped slug ${JSON.stringify(slug)} is not in PROFESSION_OPTIONS`).toContain(slug);
    }
  });
});

describe('PROFESSION_OPTIONS is the phone alphabet', () => {
  it('matches kProfessionPresets byte-for-byte (settings_widgets.dart)', () => {
    expect([...PROFESSION_OPTIONS]).toEqual([
      'software development',
      'product design',
      'devops / SRE',
      'research',
      'writing / editing',
      'teaching',
      'medicine',
      'law',
      'finance',
    ]);
  });
});

describe('every PROFESSION_OPTIONS id has a label in every overlay locale', () => {
  it('PROFESSION_LABELS has a getter for every option, and S has a non-empty string in every locale', () => {
    // Overlay locales = the nine UI locales the GETTERS-reading-S table serves.
    const overlayKeys: Record<(typeof PROFESSION_OPTIONS)[number], keyof typeof S_BY_LOCALE.en> = {
      'software development': 'profession_swdev',
      'product design': 'profession_product_design',
      'devops / SRE': 'profession_cloud_ops',
      'research': 'profession_research',
      'writing / editing': 'profession_writing',
      'teaching': 'profession_education',
      'medicine': 'profession_healthcare',
      'law': 'profession_law',
      'finance': 'profession_finance',
    };
    for (const id of PROFESSION_OPTIONS) {
      expect(Object.prototype.hasOwnProperty.call(PROFESSION_LABELS, id), `no overlay getter for ${id}`).toBe(true);
      const key = overlayKeys[id];
      for (const loc of UI_LOCALES) {
        const label = S_BY_LOCALE[loc][key];
        expect(label, `${loc}.${key} empty for id ${JSON.stringify(id)}`).toBeTruthy();
        expect(typeof label).toBe('string');
      }
    }
  });

  it('the getter actually returns that locale\'s string (not a frozen boot-locale copy)', () => {
    setLocale('en');
    expect(PROFESSION_LABELS['writing / editing']).toBe(S_BY_LOCALE.en.profession_writing);
    setLocale('zh-CN');
    expect(PROFESSION_LABELS['writing / editing']).toBe(S_BY_LOCALE['zh-CN'].profession_writing);
    setLocale('zh-CN');
  });
});
