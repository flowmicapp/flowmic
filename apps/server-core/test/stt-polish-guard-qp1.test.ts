// QP-1 (2026-10-13) — our own realtime-polish guard was throwing away good
// polishes. Each block pins one rule change in both directions: the false
// reject it removes, and the true harm it must still refuse.
import { describe, expect, it } from 'vitest';
import { boundsFor, checkMeaningPreserved, openClassLimit } from '../src/stt/stt-polish-guard';
import { numberDrift, parseHanNumber, readNumbers } from '../src/stt/stt-polish-guard-numbers';

const smooth = { strength: 'smooth' as const };
const strict = { strength: 'strict' as const };

describe('numbers are compared as values, not characters', () => {
  const neutral: [string, string][] = [
    ['我一直觉得这个方案一般', '我一直觉得，这个方案一般。'],
    ['你帮我看一下这些东西', '你帮我看看这些东西'],
    ['这些东西都要再看一看', '这些东西都要再看看'],
    ['然后还有一个一个的接口需要对接', '然后还有一个个接口需要对接'],
    ['你得一步一步来', '你得一步步来'],
    ['我们一起去吃饭吧然后一会再说', '我们一起去吃饭吧，然后一会再说。'],
    ['快一点', '快点'],
    ['下午三点开会', '下午3点开会'],
    ['预算三千万', '预算3000万'],
    ['大概两千五', '大概2500'],
    ['日活三万二左右', '日活3.2万左右'],
    ['下降了大概百分之五吧', '下降了大概5%'],
    ['十一点出发', '11点出发'],
    ['一点开会', '1点开会'],
    ['两点半见', '2:30见'],
    ['价格是1,000块', '价格是1000块'],
    ['显卡是409048G', '显卡是4090 48G'],
    ['I need fifteen apples', 'I need 15 apples'],
  ];
  for (const [raw, pol] of neutral) {
    it(`neutral: ${raw} -> ${pol}`, () => {
      expect(numberDrift(raw, pol)).toBe(false);
      expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: true });
    });
  }

  const harmful: [string, string][] = [
    ['下午三点开会', '下午两点开会'],
    ['预算五千块', '预算五百块'],
    ['来了二十个人', '来了十二个人'],
    ['the code is 15', 'the code is 50'],
    ['fifteen people came', 'fifty people came'],
    ['日活三万二', '日活三万零二'],
    ['下午一点开会', '下午两点开会'],
    ['三个苹果五个梨', '五个苹果三个梨'],
    ['一个人去', '两个人去'],
    ['大家三三两两地走了', '大家3322地走了'],
  ];
  for (const [raw, pol] of harmful) {
    it(`still refused at both strengths: ${raw} -> ${pol}`, () => {
      expect(numberDrift(raw, pol)).toBe(true);
      expect(checkMeaningPreserved(raw, pol, smooth)).toMatchObject({ ok: false, reason: 'closed-class-drift:number' });
      expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(false);
    });
  }

  it('parses the spoken elision and compounds', () => {
    expect(parseHanNumber('三万二')).toBe(32000n);
    expect(parseHanNumber('两千五')).toBe(2500n);
    expect(parseHanNumber('一百二')).toBe(120n);
    expect(parseHanNumber('一百零二')).toBe(102n);
    expect(parseHanNumber('二零二六')).toBe(2026n);
    expect(parseHanNumber('三万一千')).toBe(31000n);
    expect(readNumbers('three hundred and five people').values).toEqual(['305']);
    expect(readNumbers('twenty-one, then 3 million').values).toEqual(['21', '3000000']);
    expect(readNumbers('千万别忘了').values).toEqual([]);
    expect(readNumbers('三千万用户').values).toEqual(['30000000']);
    expect(readNumbers('这一点很重要，晚一点再说').values).toEqual([]);
  });
});

describe('modal and negation are counted per word', () => {
  it('a compound containing a modal/negation character is not that word', () => {
    expect(checkMeaningPreserved('这个功能我觉得特别好', '这个功能特别好', smooth).ok).toBe(true);
    expect(checkMeaningPreserved('这个需要我们开会讨论', '这个需要开会讨论', smooth).ok).toBe(true);
    expect(checkMeaningPreserved('那个会议我们需要再开一下', '会议需要再开一下', smooth).ok).toBe(true);
  });
  it('the real words are still protected', () => {
    expect(checkMeaningPreserved('一定要去', '不要去', smooth)).toMatchObject({ ok: false });
    expect(checkMeaningPreserved('我会去', '我去', smooth)).toMatchObject({ ok: false, reason: 'closed-class-drift:会' });
    expect(checkMeaningPreserved('别去那里', '去那里', smooth)).toMatchObject({ ok: false, reason: 'closed-class-drift:别' });
    expect(checkMeaningPreserved('你千万记得带钥匙', '你记得带钥匙', smooth)).toMatchObject({ ok: false, reason: 'closed-class-drift:千万' });
  });
});

describe('apostrophe-less negative contractions', () => {
  for (const strength of ['strict', 'smooth'] as const) {
    it(`restoring the apostrophe is neutral (${strength})`, () => {
      expect(checkMeaningPreserved('I dont think we should ship this until the tests pass', "I don't think we should ship this until the tests pass.", { strength }).ok).toBe(true);
      expect(checkMeaningPreserved('I cant come today', "I can't come today.", { strength }).ok).toBe(true);
      expect(checkMeaningPreserved('it isnt ready', 'it isn’t ready', { strength }).ok).toBe(true);
    });
    it(`a real negation change still rejects (${strength})`, () => {
      expect(checkMeaningPreserved('I do think so', "I don't think so", { strength }).ok).toBe(false);
      expect(checkMeaningPreserved('you can go now', "you can't go now", { strength }).ok).toBe(false);
      expect(checkMeaningPreserved('I did not ship it', 'I did ship it', { strength }).ok).toBe(false);
      expect(checkMeaningPreserved('I dont think so', 'I think so', { strength }).ok).toBe(false);
    });
  }
  it('words that are not contractions are left alone', () => {
    expect(checkMeaningPreserved('we were there', 'we were there.', strict).ok).toBe(true);
  });
});

describe('smooth open-class limit scales with the input', () => {
  it('limit = max(12, ceil(0.2 * length)); strict stays fixed', () => {
    expect(openClassLimit(boundsFor('smooth'), 40)).toBe(12);
    expect(openClassLimit(boundsFor('smooth'), 120)).toBe(24);
    expect(openClassLimit(boundsFor('strict'), 400)).toBe(2);
  });
  it('a long ramble that sheds 20 filler characters is accepted', () => {
    const parts = ['我们这个项目现在的进度', '大概完成了一半左右吧', '剩下的部分主要是前端页面', '还有接口需要去对接', '测试那边也要跟进一下', '我觉得月底之前', '应该是能够完成的', '然后预算方面也还够用', '大家辛苦一下', '下周我们再碰个头'];
    const raw = parts.map(p => `那个${p}`).join('');
    const pol = `${parts.join('，')}。`;
    expect([...raw].length).toBeGreaterThan(100);
    const r = checkMeaningPreserved(raw, pol, smooth);
    expect(r.metrics?.openClassDelta).toBeGreaterThan(12);
    expect(r).toMatchObject({ ok: true });
    expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(false);
  });
});

describe('user-dictionary drift (QP-1 item 4: reproduced, not loosened)', () => {
  const terms = ['FlowMic', 'Claude Code', 'PostgreSQL', 'Next.js', '飞书'];
  it('spacing, adjacent punctuation and CJK-Latin spacing are already neutral', async () => {
    const { protectedTermDrift } = await import('../src/stt/stt-polish');
    expect(protectedTermDrift('我用FlowMic打字然后用Claude Code写代码数据库是PostgreSQL前端是Next.js消息都发到飞书',
      '我用 FlowMic 打字，然后用 Claude Code 写代码，数据库是 PostgreSQL，前端是 Next.js，消息都发到飞书。', terms)).toBeNull();
  });
  it('casing is the user\'s own spelling and stays protected (lead ruling 2026-07-24)', async () => {
    const { protectedTermDrift } = await import('../src/stt/stt-polish');
    expect(protectedTermDrift('打开FlowMic', '打开Flowmic', terms)).toBe('FlowMic');
    expect(protectedTermDrift('用Claude Code写', '用Claude code写', terms)).toBe('Claude Code');
  });
  it('a smooth pass that removes a REPEATED term is refused here; the strict fallback recovers it', async () => {
    const { protectedTermDrift } = await import('../src/stt/stt-polish');
    expect(protectedTermDrift('那个FlowMic FlowMic这个功能', 'FlowMic这个功能', terms)).toBe('FlowMic');
  });
});

// QP-1 review (2026-10-13, adversarial set qp1r/adv.mjs): these were accepted
// by the first QP-1 cut at BOTH strengths. Each must refuse at both.
describe('QP-1 review: harmful edits the first cut let through', () => {
  const refuse: [string, string, string][] = [
    ['mask', '这是非法的', '这是合法的'],
    ['mask', '他从未来过这里', '他来过这里'],
    ['mask', '这里无数据', '这里有数据'],
    ['mask', '我们得出发了', '我们出发了'],
    ['mask', '我会计算一下成本', '我计算一下成本'],
    ['mask', '这些我们全能搞定', '这些我们搞定'],
    ['mask', '他能量化这个指标吗', '他量化这个指标吗'],
    ['regroup', '预算是3万', '预算是3千'],
    ['regroup', '预算是3万', '预算是3'],
    ['regroup', '日活1.5万', '日活15万'],
    ['regroup', 'We raised 3 million last year', 'We raised 3 billion last year'],
    ['regroup', 'Room 12, floor 3', 'Room 1, floor 23'],
    ['regroup', 'The timeout is 1.5 seconds', 'The timeout is 15 seconds'],
    ['regroup', 'It costs $3.50 per seat', 'It costs $350 per seat'],
    ['regroup', '营收增长了百分之五十', '营收增长了五十'],
    ['estimate', '大概三四个人', '大概34个人'],
    ['estimate', '一两天就好', '12天就好'],
    ['estimate', '再等五六分钟', '再等56分钟'],
    ['estimate', '还有七八个bug', '还有78个bug'],
    ['repeat', '然后还有一个一个的接口需要对接', '然后还有一个接口需要对接'],
    ['repeat', '我们要五个五个地分组', '我们要五个分组'],
    ['repeat', '请大家一个一个进来', '请大家一个进来'],
    ['en-words', 'it takes two three days', 'it takes five days'],
    ['en-words', 'go to room two two', 'go to room 2'],
    ['lexical', '下午三点十分开会', '下午三点开会'],
    ['lexical', '等我十分钟', '等我一会儿'],
    ['lexical', '我一下午都在开会', '我都在开会'],
    ['lexical', '今晚一点上线', '今晚上线'],
    ['lexical', '最晚一点到', '最晚到'],
    ['lexical', '这些问题我们一直在跟', '这些问题我们有时在跟'],
    ['lexical', '我们一起去现场', '我们分别去现场'],
    ['lexical', '还有一些接口没对接', '还有很多接口没对接'],
    ['lexical', '这是唯一的办法', '这是主要的办法'],
    ['lexical', '这个方案十分重要', '这个方案有点重要'],
    ['lexical', '一共三个人', '大约三个人'],
  ];
  for (const [kind, raw, pol] of refuse) {
    it(`${kind}: ${raw} -> ${pol} is refused at both strengths`, () => {
      expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(false);
      expect(checkMeaningPreserved(raw, pol, smooth).ok).toBe(false);
    });
  }
  const accept: [string, string][] = [
    ['然后还有一个一个的接口需要对接', '然后还有一个个接口需要对接'],
    ['it takes two three days', 'it takes two or three days'],
    ['it takes two three days', 'it takes two, three days'],
    ['合同编号HT20260806015一共15页', '合同编号HT20260806015，一共15页。'],
    ['显卡是409048G', '显卡是4090 48G'],
    ['价格是1,000块', '价格是1000块'],
  ];
  for (const [raw, pol] of accept) {
    it(`${raw} -> ${pol} stays accepted at both strengths`, () => {
      expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(true);
      expect(checkMeaningPreserved(raw, pol, smooth).ok).toBe(true);
    });
  }
});

it('rt-num-008 golden_bad (15 pages -> 14) is still refused', () => {
  expect(checkMeaningPreserved('合同编号HT20260806015一共15页', '合同编号HT20260806015，一共14页。', smooth).ok).toBe(false);
});

// QP-1 review round 2 (qp1r/adv2.mjs): three more holes.
describe('QP-1 review round 2', () => {
  for (const [raw, pol] of [
    ['三五个人就够了', '35个人就够了'],
    ['还差一点点就做完了', '还差就做完了'],
    ['我有一点儿不舒服', '我不舒服'],
  ] as const) {
    it(`${raw} -> ${pol} is refused at both strengths`, () => {
      expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(false);
      expect(checkMeaningPreserved(raw, pol, smooth).ok).toBe(false);
    });
  }
  for (const [raw, pol] of [['快一点儿', '快点'], ['快一点儿', '快一点'], ['我有一点儿不舒服', '我有点不舒服']] as const) {
    it(`shortening "a little" stays accepted: ${raw} -> ${pol}`, () => {
      expect(checkMeaningPreserved(raw, pol, strict).ok).toBe(true);
      expect(checkMeaningPreserved(raw, pol, smooth).ok).toBe(true);
    });
  }
});
