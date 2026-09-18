/**
 * Парсер объявлений из чатов попутчиков / посылок / передач.
 *
 * Чистые функции без зависимостей — работает и в Cloudflare Worker, и в node.
 *
 * Что умеет:
 *  - структурированные заявки (#посылка с полями Откуда/Куда/Когда/Цена/Комментарий);
 *  - свободный текст водителей («18-19.9 Белосток Гр Минск»);
 *  - **два направления в одном сообщении** — разбивает на отдельные плечи (legs):
 *    по датам («18-19.9 туда / 20-21.9 обратно») и по слову «обратно»
 *    (с явным маршрутом или разворотом предыдущего плеча);
 *  - **пограничные пункты пропускает**: Кузница, Брузги, Тересполь и т.д.
 *    не попадают в from/to/via, а складываются отдельно в `borderPoints`.
 *
 * Семантика цепочки «A B C»: from=A, to=C, via=[B].
 */

export interface AdLeg {
  from: string | null;
  to: string | null;
  via: string[];
  /** Пограничные пункты на маршруте — для заявки пропускаются, но не теряются. */
  borderPoints: string[];
  /** Дата как в тексте: «18-19.9», «20.09», «28 сентября», «до 22.09.2026». */
  dateRaw: string | null;
  /** true — плечо получено разворотом предыдущего по слову «обратно». */
  reversed?: boolean;
}

export interface ParsedAd {
  kind: 'parcel' | 'driver' | 'unknown';
  legs: AdLeg[];
  contacts: string[];
  price: string | null;
  comment: string | null;
}

// ---------------------------------------------------------------------------
// Справочники: города/страны и пограничные пункты (ключи — в нижнем регистре)
// ---------------------------------------------------------------------------

/** Алиас (lowercase) → каноническое название. */
const CITY_ALIASES: Record<string, string> = {
  // Беларусь
  'минск': 'Минск',
  'minsk': 'Минск',
  'гродно': 'Гродно',
  'гродна': 'Гродно',
  'гр': 'Гродно',
  'grodno': 'Гродно',
  'брест': 'Брест',
  'brest': 'Брест',
  'витебск': 'Витебск',
  'vitebsk': 'Витебск',
  'гомель': 'Гомель',
  'gomel': 'Гомель',
  'могилёв': 'Могилёв',
  'могилев': 'Могилёв',
  'мог': 'Могилёв', // см. lookupPlace: только с заглавной (иначе путается с глаголом «мог»)
  'mogilev': 'Могилёв',
  'бобруйск': 'Бобруйск',
  'барановичи': 'Барановичи',
  'борисов': 'Борисов',
  'пинск': 'Пинск',
  'лида': 'Лида',
  'мозырь': 'Мозырь',
  'орша': 'Орша',
  'солигорск': 'Солигорск',
  'полоцк': 'Полоцк',
  'новополоцк': 'Новополоцк',
  'жлобин': 'Жлобин',
  'светлогорск': 'Светлогорск',
  'речица': 'Речица',
  'кобрин': 'Кобрин',
  'слуцк': 'Слуцк',
  'волковыск': 'Волковыск',
  'слоним': 'Слоним',
  'сморгонь': 'Сморгонь',
  'молодечно': 'Молодечно',
  'жодино': 'Жодино',
  // Польша
  'белосток': 'Белосток',
  'bialystok': 'Белосток',
  'варшава': 'Варшава',
  'warszawa': 'Варшава',
  'warsaw': 'Варшава',
  'краков': 'Краков',
  'гданьск': 'Гданьск',
  'катовице': 'Катовице',
  'познань': 'Познань',
  'вроцлав': 'Вроцлав',
  'люблин': 'Люблин',
  'лодзь': 'Лодзь',
  'августов': 'Августов',
  'сувалки': 'Сувалки',
  'бяла подляска': 'Бяла-Подляска',
  // Балтия
  'вильнюс': 'Вильнюс',
  'vilnius': 'Вильнюс',
  'каунас': 'Каунас',
  'рига': 'Рига',
  'таллин': 'Таллин',
  'таллинн': 'Таллин',
  // Россия
  'москва': 'Москва',
  'мск': 'Москва',
  'санкт петербург': 'Санкт-Петербург',
  'спб': 'Санкт-Петербург',
  'питер': 'Санкт-Петербург',
  'смоленск': 'Смоленск',
  'брянск': 'Брянск',
  'псков': 'Псков',
  // Украина
  'киев': 'Киев',
  'київ': 'Киев',
  'kiev': 'Киев',
  'kyiv': 'Киев',
  'львов': 'Львов',
  'одесса': 'Одесса',
  'харьков': 'Харьков',
  // Турция и др.
  'стамбул': 'Стамбул',
  'istanbul': 'Стамбул',
  // Страны (маршруты уровня «из РБ в Киев»)
  'рб': 'Беларусь',
  'беларусь': 'Беларусь',
  'белоруссия': 'Беларусь',
  'польша': 'Польша',
  'пл': 'Польша',
  'украина': 'Украина',
  'литва': 'Литва',
  'латвия': 'Латвия',
  'эстония': 'Эстония',
  'россия': 'Россия',
  'рф': 'Россия',
  'турция': 'Турция',
};

/** Пограничные пункты: пропускаем для заявки, но сохраняем в `borderPoints`. */
const BORDER_ALIASES: Record<string, string> = {
  // BY–PL
  'кузница': 'Кузница',
  'кузница белостоцка': 'Кузница',
  'брузги': 'Брузги',
  'берестовица': 'Берестовица',
  'бобровники': 'Бобровники',
  'тересполь': 'Тересполь',
  'козловичи': 'Козловичи',
  'кукурыки': 'Кукурыки',
  'песчатка': 'Песчатка',
  'половцы': 'Половцы',
  'домачево': 'Домачево',
  'словатичи': 'Словатичи',
  'славатичи': 'Словатичи',
  // BY–LT
  'каменный лог': 'Каменный Лог',
  'котловка': 'Котловка',
  'бенякони': 'Бенякони',
  'привалка': 'Привалка',
  'видзы': 'Видзы',
  // BY–LV
  'григоровщина': 'Григоровщина',
  'урбаны': 'Урбаны',
  'силене': 'Силене',
  // BY–UA
  'новая гута': 'Новая Гута',
  'новые яриловичи': 'Новые Яриловичи',
  'веселовка': 'Веселовка',
  'сеньковка': 'Сеньковка',
  'мокраны': 'Мокраны',
  'доманово': 'Доманово',
  'выступовичи': 'Выступовичи',
  'глушкевичи': 'Глушкевичи',
};

/**
 * Склонения топонимов: «из/до/с + род.п.» и «в/во/через + предл./вин.п.»
 * («из Киева», «в Москву», «через Кузницу») → те же канонические названия.
 */
const INFLECTED_CITY_ALIASES: Record<string, string> = {
  'минска': 'Минск',
  'минске': 'Минск',
  'бреста': 'Брест',
  'бресте': 'Брест',
  'витебска': 'Витебск',
  'витебске': 'Витебск',
  'гомеля': 'Гомель',
  'гомеле': 'Гомель',
  'могилёва': 'Могилёв',
  'могилёве': 'Могилёв',
  'могилева': 'Могилёв',
  'могилеве': 'Могилёв',
  'бобруйска': 'Бобруйск',
  'бобруйске': 'Бобруйск',
  'барановичей': 'Барановичи',
  'барановичах': 'Барановичи',
  'борисова': 'Борисов',
  'борисове': 'Борисов',
  'пинска': 'Пинск',
  'пинске': 'Пинск',
  'лиды': 'Лида',
  'лиде': 'Лида',
  'лиду': 'Лида',
  'мозыря': 'Мозырь',
  'мозыре': 'Мозырь',
  'орши': 'Орша',
  'орше': 'Орша',
  'оршу': 'Орша',
  'солигорска': 'Солигорск',
  'солигорске': 'Солигорск',
  'полоцка': 'Полоцк',
  'полоцке': 'Полоцк',
  'новополоцка': 'Новополоцк',
  'новополоцке': 'Новополоцк',
  'жлобина': 'Жлобин',
  'жлобине': 'Жлобин',
  'светлогорска': 'Светлогорск',
  'светлогорске': 'Светлогорск',
  'речицы': 'Речица',
  'речице': 'Речица',
  'речицу': 'Речица',
  'кобрина': 'Кобрин',
  'кобрине': 'Кобрин',
  'слуцка': 'Слуцк',
  'слуцке': 'Слуцк',
  'волковыска': 'Волковыск',
  'волковыске': 'Волковыск',
  'слонима': 'Слоним',
  'слониме': 'Слоним',
  'сморгони': 'Сморгонь',
  'белостока': 'Белосток',
  'белостоке': 'Белосток',
  'варшавы': 'Варшава',
  'варшаве': 'Варшава',
  'варшаву': 'Варшава',
  'кракова': 'Краков',
  'кракове': 'Краков',
  'гданьска': 'Гданьск',
  'гданьске': 'Гданьск',
  'катовиц': 'Катовице',
  'катовицах': 'Катовице',
  'познани': 'Познань',
  'вроцлава': 'Вроцлав',
  'вроцлаве': 'Вроцлав',
  'люблина': 'Люблин',
  'люблине': 'Люблин',
  'лодзи': 'Лодзь',
  'августова': 'Августов',
  'августове': 'Августов',
  'сувалок': 'Сувалки',
  'сувалках': 'Сувалки',
  'вильнюса': 'Вильнюс',
  'вильнюсе': 'Вильнюс',
  'каунаса': 'Каунас',
  'каунасе': 'Каунас',
  'риги': 'Рига',
  'риге': 'Рига',
  'ригу': 'Рига',
  'таллина': 'Таллин',
  'таллине': 'Таллин',
  'москвы': 'Москва',
  'москве': 'Москва',
  'москву': 'Москва',
  'санкт петербурга': 'Санкт-Петербург',
  'санкт петербурге': 'Санкт-Петербург',
  'смоленска': 'Смоленск',
  'смоленске': 'Смоленск',
  'брянска': 'Брянск',
  'брянске': 'Брянск',
  'пскова': 'Псков',
  'пскове': 'Псков',
  'киева': 'Киев',
  'киеве': 'Киев',
  'києва': 'Киев',
  'києві': 'Киев',
  'львова': 'Львов',
  'львове': 'Львов',
  'одессы': 'Одесса',
  'одессе': 'Одесса',
  'одессу': 'Одесса',
  'харькова': 'Харьков',
  'харькове': 'Харьков',
  'стамбула': 'Стамбул',
  'стамбуле': 'Стамбул',
  'беларуси': 'Беларусь',
  'белоруссии': 'Беларусь',
  'польши': 'Польша',
  'польше': 'Польша',
  'польшу': 'Польша',
  'украины': 'Украина',
  'украине': 'Украина',
  'украину': 'Украина',
  'литвы': 'Литва',
  'литве': 'Литва',
  'литву': 'Литва',
  'латвии': 'Латвия',
  'латвию': 'Латвия',
  'эстонии': 'Эстония',
  'эстонию': 'Эстония',
  'россии': 'Россия',
  'россию': 'Россия',
  'турции': 'Турция',
  'турцию': 'Турция',
};

const INFLECTED_BORDER_ALIASES: Record<string, string> = {
  'кузницу': 'Кузница',
  'кузницы': 'Кузница',
  'берестовицу': 'Берестовица',
  'берестовицы': 'Берестовица',
  'тересполя': 'Тересполь',
  'тересполе': 'Тересполь',
  'песчатку': 'Песчатка',
  'печатки': 'Песчатка',
  'котловку': 'Котловка',
  'котловки': 'Котловка',
  'привалку': 'Привалка',
  'привалки': 'Привалка',
  'григоровщину': 'Григоровщина',
  'григоровщины': 'Григоровщина',
  'новую гуту': 'Новая Гута',
  'новой гуты': 'Новая Гута',
  'веселовку': 'Веселовка',
  'веселовки': 'Веселовка',
  'сеньковку': 'Сеньковка',
};

Object.assign(CITY_ALIASES, INFLECTED_CITY_ALIASES);
Object.assign(BORDER_ALIASES, INFLECTED_BORDER_ALIASES);

export interface ChainItem {
  name: string;
  border: boolean;
}

function lookupPlace(phraseLower: string, rawFirstWord: string): ChainItem | null {
  // «мог» с маленькой буквы — почти наверняка глагол («не мог взять»), а не Могилёв.
  if (phraseLower === 'мог') {
    const first = rawFirstWord.charAt(0);
    if (first === first.toLowerCase()) return null;
  }
  const city = CITY_ALIASES[phraseLower];
  if (city) return { name: city, border: false };
  const bp = BORDER_ALIASES[phraseLower];
  if (bp) return { name: bp, border: true };
  return null;
}

/** Упорядоченная цепочка мест в тексте (города + погранпункты, дубли подряд схлопываются). */
export function extractChain(text: string): ChainItem[] {
  const words = text.match(/[A-Za-zА-Яа-яЁё]+/g) ?? [];
  const out: ChainItem[] = [];
  for (let i = 0; i < words.length; i++) {
    const w0 = words[i] as string;
    let hit: ChainItem | null = null;
    let span = 1;
    // Сначала пробуем двусловное название («Каменный Лог», «Бяла Подляска»).
    if (i + 1 < words.length) {
      const w1 = words[i + 1] as string;
      hit = lookupPlace(`${w0.toLowerCase()} ${w1.toLowerCase()}`, w0);
      if (hit) span = 2;
    }
    if (!hit) hit = lookupPlace(w0.toLowerCase(), w0);
    if (hit) {
      const prev = out[out.length - 1];
      if (!prev || prev.name !== hit.name) out.push(hit);
      i += span - 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Даты
// ---------------------------------------------------------------------------

const MONTHS_GEN =
  'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';

// Юникодные границы слова: обычный \b не работает с кириллицей
// («сентября\b» не матчится, т.к. «я» не входит в \w).
const WB_LEFT = '(?<![\\p{L}\\p{N}_])';
const WB_RIGHT = '(?![\\p{L}\\p{N}_])';

const DATE_RE = new RegExp(
  `${WB_LEFT}\\d{1,2}\\.\\d{1,2}\\.\\d{2,4}${WB_RIGHT}` + // 22.09.2026
    `|${WB_LEFT}\\d{1,2}\\.\\d{1,2}\\s*[–—-]\\s*\\d{1,2}\\.\\d{1,2}${WB_RIGHT}` + // 29.09-1.10
    `|${WB_LEFT}\\d{1,2}\\s*[–—-]\\s*\\d{1,2}\\.\\d{1,2}${WB_RIGHT}` + // 18-19.9
    `|${WB_LEFT}\\d{1,2}\\s+(?:${MONTHS_GEN})${WB_RIGHT}` + // 28 сентября
    `|${WB_LEFT}\\d{1,2}\\.\\d{1,2}${WB_RIGHT}`, // 18.09
  'giu'
);

/**
 * Отсекает ложные срабатывания: время «15.00-16.00» (месяц 00),
 * мусор вида «99.99» и т.п.
 */
function isValidDateMatch(m: string): boolean {
  for (const p of m.matchAll(/(\d{1,2})\.(\d{1,2})/g)) {
    const d = Number(p[1]);
    const mo = Number(p[2]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return false;
  }
  const rest = m.replace(/(\d{1,2})\.(\d{1,2})/g, ' ');
  for (const n of rest.match(/\d+/g) ?? []) {
    const v = Number(n);
    if (v >= 1900 && v <= 2100) continue; // год
    if (v < 1 || v > 31) return false;
  }
  return true;
}

export function findDates(text: string): { text: string; index: number }[] {
  const out: { text: string; index: number }[] = [];
  DATE_RE.lastIndex = 0;
  for (;;) {
    const m = DATE_RE.exec(text);
    if (!m) break;
    if (isValidDateMatch(m[0])) out.push({ text: m[0], index: m.index });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Разбиение на плечи (legs): два направления в одном сообщении
// ---------------------------------------------------------------------------

interface Chunk {
  text: string;
  dates: string[];
}

export interface LegGroup {
  text: string;
  dates: string[];
  back: boolean;
}

const PH_OPEN = '\u0001';
const PH_CLOSE = '\u0002';

/** Режем текст на куски по границам предложений/строк, не разрывая даты. */
function splitChunks(text: string): Chunk[] {
  const dates = findDates(text);
  let prot = '';
  let pos = 0;
  dates.forEach((d, i) => {
    prot += text.slice(pos, d.index) + `${PH_OPEN}${i}${PH_CLOSE}`;
    pos = d.index + d.text.length;
  });
  prot += text.slice(pos);
  return prot
    .split(/[\n.!?;]+/)
    .map((part) => {
      const idxs: number[] = [];
      const restored = part.replace(/\u0001(\d+)\u0002/g, (_s, n: string) => {
        const i = Number(n);
        idxs.push(i);
        return dates[i]?.text ?? '';
      });
      return { text: restored.trim(), dates: idxs.map((i) => dates[i]?.text ?? '') };
    })
    .filter((c) => c.text.length > 0);
}

function mergeChunks(chunks: Chunk[]): LegGroup {
  return {
    text: chunks.map((c) => c.text).join(' '),
    dates: chunks.flatMap((c) => c.dates),
    back: chunks.some((c) => /обратно/i.test(c.text)),
  };
}

/**
 * Группирует куски в плечи. Новое плечо начинается:
 *  - на куске с датой («18-19.9 ... / 20-21.9 ...»);
 *  - на куске со словом «обратно», если в текущем плече уже есть маршрут
 *    («...в Киев. Обратно из Киева в РБ...»).
 * Текст до первой даты (шапка, контакты) приклеивается к первому плечу.
 */
export function splitLegs(text: string): LegGroup[] {
  const chunks = splitChunks(text);
  const legs: Chunk[][] = [];
  let preamble: Chunk[] = [];
  let current: Chunk[] | null = null;
  for (const ch of chunks) {
    const hasDate = ch.dates.length > 0;
    const hasBack = /обратно/i.test(ch.text);
    const currentCities = current
      ? extractChain(mergeChunks(current).text).filter((c) => !c.border).length
      : 0;
    const startsNew = hasDate || (hasBack && current !== null && currentCities >= 2);
    if (startsNew) {
      if (current) {
        legs.push(current);
        current = [ch];
      } else {
        current = [...preamble, ch];
        preamble = [];
      }
    } else if (current) {
      current.push(ch);
    } else {
      preamble.push(ch);
    }
  }
  if (current) legs.push(current);
  else if (preamble.length > 0) legs.push(preamble);
  return legs.map(mergeChunks);
}

function buildLegs(groups: LegGroup[]): AdLeg[] {
  const legs: AdLeg[] = [];
  for (const g of groups) {
    const chain = extractChain(g.text);
    const cities = chain.filter((c) => !c.border).map((c) => c.name);
    const borderPoints = chain.filter((c) => c.border).map((c) => c.name);
    const dateRaw = g.dates.length > 0 ? (g.dates[0] as string) : null;
    const prev = legs[legs.length - 1];
    if (cities.length >= 2) {
      legs.push({
        from: cities[0] as string,
        to: cities[cities.length - 1] as string,
        via: cities.slice(1, -1),
        borderPoints,
        dateRaw,
      });
    } else if (g.back && prev) {
      // «Обратно» без своего маршрута — разворачиваем предыдущее плечо.
      // С одним городом («обратно из Киева») — он становится отправлением.
      const single = cities.length === 1 ? (cities[0] as string) : null;
      legs.push({
        from: single ?? prev.to,
        to: prev.from,
        via: single ? [] : [...prev.via].reverse(),
        borderPoints: single ? borderPoints : [...prev.borderPoints].reverse(),
        dateRaw,
        reversed: true,
      });
    } else if (cities.length === 1) {
      legs.push({ from: cities[0] as string, to: null, via: [], borderPoints, dateRaw });
    } else {
      legs.push({ from: null, to: null, via: [], borderPoints, dateRaw });
    }
  }
  return legs;
}

// ---------------------------------------------------------------------------
// Контакты, цена, комментарий
// ---------------------------------------------------------------------------

const PHONE_RE = /\+\d[\d\s\-().]{6,}\d/g;
const MESSENGER_RE =
  /(viber|вайбер|телеграм|telegram|\btg\b|\bvb\b)\s*:?\s*(@[\w.]+|\+?\d[\d\s\-().]*\d)/gi;

export function extractContacts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.match(PHONE_RE) ?? []) out.push(m.trim());
  for (const m of text.match(MESSENGER_RE) ?? []) out.push(m.trim());
  return [...new Set(out)];
}

function lineValue(text: string, name: string): string | null {
  const m = text.match(new RegExp(`^\\s*${name}\\s*:(.*)$`, 'mi'));
  const v = m?.[1]?.trim();
  return v ? v : null;
}

function fallbackPrice(text: string): string | null {
  const m = text.match(
    /\d+\s*[–—-]\s*\d+\s*\$|\$\s*\d+[\d\s]*|\d+\s*(?:\$|usd|у\.е\.|дол(?:л)?(?:аров)?)/i
  );
  return m ? m[0].trim() : null;
}

function firstCityOrRaw(value: string): string {
  const found = extractChain(value).find((c) => !c.border);
  return found ? found.name : value.trim();
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

export function parseAd(text: string): ParsedAd {
  const contacts = extractContacts(text);
  const hasFrom = /^\s*откуда\s*:/mi.test(text);
  const hasTo = /^\s*куда\s*:/mi.test(text);

  let kind: ParsedAd['kind'] = 'unknown';
  if (/#\s*посылка/i.test(text) || (hasFrom && hasTo)) kind = 'parcel';
  else if (
    /#\s*водитель/i.test(text) ||
    /есть места/i.test(text) ||
    /возьму попут/i.test(text) ||
    /попутчик/i.test(text) ||
    /подстроюсь/i.test(text) ||
    /(^|[^\p{L}])((при|по)?еду)([^\p{L}]|$)/iu.test(text)
  ) {
    kind = 'driver';
  }

  // Структурированная заявка: одно плечо строго по полям.
  if (hasFrom && hasTo) {
    const fromRaw = lineValue(text, 'откуда') ?? '';
    const toRaw = lineValue(text, 'куда') ?? '';
    return {
      kind: 'parcel',
      legs: [
        {
          from: fromRaw ? firstCityOrRaw(fromRaw) : null,
          to: toRaw ? firstCityOrRaw(toRaw) : null,
          via: [],
          borderPoints: [],
          dateRaw: lineValue(text, 'когда'),
        },
      ],
      contacts,
      price: lineValue(text, 'цена') ?? fallbackPrice(text),
      comment: lineValue(text, 'комментарий'),
    };
  }

  return {
    kind,
    legs: buildLegs(splitLegs(text)),
    contacts,
    price: fallbackPrice(text),
    comment: lineValue(text, 'комментарий'),
  };
}
