// GUARD-CJK (2026-10-15): the word tables the Han / kana / Hangul / Cyrillic
// content check reads (stt-polish-guard-cjk.ts). Data only.
//
// Every table here is a CLOSED list on purpose: the check refuses when a member
// of one class is lost or replaced, and a closed list is what keeps it from
// refusing the open-ended corrections a polish is for. A word missing from a
// list is guarded only by the general Han / Hangul / Cyrillic rules and the
// edit budget, never by nothing.

/** One meaning class: every surface in it says the same thing. */
export interface TermClass {
  key: string;
  kind: 'time' | 'place';
  surfaces: readonly string[];
}

const t = (key: string, ...surfaces: string[]): TermClass => ({ key, kind: 'time', surfaces });
const p = (key: string, ...surfaces: string[]): TermClass => ({ key, kind: 'place', surfaces });

/** Days, weeks, months, years, weekdays and parts of the day in Chinese
 *  (simplified and traditional), Japanese (with the kana readings of three
 *  characters or more) and Korean. Matched as substrings, longest first, on
 *  text with spaces and punctuation removed and katakana folded to hiragana. */
export const CJK_TIME: readonly TermClass[] = [
  t('d0', '今天', '今日', '今儿', '本日', 'きょう', '오늘'),
  t('d+1', '明天', '明日', '明儿', 'あした', '내일'),
  t('d+2', '后天', '後天', '明後日', 'あさって', '모레', '내일모레'),
  t('d+3', '大后天', '大後天', '明明後日', 'しあさって', '글피'),
  t('d-1', '昨天', '昨日', '昨儿', 'きのう', '어제'),
  t('d-2', '前天', '一昨日', 'おととい', '그제', '그저께'),
  t('d-3', '大前天'),
  // 今早 and 今天早上 say the same thing: the long form is one word here,
  // read before 今天 + 早上 (longest first).
  t('morning0', '今早', '今天早上', '今朝', 'けさ', '오늘아침'),
  t('morning+1', '明早', '明天早上', '내일아침'),
  t('evening0', '今晚', '今天晚上', '今夜', '今晩', 'こんや', '오늘밤', '오늘저녁'),
  t('evening+1', '明晚', '明天晚上', '明晩', '내일밤', '내일저녁'),
  t('evening-1', '昨晚', '昨天晚上', '昨夜', '昨晩', '어젯밤'),
  t('w0', '这周', '這週', '这星期', '這星期', '这个星期', '這個星期', '本周', '本週', '这礼拜', '這禮拜', '这个礼拜', '這個禮拜', '今週', '이번주'),
  t('w+1', '下周', '下週', '下星期', '下个星期', '下個星期', '下礼拜', '下禮拜', '下个礼拜', '下個禮拜', '来週', '來週', '다음주'),
  t('w+2', '下下周', '下下週', '下下个星期', '下下個星期', '再来週', '다다음주'),
  t('w-1', '上周', '上週', '上星期', '上个星期', '上個星期', '上礼拜', '上禮拜', '上个礼拜', '上個禮拜', '先週', '지난주'),
  t('m0', '这个月', '這個月', '本月', '今月', '이번달'),
  t('m+1', '下个月', '下個月', '下月', '来月', '다음달'),
  t('m-1', '上个月', '上個月', '上月', '先月', '지난달'),
  t('y0', '今年', 'ことし', '올해'),
  t('y+1', '明年', '来年', '來年', '내년'),
  t('y-1', '去年', '昨年', '작년'),
  t('y-2', '前年', '재작년'),
  t('y+2', '后年', '後年', '再来年', '내후년'),
  t('wd1', '周一', '週一', '星期一', '礼拜一', '禮拜一', '月曜', '월요일'),
  t('wd2', '周二', '週二', '星期二', '礼拜二', '禮拜二', '火曜', '화요일'),
  t('wd3', '周三', '週三', '星期三', '礼拜三', '禮拜三', '水曜', '수요일'),
  t('wd4', '周四', '週四', '星期四', '礼拜四', '禮拜四', '木曜', '목요일'),
  t('wd5', '周五', '週五', '星期五', '礼拜五', '禮拜五', '金曜', '금요일'),
  t('wd6', '周六', '週六', '星期六', '礼拜六', '禮拜六', '土曜', '토요일'),
  t('wd7', '周日', '週日', '周天', '週天', '星期日', '星期天', '礼拜天', '禮拜天', '礼拜日', '禮拜日', '日曜', '일요일'),
  t('am', '上午', '午前', '오전'),
  t('pm', '下午', '午後', '오후'),
  t('early', '早上', '早晨', '清晨', '아침'),
  t('noon', '中午', '正午', '점심'),
  t('night', '晚上', '夜里', '夜裡', '夜晚', '저녁', '밤'),
  t('dawn', '凌晨', '새벽'),
  t('dusk', '傍晚', '夕方'),
];

/** Major cities and countries (zh simplified / traditional, ja, ko). A change
 *  to one of these is a change of place, whatever else the sentence says. */
export const CJK_PLACE: readonly TermClass[] = [
  p('beijing', '北京', '베이징'), p('shanghai', '上海', '상하이'), p('guangzhou', '广州', '廣州'),
  p('shenzhen', '深圳'), p('hangzhou', '杭州'), p('nanjing', '南京'),
  p('chongqing', '重庆', '重慶'), p('wuhan', '武汉', '武漢'),
  p('suzhou', '苏州', '蘇州'), p('xiamen', '厦门', '廈門'), p('qingdao', '青岛', '青島'),
  p('hongkong', '香港', '홍콩'), p('macau', '澳门', '澳門'), p('taipei', '台北', '臺北', '타이베이'),
  p('tokyo', '东京', '東京', '도쿄'), p('osaka', '大阪', '오사카'), p('kyoto', '京都', '교토'),
  p('nagoya', '名古屋'), p('yokohama', '横浜', '横滨', '橫濱'), p('sapporo', '札幌'), p('fukuoka', '福冈', '福岡'),
  p('kobe', '神户', '神戸'), p('sendai', '仙台'), p('hiroshima', '广岛', '廣島', '広島'), p('okinawa', '冲绳', '沖繩', '沖縄'),
  p('hokkaido', '北海道'), p('nara', '奈良'),
  p('seoul', '首尔', '首爾', '서울'), p('busan', '釜山', '부산'), p('daegu', '大邱', '대구'), p('incheon', '仁川', '인천'),
  p('gwangju', '광주'), p('daejeon', '대전'), p('ulsan', '울산'), p('jeju', '济州', '濟州', '済州', '제주'), p('suwon', '수원'),
  p('newyork', '纽约', '紐約', '뉴욕'), p('london', '伦敦', '倫敦', '런던'), p('paris', '巴黎', '파리'),
  p('china', '中国', '中國', '중국'), p('japan', '日本', '일본'), p('korea', '韩国', '韓國', '韓国', '한국'),
  p('usa', '美国', '美國', '米国', '미국'), p('uk', '英国', '英國', '영국'), p('france', '法国', '法國', '프랑스'),
  p('germany', '德国', '德國', '독일'), p('russia', '俄罗斯', '俄羅斯', '러시아'), p('canada', '加拿大', '캐나다'),
  p('australia', '澳大利亚', '澳大利亞', '澳洲', '호주'), p('singapore', '新加坡', '싱가포르'),
  p('taiwan', '台湾', '臺灣', '台灣', '대만'),
];

/** Russian / Ukrainian time words, matched as the START of a lowercased word
 *  (ё read as е). A word starts with exactly one stem here, longest first:
 *  послезавтра is not завтра. `not` lists word starts that only look like one
 *  (завтрак is breakfast). */
export interface CyrTime { key: string; starts: readonly string[]; not?: readonly string[] }
export const CYR_TIME: readonly CyrTime[] = [
  { key: 'd0', starts: ['сегодн', 'сьогодн'] },
  { key: 'd+1', starts: ['завтр'], not: ['завтрак', 'завтрашн'] },
  { key: 'd+1adj', starts: ['завтрашн'] },
  { key: 'd+2', starts: ['послезавтр', 'післязавтр'] },
  { key: 'd-1', starts: ['вчер', 'вчор'] },
  { key: 'd-2', starts: ['позавчер', 'позавчор'] },
  { key: 'wd1', starts: ['понедельн', 'понеділ'] },
  { key: 'wd2', starts: ['вторник', 'вівтор'] },
  { key: 'wd3', starts: ['среда', 'среду', 'среды', 'середа', 'середу', 'середи'] },
  { key: 'wd4', starts: ['четверг', 'четвер'] },
  { key: 'wd5', starts: ['пятниц', "п'ятниц", 'пʼятниц', 'пятниц'] },
  { key: 'wd6', starts: ['суббот', 'субот'] },
  { key: 'wd7', starts: ['воскресен', 'неділ'] },
  { key: 'early', starts: ['утро', 'утром', 'утра', 'ранок', 'вранці'] },
  { key: 'evening', starts: ['вечер', 'вечір', 'ввечері'] },
  { key: 'night', starts: ['ночь', 'ночью', 'ночи', 'ніч', 'вночі'] },
];

// Chinese words that carry no content in a transcript: fillers, discourse
// markers and hedges a smoothing pass is asked to remove. Matched as whole
// substrings, longest first, only inside a changed stretch.
export const HAN_FILLERS: readonly string[] = [
  '怎么说呢', '我的意思是', '我觉得', '我认为', '我覺得', '我認為', '我感觉', '我感覺', '一下子', '一下', '也就是说', '你知道吗', '你知道', '就是说', '我是说', '那个那个', '这个这个',
  '那个', '这个', '就是', '然后', '那么', '其实', '反正', '的话', '基本上', '对吧', '是吧', '好吧', '那啥',
  '什么的', '这样子', '那什么', '怎么讲', '我跟你说', '嗯', '啊', '呃', '额', '哎', '唉', '噢', '喔', '嘿', '哇', '哦', '呀', '嘛', '吧', '呢',
];

// Katakana / kanji fillers of Japanese (hiragana never counts as content).
export const KANA_FILLERS: readonly string[] = ['エート', 'エット', 'エー', 'アノー', 'アノ', 'ウーン', 'ンー', 'マア', 'ソノ'];

/** Han characters that are particles, interjections or personal pronouns,
 *  not content. A smoothing pass may drop 我们 / 我觉得 (QP-1 adversarial
 *  fixture adv1-058, stt-polish-guard-qp1.test.ts); swapping one pronoun for
 *  another is refused by HAN_SWAP_PAIRS, which reads the characters as written. */
export const HAN_PARTICLES = new Set([...'的得了过呢吧啊呀嘛哦哈啦么麼嗯呃额額哎唉噢喔嘿哇哟喲呗唄咯我你您他她它们們咱']);

/** Chinese connectives, by meaning. One may replace another of its class
 *  (以及 -> 和); replacing one with another class (但是 -> 所以) is refused.
 *  Adding or dropping one (而且, 还有, 所以 …) is not judged here: no rule of
 *  stt-polish-guard-cjk.ts refuses it, only the §3.1 edit budget counts it. */
export const HAN_CONNECTIVES: readonly (readonly string[])[] = [
  ['以及', '并且', '並且', '而且', '还有', '還有', '和', '与', '與', '跟', '及', '同'],
  ['但是', '可是', '不过', '不過', '然而', '但'],
  ['所以', '因此', '因而', '于是', '於是'],
  ['因为', '因為', '由于', '由於'],
  ['如果', '要是', '假如', '假设', '假設', '若是'],
  ['或者', '还是', '還是', '或'],
];

/** Han numerals: compared by value by the numbers gate. */
export const HAN_NUMERALS = new Set([...'零〇一二两兩三四五六七八九十百千万萬亿億幺壹贰貳叁參肆伍陆陸柒捌玖拾佰仟']);

/** Pairs of Han characters with opposite or different referents that a
 *  one-character "correction" must never swap (buy / sell, come / go, he /
 *  she, you / I …). Read both ways. */
export const HAN_SWAP_PAIRS: ReadonlySet<string> = new Set(`
买卖 買賣 買売 来去 來去 上下 前后 前後 左右 早晚 多少 大小 开关 開關 開閉 开闭 进出 進出 入出 男女 东西 東西 南北
涨跌 漲跌 增减 增減 増減 加减 加減 升降 输赢 輸贏 胜负 勝負 胜败 勝敗 对错 對錯 真假 新旧 新舊 新古 长短 長短 快慢 高低
好坏 好壞 冷热 冷熱 你我 我他 我她 你他 你她 收发 收發 借还 借還 生死 是否 内外 內外 始终 始終 先后
早迟 早遲 早遅 胖瘦 深浅 深淺 远近 遠近 难易 難易 成败 成敗 黑白 明暗 正反 正负 正負 往返 盈亏 盈虧 得失 爱恨 愛恨
推拉 公私 单双 單雙 首尾 头尾 頭尾 动静 動靜 冬夏 春秋 昼夜 晝夜 父母 兄弟 姐妹 兄妹 姐弟 夫妻 老少 存取 赚赔 賺賠
寒暑 起止 入退 买租 卖租 晴雨 甲乙 东南 东北 西南 西北 東南 東北 赢亏
`.split(/\s+/u).filter(Boolean).flatMap((pair) => { const [a, b] = [...pair]; return [`${a}${b}`, `${b}${a}`]; }));

/** Two-character words whose first character, swapped, says the opposite,
 *  where the two characters alone are no pair (出 / 欠 only in 出席 / 欠席). */
export const HAN_SWAP_COMPOUNDS: ReadonlySet<string> = new Set(
  ['出席|欠席'].flatMap((p) => { const [a, b] = p.split('|') as [string, string]; return [`${a}|${b}`, `${b}|${a}`]; }),
);

/** Russian colloquial spellings and the standard word they stand for: a
 *  polish that writes the standard form changed no word (щас -> сейчас). */
export const CYR_COLLOQUIAL: ReadonlyMap<string, string> = new Map([
  ['щас', 'сейчас'], ['ща', 'сейчас'], ['че', 'что'], ['чо', 'что'], ['ваще', 'вообще'],
  ['тыщ', 'тысяч'], ['тыща', 'тысяча'], ['тыщу', 'тысячу'], ['тыщи', 'тысячи'],
]);

/** Simplified -> traditional pairs of common characters. A polish that
 *  rewrites one into the other has changed the user's script. Each character
 *  appears in exactly one pair (pinned by the test). */
const TRAD_SIMP_PAIRS = `
这這 个個 们們 来來 时時 说說 会會 对對 发發 过過 还還 后後 么麼 开開 关關 问問 题題 学學 国國 长長 动動 现現 实實
经經 头頭 机機 电電 话話 见見 认認 为為 让讓 应應 点點 东東 车車 书書 门門 间間 听聽 买買 卖賣 钱錢 银銀 网網 络絡
页頁 视視 觉覺 记記 议議 论論 设設 计計 数數 据據 务務 业業 产產 报報 带帶 边邊 进進 运運 样樣 种種 万萬 与與 两兩
从從 价價 众眾 优優 传傳 体體 写寫 军軍 农農 决決 几幾 击擊 划劃 则則 别別 办辦 区區 医醫 华華 单單 历歷 压壓 厅廳
县縣 变變 号號 吗嗎 员員 团團 园園 图圖 场場 坏壞 块塊 处處 备備 妈媽 宁寧 宝寶 导導 将將 层層 岁歲 师師 帐帳 帮幫
广廣 庆慶 张張 归歸 录錄 总總 战戰 护護 换換 无無 旧舊 显顯 术術 条條 杨楊 极極 标標 树樹 楼樓 欢歡 气氣 汉漢 没沒
测測 满滿 灯燈 热熱 爱愛 状狀 独獨 环環 画畫 盘盤 礼禮 离離 积積 简簡 类類 红紅 约約 级級 纪紀 线線 练練 组組 终終
给給 统統 续續 绿綠 编編 罗羅 职職 联聯 胜勝 脑腦 艺藝 节節 药藥 获獲 营營 补補 装裝 观觀 规規 讲講 许許 访訪 证證
评評 识識 词詞 译譯 试試 该該 语語 误誤 请請 读讀 课課 谁誰 调調 谈談 谢謝 负負 财財 责責 败敗 货貨 质質 购購 贵貴
费費 资資 赛賽 转轉 轮輪 软軟 轻輕 较較 输輸 达達 远遠 连連 迟遲 选選 邮郵 释釋 钟鐘 铁鐵 错錯 键鍵 闭閉 闻聞 队隊
阳陽 阴陰 际際 陆陸 险險 随隨 难難 静靜 韩韓 顶頂 项項 顺順 须須 预預 领領 风風 飞飛 饭飯 馆館 马馬 验驗 鱼魚 鸟鳥
鸡雞 黄黃 龙龍 亚亞 亲親 仅僅 伤傷 儿兒 兰蘭 兴興 养養 内內 册冊 净淨 减減 刚剛 剧劇 劝勸 劳勞 势勢 协協 卫衛 参參
双雙 响響 围圍 圆圓 坚堅 声聲 夺奪 奋奮 妇婦 孙孫 审審 宽寬 寿壽 尔爾 尝嘗 属屬 岛島 币幣 庄莊 废廢 异異 弹彈 忆憶
态態 恶惡 惊驚 惯慣 愿願 戏戲 户戶 扩擴 扫掃 担擔 拥擁 择擇 损損 敌敵 断斷 晓曉 暂暫 杀殺 杂雜 权權 构構 枪槍 桥橋
检檢 欧歐 残殘 毕畢 汇匯 汤湯 泪淚 洁潔 浅淺 济濟 浓濃 润潤 涨漲 渐漸 温溫 湾灣 灭滅 灵靈 灾災 炉爐 爷爺 犹猶 疗療
监監 盖蓋 称稱 稳穩 穷窮 竞競 笔筆 粮糧 紧緊 纯純 纸紙 细細 织織 结結 绍紹 继繼 维維 缘緣 罚罰 聪聰 肤膚 脚腳 脸臉
苏蘇 荣榮 虑慮 虽雖 触觸 训訓 讯訊 诉訴 诗詩 诚誠 详詳 贝貝 贸貿 赵趙 赶趕 跃躍 轨軌 载載 辆輛 迁遷 违違 适適 递遞
遗遺 邻鄰 钢鋼 链鏈 销銷 锁鎖 镇鎮 阅閱 阵陣 隐隱 雾霧 顾顧 顿頓 频頻 颜顏 驱驅 骑騎 麦麥 齐齊
`.split(/\s+/u).filter(Boolean);

export const TRAD_SIMP: ReadonlyMap<string, string> = new Map(
  [...new Set(TRAD_SIMP_PAIRS)].flatMap((pair) => { const [s, tr] = [...pair] as [string, string]; return [[s, tr], [tr, s]] as const; }),
);
export const TRAD_SIMP_PAIR_LIST: readonly string[] = TRAD_SIMP_PAIRS;

/** Korean words with no content of their own: fillers, discourse markers,
 *  pronouns, conjunctions, dependent nouns. Compared after the particle is
 *  stripped. */
export const HANGUL_STOP: ReadonlySet<string> = new Set(`
음 어 아 에 에이 그 저 뭐 이제 약간 좀 그냥 막 진짜 정말 그러니까 그니까 있잖아 있잖아요 저기 그게 네 예 응 아니
나 내 내가 너 네가 저희 우리 제 제가 저는 그녀 그들 이것 그것 저것 이거 그거 저거 여기 거기 것 거 수 때 등 및
아무튼 어쨌든 하여튼 암튼 뭐랄까
그리고 그래서 그런데 근데 하지만 그러면 그럼 또 또는 혹은 그러나 그래도 이렇게 그렇게 저렇게 어떻게 왜 언제 어디 누가 무엇
`.split(/\s+/u).filter(Boolean));

/** Russian discourse fillers that are ordinary words elsewhere: read as
 *  fillers only when set off by commas or a sentence edge ("В общем, всё
 *  готово" -> "Всё готово"; "в общем зале" keeps общем). */
export const CYR_SET_OFF_FILLERS: readonly string[] = [
  'в общем', 'в принципе', 'в смысле', 'так сказать', 'короче говоря', 'честно говоря', 'блин', 'короче',
];

/** Russian / Ukrainian function words and fillers (lowercase, ё -> е). */
export const CYR_STOP: ReadonlySet<string> = new Set(`
и в во на с со к ко у о об обо от до по за из для при про над под через между а но или либо да нет же ли бы
что чтобы как так также тоже это этот эта эти этого этой этим тот та те то того той там тут здесь вот ну
он она оно они я ты мы вы его ее её их ему ей им ими мне меня мной тебе тебя тобой нас нам нами вас вам вами
себя себе свой своя свое своё свои своего своей мой моя мое моё мои моего моей моим твой твоя наш наша наше наши
ваш ваша ваше ваши уже еще ещё очень просто вообще значит короче типа слушай смотри кстати собственно
был была было были быть есть будет будут будем буду если когда где куда откуда потому поэтому зачем почему
кто какой какая какое какие который которая которое которые весь всё все всех всем
ээ э эм мм ага ой ах угу самое
і й та чи що як це цей ця ці той ті там тут ось ну він вона воно вони ми ви мені мене тебе нас вас
`.split(/\s+/u).filter(Boolean));
