'use strict';

// ============================================================
// MODULLAR
// ============================================================
const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cron = require('node-cron');

// ============================================================
// SOZLAMALAR
// ============================================================
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = parseInt(process.env.ADMIN_ID);
const PORT = process.env.PORT || 3000;
const REQUIRED_CHANNEL = process.env.REQUIRED_CHANNEL || '@student_aitex';

if (!BOT_TOKEN) throw new Error("BOT_TOKEN env o'zgaruvchisi topilmadi!");
if (!ADMIN_ID) throw new Error("ADMIN_ID env o'zgaruvchisi topilmadi!");

// ============================================================
// FAYL YO'LLARI
// ============================================================
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const PATHS = {
    db:         path.join(DATA_DIR, 'ranking_db.json'),
    settings:   path.join(DATA_DIR, 'settings.json'),
    vip:        path.join(DATA_DIR, 'vip_users.json'),
    session:    path.join(DATA_DIR, 'session.json'),
    tournament: path.join(DATA_DIR, 'tournament_data.json'),
    subjects:   path.join(__dirname, 'subjects.json'),
    customQ:    path.join(DATA_DIR, 'custom_questions.json'),
};

// ============================================================
// BOT VA APP
// ============================================================
const bot = new Telegraf(BOT_TOKEN);
const app = express();
app.use(express.static('public'));
app.use(express.json());

// ============================================================
// MA'LUMOTLAR BAZASI YORDAMCHI FUNKSIYALARI
// ============================================================
function readJSON(filePath, defaultValue) {
    try {
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
            return defaultValue;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
        console.error(`[DB] ${filePath} o'qishda xato:`, err.message);
        return defaultValue;
    }
}

function writeJSON(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
        console.error(`[DB] ${filePath} yozishda xato:`, err.message);
    }
}

const getDb       = () => readJSON(PATHS.db,         { users: {}, settings: {} });
const saveDb      = (db) => writeJSON(PATHS.db, db);
const getSettings = () => readJSON(PATHS.settings,   { timeLimit: 30 });
const saveSettings = (s) => writeJSON(PATHS.settings, s);

// ============================================================
// XOTIRA (RUNTIME)
// ============================================================
let SUBJECTS    = readJSON(PATHS.subjects, {});
// Agar maxsus savollar ham bo'lsa, ularni ustiga yozamiz
const customQ   = readJSON(PATHS.customQ, null);
if (customQ) Object.assign(SUBJECTS, customQ);

let vipUsers    = readJSON(PATHS.vip, []);
let botSettings = getSettings();
let isBotPaidMode = false;

const timers = {};

console.log(`✅ Savollar bazasi yuklandi: ${Object.keys(SUBJECTS).length} ta fan`);

// ============================================================
// YORDAMCHI FUNKSIYALAR
// ============================================================
const isAdmin = (id) => id === ADMIN_ID;

function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>"']/g, (m) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
    }[m]));
}

function getProgressBar(current, total) {
    const size = 10;
    const filled = Math.min(Math.round((current / total) * size), size);
    return '█'.repeat(filled) + '░'.repeat(size - filled);
}

const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

function saveVip() {
    writeJSON(PATHS.vip, vipUsers);
}

function getLeaderboard(requesterId = null) {
    const db = getDb();
    const sorted = Object.values(db.users)
        .filter(u => u && u.name && u.name !== 'undefined' && (u.score || 0) > 0)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10);

    if (sorted.length === 0) return '🏆 Hozircha reytingda hech kim yo\'q.';

    const isReqAdmin = requesterId === ADMIN_ID;
    let res = '🏆 <b>TOP 10 REYTING</b>\n\n';
    const medals = ['🥇', '🥈', '🥉'];

    sorted.forEach((u, i) => {
        const medal = medals[i] || '🔹';
        const name = escapeHTML(u.name.trim());
        const score = parseFloat(u.score || 0).toFixed(1);
        const link = (isReqAdmin && u.username && u.username !== 'Lichka yopiq')
            ? ` (<code>${escapeHTML(u.username)}</code>)` : '';
        res += `${medal} <b>${name}</b>${link} — <b>${score}</b> ball\n`;
    });

    return res;
}

async function checkSubscription(ctx) {
    try {
        const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
        return ['member', 'administrator', 'creator'].includes(member.status);
    } catch {
        return false;
    }
}

function updateGlobalScore(userId, name, username, score) {
    try {
        const db = getDb();
        if (!db.users[userId]) {
            db.users[userId] = { name: name || 'Foydalanuvchi', username: username || 'Lichka yopiq', score: 0, totalTests: 0 };
        }
        const u = db.users[userId];
        u.totalTests = (u.totalTests || 0) + 1;
        u.score = (u.score || 0) + score;
        u.name = name;
        u.username = username;
        saveDb(db);
    } catch (err) {
        console.error('[Score] Xato:', err.message);
    }
}

function prepareTournamentQuestions(count) {
    let all = [];
    Object.values(SUBJECTS).forEach(sub => {
        if (sub.questions) all = all.concat(sub.questions);
    });
    return shuffle(all).slice(0, count);
}

// ============================================================
// MENYU FUNKSIYALARI
// ============================================================
function adminMainKeyboard(db) {
    const s = db.settings || {};
    const statusBtn = s.isMaintenance ? '🟢 Botni Yoqish' : '🛑 Botni To\'xtatish';
    const turboBtn  = s.turboMode ? '🚀 Turbo (O\'chirish)' : '🚀 Turbo (Yoqish)';
    return Markup.keyboard([
        ['💰 Pullik versiya', '🆓 Bepul versiya'],
        ['🏆 Haftalik musobaqa', '🚀 Musobaqani start berish'],
        ['📢 Musobaqa natijalari', '📊 Statistika'],
        [statusBtn, turboBtn],
        ['🗑 Botni Restart qilish', '🧹 Reytingni tozalash'],
        ['📣 Xabar tarqatish', '⬅️ Orqaga (Fanlar)'],
    ]).resize();
}

function showSubjectMenu(ctx) {
    try {
        const db = getDb();
        const userId = ctx.from.id;
        const user = db.users[userId];
        const tour = db.tournament;

        if (!user || !user.isRegistered) {
            return ctx.reply('⚠️ Iltimos, avval /start bosing va ro\'yxatdan o\'ting.');
        }

        const yonalish = user.yonalish || '';
        let keyboard = [];

        if (yonalish === 'Dasturiy Injiniring') {
            keyboard = [
                ['📝 Akademik yozuv', '📜 Tarix'],
                ['➕ Matematika', '🧲 Fizika'],
                ['💻 Dasturlash 1', '🇬🇧 Perfect English'],
            ];
        } else if (['Kiberxavfsizlik', "Sun'iy intelekt"].includes(yonalish)) {
            keyboard = [
                ['🧲 Fizika', '📜 Tarix'],
                ['📝 Akademik yozuv', '➕ Matematika'],
                ['🇬🇧 Perfect English', '💻 Dasturlash 1'],
            ];
        } else {
            keyboard = [
                ['📝 Akademik yozuv', '📜 Tarix'],
                ['➕ Matematika', '🧲 Fizika'],
            ];
        }

        if (tour && tour.isActive && !user.tourFinished) {
            keyboard.unshift(['🏆 Xalqaro test musobaqa']);
        }
        if (db.settings?.turboMode) keyboard.push(['🚀 TURBO YODLASH']);
        keyboard.push(['📊 Reyting', '👤 Profil']);
        keyboard.push(['⚙️ Sozlamalar']);

        const text = `👤 <b>Foydalanuvchi:</b> ${escapeHTML(user.name || 'Talaba')}\n` +
                     `🎓 <b>Yo\'nalish:</b> ${escapeHTML(yonalish || 'Noma\'lum')}\n\n` +
                     `Fanni tanlang:`;

        return ctx.replyWithHTML(text, Markup.keyboard(keyboard).resize());
    } catch (err) {
        console.error('[Menu] Xato:', err.message);
        return ctx.reply('❌ Menyuni yuklashda xatolik. Qaytadan /start bosing.');
    }
}

async function showProfile(ctx) {
    const db = getDb();
    const userId = ctx.from.id;
    const user = db.users[userId];

    if (!user) return ctx.reply('Avval test yechib ko\'ring!');

    const usersArr = Object.values(db.users).sort((a, b) => (b.score || 0) - (a.score || 0));
    const rank = usersArr.findIndex(u => String(u.id) === String(userId)) + 1;
    const vipStatus = (user.isVip || vipUsers.includes(userId)) ? '💎 VIP' : '🆓 Oddiy';

    let msg = `👤 <b>SIZNING PROFILINGIZ</b>\n\n` +
              `🆔 <b>ID:</b> <code>${userId}</code>\n` +
              `👤 <b>Ism:</b> ${escapeHTML(user.name || 'Kiritilmagan')}\n` +
              `🎓 <b>OTM:</b> ${escapeHTML(user.univ || '—')}\n` +
              `📚 <b>Kurs:</b> ${escapeHTML(user.kurs || '—')}\n` +
              `🏆 <b>Umumiy ball:</b> ${parseFloat(user.score || 0).toFixed(1)}\n` +
              `📈 <b>Reyting o\'rni:</b> ${rank}-o\'rin (${usersArr.length} tadan)\n` +
              `⭐ <b>Status:</b> ${vipStatus}\n\n`;

    msg += rank <= 3 ? '🌟 Siz TOP-3 talabasiz! Zo\'r!' :
           rank <= 10 ? '🚀 TOP-10 dasiz! Davom eting!' :
                        '💪 TOP-10 ga kirish uchun ko\'proq mashq qiling!';

    return ctx.replyWithHTML(msg);
}

// ============================================================
// TEST YUBORISH FUNKSIYALARI
// ============================================================
async function sendQuestion(ctx, isNew = false) {
    const s = ctx.session;
    const userId = ctx.from.id;
    if (timers[userId]) clearTimeout(timers[userId]);

    // ─── TEST YAKUNLANDI ───────────────────────────────────
    if (!s.activeList || s.index >= s.activeList.length) {
        if (!s.isTurbo) {
            updateGlobalScore(userId, s.userName, ctx.from.username || 'Lichka yopiq', s.score);
        }

        const total = s.activeList?.length || 1;
        const percent = ((s.score / total) * 100).toFixed(1);

        let resultMsg = s.isTurbo
            ? `🏁 <b>Turbo yodlash yakunlandi!</b>`
            : `🏁 <b>Test yakunlandi, ${escapeHTML(s.userName)}!</b>\n\n` +
              `✅ To\'g\'ri javob: <b>${s.score} ta</b>\n` +
              `❌ Xato javob: <b>${(s.wrongs || []).length} ta</b>\n` +
              `📊 Natija: <b>${percent}%</b>\n` +
              `_________________________\n\n`;

        if (!s.isTurbo && s.wrongs && s.wrongs.length > 0) {
            resultMsg += `⚠️ <b>Xatolar tahlili:</b>\n\n`;
            for (let i = 0; i < s.wrongs.length; i++) {
                const x = s.wrongs[i];
                const block = `<b>${i + 1}.</b> ${escapeHTML(x.q)}\n` +
                              `❌ Siz: <s>${escapeHTML(x.userAnswer || 'Vaqt tugadi')}</s>\n` +
                              `✅ To\'g\'ri: <u>${escapeHTML(x.a)}</u>\n_________________________\n\n`;
                if ((resultMsg + block).length > 3900) {
                    resultMsg += `...(qolgan xatolar sig\'madi)`; break;
                }
                resultMsg += block;
            }
        } else if (!s.isTurbo) {
            resultMsg += `🌟 <b>Ajoyib! Hech qanday xato qilmadingiz!</b>`;
        }

        s.isTurbo = false;
        const keyboard = Markup.keyboard([['⚡️ Blitz (25)', '📝 To\'liq test'], ['⬅️ Orqaga (Fanlar)']]).resize();
        try {
            await ctx.replyWithHTML(resultMsg, keyboard);
        } catch {
            await ctx.reply(`Test yakunlandi! To\'g\'ri: ${s.score}, Xato: ${(s.wrongs || []).length}`);
        }
        return;
    }

    // ─── TURBO REJIM ───────────────────────────────────────
    const qData = s.activeList[s.index];
    if (!qData || !qData.q) { s.index++; return sendQuestion(ctx, true); }

    const safe = escapeHTML(qData.q);
    const progress = getProgressBar(s.index + 1, s.activeList.length);
    const imagePath = qData.image ? path.join(__dirname, 'images', qData.image) : null;
    const hasImage = imagePath && fs.existsSync(imagePath);

    if (s.isTurbo) {
        const turboText =
            `🚀 <b>TURBO YODLASH</b>\n📊 [${progress}]\n🔢 Savol: <b>${s.index + 1}/${s.activeList.length}</b>\n` +
            `_________________________\n\n❓ <b>${safe}</b>\n\n` +
            `✅ <b>TO\'G\'RI JAVOB:</b>\n<code>${escapeHTML(qData.a)}</code>\n` +
            `_________________________\n👇 Keyingi savol:`;

        const turboBtn = Markup.inlineKeyboard([
            [Markup.button.callback('Keyingi savol ➡️', 'next_turbo_q')],
            [Markup.button.callback('🛑 To\'xtatish', 'stop_test')],
        ]);

        if (hasImage) {
            return ctx.replyWithPhoto({ source: imagePath }, { caption: turboText, parse_mode: 'HTML', ...turboBtn });
        }
        try {
            return isNew
                ? ctx.replyWithHTML(turboText, turboBtn)
                : ctx.editMessageText(turboText, { parse_mode: 'HTML', ...turboBtn });
        } catch {
            return ctx.replyWithHTML(turboText, turboBtn);
        }
    }

    // ─── ODDIY TEST REJIMI ─────────────────────────────────
    const timeLimit = s.userTimeLimit || botSettings.timeLimit || 30;
    s.currentOptions = shuffle([...qData.options]);
    const labels = ['A', 'B', 'C', 'D'];

    let text = `📊 Progress: [${progress}]\n🔢 Savol: <b>${s.index + 1}/${s.activeList.length}</b>\n` +
               `⏱ <b>VAQT: ${timeLimit}s</b>\n\n❓ <b>${safe}</b>\n\n`;

    s.currentOptions.forEach((opt, i) => { text += `<b>${labels[i]})</b> ${escapeHTML(opt)}\n\n`; });

    const inlineBtn = Markup.inlineKeyboard([
        s.currentOptions.map((_, i) => Markup.button.callback(labels[i], `ans_${i}`)),
        [Markup.button.callback('💡 Tushuntirish', 'show_explanation')],
        [Markup.button.callback('🛑 Testni to\'xtatish', 'stop_test')],
    ]);

    if (hasImage) {
        await ctx.replyWithPhoto({ source: imagePath }, { caption: text, parse_mode: 'HTML', ...inlineBtn });
    } else {
        try {
            isNew ? await ctx.replyWithHTML(text, inlineBtn)
                  : await ctx.editMessageText(text, { parse_mode: 'HTML', ...inlineBtn });
        } catch {
            await ctx.replyWithHTML(text, inlineBtn);
        }
    }

    // Taymer
    timers[userId] = setTimeout(async () => {
        if (ctx.session?.index === s.index && !ctx.session?.isTurbo) {
            ctx.session.wrongs.push({ ...qData, userAnswer: 'Vaqt tugadi ⏰' });
            ctx.session.index++;
            await ctx.replyWithHTML('⏰ <b>VAQT TUGADI!</b>').catch(() => {});
            sendQuestion(ctx, true);
        }
    }, timeLimit * 1000);
}

async function sendTourQuestion(ctx, isNew = false) {
    const s = ctx.session;
    const userId = ctx.from.id;
    const db = getDb();
    const tour = db.tournament;

    if (timers[userId]) clearTimeout(timers[userId]);

    const isTimeOut = s.tourEndTime && Date.now() > s.tourEndTime;

    if (!tour || s.tourIndex >= tour.count || isTimeOut) {
        if (db.users[userId]) {
            db.users[userId].tourScore = s.tourScore || 0;
            db.users[userId].tourFinished = true;
            saveDb(db);
        }

        const title = isTimeOut ? '⏰ <b>Vaqtingiz tugadi!</b>' : '🏁 <b>Musobaqa yakunlandi!</b>';
        const sub   = isTimeOut ? 'Ajratilgan umumiy vaqt yakunlandi.' : 'Barcha savollarga javob berdingiz.';

        const resultMsg = `${title}\n\n${sub}\n\n👤 Ishtirokchi: <b>${escapeHTML(s.userName)}</b>\n` +
                          `✅ To\'g\'ri javoblar: <b>${s.tourScore || 0} ta</b>\n\n` +
                          `🏆 Natijangiz saqlandi. G\'oliblarni kuting!`;

        try { await ctx.deleteMessage(); } catch {}
        await ctx.replyWithHTML(resultMsg);
        return showSubjectMenu(ctx);
    }

    // Vaqtni hisoblash
    if (!s.tourEndTime) {
        s.tourEndTime = Date.now() + (tour.count * 30 * 1000);
    }
    const remaining = Math.max(0, s.tourEndTime - Date.now());
    const remMin = Math.floor(remaining / 60000);
    const remSec = Math.floor((remaining % 60000) / 1000);
    const timerStr = `${String(remMin).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;

    const qData = tour.questions[s.tourIndex];
    if (!qData) { s.tourIndex++; return sendTourQuestion(ctx, false); }

    const progress = getProgressBar(s.tourIndex + 1, tour.count);
    s.currentOptions = shuffle([...qData.options]);
    const labels = ['A', 'B', 'C', 'D'];

    let text = `🏆 <b>MUSOBAQA REJIMI</b>\n` +
               `⏱ <b>Tugashiga: ${timerStr} qoldi</b>\n` +
               `📊 Progress: [${progress}]\n` +
               `🔢 Savol: <b>${s.tourIndex + 1}/${tour.count}</b>\n` +
               `⌛️ Bu savol uchun: <b>30s</b>\n` +
               `_________________________\n\n❓ <b>${escapeHTML(qData.q)}</b>\n\n`;

    s.currentOptions.forEach((opt, i) => { text += `<b>${labels[i]})</b> ${escapeHTML(opt)}\n\n`; });

    const inlineBtn = Markup.inlineKeyboard([
        s.currentOptions.map((_, i) => Markup.button.callback(labels[i], `tourans_${i}`)),
        [Markup.button.callback('🛑 Chiqish', 'stop_tour')],
    ]);

    try {
        isNew ? await ctx.replyWithHTML(text, inlineBtn)
              : await ctx.editMessageText(text, { parse_mode: 'HTML', ...inlineBtn });
    } catch {
        await ctx.replyWithHTML(text, inlineBtn);
    }

    timers[userId] = setTimeout(async () => {
        if (ctx.session?.tourIndex === s.tourIndex) {
            ctx.session.tourIndex++;
            sendTourQuestion(ctx, false);
        }
    }, 30000);
}

async function finalizeTournament(ctx) {
    const db = getDb();
    const tour = db.tournament;

    if (!tour?.participants?.length) return ctx.reply('❌ Ishtirokchilar ro\'yxati bo\'sh.');

    const leaderboard = tour.participants
        .map(id => {
            const u = db.users[id];
            return u ? { id, name: u.name || 'Foydalanuvchi', score: u.tourScore || 0 } : null;
        })
        .filter(Boolean)
        .sort((a, b) => b.score - a.score);

    if (!leaderboard.length) return ctx.reply('❌ Natijalar hisoblanmadi.');

    const medals = ['🥇', '🥈', '🥉'];
    let rankingMsg = `🏆 <b>MUSOBAQA NATIJALARI</b>\n📅 Sana: ${tour.date || '---'}\n_________________________\n\n`;
    leaderboard.slice(0, 10).forEach((u, i) => {
        rankingMsg += `${medals[i] || `${i + 1}.`} <b>${escapeHTML(u.name)}</b> — ${u.score} ball\n`;
    });

    // G'olibga tabrik
    const winner = leaderboard[0];
    if (winner?.score > 0) {
        await ctx.telegram.sendMessage(winner.id, '🥳 <b>TABRIKLAYMIZ!</b>\n\nSiz 1-o\'rinni egalladingiz! 🏆', { parse_mode: 'HTML' }).catch(() => {});
    }

    // Barcha ishtirokchilarga natija yuborish (20 tadan batch)
    const chunkSize = 20;
    for (let i = 0; i < tour.participants.length; i += chunkSize) {
        const chunk = tour.participants.slice(i, i + chunkSize);
        await Promise.allSettled(chunk.map(async (uid) => {
            try {
                await ctx.telegram.sendMessage(uid, rankingMsg, { parse_mode: 'HTML' });
                await ctx.telegram.sendMessage(uid, '🏁 Musobaqa yakunlandi. Asosiy menyudasiz:', {
                    ...Markup.keyboard([['📝 Akademik yozuv', '📜 Tarix'], ['➕ Matematika', '📊 Reyting'], ['👤 Profil']]).resize()
                });
            } catch {}
        }));
        if (i + chunkSize < tour.participants.length) await new Promise(r => setTimeout(r, 1000));
    }

    db.tournament.isActive = false;
    saveDb(db);

    return ctx.replyWithHTML(`✅ Natijalar ${tour.participants.length} ta foydalanuvchiga yuborildi!\n\n${rankingMsg}`);
}

// ============================================================
// MIDDLEWARLAR
// ============================================================

// 1. Sessiya
bot.use((new LocalSession({ database: PATHS.session })).middleware());

// 2. Maintenance tekshiruvi
bot.use(async (ctx, next) => {
    const db = getDb();
    if (db.settings?.isMaintenance && ctx.from?.id !== ADMIN_ID) {
        return ctx.reply('🛠 Botda texnik ishlar olib borilmoqda. Tez orada qaytamiz!');
    }
    return next();
});

// 3. Obuna tekshiruvi (start va callback bundan mustasno)
bot.use(async (ctx, next) => {
    if (ctx.message?.text === '/start') return next();
    if (ctx.callbackQuery) return next();

    try {
        const subscribed = await checkSubscription(ctx);
        if (!subscribed) {
            return ctx.reply(
                '⚠️ Botdan foydalanish uchun kanalimizga obuna bo\'ling!',
                Markup.inlineKeyboard([
                    [Markup.button.url('📢 Kanalga o\'tish', `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`)],
                    [Markup.button.callback('✅ Tekshirish', 'check_sub')],
                ])
            ).catch(() => {});
            return;
        }
    } catch (err) {
        console.error('[Sub check]', err.message);
    }
    return next();
});

// ============================================================
// /start KOMANDASI
// ============================================================
bot.start(async (ctx) => {
    const db = getDb();
    const userId = ctx.from.id;
    const user = db.users[userId];

    if (user?.isRegistered) {
        await ctx.reply(`Xush kelibsiz, ${escapeHTML(user.name)}! 😊`);
        return showSubjectMenu(ctx);
    }

    if (!db.users[userId]) {
        db.users[userId] = {
            id: userId,
            username: ctx.from.username || "Noma'lum",
            name: '', univ: '', kurs: '', yonalish: '',
            score: 0, totalTests: 0,
            step: 'wait_name', isRegistered: false,
        };
        saveDb(db);
    }

    return ctx.replyWithHTML(
        `✨ <b>Assalomu alaykum! Botga xush kelibsiz.</b>\n\nRo\'yxatdan o\'tish uchun ism va familiyangizni kiriting:`,
        Markup.removeKeyboard()
    );
});

// ============================================================
// /admin KOMANDASI
// ============================================================
bot.command('admin', (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.reply('❌ Ruxsat yo\'q!');
    const db = getDb();
    return ctx.reply('🛠 <b>Admin Panel</b>', { parse_mode: 'HTML', ...adminMainKeyboard(db) });
});

// ============================================================
// CALLBACK QUERY HANDLERLARI
// ============================================================
bot.action('check_sub', async (ctx) => {
    const subscribed = await checkSubscription(ctx);
    if (subscribed) {
        await ctx.answerCbQuery('✅ Rahmat! Botdan foydalanishingiz mumkin.');
        await ctx.deleteMessage().catch(() => {});
        return showSubjectMenu(ctx);
    }
    return ctx.answerCbQuery('❌ Siz hali kanalga obuna bo\'lmadingiz!', { show_alert: true });
});

// Javob tanlash
bot.action(/^ans_(\d+)$/, async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;

    if (!s?.activeList || s.index === undefined || !s.activeList[s.index]) {
        if (timers[userId]) clearTimeout(timers[userId]);
        await ctx.answerCbQuery('⚠️ Sessiya tugagan.').catch(() => {});
        return ctx.reply('⚠️ Sessiya tugagan. /start bosing.');
    }

    if (timers[userId]) clearTimeout(timers[userId]);

    const selIdx = parseInt(ctx.match[1]);
    const currentQ = s.activeList[s.index];
    const labels = ['A', 'B', 'C', 'D'];

    try {
        const userAnswer = s.currentOptions[selIdx];

        if (userAnswer === currentQ.a) {
            s.score++;
            await ctx.answerCbQuery('✅ To\'g\'ri!');
        } else {
            s.wrongs.push({ ...currentQ, userAnswer });
            const correctIdx = s.currentOptions.indexOf(currentQ.a);
            const correctLetter = labels[correctIdx] !== undefined ? labels[correctIdx] : '?';
            await ctx.answerCbQuery(`❌ Noto\'g\'ri!\nTo\'g\'ri: ${correctLetter}) ${currentQ.a}`, { show_alert: true });
        }

        s.index++;
        return sendQuestion(ctx, false);
    } catch (err) {
        console.error('[ans]', err.message);
        await ctx.answerCbQuery('Xatolik.').catch(() => {});
    }
});

// Turbo — keyingi savol
bot.action('next_turbo_q', async (ctx) => {
    if (ctx.session?.isTurbo) {
        ctx.session.index++;
        return sendQuestion(ctx, true);
    }
    await ctx.answerCbQuery();
});

// Testni to'xtatish
bot.action('stop_test', (ctx) => {
    if (timers[ctx.from.id]) clearTimeout(timers[ctx.from.id]);
    ctx.session.index = 999;
    return showSubjectMenu(ctx);
});

// Tushuntirish
bot.action('show_explanation', async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;
    const db = getDb();
    const user = db.users[userId] || {};

    if (!user.isVip && !vipUsers.includes(userId) && !isAdmin(userId)) {
        await ctx.answerCbQuery('🔒 Faqat VIP a\'zolar uchun!', { show_alert: true });
        return ctx.replyWithHTML(
            '⭐ <b>Tushuntirishlar faqat VIP a\'zolar uchun!</b>\nVIP statusini sotib oling.',
            Markup.inlineKeyboard([[Markup.button.callback('💎 VIP sotib olish', 'buy_vip')]])
        );
    }

    const qData = s.activeList?.[s.index];
    if (!qData) return ctx.answerCbQuery('Xatolik: savol topilmadi.');

    if (!qData.hint?.trim()) {
        return ctx.answerCbQuery('⚠️ Bu savolga tushuntirish qo\'shilmagan.', { show_alert: true });
    }

    await ctx.answerCbQuery('🔍 Tushuntirish');
    const progress = getProgressBar(s.index + 1, s.activeList.length);
    const labels = ['A', 'B', 'C', 'D'];
    let updText = `📊 [${progress}]\n🔢 <b>${s.index + 1}/${s.activeList.length}</b>\n\n❓ <b>${escapeHTML(qData.q)}</b>\n\n` +
                  `━━━━━━━━━━\n💡 <b>TUSHUNTIRISH:</b>\n${escapeHTML(qData.hint)}\n━━━━━━━━━━\n\n`;

    if (!s.isTurbo) {
        (s.currentOptions || []).forEach((opt, i) => { updText += `<b>${labels[i]})</b> ${escapeHTML(opt)}\n\n`; });
    } else {
        updText += `✅ <b>TO\'G\'RI JAVOB:</b>\n<code>${escapeHTML(qData.a)}</code>`;
    }

    const keyboard = ctx.callbackQuery.message.reply_markup;
    try {
        ctx.callbackQuery.message.photo
            ? await ctx.editMessageCaption(updText, { parse_mode: 'HTML', reply_markup: keyboard })
            : await ctx.editMessageText(updText, { parse_mode: 'HTML', reply_markup: keyboard });
    } catch {}
});

// VIP sotib olish
bot.action('buy_vip', (ctx) => {
    ctx.session.waitingForReceipt = true;
    return ctx.replyWithHTML(
        `💎 <b>VIP STATUS SOTIB OLISH</b>\n\n` +
        `💳 Karta: <code>4073420058363577</code>\n👤 Egasi: M.M\n💰 Summa: 6,000 so'm\n\n` +
        `📸 To'lovni amalga oshirgach, <b>chekni (rasm)</b> yuboring.`
    );
});

// VIP tasdiqlash
bot.action(/^approve_(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]);
    const db = getDb();

    if (db.users[targetId]) { db.users[targetId].isVip = true; saveDb(db); }
    if (!vipUsers.includes(targetId)) { vipUsers.push(targetId); saveVip(); }

    await ctx.telegram.sendMessage(targetId,
        '🎉 <b>Xushxabar!</b>\n\nTo\'lovingiz tasdiqlandi! Barcha testlarning 💡 tushuntirishlarini va 🏆 Musobaqani ko\'rishingiz mumkin.',
        { parse_mode: 'HTML' }
    ).catch(() => {});

    return ctx.editMessageCaption('✅ <b>Tasdiqlandi:</b> Foydalanuvchi VIP bo\'ldi.', { parse_mode: 'HTML' });
});

// VIP rad etish
bot.action(/^reject_(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]);
    await ctx.telegram.sendMessage(targetId, '❌ Chek tasdiqlanmadi. Muammo bo\'lsa adminga yozing.').catch(() => {});
    return ctx.editMessageCaption('❌ To\'lov rad etildi.');
});

// Musobaqani tasdiqlash
bot.action('confirm_tour', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q!');
    const db = getDb();
    const s = ctx.session;

    Object.keys(db.users).forEach(id => {
        db.users[id].tourScore = 0;
        db.users[id].tourFinished = false;
    });

    db.tournament = {
        isActive: true,
        date: s.tourDate,
        time: s.tourTime,
        count: parseInt(s.tourCount),
        participants: [],
        questions: prepareTournamentQuestions(parseInt(s.tourCount)),
    };
    saveDb(db);

    await ctx.editMessageText(
        `✅ <b>Musobaqa e\'lon qilindi!</b>\n\n📅 ${s.tourDate}\n🕒 ${s.tourTime}\n\nFoydalanuvchilarga xabar yuborilmoqda...`,
        { parse_mode: 'HTML' }
    );

    const announceText = `📣 <b>YANGI MUSOBAQA!</b>\n\n📅 Sana: <b>${s.tourDate}</b>\n🕒 Vaqt: <b>${s.tourTime}</b>\n` +
                         `📝 Savollar: <b>${s.tourCount} ta</b>\n\nQatnashish uchun tugmani bosing:`;

    for (const uid of Object.keys(db.users)) {
        await ctx.telegram.sendMessage(uid, announceText, {
            parse_mode: 'HTML',
            ...Markup.keyboard([["🏆 Musobaqaga o'tish"]]).resize()
        }).catch(() => {});
    }

    s.adminStep = null;
});

// Musobaqani bekor qilish
bot.action('reject_tour', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q!');
    const db = getDb();
    if (db.tournament) { db.tournament.isActive = false; db.tournament.participants = []; saveDb(db); }
    ctx.session.adminStep = null;
    await ctx.answerCbQuery('Musobaqa bekor qilindi');
    return ctx.editMessageText('❌ <b>Musobaqa yaratish bekor qilindi.</b>', { parse_mode: 'HTML' });
});

// Musobaqaga qo'shilish
bot.action('join_tour', async (ctx) => {
    const db = getDb();
    const userId = ctx.from.id;
    const tour = db.tournament;

    if (!tour?.isActive) return ctx.answerCbQuery('❌ Musobaqa yakunlangan yoki faol emas.');
    if (tour.participants.includes(userId)) return ctx.answerCbQuery('✅ Siz allaqachon ro\'yxatdan o\'tgansiz!');

    db.tournament.participants.push(userId);
    saveDb(db);

    return ctx.editMessageText(
        `🎉 <b>Muvaffaqiyatli ro\'yxatdan o\'tdingiz!</b>\n\nMusobaqa boshlanish vaqti: <b>${tour.time}</b>.\n🚀 Tayyor turing!`,
        { parse_mode: 'HTML' }
    );
});

bot.action('cancel_join', async (ctx) => {
    return ctx.editMessageText('❌ Musobaqada qatnashish rad etildi.');
});

bot.action('back_to_main', async (ctx) => {
    try { await ctx.deleteMessage(); } catch {}
    return showSubjectMenu(ctx);
});

// Musobaqa — javob berish
bot.action(/^tourans_(\d+)$/, async (ctx) => {
    const s = ctx.session;
    const db = getDb();
    const tour = db.tournament;
    const userId = ctx.from.id;

    if (!s || s.tourIndex === undefined || !tour) {
        return ctx.answerCbQuery('❌ Sessiya topilmadi.');
    }

    if (s.tourEndTime && Date.now() > s.tourEndTime) {
        if (timers[userId]) clearTimeout(timers[userId]);
        await ctx.answerCbQuery('⏰ Musobaqa vaqti tugadi!', { show_alert: true });
        s.tourIndex = tour.count;
        return sendTourQuestion(ctx, false);
    }

    const choiceIdx = parseInt(ctx.match[1]);
    const currentQ = tour.questions[s.tourIndex];
    if (!currentQ || !s.currentOptions) return ctx.answerCbQuery();

    const userAnswer = s.currentOptions[choiceIdx];
    if (userAnswer === currentQ.a) {
        s.tourScore = (s.tourScore || 0) + 1;
        await ctx.answerCbQuery('✅ To\'g\'ri!');
    } else {
        await ctx.answerCbQuery('❌ Noto\'g\'ri!');
    }

    s.tourIndex++;
    if (db.users[userId]) {
        db.users[userId].tourScore = s.tourScore;
        if (s.tourIndex >= tour.count) db.users[userId].tourFinished = true;
        saveDb(db);
    }

    return sendTourQuestion(ctx, false);
});

bot.action('start_actual_tour', async (ctx) => {
    const s = ctx.session;
    const db = getDb();
    const tour = db.tournament;
    const userId = ctx.from.id;

    if (!tour?.isActive) return ctx.answerCbQuery('❌ Musobaqa yakunlangan.', { show_alert: true });
    if (!tour.participants.includes(userId)) return ctx.answerCbQuery('❌ Siz ro\'yxatdan o\'tmagansiz!', { show_alert: true });
    if (db.users[userId]?.tourFinished) return ctx.answerCbQuery('✅ Siz bu musobaqani yechib bo\'lgansiz!', { show_alert: true });

    s.tourIndex = 0;
    s.tourScore = 0;
    s.userName = db.users[userId]?.name || ctx.from.first_name;
    s.tourEndTime = Date.now() + (tour.count * 30 * 1000);

    await ctx.answerCbQuery('🚀 Musobaqa boshlandi! Omad!');
    try { await ctx.deleteMessage(); } catch {}
    return sendTourQuestion(ctx, true);
});

bot.action('stop_tour', async (ctx) => {
    if (timers[ctx.from.id]) clearTimeout(timers[ctx.from.id]);
    try { await ctx.deleteMessage(); } catch {}
    return showSubjectMenu(ctx);
});

// Reytingni tozalash
bot.action('confirm_clear_rank', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q!');
    const db = getDb();
    Object.keys(db.users).forEach(id => { db.users[id].score = 0; });
    if (db.scores) db.scores = [];
    saveDb(db);
    await ctx.editMessageText('✅ Reyting tozalandi.');
    return ctx.answerCbQuery();
});

bot.action('cancel_clear', (ctx) => ctx.deleteMessage().catch(() => {}));

// To'liq restart
bot.action('confirm_full_restart', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q!');
    try {
        saveDb({ users: {}, settings: { isMaintenance: false, turboMode: false } });
        await ctx.editMessageText('✅ Barcha ma\'lumotlar tozalandi!');
        await ctx.reply('🔄 Tizim yangilandi. Davom etish uchun ismingizni yozing:', Markup.removeKeyboard());
    } catch (err) {
        console.error('[Restart]', err.message);
        await ctx.reply('❌ Xatolik yuz berdi.');
    }
});

bot.action('cancel_restart', (ctx) => { ctx.deleteMessage().catch(() => {}); ctx.reply('Bekor qilindi.'); });

// Natijalarni e'lon qilish
bot.action('announce_results', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('Ruxsat yo\'q!');
    try {
        await ctx.editMessageText('🔄 Natijalar hisoblanmoqda...');
        await finalizeTournament(ctx);
        await ctx.answerCbQuery('✅ Jarayon yakunlandi!');
    } catch (err) {
        console.error('[Results]', err.message);
        await ctx.reply('❌ Natijalarni yuborishda xatolik.');
    }
});

bot.action('cancel_action', (ctx) => ctx.deleteMessage().catch(() => {}));

// ============================================================
// MATN HANDLERLARI (bot.hears / bot.on)
// ============================================================

// Foydalanuvchi — obunani tekshirish eskirgan handler (yuqorida bor)

// Test boshlash — fan tanlash
bot.hears(['📝 Akademik yozuv', '📜 Tarix', '➕ Matematika', '💻 Dasturlash 1', '🧲 Fizika', '🇬🇧 Perfect English'], async (ctx) => {
    const text = ctx.message.text;
    const s = ctx.session;
    const db = getDb();
    const user = db.users[ctx.from.id];

    if (!user?.isRegistered) return ctx.reply('⚠️ Avval ro\'yxatdan o\'ting.');

    const yonalishKey = user.yonalish.toLowerCase().trim().replace(/'/g, '').replace(/ /g, '_');
    const subjectMap = { 'Akademik': 'academic', 'Tarix': 'history', 'Matematika': 'math', 'Dasturlash': 'dasturlash', 'Fizika': 'physics', 'English': 'english' };
    const subjectPart = Object.entries(subjectMap).find(([k]) => text.includes(k))?.[1];
    const finalKey = `${yonalishKey}_${subjectPart}`;

    if (SUBJECTS[finalKey]?.questions) {
        s.currentSubject = finalKey;

        if (s.isTurbo) {
            const questions = SUBJECTS[finalKey].questions;
            if (!questions.length) return ctx.reply('Bu fanda savollar yo\'q.');
            s.activeList = shuffle([...questions]);
            s.index = 0; s.score = 0; s.wrongs = [];
            return sendQuestion(ctx, true);
        }

        return ctx.reply(`Tayyormisiz? (${text})`, Markup.keyboard([
            ['⚡️ Blitz (25)', '📝 To\'liq test'],
            ['⬅️ Orqaga (Fanlar)'],
        ]).resize());
    } else {
        console.log('[Subject] Kalit topilmadi:', finalKey);
        return ctx.reply(`⚠️ ${user.yonalish} uchun "${text}" savollari hali yuklanmagan.`);
    }
});

// Test turi tanlash
bot.hears(['⚡️ Blitz (25)', '📝 To\'liq test'], async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;

    s.isTurbo = false;

    if (isBotPaidMode && !vipUsers.includes(userId) && !isAdmin(userId)) {
        return ctx.reply('⚠️ Bot hozirda pullik rejimda. Test topshirish uchun VIP kerak.',
            Markup.inlineKeyboard([[Markup.button.callback('💎 VIP sotib olish', 'buy_vip')]]));
    }

    if (!s.currentSubject || !SUBJECTS[s.currentSubject]) return showSubjectMenu(ctx);

    const questions = SUBJECTS[s.currentSubject].questions;
    if (!questions?.length) return ctx.reply('Bu fanda savollar yo\'q.');

    s.activeList = ctx.message.text.includes('25') ? shuffle(questions).slice(0, 25) : shuffle(questions);
    s.index = 0; s.score = 0; s.wrongs = [];
    return sendQuestion(ctx, true);
});

// Reyting
bot.hears('📊 Reyting', async (ctx) => {
    return ctx.replyWithHTML(getLeaderboard(ctx.from.id));
});

// Profil
bot.hears(['👤 Profil', '👤 Profilim'], async (ctx) => showProfile(ctx));

// Orqaga
bot.hears(['⬅️ Orqaga (Fanlar)', '⬅️ Orqaga (Fanlar)'], (ctx) => showSubjectMenu(ctx));

// Sozlamalar
bot.hears('⚙️ Sozlamalar', (ctx) => {
    return ctx.reply('Sozlamalar:', Markup.keyboard([
        ['📝 Ismni o\'zgartirish'],
        ['🎓 Yo\'nalishni qayta tanlash'],
        ['⬅️ Orqaga (Fanlar)'],
    ]).resize());
});

bot.hears('📝 Ismni o\'zgartirish', (ctx) => {
    const db = getDb();
    if (!db.users[ctx.from.id]) return;
    db.users[ctx.from.id].step = 'edit_name';
    saveDb(db);
    return ctx.reply('Yangi ismingizni kiriting:');
});

bot.hears('🎓 Yo\'nalishni qayta tanlash', (ctx) => {
    const db = getDb();
    const user = db.users[ctx.from.id];
    if (!user) return;
    user.isRegistered = false;
    user.step = 'wait_univ';
    saveDb(db);
    return ctx.reply('OTMni qayta tanlang:', Markup.keyboard([
        ['Alfraganus Universiteti', 'Perfect Universiteti'],
        ['TATU', 'TDPU'],
    ]).oneTime().resize());
});

// ─── ADMIN HANDLERLARI ─────────────────────────────────────

bot.hears('📊 Statistika', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    const entries = Object.entries(db.users || {});
    await ctx.replyWithHTML(`📊 <b>BOT STATISTIKASI</b>\n\n👥 Jami foydalanuvchilar: <b>${entries.length} ta</b>`);

    let report = '🆔 <b>Foydalanuvchilar:</b>\n';
    for (let i = 0; i < entries.length; i++) {
        const [id, data] = entries[i];
        const line = `${i + 1}. 👤 ${escapeHTML(data.name || 'Ismsiz')} | ID: <code>${id}</code>\n`;
        if ((report + line).length > 4000) { await ctx.replyWithHTML(report); report = ''; }
        report += line;
    }
    if (report) await ctx.replyWithHTML(report, Markup.keyboard([["🗑 Foydalanuvchini o'chirish"], ['⬅️ Orqaga']]).resize());
});

bot.hears('💰 Pullik versiya', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    isBotPaidMode = true;
    return ctx.reply('✅ Bot PULLIK REJIMGA o\'tkazildi.');
});

bot.hears('🆓 Bepul versiya', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    isBotPaidMode = false;
    return ctx.reply('✅ Bot BEPUL REJIMGA o\'tkazildi.');
});

bot.hears(["🛑 Botni To'xtatish", '🟢 Botni Yoqish'], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    if (!db.settings) db.settings = {};
    const isStopping = ctx.message.text.includes('To\'xtatish');
    db.settings.isMaintenance = isStopping;
    saveDb(db);
    const text = isStopping ? '🔴 Bot hamma uchun to\'xtatildi!' : '🟢 Bot qayta yoqildi!';
    return ctx.reply(text, adminMainKeyboard(db));
});

bot.hears(['🚀 Turbo (Yoqish)', "🚀 Turbo (O'chirish)"], async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    if (!db.settings) db.settings = {};
    db.settings.turboMode = ctx.message.text.includes('Yoqish');
    saveDb(db);
    const msg = db.settings.turboMode ? '🚀 TURBO REJIM YOQILDI!' : '🚀 Turbo rejim o\'chirildi.';
    await ctx.reply(msg);
    return ctx.reply('🛠 Admin Panel', adminMainKeyboard(db));
});

bot.hears('🏆 Musobaqa boshqarish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    const status = db.tournament?.isActive ? '✅ FAOL' : "❌ FAOL EMAS";
    return ctx.reply(`🏆 Musobaqa boshqaruv paneli\nHolat: ${status}`, Markup.keyboard([
        ['🟢 Yoqish', "🔴 O'chirish"],
        ['📢 Boshlash haqida xabar', '📊 Natijalar'],
        ['⬅️ Orqaga (Admin)'],
    ]).resize());
});

bot.hears('🟢 Yoqish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    if (!db.tournament) db.tournament = { isActive: false, participants: [], results: {} };
    db.tournament.isActive = true;
    db.tournament.results = {};
    saveDb(db);
    return ctx.reply('✅ Musobaqa rejimi yoqildi!');
});

bot.hears("🔴 O'chirish", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    if (db.tournament) { db.tournament.isActive = false; saveDb(db); }
    return ctx.reply("🛑 Musobaqa o'chirildi.");
});

bot.hears('📢 Musobaqa natijalari', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    return ctx.reply('Natijalarni hisoblab e\'lon qilishni tasdiqlaysizmi?', Markup.inlineKeyboard([
        [Markup.button.callback("✅ Tasdiqlash va e'lon qilish", 'announce_results')],
        [Markup.button.callback('❌ Bekor qilish', 'cancel_action')],
    ]));
});

bot.hears('🚀 Musobaqani start berish', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    const tour = db.tournament;

    if (!tour?.isActive) return ctx.reply('❌ Faol musobaqa belgilanmagan. Avval yangi musobaqa yarating!');
    if (!tour.participants.length) return ctx.reply('❌ Musobaqada hech kim ro\'yxatdan o\'tmagan.');

    let sent = 0;
    for (const uid of tour.participants) {
        try {
            await ctx.telegram.sendMessage(uid,
                '🔔 <b>MUSOBAQA BOSHLANDI!</b>\n\nAdmin tomonidan start berildi. Pastdagi tugmani bosing:',
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏁 TESTNI BOSHLASH', 'start_actual_tour')]]) }
            );
            sent++;
        } catch {}
    }
    return ctx.reply(`🚀 Musobaqa ${sent} ta ishtirokchiga yuborildi!`);
});

bot.hears('🏆 Xalqaro test musobaqa', async (ctx) => {
    const db = getDb();
    const tour = db.tournament;
    const userId = ctx.from.id;

    if (!tour?.isActive) return ctx.reply('❌ Hozircha faol musobaqa yo\'q. Admin e\'lonini kuting.');

    const totalSec = tour.count * 30;
    const [sh, sm] = tour.time.split(':').map(Number);
    let endMin = sm + Math.floor(totalSec / 60);
    const endHour = (sh + Math.floor(endMin / 60)) % 24;
    endMin = endMin % 60;
    const endTimeStr = `${String(endHour).padStart(2,'0')}:${String(endMin).padStart(2,'0')}`;
    const durationStr = totalSec >= 60 ? `${Math.floor(totalSec/60)} daq` : `${totalSec} sek`;

    const isJoined = tour.participants.includes(userId);
    const info = `🏆 <b>XALQARO TEST MUSOBAQA</b>\n\n📅 <b>Sana:</b> ${tour.date}\n🕒 <b>Boshlanish:</b> ${tour.time}\n` +
                 `🏁 <b>Tugash (taxm.):</b> ${endTimeStr}\n⏱ <b>Davomiylik:</b> ${durationStr}\n📝 <b>Savollar:</b> ${tour.count} ta\n_________________________\n`;

    if (isJoined) {
        return ctx.replyWithHTML(`${info}\n✅ <b>Siz ro\'yxatdansiz!</b>\n🚀 Musobaqa vaqtida xabar keladi.`);
    }

    return ctx.replyWithHTML(`${info}\nMusobaqada qatnashishni tasdiqlaysizmi?`, Markup.inlineKeyboard([
        [Markup.button.callback("✅ Qo'shilish", 'join_tour'), Markup.button.callback('❌ Rad etish', 'cancel_join')],
    ]));
});

bot.hears("🏆 Musobaqaga o'tish", async (ctx) => {
    const db = getDb();
    const tour = db.tournament;
    if (!tour?.isActive) return showSubjectMenu(ctx);

    return ctx.replyWithHTML(
        `🏆 <b>Musobaqa rejasi</b>\n\n📅 Sana: ${tour.date}\n🕒 Vaqt: ${tour.time}\n📝 Savollar: ${tour.count} ta\n\nRo\'yxatdan o\'tish uchun:`,
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Ro'yxatdan o'tish", 'join_tour')],
            [Markup.button.callback('⬅️ Fanlarga qaytish', 'back_to_main')],
        ])
    );
});

bot.hears('🧹 Reytingni tozalash', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    return ctx.reply('⚠️ Barcha ballarni tozalashni tasdiqlaysizmi?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, tozalash', 'confirm_clear_rank')],
        [Markup.button.callback('❌ Yo\'q', 'cancel_clear')],
    ]));
});

bot.hears('🗑 Botni Restart qilish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    return ctx.reply('⚠️ Barcha ma\'lumotlarni o\'chirib restart qilmoqchimisiz?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha, tasdiqlash', 'confirm_full_restart')],
        [Markup.button.callback('❌ Yo\'q', 'cancel_restart')],
    ]));
});

bot.hears('📣 Xabar tarqatish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.waitingForForward = true;
    return ctx.reply('Yubormoqchi bo\'lgan xabaringizni yuboring:', Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

bot.hears("⏱ Vaqtni o'zgartirish", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.waitingForTime = true;
    return ctx.reply('Vaqtni soniyalarda kiriting:', Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

bot.hears('➕ Yangi fan qoshish', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.waitingForSubjectName = true;
    return ctx.reply('Yangi fan nomini kiriting (Masalan: Fizika):', Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

bot.hears(["🗑 Foydalanuvchini o'chirish"], (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminStep = 'wait_delete_id';
    return ctx.reply('🗑 O\'chirmoqchi bo\'lgan foydalanuvchining ID raqamini kiriting:');
});

bot.hears(['⬅️ Orqaga (Admin)', '⬅️ Orqaga'], (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const db = getDb();
    return ctx.reply('Admin paneli:', adminMainKeyboard(db));
});

bot.hears('🏆 Haftalik musobaqa', (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminStep = 'wait_tour_date';
    return ctx.reply('📅 Musobaqa sanasini kiriting (masalan: 09.03.2026):', Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

// ============================================================
// ASOSIY MATN / MEDIA HANDLER
// ============================================================
bot.on(['text', 'photo', 'video', 'animation', 'document'], async (ctx, next) => {
    const msgText = ctx.message.text || ctx.message.caption || '';
    const userId = ctx.from.id;
    const username = ctx.from.username || 'Lichka yopiq';
    const s = ctx.session;

    if (msgText.startsWith('/')) return next();

    // Bekor qilish
    if (msgText === '🚫 Bekor qilish') {
        s.waitingForForward = false;
        s.waitingForTime = false;
        s.waitingForSubjectName = false;
        s.waitingForSubjectQuestions = false;
        s.waitingForName = false;
        s.adminStep = null;
        return showSubjectMenu(ctx);
    }

    // VIP chek qabul qilish
    if (s.waitingForReceipt && ctx.message.photo) {
        s.waitingForReceipt = false;
        const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        await ctx.telegram.sendPhoto(ADMIN_ID, fileId, {
            caption: `🔔 <b>Yangi to\'lov!</b>\n👤 ${escapeHTML(ctx.from.first_name)}\n🆔 <code>${userId}</code>`,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('✅ Tasdiqlash', `approve_${userId}`)],
                [Markup.button.callback('❌ Rad etish', `reject_${userId}`)],
            ])
        });
        return ctx.reply('✅ Chekingiz adminga yuborildi. Tasdiqlangach xabar boradi.');
    }

    // Admin — xabar tarqatish
    if (isAdmin(userId) && s.waitingForForward) {
        s.waitingForForward = false;
        const db = getDb();
        const users = Object.keys(db.users || {});
        await ctx.reply(`📣 ${users.length} kishiga yuborilmoqda...`);
        let success = 0;
        for (const uid of users) {
            try {
                await ctx.telegram.copyMessage(uid, ctx.chat.id, ctx.message.message_id);
                success++;
                if (success % 25 === 0) await new Promise(r => setTimeout(r, 500));
            } catch {}
        }
        await ctx.reply(`✅ Xabar yuborildi!\nJami: ${users.length} | Muvaffaqiyatli: ${success}`);
        return showSubjectMenu(ctx);
    }

    // Admin — vaqt o'zgartirish
    if (isAdmin(userId) && s.waitingForTime) {
        const val = parseInt(msgText);
        if (isNaN(val) || val < 5) return ctx.reply('❌ Xato raqam! Kamida 5 kiriting:');
        botSettings.timeLimit = val;
        saveSettings(botSettings);
        s.waitingForTime = false;
        await ctx.reply(`✅ Savol vaqti ${val} soniyaga yangilandi.`);
        return showSubjectMenu(ctx);
    }

    // Admin — yangi fan nomi
    if (isAdmin(userId) && s.waitingForSubjectName) {
        s.newSubName = msgText;
        s.waitingForSubjectName = false;
        s.waitingForSubjectQuestions = true;
        return ctx.reply(`"${msgText}" fani uchun savollarni JSON formatida yuboring:`, Markup.keyboard([['🚫 Bekor qilish']]).resize());
    }

    // Admin — fan savollari JSON
    if (isAdmin(userId) && s.waitingForSubjectQuestions) {
        try {
            const qs = JSON.parse(msgText);
            const key = s.newSubName.toLowerCase().replace(/ /g, '_');
            SUBJECTS[key] = { title: s.newSubName, questions: qs };
            writeJSON(PATHS.customQ, SUBJECTS);
            s.waitingForSubjectQuestions = false;
            await ctx.reply('✅ Yangi fan muvaffaqiyatli qo\'shildi!');
            return showSubjectMenu(ctx);
        } catch {
            return ctx.reply('❌ JSON formati noto\'g\'ri! Tekshirib qaytadan yuboring:');
        }
    }

    // Admin — musobaqa yaratish (step-by-step)
    if (isAdmin(userId)) {
        if (s.adminStep === 'wait_tour_date') {
            if (msgText === '🚫 Bekor qilish') { s.adminStep = null; return ctx.reply('Bekor qilindi.'); }
            s.tourDate = msgText;
            s.adminStep = 'wait_tour_time';
            return ctx.reply('🕒 Musobaqa boshlanish soatini kiriting (masalan: 15:00):');
        }

        if (s.adminStep === 'wait_tour_time') {
            s.tourTime = msgText;
            s.adminStep = 'wait_tour_count';
            return ctx.reply('📝 Jami testlar sonini kiriting (masalan: 50):');
        }

        if (s.adminStep === 'wait_tour_count') {
            if (isNaN(msgText)) return ctx.reply('❌ Faqat raqam kiriting:');
            s.tourCount = msgText;
            s.adminStep = null;
            return ctx.replyWithHTML(
                `🏆 <b>Yangi musobaqa tafsilotlari:</b>\n\n📅 ${s.tourDate}\n🕒 ${s.tourTime}\n📝 ${s.tourCount} ta\n\nTasdiqlaysizmi?`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Tasdiqlash', 'confirm_tour'), Markup.button.callback('❌ Rad etish', 'reject_tour')]
                ])
            );
        }

        if (s.adminStep === 'wait_delete_id') {
            const delId = parseInt(msgText);
            s.adminStep = null;
            const db = getDb();
            if (db.users[delId]) {
                delete db.users[delId];
                saveDb(db);
                return ctx.reply(`✅ Foydalanuvchi (ID: ${delId}) o'chirildi.`);
            }
            return ctx.reply('❌ Bunday ID li foydalanuvchi topilmadi.');
        }
    }

    // Ro'yxatdan o'tish
    const db = getDb();
    const user = db.users[userId];

    if (!user || !user.isRegistered) {
        if (!db.users[userId]) {
            db.users[userId] = { id: userId, step: 'wait_name', isRegistered: false, score: 0, username };
            saveDb(db);
        }
        const cu = db.users[userId];

        if (cu.step === 'wait_name') {
            const forbidden = ['📝 Akademik yozuv','📜 Tarix','➕ Matematika','💻 Dasturlash 1','🧲 Fizika','🇬🇧 Perfect English','📊 Reyting','👤 Profil','⚙️ Sozlamalar'];
            if (forbidden.includes(msgText) || msgText.length < 3) {
                return ctx.reply('❌ Ism va familiyangizni to\'g\'ri kiriting (kamida 3 harf):', Markup.removeKeyboard());
            }
            cu.name = msgText; cu.step = 'wait_univ'; saveDb(db);
            return ctx.reply(`Rahmat, ${escapeHTML(msgText)}!\n\nO\'qish joyingizni tanlang:`, Markup.keyboard([
                ['Alfraganus Universiteti', 'Perfect Universiteti'], ['TATU', 'TDPU']
            ]).oneTime().resize());
        }

        if (cu.step === 'wait_univ') {
            if (!['Alfraganus Universiteti', 'Perfect Universiteti', 'TATU', 'TDPU'].includes(msgText)) return ctx.reply('⚠️ Universitetni tanlang:');
            cu.univ = msgText; cu.step = 'wait_kurs'; saveDb(db);
            return ctx.reply('Nechanchi kurs?', Markup.keyboard([['1-kurs', '2-kurs'], ['3-kurs', '4-kurs']]).oneTime().resize());
        }

        if (cu.step === 'wait_kurs') {
            if (!['1-kurs','2-kurs','3-kurs','4-kurs'].includes(msgText)) return ctx.reply('⚠️ Kursni tanlang:');
            cu.kurs = msgText; cu.step = 'wait_yonalish'; saveDb(db);
            const buttons = msgText === '1-kurs'
                ? [["Dasturiy Injiniring", "Kiberxavfsizlik"], ["Sun'iy intelekt"]]
                : [['Magistratura', 'Boshqa']];
            return ctx.reply('Yo\'nalishingizni tanlang:', Markup.keyboard(buttons).oneTime().resize());
        }

        if (cu.step === 'wait_yonalish') {
            cu.yonalish = msgText; cu.step = 'wait_semester'; saveDb(db);
            return ctx.reply('Semestrni tanlang:', Markup.keyboard([['1-semestr', '2-semestr']]).oneTime().resize());
        }

        if (cu.step === 'wait_semester') {
            if (msgText === '2-semestr') return ctx.reply('❌ Hozircha faqat 1-semestr mavjud.');
            if (msgText === '1-semestr') {
                cu.semester = msgText; cu.isRegistered = true; cu.step = 'completed'; saveDb(db);
                await ctx.reply('✅ Ro\'yxatdan o\'tildi!');
                return showSubjectMenu(ctx);
            }
            return ctx.reply('⚠️ Semestrni tanlang:');
        }
        return ctx.reply('⚠️ Davom etish uchun ismingizni kiriting!');
    }

    // Ism tahrirlash
    if (user.step === 'edit_name') {
        if (msgText.length < 3) return ctx.reply('❌ Ism juda qisqa (kamida 3 harf):');
        user.name = msgText; user.step = 'completed'; saveDb(db);
        await ctx.reply(`✅ Ism o'zgartirildi: ${escapeHTML(msgText)}`);
        return showSubjectMenu(ctx);
    }

    // Ism qayta kiritish (waitingForName — eski session uchun)
    if (s.waitingForName) {
        if (msgText.length < 3) return ctx.reply('❌ Ism juda qisqa:');
        s.userName = msgText;
        s.waitingForName = false;
        const dbU = getDb();
        if (!dbU.users[userId]) dbU.users[userId] = {};
        dbU.users[userId] = { ...dbU.users[userId], name: msgText, username: `@${username}` };
        saveDb(dbU);
        await ctx.reply(`✅ Rahmat, ${escapeHTML(msgText)}!`);
        return showSubjectMenu(ctx);
    }

    return next();
});

// ============================================================
// CRON — MUSOBAQA AVTOMATIK BOSHLASH
// ============================================================
cron.schedule('* * * * *', async () => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const db = getDb();
    const tour = db.tournament;

    if (tour?.isActive && tour.time === currentTime) {
        console.log('🚀 Musobaqa avtomatik boshlanmoqda...');
        for (const uid of tour.participants) {
            await bot.telegram.sendMessage(uid,
                `🔔 <b>MUSOBAQA BOSHLANDI!</b>\n\nSoat <b>${tour.time}</b> bo\'ldi. Omad!\nPastdagi tugmani bosing:`,
                { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('🏁 TESTNI BOSHLASH', 'start_actual_tour')]]) }
            ).catch(() => {});
        }
    }
});

// ============================================================
// EXPRESS API
// ============================================================
// Foydalanuvchi statistikasini ismi orqali qaytarish
app.get('/api/user-stats', (req, res) => {
    const name = (req.query.name || '').toLowerCase().trim();
    if (!name) return res.status(400).json({ error: 'name kerak' });
    const db = getDb();
    const user = Object.values(db.users).find(u => (u.name || '').toLowerCase().trim() === name);
    if (!user) return res.status(404).json({ error: 'Topilmadi' });
    res.json({
        score:      user.score      || 0,
        totalTests: user.totalTests || 0,
        univ:       user.univ       || '—',
        kurs:       user.kurs       || '—',
        yonalish:   user.yonalish   || '—',
    });
});

app.get('/api/tournament', (req, res) => {
    const db = getDb();
    res.json(db.tournament || { isActive: false });
});

app.post('/api/reject', async (req, res) => {
    const db = getDb();
    db.tournament = { isActive: false, date: null, time: null, participants: [] };
    saveDb(db);

    for (const id of Object.keys(db.users || {})) {
        await bot.telegram.sendMessage(id, "🚫 <b>E'lon:</b> Rejalashtirilgan musobaqa bekor qilindi.", {
            parse_mode: 'HTML',
            ...Markup.keyboard([['📝 Akademik yozuv', '📜 Tarix'], ['➕ Matematika', '📊 Reyting'], ['👤 Profil']]).resize()
        }).catch(() => {});
    }
    res.json({ success: true });
});

app.get('/', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'index.html');
    fs.readFile(filePath, (err, data) => {
        if (err) return res.status(404).send('HTML fayl topilmadi.');
        res.setHeader('Content-Type', 'text/html');
        res.send(data);
    });
});

// Statik fayllar (CSS, JS va boshqalar)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// XATOLARNI USHLASH
// ============================================================
bot.catch((err, ctx) => {
    if (err.response?.error_code === 403) {
        console.log(`🚫 Foydalanuvchi (${ctx.from?.id}) botni bloklagan.`);
        return;
    }
    console.error('🔴 Xatolik:', err.message);
});

// ============================================================
// ISHGA TUSHIRISH
// ============================================================
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Express server ${PORT}-portda ishlamoqda`);
});

bot.launch()
    .then(() => console.log('✅ Bot muvaffaqiyatli ishga tushdi!'))
    .catch((err) => console.error('❌ Bot ishga tushmadi:', err.message));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));