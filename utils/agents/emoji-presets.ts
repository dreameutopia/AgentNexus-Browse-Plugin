/**
 * 头像 emoji 全量清单（按类别分组，供头像选择器展示）。
 *
 * 数据形态：每类一个以空格分隔的字符串——emoji 字符本身不含空格，
 * 拆分即得逐项列表，比大数组更省体积、更好 diff。
 * 只收录基础形态（不含肤色变体），与主流选择器口径一致；
 * 旗帜由 ISO 3166-1 alpha-2 代码经区域指示符对生成（见 FLAG_CODES）。
 * 各类别在模块初始化时去重（同一 emoji 重复出现只保留首次）。
 */

/** 类别元数据（tab 的 key 与文案） */
export interface EmojiCategory {
  /** 稳定 id（tab 切换的 key） */
  id: string;
  /** 文案 key（hub.emojiCat*） */
  labelKey: string;
  /** 去重后的 emoji 清单 */
  emojis: readonly string[];
}

/**
 * ISO 3166-1 alpha-2 代码：运行时映射为区域指示符对，
 * 保证只产出合法旗帜，避免手写 676 个组合里的无效对。
 */
const FLAG_CODES =
  'AC AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW';

/** 区域指示符基准码位（🇦 的 code point） */
const REGIONAL_INDICATOR_BASE = 0x1f1e6;

/** ISO 代码 → 🇦🇩 形式的旗帜 emoji */
function codeToFlag(code: string): string {
  return code
    .toUpperCase()
    .split('')
    .map(char => String.fromCodePoint(REGIONAL_INDICATOR_BASE + (char.charCodeAt(0) - 65)))
    .join('');
}

const generatedFlags = FLAG_CODES.split(' ')
  .filter(code => code.length === 2)
  .map(codeToFlag);

/** 原始分组（空格分隔字符串；初始化时逐类别去重保序） */
const RAW_CATEGORIES: ReadonlyArray<{ id: string; labelKey: string; emojis: string }> = [
  {
    id: 'smileys',
    labelKey: 'hub.emojiCatSmileys',
    emojis: [
      '😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤗 🤭 🤫 🤔 🤐 🤨',
      '😐 😑 😶 😏 😒 🙄 😬 😌 😔 😪 🤤 😴 🤒 🤕 🤢 🤮 🥵 🥶 😵 🤯 😎 🤠 🥸 🤓 🧐 😕 🙁 😮 😯 😲 🥺',
      '😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤖 👻 👽 👾 🎃',
      '😺 😸 😹 😻 😼 😽 🙀 😿 😾 🫠 🫡 🫢 🫣 🫤 🫨 🫥 🥹',
      '🤡 👺 🤡 🎭 👻 💀 🤖 🧟 🧛 🧟‍♂️',
    ].join(' '),
  },
  {
    id: 'people',
    labelKey: 'hub.emojiCatPeople',
    emojis: [
      '👋 🤚 🖐 ✋ 🖖 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 👊 ✊ 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏',
      '💪 🦾 🦿 🦵 🦶 👂 👃 🧠 🫀 🫁 🦷 🦴 👀 👅 👄 💋 🩸 🫦 🫵 🫶 ✍️ 🫱 🫲 🫳 🫴',
      '🧑 👶 🧒 👦 👧 👨 👩 🧔 👴 👵 🙍 🙎 🙅 🙆 💁 🙇 🤦 🤷 🧑‍🦰 🧑‍🦱 🧑‍🦳 🧑‍🦲',
      '👮 🕵️ 💂 👷 🤴 👸 🧙 🧚 🧛 🧟 🧞 🧜 🧝 🤵 👔 👗 👘 👙 👚 👛 👜 👞 👟 👠 👡 👢 👣 🧣 🧤 🧥 🧦 👑 👡',
      '👓 🕶 🥽 🥼 🦺 🧢 👒 🎩 🎓 👮 🕴 🚶 🚶‍♀️ 🚶‍♂️ 🏃 🏃‍♀️ 🏃‍♂️ 💃 🕺 🧎 🧎‍♀️ 🧎‍♂️',
      '🧑‍🦽 🧑‍🦼 🧑‍🍳 🧑‍🎓 🧑‍🎤 🧑‍🔬 🧑‍💻 🧑‍🏫 🧑‍🏭 🧑‍🚒 🧑‍✈️ 🧑‍⚖️ 👥 👤 🫂',
      '👯‍♀️ 🧖 🧖‍♀️ 🧖‍♂️ 🤸 🤹 🤺 🤼 🤽 🤾 🧘 🧘‍♀️ 🧘‍♂️ 🏌️ 🏄 🏊 🏊‍♀️ 🏋️ 🤼 🤽 🤾 🧗 🧗‍♀️ 🧗‍♂️',
      '⛷ 🏂 🛷 🥌 🪂 🛹 🛼 🚴 🚴‍♀️ 🚴‍♂️ 🚵 🚵‍♀️ 🚵‍♂️ 🤸‍♂️ 🤸‍♀️ 🤸 🤾‍♀️ 🤾‍♂️',
      '🤰 🤱 🧑‍🍼 👨‍👩‍👧 👨‍👩‍👦 👨‍👩‍👧‍👦 👨‍👦 👨‍👧 👨‍👦‍👦 👨‍👧‍👧 👩‍👩‍👦 👩‍👩‍👧 👩‍👩‍👧‍👦 👨‍👨‍👦 👨‍👨‍👧 👨‍👨‍👧‍👦 👩‍👦 👩‍👧 👩‍👧‍👦 👩‍👦‍👦 👩‍👧‍👧 👪',
    ].join(' '),
  },
  {
    id: 'animals',
    labelKey: 'hub.emojiCatAnimals',
    emojis: [
      '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐽 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🐥 🦆 🦅 🦉 🦇',
      '🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🪰 🪲 🪳 🦗 🕷 🦂 🐢 🐍 🦎 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐬 🐳 🐋 🦈 🐊',
      '🐅 🐆 🦓 🦍 🦧 🦩 🦫 🦦 🦥 🐁 🐀 🐿 🦔 🐾 🐉 🐲 🐕 🦮 🐩 🐈 🐈‍⬛ 🐓 🦜 🦢 🦤 🪿 🦨 🦡 🐘 🦒',
      '🌱 🌿 ☘️ 🍀 🍁 🍂 🍃 🪴 🌵 🎄 🌲 🌳 🌴 🌸 🌺 🌻 🌼 🌷 🌹 🥀 🪻 🌾 🌾 🍄 🌰 🎃 🐚',
      '🌍 🌎 🌏 🌐 🪐 🌑 🌒 🌓 🌔 🌕 🌖 🌗 🌘 🌙 🌚 🌞 ⭐ 🌟 ✨ ⚡☄️ 🌈 ☀️ ⛅ 🌤 🌦 🌧 ⛈ 🌩 🌨',
      '❄️ ☃️ ⛄ 🌬 💨 🌀 🌊 💧 💦 🫧 🔥 💥 🌡 🌫 🌪 🌦️ 🪶 🐾 🌱 🍃',
    ].join(' '),
  },
  {
    id: 'food',
    labelKey: 'hub.emojiCatFood',
    emojis: [
      '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍑 🍒 🥝 🍍 🥥 🍅 🥑 🍆 🥔 🥕 🌽 🌶 🥒 🥬 🥦 🧄 🧅 🫘 🥜 🌰',
      '🍞 🥐 🥖 🥨 🥯 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🍔 🍟 🍕 🌭 🥪 🌮 🌯 🫔 🥙 🧆 🍖 🍗 🦴 🥩 🍣 🍥 🍚',
      '🍚 🍘 🍙 🥠 🍜 🍝 🍛 🍲 🍱 🥟 🍤 🍡 🍢 🥠 🍣 🍥 🍙 🍚 🍘',
      '🧁 🍰 🎂 🥮 🥧 🍫 🍬 🍭 🍯 🍪 🍩 🍦 🍨 🍧 🥤 🧃 🧋 🍵 ☕ 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🧊 🍾',
      '🧂 🥨 🫘 🫒 🫑 🫚 🫛 🍄 🫓 🥫 🍢 🍡 🍧 🍨 🥛 🍼 🫕 🥘 🥗 🥪 🥙 🧆 🥪',
      '🍉 🍑 🍒 🍍 🥭 🍈 🍊 🍋 🫒 🥬 🥦 🥒 🌽 🫑 🌶 🫚 🫛 🍄 🥔 🧄 🧅 🥕 🫘 🌰 🥜',
    ].join(' '),
  },
  {
    id: 'travel',
    labelKey: 'hub.emojiCatTravel',
    emojis: [
      '🚗 🚕 🚙 🚌 🚎 🏎 🚓 🚑 🚒 🚐 🛻 🚚 🚜 🛵 🏍 🚲 🛴 🛹 🚡 🚠 🚟 🚃 🚋 🚝 🚄 🚅 🚈 🚉 🚊 🚇',
      '🚈 🚞 🚆 🚉 🚊 🚈 🚃 🚋 🚝 🚞 🛫 🛬 🚀 🛸 🚁 🚡 🛶 ⛵ 🚤 🛳 ⛴ 🚢 🛥',
      '🏠 🏡 🏘 🏚 🏗 🏭 🏢 🏬 🏣 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛 ⛪ 🕌 🕍 🕋 ⛩ 🗼 🗽 🏰',
      '🗻 🏔 ⛰ 🌋 🗾 🗿 🏝 🏜 🏞 🏕 ⛺ 🌅 🌄 🌇 🌆 🌃 🌉 🌅 🌄',
      '🗺 🧱 🪨 🛤 🛣 ♨️ 🎡 🎢 🎠 🎪 🏞 🛖 🚉 🚏 🛣️ 🛤️ 🌉',
      '🚰 🚽 🚿 🛁 🚻 🚹 🚺 🚼 🚾 🛗 🚪 🪟 🛋 🛌 🛏 🪑 🏧 🚦 🛑 🚧 ⚠️ 🚏 🚉',
    ].join(' '),
  },
  {
    id: 'activities',
    labelKey: 'hub.emojiCatActivities',
    emojis: [
      '🎃 🎄 🎁 🎂 🎊 🎉 🎀 🎗 🎫 🎟 🎪 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🏏 🏐 🏉 🎾',
      '🎱 🏓 🏸 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 ⛸ 🎿 🏂 🏄 🏊 🏋️ 🤼 🤸 🤹 🤺 🤽 🤾 🧘 🏌️ ⛷️',
      '🏆 🥇 🥈 🥉 🏅 🎖 🏵 🎭 🎨 🎦 🎞 🎥 🎬 📽 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻',
      '🎲 🧩 🪄 🧸 🪆 🪀 🪁 🪃 🃏 🀄 🁢 🁈 🁟 🎴 🎰 ♟️ 🎯 🎳 🎱 🪁',
      '🎰 🧩 🪄 🧸 🪆 🪀 🪁 🪃 🎻 🪕 🎺 🪗 🪘 🪇 🪈 🎸 🎹 🎼 🎤 🎧',
      '⛸ 🎿 🛷 🥌 🪂 🛹 🛼 🚴 🚵 🏌️ ⛷ 🏂 🏄 🏊 🏋️ 🤸 🤹 🤺 🤼 🤽 🤾 🧘 🧗 🧎 🧗‍♀️ 🧗‍♂️',
    ].join(' '),
  },
  {
    id: 'objects',
    labelKey: 'hub.emojiCatObjects',
    emojis: [
      '⌚ 📱 💻 ⌨ 🖥 🖨 🖱 🖲 🕹 🗑 💾 💿 📀 📼 📷 📸 📹 🎥 📽 🎞 📞 ☎ 📟 📠 🔋 🔌 💡 🔦 🕯 🪔 🧯',
      '💸 💵 💴 💶 💷 🪙 💳 🪪 💰 🧮 ✉️ 📧 📨 📩 📤 📥 📦 📫 📪 📬 📭 📮 🗳 ✏️ ✒️ 🖋 🖊 🖌 🖍 📝 📁',
      '📂 🗂 📅 📆 📇 📈 📉 📊 📋 📌 📍 📎 🖇 📐 ✂️ 📏 🧷 🔒 🔓 🔏 🔐 🔑 🗝 🪓 ⛏ ⚒ ⚙ 🔧 🔩 🧰 🧲',
      '🪜 🔪 🗡 ⚔️ 🛡 🚬 ⚰ 🪦 🏺 🧺 🧻 🚽 🪠 🚿 🛁 🧼 🪥 🪒 🧽 🪣 🧤 🧣 🧥 🧦 👕 👘 👗 👙 👚 👛',
      '👜 👞 👟 👠 👡 👢 👣 👑 👓 🕶 🥽 🥼 🦺 👔 🧢 👒 🎩 🩱 🩲 🩳 🥻 🩴 🩰',
      '🛏 🛋 🪑 🚪 🛁 🪟 🛌 🏠 🪞 🧹 🪣 🧺 🧻 🧼 🪥 🪠 🧽',
      '🧸 🪅 📿 💍 💎 🥾 🔨 🪚 🔧 🪛 🔩 ⚙ 🧰 🪤 🧲 🪜 🪞 🪟 🪡 🧵 🧶 🎽 🥋 🥼 🩲',
    ].join(' '),
  },
  {
    id: 'symbols',
    labelKey: 'hub.emojiCatSymbols',
    emojis: [
      '❤️ 🧡 💛 💚 💙 💜 🤎 🖤 🤍 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ☮️ ✝️ ☪️ 🕉 ☸️ ✡️ 🔯 🕎 ☯️ ☦️ 🛐 ⛎',
      '♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ 🆔 ⚛️ 🉑 ☢️ ☣️ 📴 📳 🈶 🈚 🈸 🈺 🈷️ ✴️ 🆚 💮 🉐 🈯 🈲 🈳 🈵 🈴',
      '🈲 🅰️ 🅱️ 🆎 🅾️ 🆑 🆘 ❌ ⭕ 🛑 ⛔ 🚫 💯 💢 ♨️ 🚷 🚯 🚳 🚱 🔞 📵 🚭 ❗ ❕ ❓ ❔ ‼️ ⁉️ 🔅 🔆',
      '〽️ ⚠️ 🚸 🔱 🛡 ♻️ ✅ ♇ 💠 ✳️ ❎ 🌐 ™️ 🔼 🔽 ◀️ ▶️ ⏸ ⏹ ⏺ ⏭ ⏮ ⏩ ⏪ ↩️ ↪️ ↔️ ↕️ ⤴️ ⤵️ 🔀 🔁',
      '🔂 🔊 🔉 🔈 🔇 🎵 🎶 ➕ ➖ ➗ ✖️ ➰ ➿ ✔️ ☑️ ©️ ®️ #️⃣ *️⃣ 0️⃣ 1️⃣ 2️⃣ 3️⃣ 4️⃣ 5️⃣ 6️⃣ 7️⃣',
      '8️⃣ 9️⃣ 🔟 🔠 🔡 🔢 🔣 🔤 🆎 🆑 🆒 🆓 ℹ️ 🈁 🆕 🆖 🆗 🆘 🆙 ⚫ ⚪ 🔴 🟠 🟡 🟢 🔵 🟣 🟤',
      '🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ ◼️ ◻️ ◾ ◽ ▫️ ▪️ 🔶 🔷 🔸 🔹 🔺 🔻 💠 🔲 🔳 🔘 ♾️ 🧿 ⚜️ ♿ 🔰 Ⓜ️',
      '🪪 ⚧️ 🚻 🚹 🚺 🚼 🚾 ♾️ 🚫 🆚 🈁 🈲 🈳 🈵 🈶 🈸 🈺 🈷️ 🈴 🈹 🈁',
    ].join(' '),
  },
  {
    id: 'flags',
    labelKey: 'hub.emojiCatFlags',
    // 旗帜：ISO 代码生成 + 少量不能由代码对表达的特殊旗帜（彩虹旗 / 海盗旗 / 跨性别旗等）
    emojis: [...generatedFlags, '🏳️ 🏴 🏳️‍🌈 🏴‍☠️ 🏳️‍⚧️ 🇺🇳 🇪🇺'].join(' '),
  },
];

/** 逐类别去重保序（初始化时执行一次，组件直接消费） */
function dedupe(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const emoji of raw.split(' ')) {
    if (!emoji || seen.has(emoji)) continue;
    seen.add(emoji);
    result.push(emoji);
  }
  return result;
}

/** 类别清单（顺序即选择器 tab 顺序） */
export const EMOJI_CATEGORIES: readonly EmojiCategory[] = Object.freeze(
  RAW_CATEGORIES.map(category => Object.freeze({ ...category, emojis: Object.freeze(dedupe(category.emojis)) })),
);

/** 全部 emoji（按类别顺序展平，去重保序）——供搜索 / 计数等场景 */
export function flattenEmojis(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const category of EMOJI_CATEGORIES) {
    for (const emoji of category.emojis) {
      if (seen.has(emoji)) continue;
      seen.add(emoji);
      result.push(emoji);
    }
  }
  return result;
}
