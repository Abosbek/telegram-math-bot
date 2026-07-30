const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@libsql/client');

// =====================================================================
// 1. SOZLAMALAR VA BAZAGA ULANISH
// =====================================================================
const db = createClient({
  url: process.env.TURSO_DB_URL,
  authToken: process.env.TURSO_DB_TOKEN
});

const bot = new Telegraf(process.env.BOT_TOKEN);
const SUPER_ADMIN_ID = parseInt(process.env.SUPER_ADMIN_ID);

// Bazani faqat bir marta yuklash uchun kesh-bayroq
let isDbInitialized = false;

async function initDB() {
    if (isDbInitialized) return;

    // ✅ TUZATISH: jadvallar avval hech qachon avtomatik yaratilmagan edi.
    // Agar siz ularni Turso konsolida qo'lda yaratgan bo'lsangiz muammo yo'q,
    // lekin xavfsizlik uchun "IF NOT EXISTS" bilan har doim tekshirib turamiz.
    await db.execute(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'user'
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS favorites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        label TEXT
    );`);
    await db.execute(`CREATE TABLE IF NOT EXISTS user_states (
        user_id INTEGER PRIMARY KEY,
        state TEXT,
        data TEXT
    );`);
    await db.execute(`INSERT OR IGNORE INTO settings (key, value) VALUES
        ('unauth_msg', '⛔ Sizda botdan foydalanish huquqi yo''q. Administrator bilan bog''laning.');`);

    if (SUPER_ADMIN_ID) {
        try {
            await db.execute({
                sql: `INSERT OR IGNORE INTO users (id, role) VALUES (?, 'admin')`,
                args: [SUPER_ADMIN_ID]
            });
        } catch (error) {
            console.error("Admin qo'shishda xatolik:", error.message);
        }
    }

    isDbInitialized = true;
}

// =====================================================================
// 2. KUTISH HOLATLARI (STATE MANAGEMENT)
// =====================================================================
async function setState(userId, state, data = null) {
  const dataStr = data ? JSON.stringify(data) : null;
  await db.execute({
    sql: `INSERT INTO user_states (user_id, state, data) VALUES (?, ?, ?) 
          ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data=excluded.data`,
    args: [userId, state, dataStr]
  });
}

async function getState(userId) {
  const res = await db.execute({ sql: `SELECT state, data FROM user_states WHERE user_id = ?`, args: [userId] });
  if (res.rows.length === 0) return null;
  return { state: res.rows[0].state, data: res.rows[0].data ? JSON.parse(res.rows[0].data) : null };
}

async function clearState(userId) {
  await db.execute({ sql: `DELETE FROM user_states WHERE user_id = ?`, args: [userId] });
}

// =====================================================================
// 2.1. LaTeX -> UNICODE FALLBACK (sendRichMessage ishlamay qolsa ishlatiladi)
// =====================================================================
const GREEK = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', theta: 'θ', lambda: 'λ',
  mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω',
};
const SUP = { 0:'⁰',1:'¹',2:'²',3:'³',4:'⁴',5:'⁵',6:'⁶',7:'⁷',8:'⁸',9:'⁹','+':'⁺','-':'⁻' };
const SUB = { 0:'₀',1:'₁',2:'₂',3:'₃',4:'₄',5:'₅',6:'₆',7:'₇',8:'₈',9:'₉' };
function toScript(str, map) { return str.split('').map(c => map[c] || c).join(''); }

function latexToUnicode(input) {
  let s = input;
  s = s.replace(/\\(sqrt|sum|int|infty|cdot|times|pm|leq|geq|neq|approx|to|rightarrow)/g, (m, w) => ({
    sqrt:'√', sum:'∑', int:'∫', infty:'∞', cdot:'·', times:'×', pm:'±',
    leq:'≤', geq:'≥', neq:'≠', approx:'≈', to:'→', rightarrow:'→'
  }[w] || m));
  s = s.replace(/\\([a-zA-Z]+)/g, (m, w) => GREEK[w] || m);
  s = s.replace(/\^\{([^}]+)\}/g, (m, g) => toScript(g, SUP));
  s = s.replace(/\^([0-9+\-])/g, (m, g) => toScript(g, SUP));
  s = s.replace(/_\{([^}]+)\}/g, (m, g) => toScript(g, SUB));
  s = s.replace(/_([0-9])/g, (m, g) => toScript(g, SUB));
  s = s.replace(/\\frac\{([^}]+)\}\{([^}]+)\}/g, (m, a, b) => `${a}/${b}`);
  s = s.replace(/[{}]/g, '');
  return s.trim();
}

// =====================================================================
// 3. MIDDLEWARE: RUXSAT VA MAJBURIY OBUNA (ANTI-SPAM)
// =====================================================================
bot.use(async (ctx, next) => {
  if (!ctx.from) return next();
  const userId = ctx.from.id;

  try {
    const userRes = await db.execute({ sql: `SELECT role FROM users WHERE id = ?`, args: [userId] });
    const role = userRes.rows.length > 0 ? userRes.rows[0].role : 'guest';
    const isAdmin = role === 'admin';
    const isUser = role === 'user';

    if (!isAdmin && !isUser) {
      if (ctx.message && ctx.message.text === '/start') {
        const msgRes = await db.execute(`SELECT value FROM settings WHERE key = 'unauth_msg'`);
        const text = msgRes.rows[0] ? msgRes.rows[0].value : "⛔ Sizda ruxsat yo'q.";
        return ctx.reply(text);
      }
      return;
    }

    if (!isAdmin) {
      const channelsRes = await db.execute(`SELECT username FROM channels`);
      const channels = channelsRes.rows.map(r => r.username);

      if (channels.length > 0) {
        let notSubscribed = [];
        for (const channel of channels) {
          try {
            const member = await ctx.telegram.getChatMember(channel, userId);
            if (['left', 'kicked'].includes(member.status)) notSubscribed.push(channel);
          } catch (e) { /* Xato bo'lsa o'tkazib yuboramiz */ }
        }

        if (notSubscribed.length > 0) {
          let buttons = notSubscribed.map(ch => [Markup.button.url('📢 A’zo bo‘lish', `https://t.me/${ch.replace('@', '')}`)]);
          buttons.push([Markup.button.callback('✅ Tekshirish', 'check_sub')]);

          if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_sub') {
              return ctx.answerCbQuery("Hali barcha kanallarga a'zo bo'lmagansiz!", { show_alert: true });
          } else if (ctx.callbackQuery) {
              return;
          }
          return ctx.reply("Botdan foydalanish uchun quyidagi kanallarga obuna bo'lishingiz shart:", Markup.inlineKeyboard(buttons));
        } else if (ctx.callbackQuery && ctx.callbackQuery.data === 'check_sub') {
            await ctx.answerCbQuery("Rahmat! Botdan foydalanishingiz mumkin.");
            return ctx.deleteMessage().catch(() => {});
        }
      }
    }

    ctx.state.role = role;
    return next();
  } catch (error) {
    console.error("Middleware xatosi:", error);
  }
});

// =====================================================================
// 4. ADMIN PANEL (BOSHQARUV) — o'zgarishsiz qoldi
// =====================================================================
bot.command('admin', async (ctx) => {
  if (ctx.state.role !== 'admin') return;
  await sendAdminMenu(ctx);
});

async function sendAdminMenu(ctx, edit = false) {
  const text = `⚙️ **Admin Panel**\nSiz botni to'liq boshqara olasiz:`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('👥 Ruxsat berish (Whitelist)', 'adm_users')],
    [Markup.button.callback('📝 Start xabarini tahrirlash', 'adm_msg')],
    [Markup.button.callback('📢 Majburiy kanallar', 'adm_channels')],
    [Markup.button.callback('📊 Statistika & Rassilka', 'adm_stats')]
  ]);

  if (edit) return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(()=> {});
  return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}

bot.action('adm_users', async (ctx) => {
  await setState(ctx.from.id, 'awaiting_user_id');
  return ctx.editMessageText("Mijozning Telegram ID raqamini yuboring:", Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'adm_back')]]));
});

bot.action('adm_msg', async (ctx) => {
  await setState(ctx.from.id, 'awaiting_start_msg');
  const msgRes = await db.execute(`SELECT value FROM settings WHERE key = 'unauth_msg'`);
  const current = msgRes.rows[0] ? msgRes.rows[0].value : '(hali o\'rnatilmagan)';
  return ctx.editMessageText(`Joriy xabar: \n\n_${current}_\n\nYangi ogohlantirish xabarini yuboring:`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'adm_back')]])});
});

bot.action('adm_channels', async (ctx) => {
  const chRes = await db.execute(`SELECT username FROM channels`);
  let buttons = chRes.rows.map(r => [Markup.button.callback(`❌ O'chirish: ${r.username}`, `del_ch_${r.username}`)]);
  buttons.push([Markup.button.callback('➕ Kanal qo‘shish', 'add_ch_prompt')]);
  buttons.push([Markup.button.callback('🔙 Orqaga', 'adm_back')]);
  return ctx.editMessageText("📢 **Majburiy kanallar:**", { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action('add_ch_prompt', async (ctx) => {
  await setState(ctx.from.id, 'awaiting_channel');
  return ctx.editMessageText("Kanal username'ini @ bilan yuboring:", Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'adm_channels')]]));
});

bot.action(/del_ch_(.+)/, async (ctx) => {
  await db.execute({ sql: `DELETE FROM channels WHERE username = ?`, args: [ctx.match[1]] });
  await ctx.answerCbQuery("Kanal ro'yxatdan o'chirildi!");
  return sendAdminMenu(ctx, true);
});

bot.action('adm_stats', async (ctx) => {
  const usersRes = await db.execute(`SELECT COUNT(*) as count FROM users WHERE role = 'user'`);
  return ctx.editMessageText(`📊 Ruxsat etilgan foydalanuvchilar: ${usersRes.rows[0].count} ta`, Markup.inlineKeyboard([
    [Markup.button.callback('✉️ Hammaga xabar (Rassilka)', 'adm_broadcast')],
    [Markup.button.callback('🔙 Orqaga', 'adm_back')]
  ]));
});

bot.action('adm_broadcast', async (ctx) => {
  await setState(ctx.from.id, 'awaiting_broadcast');
  return ctx.editMessageText("Barcha mijozlarga yuboriladigan xabarni (matn, rasm, video) tashlang:", Markup.inlineKeyboard([[Markup.button.callback('🔙 Orqaga', 'adm_back')]]));
});

bot.action('adm_back', async (ctx) => {
  await clearState(ctx.from.id);
  await sendAdminMenu(ctx, true);
});

// =====================================================================
// 5. MATN, EMOJI VA LATEX XABARLARNI QAYTA ISHLASH
// =====================================================================
bot.on('message', async (ctx, next) => {
  const text = ctx.message?.text || '';
  const userId = ctx.from.id;

  const stateObj = await getState(userId);

  // --- A. KUTILAYOTGAN HOLATLAR (STATE) ---
  if (stateObj) {
    const { state, data } = stateObj;

    if (ctx.state.role === 'admin') {
      if (state === 'awaiting_user_id') {
        const targetId = parseInt(text);
        if (isNaN(targetId)) return ctx.reply("Iltimos, faqat raqamlardan iborat ID yuboring!");
        await db.execute({ sql: `INSERT OR REPLACE INTO users (id, role) VALUES (?, 'user')`, args: [targetId] });
        await clearState(userId);
        return ctx.reply(`✅ ${targetId} bazaga qo'shildi! Endi u botdan foydalana oladi.`, Markup.inlineKeyboard([[Markup.button.callback('⚙️ Admin panel', 'adm_back')]]));
      }
      if (state === 'awaiting_start_msg' && text) {
        await db.execute({ sql: `INSERT INTO settings (key, value) VALUES ('unauth_msg', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [text] });
        await clearState(userId);
        return ctx.reply("✅ Start xabari muvaffaqiyatli yangilandi.");
      }
      if (state === 'awaiting_channel' && text.startsWith('@')) {
        await db.execute({ sql: `INSERT OR IGNORE INTO channels (username) VALUES (?)`, args: [text] });
        await clearState(userId);
        return ctx.reply("✅ Kanal qo'shildi.");
      }
      if (state === 'awaiting_broadcast') {
        await clearState(userId);
        const usersRes = await db.execute(`SELECT id FROM users WHERE role = 'user'`);
        let success = 0;
        await ctx.reply("⏳ Xabar yuborilmoqda... Bu biroz vaqt olishi mumkin.");
        for (const row of usersRes.rows) {
          try {
            await ctx.telegram.copyMessage(row.id, ctx.chat.id, ctx.message.message_id);
            success++;
          } catch (e) {}
        }
        return ctx.reply(`✅ Rassilka yakunlandi! Jami ${success} kishiga muvaffaqiyatli yuborildi.`);
      }
    }

    if (state === 'awaiting_emoji_numbers' && text) {
      let selectedIndices = [];
      try {
        text.split(',').forEach(p => {
          if (p.includes('-')) {
            let [start, end] = p.split('-').map(num => parseInt(num.trim()));
            for (let i = start; i <= end; i++) { if (data[i - 1]) selectedIndices.push(i - 1); }
          } else {
            let idx = parseInt(p.trim()) - 1;
            if (data[idx]) selectedIndices.push(idx);
          }
        });
      } catch (e) {
        return ctx.reply("Xato format. Qaytadan urinib ko'ring (Masalan: 1, 5, 10-12):");
      }

      if (selectedIndices.length === 0) return ctx.reply("Bunday raqamdagi emojilar topilmadi. Qaytadan kiriting:");

      let resultMsg = "✅ **Siz tanlagan Emoji ID'lar:**\n\n";
      selectedIndices.forEach(idx => { resultMsg += `${idx + 1}-emoji: <code>${data[idx].custom_emoji_id}</code>\n`; });

      await clearState(userId);
      return ctx.replyWithHTML(resultMsg);
    }
  }

  // B. GURUHLAR VA CHATLAR UCHUN NATIVE LATEX (Bot API 10.1/10.2 Rich Messages)
  if (text.startsWith('$') || text.includes('\\frac') || text.includes('\\sqrt') || text.includes('\\int')) {
    const isGroup = ['group', 'supergroup'].includes(ctx.chat.type);
    const cleanLatex = isGroup && text.match(/\$(.*?)\$/) ? text.match(/\$(.*?)\$/)[1] : text.replace(/^\$+|\$+$/g, '').trim();

    if (cleanLatex) {
      try {
        // ✅ TUZATISH: "blocks" endi to'g'ridan-to'g'ri emas, balki
        // "rich_message" obyekti ICHIDA yuborilyapti — InputRichMessage tipi shuni talab qiladi.
        await ctx.telegram.callApi('sendRichMessage', {
          chat_id: ctx.chat.id,
          reply_to_message_id: ctx.message.message_id,
          rich_message: {
            blocks: [{ type: 'mathematical_expression', expression: cleanLatex }]
          }
        });
        return;
      } catch (error) {
        // ✅ TUZATISH: xato endi konsolga chiqadi (debug uchun) va foydalanuvchi
        // hech bo'lmasa Unicode ko'rinishdagi natijani ko'radi (jimgina yo'qolmaydi).
        console.error('sendRichMessage xatosi:', error.response?.description || error.message);
        await ctx.reply(`📐 ${latexToUnicode(cleanLatex)}`);
        return;
      }
    }
  }

  // C. PREMIUM EMOJI LINKI
  if (text.includes('t.me/addemoji/')) {
    const packName = text.split('t.me/addemoji/')[1].split('/')[0].split('?')[0];
    try {
      const stickerSet = await ctx.telegram.getStickerSet(packName);
      const minimalStickers = stickerSet.stickers.map(s => ({ custom_emoji_id: s.custom_emoji_id }));
      await setState(userId, 'awaiting_emoji_numbers', minimalStickers);
      return ctx.reply(`📦 To'plam topildi. Jami: ${minimalStickers.length} ta emoji.\n\nQaysi raqamdagilari kerak?\nMasalan: <code>1, 5, 10-12</code>`, { parse_mode: 'HTML' });
    } catch (e) {
      return ctx.reply("❌ To'plamni yuklashda xatolik yuz berdi. Linkni tekshiring.");
    }
  }

  // D. SEVIMLILARGA QO'SHISH (/save nomi | ma'lumot)
  if (text.startsWith('/save ')) {
    const parts = text.replace('/save ', '').split('|');
    if (parts.length < 2) return ctx.reply("Format xato! To'g'ri namuna:\n`/save Yurak emoji | 5411730030248888046`\n`/save Murakkab Kasr | \\frac{1}{2}`", { parse_mode: 'Markdown' });

    const label = parts[0].trim();
    const content = parts[1].trim();
    const type = isNaN(content.replace(/[^0-9]/g, '')) ? 'math' : 'emoji';

    await db.execute({ sql: `INSERT INTO favorites (user_id, type, content, label) VALUES (?, ?, ?, ?)`, args: [userId, type, content, label] });
    return ctx.reply(`✅ "${label}" sevimlilarga qo'shildi!\nUni istalgan chatda chiqarish uchun quyidagicha yozing:\n\n\`@${ctx.botInfo.username} fav\``, { parse_mode: 'Markdown' });
  }

  return next();
});

// =====================================================================
// 6. INLINE REJIM (Boshqa chatlarda ishlatish uchun)
// =====================================================================
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  const userId = ctx.from.id;

  try {
    const userRes = await db.execute({ sql: `SELECT role FROM users WHERE id = ?`, args: [userId] });
    if (userRes.rows.length === 0) return ctx.answerInlineQuery([], { button: { text: "Foydalanish ruxsati yo'q", start_parameter: "unauth" } });

    let results = [];

    if (query.toLowerCase() === 'fav') {
      const favRes = await db.execute({ sql: `SELECT * FROM favorites WHERE user_id = ?`, args: [userId] });
      results = favRes.rows.map((fav, index) => {
        if (fav.type === 'emoji') {
          return {
            type: 'article', id: `fav_${index}`, title: fav.label, description: 'Premium Emoji',
            input_message_content: { message_text: `<tg-emoji emoji-id="${fav.content}">⭐</tg-emoji>`, parse_mode: 'HTML' }
          };
        } else {
          return {
            type: 'article', id: `fav_${index}`, title: fav.label, description: 'Matematik Formula',
            // ✅ TUZATISH: agar rich_message ba'zi klientlarda ko'rinmasa,
            // Unicode fallback matnini "description" o'rniga to'g'ridan-to'g'ri
            // yubormoqchi bo'lsangiz, quyidagi qatorni almashtiring:
            // input_message_content: { message_text: latexToUnicode(fav.content) }
            input_message_content: { rich_message: { blocks: [{ type: 'mathematical_expression', expression: fav.content }] } }
          };
        }
      });
    }
    else if (query.includes('\\') || query.startsWith('$')) {
      const cleanMath = query.replace(/^\$+|\$+$/g, '').trim();
      if (cleanMath) {
        results.push({
          type: 'article', id: 'math_' + Date.now(), title: '📐 Matematik formula (Native)', description: cleanMath,
          input_message_content: { rich_message: { blocks: [{ type: 'mathematical_expression', expression: cleanMath }] } }
        });
        // Zaxira variant: agar klient native formatni qo'llab-quvvatlamasa
        results.push({
          type: 'article', id: 'math_unicode_' + Date.now(), title: '📐 Formula (Unicode, universal)', description: latexToUnicode(cleanMath),
          input_message_content: { message_text: latexToUnicode(cleanMath) }
        });
      }
    }
    else if (query.match(/^\d{10,}/)) {
      const spaceIndex = query.indexOf(' ');
      let emojiId = query;
      let userText = '';
      if (spaceIndex !== -1) {
        emojiId = query.substring(0, spaceIndex);
        userText = query.substring(spaceIndex + 1);
      }
      results.push({
        type: 'article', id: 'emoji_1', title: 'Premium Emoji bilan yozish', description: userText || 'Emojini yuborish',
        input_message_content: { message_text: `<tg-emoji emoji-id="${emojiId}">⭐</tg-emoji> ${userText}`, parse_mode: 'HTML' }
      });
    }

    await ctx.answerInlineQuery(results, { cache_time: 0 });
  } catch (error) {
    console.error("Inline query xatosi:", error);
  }
});

// =====================================================================
// 6.1. XATOLIKLARNI GLOBAL QAYTA ISHLASH (avval umuman yo'q edi)
// =====================================================================
bot.catch((err, ctx) => {
  console.error(`Bot xatosi (${ctx.updateType}):`, err);
});

// =====================================================================
// 7. VERCEL SERVERLESS HTTP HANDLER
// =====================================================================
module.exports = async (req, res) => {
  try {
    await initDB();

    if (req.method === 'POST') {
      if (req.body) {
        await bot.handleUpdate(req.body);
      }
      res.status(200).send('OK');
    } else {
      res.status(200).send('Vercel bot aktiv holatda. Webhook kutmoqda...');
    }
  } catch (err) {
    console.error("Handler xatosi:", err);
    res.status(500).send('Server Error');
  }
};

