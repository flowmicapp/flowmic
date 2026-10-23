// ML-1 — per-family checks for the multilingual guard rules, beside the
// fixture (polish-guard-multilingual.test.ts). Each block names the ML-0 defect
// it closes (_dispatch/2026-10-13-eval-multilingual-baseline.md §3).
import { describe, expect, it } from 'vitest';
import { checkMeaningPreserved } from '../src/stt/stt-polish-guard';
import { guardComposeOutput } from '../src/compose/output-guard';
import { languageDrift } from '../src/stt/stt-polish-guard-lang';

const both = ['strict', 'smooth'] as const;
const verdict = (raw: string, pol: string, strength: 'strict' | 'smooth', language?: string): string => {
  const g = checkMeaningPreserved(raw, pol, { strength, ...(language !== undefined ? { language } : {}) });
  return g.ok ? 'accept' : `refuse:${g.reason}`;
};

describe('D5 language drift (realtime guard)', () => {
  const drift: [string, string, string, string][] = [
    ['de', 'Das Meeting mit Frau Müller findet in Düsseldorf statt.', 'The meeting with Ms. Müller takes place in Düsseldorf.', 'en'],
    ['es', 'Hay que hacer merge del pull request antes de desplegar en Kubernetes.', 'We need to merge the pull request before deploying to Kubernetes.', 'en'],
    ['ru', 'Встреча с Ольгой Петровной пройдёт в Новосибирске.', 'The meeting with Olga Petrovna will take place in Novosibirsk.', 'en'],
    ['ja', '来週、大阪で鈴木部長と打ち合わせがあります。', '下周在大阪和铃木部长有个会议。', 'zh'],
    ['ko', '풀 리퀘스트를 머지한 다음에 Kubernetes에 배포해 주세요.', 'Please merge the pull request and then deploy to Kubernetes.', 'en'],
  ];
  for (const [lang, raw, pol, into] of drift) {
    for (const s of both) {
      it(`${lang} -> ${into} is refused as language drift (${s})`, () => {
        expect(verdict(raw, pol, s, lang)).toBe(`refuse:language-drift:${into}`);
      });
    }
  }

  it('is silent without a language, and for a language it has no profile for', () => {
    const [, raw, pol] = drift[0]!;
    expect(languageDrift(raw, pol, undefined)).toBeNull();
    expect(languageDrift(raw, pol, 'auto')).toBeNull();
    expect(languageDrift(raw, pol, 'it')).toBeNull();
  });

  it('does not fire on English tech terms inside the session language', () => {
    expect(languageDrift(
      'Peux-tu relancer le pipeline GitHub Actions et vérifier les logs dans Grafana ?',
      'Peux-tu relancer le pipeline GitHub Actions et vérifier les logs dans Grafana ?', 'fr')).toBeNull();
    expect(languageDrift('Kubernetes 클러스터에 배포해 주세요', 'Kubernetes 클러스터에 배포해 주세요.', 'ko')).toBeNull();
  });

  it('keeps an English sentence the user dictated inside a German session', () => {
    const raw = 'Bitte schick mir das. Please merge the pull request before Friday.';
    expect(languageDrift(raw, 'Bitte schick mir das. Please merge the pull request before Friday.', 'de')).toBeNull();
  });
});

describe('D5 language drift (compose organize / draft_polish)', () => {
  for (const task of ['organize', 'draft_polish'] as const) {
    it(`${task}: German in, English out is refused as language_changed`, () => {
      const v = guardComposeOutput({
        task,
        source: 'Kannst du den Pull Request reviewen, bevor wir auf Kubernetes deployen? Das Meeting ist am Freitag.',
        output: 'Can you review the pull request before we deploy to Kubernetes? The meeting is on Friday.',
        source_lang: 'de',
      });
      expect(v.ok ? 'accept' : v.rule).toBe('language_changed');
    });
  }
  it('organize: silent on auto', () => {
    const v = guardComposeOutput({
      task: 'organize',
      source: 'Kannst du den Pull Request reviewen, bevor wir auf Kubernetes deployen?',
      output: 'Can you review the pull request before we deploy to Kubernetes?',
      source_lang: 'auto',
    });
    expect(v.ok).toBe(true);
  });
});

describe('D1 / D2 number words and local number formats', () => {
  // [lang, raw, polished, smooth verdict]
  const cases: [string, string, string, 'accept' | 'refuse'][] = [
    // D2: correct rewrites ML-0 saw refused on the live line.
    ['es', 'Tenemos 2.400 usuarios activos.', 'Tenemos 2400 usuarios activos.', 'accept'],
    ['es', 'Son quinientos euros.', 'Son 500 euros.', 'accept'],
    ['de', 'Wir haben zweitausenddreihundert Nutzer.', 'Wir haben 2300 Nutzer.', 'accept'],
    ['de', 'Der Fehler vierhundertvier kommt oft.', 'Der Fehler 404 kommt oft.', 'accept'],
    ['ru', 'Это стоит пятьсот рублей.', 'Это стоит 500 рублей.', 'accept'],
    ['ko', '사월 십오일 오후 두 시 반에 만나요.', '4월 15일 오후 2시 30분에 만나요.', 'accept'],
    ['fr', 'Ça coûte quarante-neuf euros quatre-vingt-dix.', 'Ça coûte 49,90 euros.', 'accept'],
    ['de', 'Wir treffen uns um halb drei.', 'Wir treffen uns um 2:30 Uhr.', 'accept'],
    // D1: changed values, in words and in the local format.
    ['de', 'Wir treffen uns um halb drei.', 'Wir treffen uns um 3:30 Uhr.', 'refuse'],
    ['de', 'Es kostet 49,90 Euro.', 'Es kostet 4990 Euro.', 'refuse'],
    ['fr', 'Il reste quatre-vingt-dix places.', 'Il reste quatre-vingts places.', 'refuse'],
    ['es', 'Llegan veintidós personas.', 'Llegan doce personas.', 'refuse'],
    ['ru', 'Осталось сорок два дня.', 'Осталось сорок дней.', 'refuse'],
    ['ko', '스물다섯 명이 왔어요.', '스물여섯 명이 왔어요.', 'refuse'],
  ];
  for (const [lang, raw, pol, want] of cases) {
    it(`${lang}: ${raw} -> ${pol} is ${want}ed under smooth`, () => {
      expect(verdict(raw, pol, 'smooth', lang).split(':')[0]).toBe(want);
    });
  }

  it('reads nothing new without a language: "2.400" stays 2.4 and Latin number words stay unread', () => {
    // The pre-ML-1 reading, which en/zh traffic depends on.
    expect(verdict('Tenemos 2.400 usuarios activos.', 'Tenemos 2400 usuarios activos.', 'smooth')).toBe('refuse:closed-class-drift:number');
  });
});

describe('D3 inflected negation / modality / quantifiers (lemma classes)', () => {
  const cases: [string, string, string, 'accept' | 'refuse'][] = [
    // ML-0 fr-fil-01, refused on the live line: a person change of the same modal.
    ['fr', 'Euh, on devrait reporter la démo.', 'Nous devrions reporter la démo.', 'accept'],
    ['ru', 'Я, ну, никого не вижу.', 'Я никого не вижу.', 'accept'],
    ['ru', 'Всё готово к релизу.', 'Все готово к релизу.', 'accept'],
    ['de', 'Ich habe keinen Zugang.', 'Ich habe einen Zugang.', 'refuse'],
    ['fr', 'Il ne répond plus.', 'Il répond.', 'refuse'],
    ['es', 'Tampoco funciona.', 'También funciona.', 'refuse'],
    ['ru', 'Никого не было.', 'Кого-то не было.', 'refuse'],
    ['ko', '아직 연락이 없습니다.', '아직 연락이 있습니다.', 'refuse'],
    ['ko', '그 파일은 쓰지 않았습니다.', '그 파일은 썼습니다.', 'refuse'],
    ['es', 'Deberíamos esperar.', 'Debemos esperar.', 'refuse'],
    ['ja', '午後三時に来てください。', '午前三時に来てください。', 'refuse'],
  ];
  for (const [lang, raw, pol, want] of cases) {
    it(`${lang}: ${raw} -> ${pol} is ${want}ed under smooth`, () => {
      expect(verdict(raw, pol, 'smooth', lang).split(':')[0]).toBe(want);
    });
  }
});

describe('D4 structure: negation per clause, dropped clause, register', () => {
  const cases: [string, string, string, 'accept' | 'refuse'][] = [
    ['de', 'Ich habe nicht gesagt, dass wir das Release verschieben.', 'Ich habe gesagt, dass wir das Release nicht verschieben.', 'refuse'],
    ['es', 'No dije que el cliente pagó la factura.', 'Dije que el cliente no pagó la factura.', 'refuse'],
    ['ja', '本番には入れないで、ステージングに入れてください。', '本番に入れて、ステージングには入れないでください。', 'refuse'],
    ['ko', '자료는 이 대리님께 보내 주시고, 팀장님께도 공유해 주세요.', '자료는 이 대리님께 보내 주세요.', 'refuse'],
    ['fr', 'Tu peux me rappeler ce soir ?', 'Vous pouvez me rappeler ce soir ?', 'refuse'],
    ['de', 'Könnten Sie mir den Bericht schicken?', 'Könntest du mir den Bericht schicken?', 'refuse'],
    ['ru', 'Можешь перезвонить мне вечером?', 'Можете перезвонить мне вечером?', 'refuse'],
    ['ja', '明日の資料、送ってくれる？', '明日の資料を送っていただけますか？', 'refuse'],
    ['ko', '내일 자료 좀 보내 줄래?', '내일 자료 좀 보내 주시겠어요?', 'refuse'],
    // Legitimate edits that keep structure and register.
    ['de', 'Äh, ich glaube, wir sollten, ähm, das Release verschieben.', 'Ich glaube, wir sollten das Release verschieben.', 'accept'],
    ['de', 'Sie hat gesagt, dass es nicht klappt.', 'Sie hat gesagt, dass es nicht klappt.', 'accept'],
    ['ko', '음, 어, 데모는 다음 주로 미루는 게 좋을 것 같아요.', '데모는 다음 주로 미루는 게 좋을 것 같아요.', 'accept'],
    ['ja', '皆さん てん 本番へのデプロイが完了しました まる', '皆さん、本番へのデプロイが完了しました。', 'accept'],
    ['ru', 'Э, я думаю, что нам, ну, стоит перенести демо.', 'Я думаю, что нам стоит перенести демо.', 'accept'],
  ];
  for (const [lang, raw, pol, want] of cases) {
    it(`${lang}: ${raw} -> ${pol} is ${want}ed under smooth`, () => {
      expect(verdict(raw, pol, 'smooth', lang).split(':')[0]).toBe(want);
    });
  }
});

describe('D6 self-corrections in the session language (smooth only)', () => {
  const cases: [string, string, string, 'accept' | 'refuse'][] = [
    ['fr', "Envoie le fichier à Paul, non, pardon, à Pierre, avant midi.", 'Envoie le fichier à Pierre avant midi.', 'accept'],
    ['de', 'Schick die Datei an Thomas, nein, ich meine an Tobias, bis heute Mittag.', 'Schick die Datei an Tobias, bis heute Mittag.', 'accept'],
    ['de', 'Wir treffen uns um 3, nein, um 4 Uhr.', 'Wir treffen uns um 4 Uhr.', 'accept'],
    ['es', 'Mándale el archivo a Pablo, no, perdón, a Pedro, antes del mediodía.', 'Mándale el archivo a Pedro antes del mediodía.', 'accept'],
    ['ru', 'Отправь файл Павлу, нет, то есть Петру, до обеда.', 'Отправь файл Петру до обеда.', 'accept'],
    ['ko', '자료는 김 대리님께, 아니, 이 대리님께 보내 주세요.', '자료는 이 대리님께 보내 주세요.', 'accept'],
    ['ja', '資料は山田さんに、いや、山本さんに送ってください。', '資料は山本さんに送ってください。', 'accept'],
    // Keeping the replaced value, or dropping the repair, is not a resolution.
    ['es', 'Mándale el archivo a Pablo, no, perdón, a Pedro.', 'Mándale el archivo a Pablo.', 'refuse'],
    ['ru', 'Отправь файл Павлу, нет, то есть Петру.', 'Отправь файл Павлу, Петру.', 'refuse'],
    ['ko', '자료는 김 대리님께, 아니, 이 대리님께 보내 주세요.', '자료는 김 대리님께 보내 주세요.', 'refuse'],
    // A negation that answers, not corrects: no parallel repair, never a marker.
    ['ru', 'Это готово? Нет, проверь ещё раз.', 'Это готово? Проверь ещё раз.', 'refuse'],
    ['es', 'El backend está listo, no, todavía falla el login.', 'El backend está listo, todavía falla el login.', 'refuse'],
    ['fr', "C'est réglé, non, le serveur plante encore.", "C'est réglé, le serveur plante encore.", 'refuse'],
  ];
  for (const [lang, raw, pol, want] of cases) {
    it(`${lang}: ${raw} -> ${pol} is ${want}ed under smooth`, () => {
      expect(verdict(raw, pol, 'smooth', lang).split(':')[0]).toBe(want);
    });
    if (want === 'accept') {
      it(`${lang}: strict keeps both values (${raw.slice(0, 24)})`, () => {
        expect(verdict(raw, pol, 'strict', lang).split(':')[0]).toBe('refuse');
      });
    }
  }
});

describe('ML-1 review fixes', () => {
  // F1: a modal's person / number is part of what was said.
  const f1: [string, string, string][] = [
    ['es', 'puedo hacerlo mañana', 'Puede hacerlo mañana.'],
    ['es', 'debo pagar la factura', 'Debe pagar la factura.'],
    ['es', '¿podéis venir mañana?', '¿Pueden venir mañana?'],
    ['fr', 'on peut le faire demain', 'Ils peuvent le faire demain.'],
    ['de', 'ihr könnt das morgen machen', 'Sie können das morgen machen.'],
    ['de', 'ich muss das heute erledigen', 'Wir müssen das heute erledigen.'],
    ['fr', 'je dois partir maintenant', 'Nous devons partir maintenant.'],
  ];
  for (const [lang, raw, pol] of f1) {
    for (const s of both) {
      it(`F1 ${lang} ${s}: ${raw} -> ${pol} is refused`, () => { expect(verdict(raw, pol, s, lang).split(':')[0]).toBe('refuse'); });
    }
  }
  it('F1 keeps on devrait -> nous devrions (on is a first person plural)', () => {
    expect(verdict('Euh, on devrait reporter la démo.', 'Nous devrions reporter la démo.', 'smooth', 'fr')).toBe('accept');
  });

  // F2: an English clause that gets its own sentence or bullet is not a translation.
  const f2: [string, string, string][] = [
    ['zh', '我们今天要讨论一下新版本的问题，then we need to update the docs for the release，最后下午五点之前把代码合进去', '我们今天要讨论一下新版本的问题。Then we need to update the docs for the release. 最后，下午五点之前把代码合进去。'],
    ['zh', '我想说的是，呃，we should not over engineer this，嗯，先做一个简单版本上线看看。', '我想说的是，we should not over engineer this，先做一个简单版本上线看看。'],
    ['ko', '오늘 회의는 취소됐어요 we will reschedule it next week 다음 주에 다시 연락드릴게요', '오늘 회의는 취소됐어요. We will reschedule it next week. 다음 주에 다시 연락드릴게요.'],
    ['de', 'ähm deploy staging first then run tests', 'Deploy to staging first, then run the tests.'],
  ];
  for (const [lang, raw, pol] of f2) {
    it(`F2 ${lang}: no language drift on ${pol.slice(0, 30)}`, () => { expect(languageDrift(raw, pol, lang)).toBeNull(); });
  }
  it('F2 organize keeps an English bullet', () => {
    const v = guardComposeOutput({ task: 'organize', source: '客户那边反馈了几个问题 一个是登录很慢 一个是 the export button does not work on Safari 还有就是希望加一个暗色模式', output: '客户反馈了几个问题：\n- 登录很慢\n- The export button does not work on Safari\n- 希望加一个暗色模式', source_lang: 'zh' });
    expect(v.ok ? 'ok' : v.rule).toBe('ok');
  });
  it('F2 still refuses a translation with an abbreviation in it', () => {
    expect(languageDrift('Das Meeting mit Frau Müller findet in Düsseldorf statt.', 'The meeting with Ms. Müller takes place in Düsseldorf.', 'de')).toBe('en');
  });

  // F3: French 70-79 / 90-99 are one number.
  it('F3 soixante-dix-huit and quatre-vingt-dix-neuf', () => {
    expect(verdict('Il y a soixante-dix-huit personnes.', 'Il y a 78 personnes.', 'smooth', 'fr')).toBe('accept');
    expect(verdict('Ça fait quatre-vingt-dix-neuf euros.', 'Ça fait 99 euros.', 'smooth', 'fr')).toBe('accept');
    expect(verdict('Il y a soixante-dix-huit personnes.', 'Il y a 70 8 personnes.', 'smooth', 'fr').split(':')[0]).toBe('refuse');
    expect(verdict('Il y a dix-sept personnes.', 'Il y a 17 personnes.', 'smooth', 'fr')).toBe('accept');
  });

  // F4: a Russian number word rewritten as digits is not a dropped clause.
  for (const s of both) {
    it(`F4 ru ${s}`, () => {
      expect(verdict('у нас двадцать пять заказов', 'У нас 25 заказов.', s, 'ru')).toBe('accept');
      expect(verdict('двадцать пятого марта', '25 марта.', s, 'ru')).toBe('accept');
      expect(verdict('я отправил отчёт но ответа пока нет', 'Я отправил отчёт.', s, 'ru').split(':')[0]).toBe('refuse');
    });
  }

  // F5: a negation moved across an elided qu'.
  for (const s of both) {
    it(`F5 fr ${s}`, () => { expect(verdict("je ne pense pas qu'il viendra", "Je pense qu'il ne viendra pas.", s, 'fr').split(':')[0]).toBe('refuse'); });
  }
});
