// NR-245 (GUARD-2) — each family pinned in both directions: the meaning change
// it now refuses and the neighbouring legitimate edit it must still accept.
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { numberSubjectSwap } from '../src/stt/stt-polish-guard-numctx';

const both = ['strict', 'smooth'] as const;

function verdicts(raw: string, pol: string): string[] {
  return both.map((strength) => (checkMeaningPreserved(raw, pol, { strength }).ok ? 'accept' : 'refuse'));
}

function family(name: string, harmful: [string, string][], neutral: [string, string][]): void {
  describe(name, () => {
    for (const [raw, pol] of harmful) it(`refuses: ${raw} -> ${pol}`, () => expect(verdicts(raw, pol)).toEqual(['refuse', 'refuse']));
    for (const [raw, pol] of neutral) it(`accepts: ${raw} -> ${pol}`, () => expect(verdicts(raw, pol)).toEqual(['accept', 'accept']));
  });
}

family('closed-class words with a context rule', [
  ['我们可以下周发', '我们下周发'],
  ['We usually deploy on Fridays', 'We always deploy on Fridays'],
  ['it failed twice', 'it failed once'],
  ['take the first exit', 'take the second exit'],
  ['开了一个半小时', '开了一个小时'],
  ['把合同发给张伟和李明', '把合同发给张伟'],
  ['我有时会迟到', '我会迟到'],
], [
  ['我们可以下周发吧', '我们可以下周发。'],
  ['我没有时间', '我没有时间。'],
  ['两点半见', '2:30见'],
  ['we usually um deploy on Fridays', 'We usually deploy on Fridays.'],
  ['我们参与了这个项目', '我们参与了这个项目。'],
]);

family('negation scope', [
  ['这个不是很好', '这个很不好'],
  ['这个不一定对', '这个一定不对'],
  ['大家都不同意', '大家不都同意'],
  ['Not all files were deleted', 'All files were not deleted'],
], [
  ['这个呃不是很好', '这个不是很好'],
  ["I don't really think so", "I don't think so"],
]);

family('marks attached to a number', [
  ['来了十几个人', '来了十个人'],
  ['大概二十多个', '大概二十个'],
  ['开了三个多小时', '开了三个小时'],
  ['来了几十个人', '来了十个人'],
  ['三十余人参加', '三十人参加'],
  ['气温是-5度', '气温是5度'],
  ['零下5度', '5度'],
  ['about 50 people came', '50 people came'],
  ['more than 20 tickets', '20 tickets'],
  ['pages 12 3 and 4', 'pages 1 23 and 4'],
], [
  ['零下5度', '-5度'],
  ['三点左右开会', '3点左右开会'],
  ['等三到五天', '等3到5天'],
  ['等3-5天', '等3到5天'],
  ['about fifty people came', 'About 50 people came.'],
  ['显卡是409048G', '显卡是4090 48G'],
]);

family('a number keeps the noun it counts', [
  ['三个苹果五个梨', '三个梨五个苹果'],
  ['I need 3 apples and 5 pears', 'I need 3 pears and 5 apples'],
  ['苹果三个，梨五个', '梨三个，苹果五个'],
], [
  ['三个呃苹果五个梨', '三个苹果五个梨'],
  ['3 apples and um 5 pears', '3 apples and 5 pears'],
]);

describe('a swap between equal values is not a meaning change', () => {
  it('两个苹果两个梨 -> 两个梨两个苹果 is not a subject swap', () => {
    expect(numberSubjectSwap('两个苹果两个梨', '两个梨两个苹果')).toBe(false);
    expect(numberSubjectSwap('三个苹果五个梨', '三个梨五个苹果')).toBe(true);
  });
});

family('a noun keeps its number', [
  ['Delete the files in the cache folder', 'Delete the file in the cache folder'],
  ['Restart the server', 'Restart the servers'],
  ['update the dependencies', 'update the dependency'],
], [
  ['we found two bug in the parser', 'We found two bugs in the parser.'],
  ['there is a files missing', 'There is a file missing.'],
  ["check John's notes", "Check John's notes."],
]);

family('Latin content words survive', [
  ['把这个PR merge到main分支，然后deploy到staging', '把这个PR merge到main分支'],
  ['update the auth flow and the billing webhook before Friday', 'update the auth flow before Friday'],
  ['ping Martin and Sarah about the release', 'ping Martin about the release'],
], [
  ['I will meat you at the station', 'I will meet you at the station.'],
  ['add a web hook for billing', 'Add a webhook for billing.'],
  ['we deploy it yesterday', 'We deployed it yesterday.'],
]);

describe('a known term may replace the words it was misheard as', () => {
  it('strict: run cube control get pods -> run kubectl get pods (coding default list, coding app)', () => {
    expect(checkMeaningPreserved('run cube control get pods', 'run kubectl get pods', { strength: 'strict', appCategory: 'coding' })).toMatchObject({ ok: true });
  });
  // Review round: the coding default list counts only when the focused app is
  // a code editor or terminal — the same gate as the recognizer's context
  // (sonioxDefaultTermsFor in stt/engine-factory.ts).
  it('strict: without the coding category a default term excuses nothing', () => {
    expect(checkMeaningPreserved('The polymer chains broke at high heat.', 'The Ollama chains broke at high heat.', { strength: 'strict' })).toMatchObject({ ok: false });
    expect(checkMeaningPreserved('The polymer chains broke at high heat.', 'The Ollama chains broke at high heat.', { strength: 'strict', appCategory: 'email' })).toMatchObject({ ok: false });
    expect(checkMeaningPreserved('run cube control get pods', 'run kubectl get pods', { strength: 'strict' })).toMatchObject({ ok: false });
  });
  it('declared user terms count in every app', () => {
    expect(checkMeaningPreserved('push it to lock store tonight', 'push it to Rockstore tonight', { strength: 'strict', declaredTerms: ['Rockstore'], appCategory: 'email' })).toMatchObject({ ok: true });
  });
  it('resemblance at 0.4: a real word is not taken for a term that merely shares letters', () => {
    // These two passed at 0.6 (review table: 34 of 35 real words did).
    expect(checkMeaningPreserved('Send the receipt to the vendor today.', 'Send the receipt to the Vercel today.', { strength: 'smooth', appCategory: 'coding' })).toMatchObject({ ok: false });
    expect(checkMeaningPreserved('We hiked through the jungle all day.', 'We hiked through the Django all day.', { strength: 'smooth', appCategory: 'coding' })).toMatchObject({ ok: false });
  });
  it('strict: the user term repairs its mishearing', () => {
    expect(checkMeaningPreserved('push it to lock store tonight', 'push it to Rockstore tonight', { strength: 'strict', declaredTerms: ['Rockstore'] })).toMatchObject({ ok: true });
  });
  it('reverse control: without the term the same repair is a dropped word', () => {
    expect(checkMeaningPreserved('push it to lock store tonight', 'push it to Rockstore tonight', { strength: 'strict' })).toMatchObject({ ok: false, reason: 'closed-class-drift:content' });
  });
  it('a known term does not excuse a word it does not resemble', () => {
    expect(checkMeaningPreserved('deploy the billing service', 'deploy the Docker service', { strength: 'smooth', appCategory: 'coding' })).toMatchObject({ ok: false, reason: 'closed-class-drift:content' });
  });
  it('a known term does not excuse a drop elsewhere in the sentence', () => {
    expect(checkMeaningPreserved('run cube control get pods and delete the staging namespace', 'run kubectl get pods', { strength: 'smooth', appCategory: 'coding' })).toMatchObject({ ok: false });
  });
});

describe('smooth: filler removal around content words is still accepted', () => {
  it('so um basically we need to move the session store to Redis', () => {
    expect(checkMeaningPreserved('so um basically we need to move the session store to Redis', 'We need to move the session store to Redis.', { strength: 'smooth' })).toMatchObject({ ok: true });
  });
});

// Review round: a dropped word whose written form is in the output was
// rewritten, not lost; and the approximators are compared by CLASS, the same
// classes the number marks use ('~' approximately/roughly, '<' nearly/almost),
// so a swap inside a class is neutral and a swap across classes is not.
family('written forms and approximator classes', [
  ['nearly 50 people came', 'roughly 50 people came'],
  ['the build is nearly done', 'the build is done'],
  ['it took roughly an hour', 'it took an hour'],
], [
  ['It costs 5 euros.', 'It costs €5.'],
  ['temperature dropped to minus 5', 'temperature dropped to -5'],
  ['it is 30 degrees outside', 'it is 30° outside'],
  ['growth was 5 percent', 'growth was 5%'],
  ['nearly 50 people came', 'almost 50 people came'],
  ['the build is nearly done', 'the build is almost done'],
  ['Restart all service now.', 'Restart all services now.'],
  ['Wait a second, I need to check.', 'Wait a moment, I need to check.'],
  ['以及测试报告', '和测试报告'],
]);

describe('smooth: an approximation may move from after the noun to before the number', () => {
  it('roughly 50 -> approximately 50 (same class; strict refuses it on distance alone)', () => {
    expect(checkMeaningPreserved('roughly 50 people came', 'approximately 50 people came', { strength: 'smooth' })).toMatchObject({ ok: true });
  });
  it('over 5 dollars -> over $5 (strict refuses it on distance alone)', () => {
    expect(checkMeaningPreserved('it costs over 5 dollars', 'it costs over $5', { strength: 'smooth' })).toMatchObject({ ok: true });
  });
  it('30 people or so came -> about 30 people came', () => {
    expect(checkMeaningPreserved('30 people or so came', 'about 30 people came', { strength: 'smooth' })).toMatchObject({ ok: true });
  });
});
