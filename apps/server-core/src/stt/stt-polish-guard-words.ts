// QP-1 (2026-10-13): make the §3.2 modal / negation counts word-level where
// they were character-level.
//
// The Chinese modal and negation terms are single characters counted as plain
// substrings (stt-polish-guard-terms.ts: ZH_MODAL / ZH_NEGATION), so the 会 in
// 会议, the 要 in 需要, the 得 in 觉得, the 别 in 特别 and the 非 in 非常 all
// counted as modals and negations. A smoothing pass that drops a filler 会议
// mention or rewrites 觉得 changed "the modal count" without touching a modal.
// Masking the lexicalized compounds before counting keeps the protection for
// the real word (不会, 要去, 得走, 别去) and stops the false hit.
//
// English: an apostrophe-less negative contraction (dont, cant, isnt …) is the
// same word as its apostrophe form. The `n't` substring term could not see it,
// so restoring the apostrophe — exactly what a transcription polish should do —
// read as an ADDED negation under both strengths. Both sides are normalized
// before counting, so the restore is neutral and I do -> I don't still rejects.
// Words that are real words in other senses and not negations (were, its, well,
// hell, ill) are deliberately left alone.

/** Compounds whose modal/negation character is not a modal or a negation.
 *  Masked (not deleted) before counting. Only unambiguous ones: 不过, 不错,
 *  不管, 要不, 都会 stay counted because they can carry the real meaning. */
// QP-1 review (2026-10-13) narrowed this list to SUFFIX-position compounds of
// 会 / 要 / 得 / 能 / 别 only: the modal or negation character is the second
// half of a fixed word (需要, 觉得, 机会, 功能, 特别). Two families were removed
// because masking them let real meaning changes through at both strengths:
//   · anything holding 非 / 未 / 无 / 莫, or starting with 别: 这是非法的 ->
//     这是合法的, 他从未来过 -> 他来过, 这里无数据 -> 这里有数据 were accepted;
//   · anything STARTING with the modal (会计, 会面, 会谈, 得出, 得到, 得分,
//     能量, 能力, 要求 …): 我会计算 -> 我计算, 我们得出发了 -> 我们出发了 read
//     the modal as part of a noun. 全能 / 万能 / 本能 go for the same reason
//     (这些我们全能搞定 -> 这些我们搞定).
// A correct edit that touches one of the removed words is now refused; the
// Smooth -> Strict fallback in stt-polish.ts is what absorbs that cost.
const NON_CLOSED_CLASS_COMPOUNDS: readonly string[] = [
  // 会
  '博览会', '研讨会', '发布会', '运动会', '委员会', '开会', '一会', '机会', '社会',
  '聚会', '晚会', '大会', '宴会', '约会', '协会', '体会', '误会',
  '理会', '领会', '例会', '早会', '周会', '年会', '展会', '工会', '国会', '省会',
  // 要
  '需要', '重要', '主要', '摘要', '必要', '纲要', '首要', '简要', '次要',
  // 得
  '来得及', '觉得', '记得', '获得', '取得', '值得', '懂得', '显得', '难得', '舍得',
  '晓得', '免得', '使得', '心得', '赢得', '认得',
  '博得', '省得', '弄得', '搞得', '变得', '长得', '说得', '做得', '跑得', '写得', '讲得', '听得',
  '看得', '想得', '过得', '吃得', '睡得', '玩得', '干得', '办得', '来得', '走得', '学得', '唱得',
  '笑得', '哭得', '打得',
  // 能
  '功能', '智能', '性能', '技能', '职能', '效能', '潜能', '体能', '动能', '节能', '产能',
  // 别 (suffix only)
  '特别', '区别', '分别', '级别', '类别', '识别', '性别', '差别', '个别', '告别',
  '鉴别', '辨别', '离别', '派别',
].slice().sort((a, b) => b.length - a.length);

// 千万 counts as a modal (ZH_MODAL) only as the adverb; 三千万 / 千万用户 is a
// number and is compared by the numbers gate instead.
const QIANWAN_NUMBER_BEFORE = /[0-9零〇一幺二两三四五六七八九十百]$/u;
const QIANWAN_NUMBER_AFTER = new RegExp(`^(?:[${'0-9元块人个位次级条张台家美欧日港英用名份件套辆部本字年户'}]|以上|左右|多)`, 'u');

const NEG_CONTRACTION_RE = /(?<![\p{L}\p{N}_'])(do|does|did|ca|wo|is|are|was|were|could|should|would|have|has|had|must|need)nt(?![\p{L}\p{N}_'])/giu;

const MASK = '¤';

/** The text the closed-class counter reads. Pure; never shown to anyone. */
export function closedClassSurface(text: string): string {
  let s = text.replace(/[’ʼ]/gu, "'");
  s = s.replace(NEG_CONTRACTION_RE, (_m, stem: string) => `${stem}n't`);
  for (const w of NON_CLOSED_CLASS_COMPOUNDS) s = s.split(w).join(MASK.repeat([...w].length));
  s = s.replace(/千万/gu, (m, offset: number, whole: string) => (
    QIANWAN_NUMBER_BEFORE.test(whole.slice(0, offset)) || QIANWAN_NUMBER_AFTER.test(whole.slice(offset + 2))
      ? MASK + MASK
      : m
  ));
  return s;
}
