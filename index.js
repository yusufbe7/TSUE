const { Telegraf, Markup } = require('telegraf');
const LocalSession = require('telegraf-session-local'); //Qisqa muddatli xotirasi Telegram botlar tabiatan "esda tutmas" (stateless) bo'ladi. Ya'ni, bot foydalanuvchi hozirgina nima deganini darrov unutadi.
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const http = require('http');



// 1. O'zgaruvchilarni tartib bilan e'lon qilish
const ADMIN_ID = parseInt(process.env.ADMIN_ID); 
const bot = new Telegraf(process.env.BOT_TOKEN);
const REQUIRED_CHANNEL = '@student_aitex'; // Kanal yuzernamini yozing (@ bilan)
const CHANNEL_ID = '-1001234567890'; // Kanal ID raqamini yozing (agar bilsangiz)

// Railway uchun doimiy papka (Volume)
const DATA_DIR = '/data'; 

if (!fs.existsSync(DATA_DIR)) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (err) {
        console.log("LocalStorage rejimi faollashdi");
    }
}

// Fayl manzillari
const DB_FILE = path.join(DATA_DIR, 'ranking_db.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const QUESTIONS_FILE = path.join(DATA_DIR, 'custom_questions.json');
const VIP_FILE = path.join(DATA_DIR, 'vip_users.json');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

const SUBJECTS_FILE = path.join(__dirname, 'subjects.json');
const adminStates = {}; // Admin holatlarini saqlash uchun
// 2. Bazalarni tekshirish va funksiyalar
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ users: {} }));

function getDb() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, settings: {} }, null, 2));
        }
        const data = fs.readFileSync(DB_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Bazani o'qishda xato:", error);
        return { users: {}, settings: {} };
    }
}

function saveDb(db) {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
    } catch (err) {
        console.error("FAYLGA YOZISHDA XATO:", err);
    }
}

// Bot sozlamalarini yuklash
let botSettings = { timeLimit: 60 }; 
if (fs.existsSync(SETTINGS_FILE)) {
    try {
        botSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) { console.error("Settings o'qishda xato"); }
}

// 3. Sessiyani ulash
bot.use((new LocalSession({ database: SESSION_FILE })).middleware());

// --- MA'LUMOTLAR BAZASI VA REJIMLAR ---
let isBotPaidMode = false;
let vipUsers = [];

try {
    if (fs.existsSync(VIP_FILE)) {
        vipUsers = JSON.parse(fs.readFileSync(VIP_FILE));
    }
} catch (err) { vipUsers = []; }

// --- FANLAR BAZASI ---
// Savollarni o'qiymiz
let SUBJECTS = {};
// Fayl mavjudligini tekshirib, ichidagilarni o'qiymiz
if (fs.existsSync(SUBJECTS_FILE)) {
    try {
        const rawData = fs.readFileSync(SUBJECTS_FILE, 'utf8');
        SUBJECTS = JSON.parse(rawData);
        console.log("✅ Savollar bazasi (subjects.json) muvaffaqiyatli yuklandi!");
    } catch (e) {
        console.error("❌ subjects.json faylini o'qishda xato:", e);
    }
} else {
    console.log("⚠️ subjects.json fayli topilmadi!");
}


let tournament = {
    isActive: false,       // Musobaqa ochiqmi?
    participants: [],      // To'lov qilgan foydalanuvchilar ID-lari
    results: {},           // { userId: { score: 0, time: 0 } }
    subject: null          // Musobaqa qaysi fandan bo'ladi?
};

const TOURNAMENT_FILE = path.join(DATA_DIR, 'tournament_data.json');
// Eskidan saqlangan musobaqa bo'lsa, yuklaymiz
if (fs.existsSync(TOURNAMENT_FILE)) {
    try { tournament = JSON.parse(fs.readFileSync(TOURNAMENT_FILE)); } catch(e) {}
}

if (fs.existsSync(QUESTIONS_FILE)) {
    try {
        SUBJECTS = JSON.parse(fs.readFileSync(QUESTIONS_FILE, 'utf8'));
    } catch (e) { console.error("Savollarni o'qishda xato"); }
}

const timers = {};
const shuffle = (arr) => [...arr].sort(() => Math.random() - 0.5);

function getProgressBar(current, total) {
    const size = 10;
    const progress = Math.min(Math.round((current / total) * size), size);
    return "█".repeat(progress) + "░".repeat(size - progress);
}

function updateGlobalScore(userId, name, username, score) {
    try {
        let db = getDb();
        if (!db.users[userId]) {
            db.users[userId] = { 
                name: name || "Foydalanuvchi", 
                username: username ? `@${username}` : "Lichka yopiq",
                score: 0, 
                totalTests: 0 
            };
        }
        db.users[userId].totalTests = (db.users[userId].totalTests || 0) + 1;
        
        // Ballarni shunchaki qo'shish (Eski kodingizda faqat eng yuqorisini saqlardi)
        db.users[userId].score = (db.users[userId].score || 0) + score;
        
        db.users[userId].name = name;
        db.users[userId].username = username ? `@${username}` : "Lichka yopiq";
        
        saveDb(db); // Biz yangilagan saveDb ni chaqiramiz
    } catch (error) { console.error("Bazaga yozishda xato:", error); }
}

function getLeaderboard(ctx) {
    const db = getDb();
    
    // 1. Bazada foydalanuvchilar borligini tekshirish
    if (!db || !db.users || Object.keys(db.users).length === 0) {
        return "🏆 Hozircha hech kim test topshirmadi. Birinchi bo'ling! 🚀";
    }
    
    // 2. Obyektni massivga o'tkazish
    const usersArray = Object.values(db.users);
    
    // 3. FILTRLASH: Faqat ismi bor va balli 0 dan baland foydalanuvchilarni olish
    const sorted = usersArray
        .filter(u => u && u.name && u.name !== "undefined" && (u.score || 0) > 0) 
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 10);

    if (sorted.length === 0) {
        return "🏆 Hozircha reytingda hech kim yo'q.";
    }
    
    // Admin ekanligingizni tekshirish
    const isRequesterAdmin = ctx && ctx.from && ctx.from.id === ADMIN_ID;

    let res = "🏆 <b>TOP 10 REYTING</b>\n\n";
    
    sorted.forEach((u, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : "🔹";
        
        // Ma'lumotlarni chiroyli formatlash
        const name = u.name.trim();
        const score = parseFloat(u.score || 0).toFixed(1);
        
        // Username faqat admin uchun ko'rinadi
        let userLink = "";
        if (isRequesterAdmin && u.username && u.username !== "Lichka yopiq") {
            userLink = ` (<code>${u.username}</code>)`;
        }

        res += `${medal} <b>${name}</b>${userLink} — <b>${score}</b> ball\n`;
    });
    
    return res;
}

function showSubjectMenu(ctx) {
    try {
        const db = getDb();
        const userId = ctx.from.id;

        // 1. Bazada users obyekti borligini tekshirish
        if (!db || !db.users) {
            return ctx.reply("❌ Malumotlar bazasi topilmadiku umuman. Iltimos, /start bosing.");
        }

        const user = db.users[userId];

        // 2. Foydalanuvchi ro'yxatdan o'tganini tekshirish
        if (!user || !user.isRegistered) {
            return ctx.reply("⚠️ Iltimos, avval /start buyrug'ini bosing va ro'yxatdan o'ting.");
        }

        let keyboard = [];

        // ==========================================
        // 🎭 YO'NALISHLARGA QARAB TUGMALARNI SARALASH
        // ==========================================
        const yonalish = user.yonalish;

        if (yonalish === "Dasturiy Injiniring") {
            keyboard = [
                ["📝 Akademik yozuv", "📜 Tarix"],
                ["➕ Matematika", "🧲 Fizika"],
                ["💻 Dasturlash 1", "🇬🇧 Perfect English"]
            ];
        } else if (yonalish === "Kiberxavfsizlik") {
            keyboard = [
                ["🧲 Fizika", "📜 Tarix"],
                ["📝 Akademik yozuv", "➕ Matematika"],
                ["🇬🇧 Perfect English", "💻 Dasturlash 1"]
            ];
        } else if (yonalish === "Sun'iy intelekt") {
            keyboard = [
                ["🧲 Fizika", "📜 Tarix"],
                ["📝 Akademik yozuv", "➕ Matematika"],
                ["🇬🇧 Perfect English", "💻 Dasturlash 1"]
            ];
        } else if (yonalish === "Matematika") {
            keyboard = [
                ["➕ Matematika", "📐 Geometriya"],
                ["📜 Tarix", "🇬🇧 Perfect English"]
            ];
        } else {
            keyboard = [
                ["📝 Akademik yozuv", "📜 Tarix"],
                ["➕ Matematika", "🧲 Fizika"]
            ];
        }

        // ==========================================
        // ⚙️ QO'SHIMCHA SOZLAMALAR
        // ==========================================
        if (db.settings?.turboMode) {
            keyboard.unshift(["🚀 TURBO YODLASH (16:30)"]);
        }

        if (typeof tournament !== 'undefined' && tournament.isActive) {
            keyboard.push(["🏆 Musobaqada qatnashish"]);
        }

        // Tizim menyusi
        keyboard.push(["📊 Reyting", "👤 Profil"]);
        keyboard.push(["⚙️ Sozlamalar"]);

        const welcomeText = `👤 <b>Foydalanuvchi:</b> ${user.name || "Talaba"}\n` +
                            `🏛 <b>OTM:</b> ${user.univ || "Noma'lum"}\n` +
                            `🎓 <b>Yo'nalish:</b> ${yonalish}\n\n` +
                            `Fanni tanlang:`;

        return ctx.replyWithHTML(welcomeText, Markup.keyboard(keyboard).resize());

    } catch (error) {
        console.error("CRITICAL ERROR in showSubjectMenu:", error);
        return ctx.reply("❌ Menyuni yuklashda xatolik yuz berdi. Qayta urinib ko'ring yoki /start bosing.");
    }
}

function makeUserVip(userId) {
    const db = getDb();
    if (db.users[userId]) {
        db.users[userId].isVip = true;
        saveDb(db);
        return true;
    }
    return false;
}

async function sendQuestion(ctx, isNew = false) {
    const s = ctx.session;
    const userId = ctx.from.id;
    if (timers[userId]) clearTimeout(timers[userId]);

    // ==========================================
    // 🏁 1. TEST YAKUNLANISHI VA TAHLIL QISMI
    // ==========================================
    if (s.index >= s.activeList.length) {
        if (!s.isTurbo) {
            updateGlobalScore(userId, s.userName, ctx.from.username, s.score);
        }
        
        // Natija sarlavhasi
        let resultMsg = s.isTurbo 
            ? `🏁 <b>Turbo yodlash yakunlandi!</b>`
            : `🏁 <b>Test yakunlandi, ${s.userName}!</b>\n\n` +
              `✅ To'g'ri javob: <b>${s.score} ta</b>\n` +
              `❌ Xato javob: <b>${s.wrongs.length} ta</b>\n` +
              `📊 Natij"a": <b>${((s.score / s.activeList.length) * 100).toFixed(1)}%</b>\n` +
              `_________________________\n\n`;

        // Xatolar tahlili
        if (s.wrongs.length > 0 && !s.isTurbo) {
            resultMsg += `⚠️ <b>Xatolar tahlili:</b>\n\n`;
            
            s.wrongs.forEach((xato, i) => {
                // Har bir savol blokini vaqtinchalik o'zgaruvchiga olamiz
                let errorBlock = `<b>${i + 1}.</b> ${escapeHTML(xato.q)}\n` +
                                 `❌ Siz tanladingiz: <s>${escapeHTML(xato.userAnswer || "Vaqt tugadi")}</s>\n` +
                                 `✅ To'g'ri javob: <u>${escapeHTML(xato.a)}</u>\n` +
                                 `_________________________\n\n`;
                
                // Telegram limiti 4096 belgi, shuning uchun xabar to'lib qolmasligini tekshiramiz
                if ((resultMsg + errorBlock).length < 3900) {
                    resultMsg += errorBlock;
                }
            });

            if (resultMsg.length >= 3900) {
                resultMsg += `\n...(Xatolar juda ko'p, barchasi sig'madi)`;
            }
        } else if (!s.isTurbo) {
            resultMsg += `🌟 <b>Ajoyib! Hech qanday xato qilmadingiz!</b>\n`;
        }

        s.isTurbo = false;

        // HTML parse xatosini oldini olish uchun try-catch
        try {
            return await ctx.replyWithHTML(resultMsg, Markup.keyboard([
                ["⚡️ Blitz (25)", "📝 To'liq test"], 
                ["⬅️ Orqaga (Fanlar)"]
            ]).resize());
        } catch (e) {
            console.error("HTML yuborishda xato:", e);
            // Agar HTML xatosi bo'lsa, oddiy matn yuboramiz
            return ctx.reply(`🏁 Test yakunlandi, ${s.userName}!\n✅ To'g'ri: ${s.score}\n❌ Xato: ${s.wrongs.length}\nNatij"a": ${((s.score / s.activeList.length) * 100).toFixed(1)}%`);
        }
    }

    // 🛑 XATOLIKDAN HIMOYA
    const qData = s.activeList[s.index];
    if (!qData || !qData.q) {
        s.index++;
        return sendQuestion(ctx, true);
    }

    const safeQuestion = escapeHTML(qData.q);
    const progress = getProgressBar(s.index + 1, s.activeList.length);
    const imagePath = qData.image ? `./images/${qData.image}` : null;
    const hasImage = imagePath && fs.existsSync(imagePath);

    // ==========================================
    // 🚀 2. TURBO YODLASH REJIMI
    // ==========================================
    if (s.isTurbo) {
        let turboText = `🚀 <b>TURBO YODLASH</b>\n📊 [${progress}]\n🔢 Savol: <b>${s.index + 1} / ${s.activeList.length}</b>\n` +
                        `_________________________\n\n❓ <b>${safeQuestion}</b>\n\n` +
                        `✅ <b>TO'G'RI JAVOB:</b>\n<code>${escapeHTML(qData.a)}</code>\n` +
                        `_________________________\n👇 Keyingi savol:`;

        const turboButtons = Markup.inlineKeyboard([
            [Markup.button.callback("Keyingi savol ➡️", "next_turbo_q")],
            [Markup.button.callback("🛑 To'xtatish", "stop_test")]
        ]);

        if (hasImage) {
            return await ctx.replyWithPhoto({ source: imagePath }, { caption: turboText, parse_mode: 'HTML', ...turboButtons });
        }
        try {
            if (isNew) return await ctx.replyWithHTML(turboText, turboButtons);
            return await ctx.editMessageText(turboText, { parse_mode: 'HTML', ...turboButtons });
        } catch (e) {
            return await ctx.replyWithHTML(turboText, turboButtons);
        }
    }

    // ==========================================
    // 📝 3. ODDIY TEST REJIMI
    // ==========================================
    const currentTimeLimit = s.userTimeLimit || botSettings.timeLimit || 30;
    s.currentOptions = shuffle([...qData.options]);
    const labels = ['A', 'B', 'C', 'D'];

    let text = `📊 Progress: [${progress}]\n🔢 Savol: <b>${s.index + 1} / ${s.activeList.length}</b>\n` +
               `⏱ <b>VAQT: ${currentTimeLimit}s</b>\n\n❓ <b>${safeQuestion}</b>\n\n`;

    s.currentOptions.forEach((opt, i) => { text += `<b>${labels[i]})</b> ${escapeHTML(opt)}\n\n`; });

    const inlineButtons = Markup.inlineKeyboard([
        s.currentOptions.map((_, i) => Markup.button.callback(labels[i], `ans_${i}`)),
        [Markup.button.callback("💡 Tushuntirish", "show_explanation")], 
        [Markup.button.callback("🛑 Testni to'xtatish", "stop_test")]
    ]);

    if (hasImage) {
        await ctx.replyWithPhoto({ source: imagePath }, { caption: text, parse_mode: 'HTML', ...inlineButtons });
    } else {
        try {
            if (isNew) await ctx.replyWithHTML(text, inlineButtons);
            else await ctx.editMessageText(text, { parse_mode: 'HTML', ...inlineButtons });
        } catch (e) {
            await ctx.replyWithHTML(text, inlineButtons);
        }
    }

    // Taymerni o'rnatish
    timers[userId] = setTimeout(async () => {
        if (ctx.session && ctx.session.index === s.index && !ctx.session.isTurbo) {
            ctx.session.wrongs.push({ ...qData, userAnswer: "Vaqt tugadi ⏰" });
            ctx.session.index++; 
            await ctx.replyWithHTML(`⏰ <b>VAQT TUGADI!</b>`);
            sendQuestion(ctx, true);
        }
    }, currentTimeLimit * 1000);
}

async function checkSubscription(ctx) {
    try {
        // Kanal yuzernami yoki ID orqali tekshirish
        const member = await ctx.telegram.getChatMember(REQUIRED_CHANNEL, ctx.from.id);
        const status = member.status;
        
        // Agar foydalanuvchi kanalda bo'ls"a": member, administrator yoki creator bo'ladi
        return ['member', 'administrator', 'creator'].includes(status);
    } catch (error) {
        console.error("Obunani tekshirishda xato:", error);
        return false; // Xatolik bo'lsa (masalan bot kanalda admin emas), xavfsizlik uchun false qaytaramiz
    }
}

async function showProfile(ctx) {
    const db = getDb();
    const userId = ctx.from.id;
    const user = db.users[userId];

    if (!user) {
        return ctx.reply("Siz hali test topshirmagansiz. Avval test yechib ko'ring!");
    }

    // Reytingdagi o'rnini aniqlash
    const usersArray = Object.values(db.users);
    const sortedUsers = usersArray.sort((a, b) => (b.score || 0) - (a.score || 0));
    const rank = sortedUsers.findIndex(u => u.id === userId) + 1;

    let profileMsg = `👤 <b>SIZNING PROFILINGIZ</b>\n\n`;
    profileMsg += `🆔 <b>ID:</b> <code>${userId}</code>\n`;
    profileMsg += `👤 <b>Ism:</b> ${user.name || "Kiritilmagan"}\n`;
    profileMsg += `🏆 <b>Umumiy ball:</b> ${user.score.toFixed(1)} ball\n`;
    profileMsg += `📈 <b>Reytingdagi o'rningiz:</b> ${rank}-o'rin (jami ${usersArray.length} tadan)\n\n`;
    
    // Foydalanuvchiga qo'shimcha motivatsiya
    if (rank <= 10) {
        profileMsg += `🌟 Siz TOP-10 talikdasiz! Baraka bering!`;
    } else {
        profileMsg += `🚀 TOP-10 ga kirish uchun yana biroz harakat qiling!`;
    }

    return ctx.replyWithHTML(profileMsg);
}

// BU FUNKSIYANI KODINGIZNING OXIRIGA QO'SHIB QO'YING
function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, function(m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}



bot.use(async (ctx, next) => {
    const db = getDb();
    // Agar bot to'xtatilgan bo'lsa va foydalanuvchi admin bo'lmasa
    if (db.settings?.isMaintenance && ctx.from?.id !== ADMIN_ID) {
        return ctx.reply("🛠 Botimizda hozirda texnik ishlar olib borilmoqda. Tez orada qaytamiz! Sabringiz uchun rahmat.");
    }
    return next();
});

// --- ADMIN KOMANDALARI ---
bot.command('admin', (ctx) => {
    if (ctx.from.id === ADMIN_ID) {
        const db = getDb();
        const statusEmoji = db.settings?.isMaintenance ? "🟢 Botni Yoqish" : "🛑 Botni To'xtatish";
        
        return ctx.reply(`🛠 **Admin Panel**`, 
            Markup.keyboard([
                ['💰 Pullik versiya', '🆓 Bepul versiya'],
                [statusEmoji, '📊 Statistika'],
                ['🏆 Musobaqa boshqarish', '🗑 Botni Restart qilish'], // Yangi tugma shu yerda
                ['🗑 Foydalanuvchini o\'chirish', '🧹 Reytingni tozalash'],
                ['📣 Xabar tarqatish', '⬅️ Orqaga (Fanlar)']
            ]).resize());
    }
});


bot.use(async (ctx, next) => {
    try {
        // 1. Agar bu start komandasi yoki tugma bosilishi (callback) bo'lsa, o'tkazib yuboramiz
        if (ctx.message && ctx.message.text === '/start') return next();
        if (ctx.callbackQuery) return next();

        // 2. Obunani tekshiramiz
        const isSubscribed = await checkSubscription(ctx);
        
        if (!isSubscribed) {
            // 3. Xabarni yuborishda bloklanganligini try-catch orqali tekshiramiz
            return await ctx.reply(
                "⚠️ Botdan foydalanish uchun rasmiy kanalimizga obuna bo'lishingiz shart!",
                Markup.inlineKeyboard([
                    [Markup.button.url("📢 Kanalga o'tish", `https://t.me/${REQUIRED_CHANNEL.replace('@', '')}`)],
                    [Markup.button.callback("✅ Tekshirish", "check_sub")]
                ])
            ).catch(e => {
                if (e.response?.error_code === 403) {
                    console.log(`🚫 User ${ctx.from.id} botni bloklagani uchun obuna xabari yuborilmadi.`);
                }
            });
        }
        
        return next(); 
    } catch (error) {
        console.error("🔴 Middleware error (Subscription check):", error.message);
        return next(); // Xatolik bo'lsa ham bot to'xtab qolmasin
    }
});

// "✅ Tekshirish" tugmasi bosilganda
bot.action('check_sub', async (ctx) => {
    const isSubscribed = await checkSubscription(ctx);
    if (isSubscribed) {
        await ctx.answerCbQuery("✅ Rahmat! Endi botdan foydalanishingiz mumkin.");
        await ctx.deleteMessage();
        return showSubjectMenu(ctx);
    } else {
        return ctx.answerCbQuery("❌ Siz hali ham kanalga obuna emassiz!", { show_alert: true });
    }
});


bot.action("next_turbo_q", async (ctx) => {
    if (ctx.session && ctx.session.isTurbo) {
        ctx.session.index++;
        // Har doim true yuboramiz, chunki rasm bo'lsa editMessageText xato beradi
        return sendQuestion(ctx, true); 
    }
    await ctx.answerCbQuery();
});

bot.action("show_explanation", async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;
    const db = getDb();
    
    const user = db.users[userId] || {};
    const isUserVip = user.isVip;
    const isUserAdmin = (userId === Number(ADMIN_ID));

    // 1. VIP tekshiruvi
    if (!isUserVip && !isUserAdmin) {
        await ctx.answerCbQuery("🔒 Faqat VIP a'zolar uchun!", { show_alert: true });
        return ctx.replyWithHTML(
            `⭐ <b>DIQQAT: Tushuntirishlar faqat VIP a'zolar uchun!</b>\n\n` +
            `Yechimlarni ko'rish uchun VIP statusini sotib oling.`,
            Markup.inlineKeyboard([[Markup.button.callback("💎 VIP sotib olish", "buy_vip")]])
        );
    }

    // 2. Savolni olish
    const qData = s.activeList && s.activeList[s.index];
    if (!qData) return ctx.answerCbQuery("Xatolik: Savol topilmadi.");

    // 3. Tushuntirish borligini tekshirish
    if (qData.hint && qData.hint.trim() !== "") {
        await ctx.answerCbQuery("🔍 Tushuntirish qo'shildi");

        const progress = getProgressBar(s.index + 1, s.activeList.length);
        const safeQuestion = escapeHTML(qData.q);
        
        // Asosiy matnni yig'amiz
        let updatedText = `📊 Progress: [${progress}]\n` +
                          `🔢 Savol: <b>${s.index + 1} / ${s.activeList.length}</b>\n\n` +
                          `❓ <b>${safeQuestion}</b>\n\n` +
                          `━━━━━━━━━━━━━━\n` +
                          `💡 <b>TUSHUNTIRISH:</b>\n${escapeHTML(qData.hint)}\n` +
                          `━━━━━━━━━━━━━━\n\n`;

        // Agar test rejimida bo'lsa variantlarni ham qayta yozamiz
        if (!s.isTurbo) {
            const labels = ['A', 'B', 'C', 'D'];
            const options = s.currentOptions || [];
            options.forEach((opt, i) => {
                updatedText += `<b>${labels[i]})</b> ${escapeHTML(opt)}\n\n`;
            });
        } else {
            // Turbo rejimda to'g'ri javobni ko'rsatamiz
            updatedText += `✅ <b>TO'G'RI JAVOB:</b>\n<code>${escapeHTML(qData.a)}</code>\n`;
        }

        // Tugmalarni o'zgarishsiz qoldirish uchun xabardan olamiz
        const keyboard = ctx.callbackQuery.message.reply_markup;

        try {
            // Agar rasm bo'lsa editMessageCaption, matn bo'lsa editMessageText ishlatiladi
            if (ctx.callbackQuery.message.photo) {
                await ctx.editMessageCaption(updatedText, { parse_mode: 'HTML', reply_markup: keyboard });
            } else {
                await ctx.editMessageText(updatedText, { parse_mode: 'HTML', reply_markup: keyboard });
            }
        } catch (e) {
            // Agar foydalanuvchi tugmani 2 marta bossa va matn o'zgarmasa xato bermasligi uchun
            console.log("Xabarni tahrirlashda xatolik yoki matn o'zgarmagan.");
        }
    } else {
        return ctx.answerCbQuery("⚠️ Bu savolga tushuntirish hali qo'shilmagan.", { show_alert: true });
    }
});

// Tushuntirish xabarini o'chirish uchun (ixtiyoriy)
bot.action("close_explanation", (ctx) => ctx.deleteMessage());

bot.action("confirm_clear_rank", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Ruxsat yo'q!");
    
    const db = getDb();
    
    // Foydalanuvchilarning ballarini 0 qilish
    Object.keys(db.users).forEach(userId => {
        db.users[userId].score = 0;
    });

    // Agar alohida scores massivi bo'lsa uni bo'shatish
    if (db.scores) db.scores = [];

    saveDb(db);
    
    await ctx.editMessageText("✅ Reyting va barcha foydalanuvchilar ballari muvaffaqiyatli tozalandi.");
    return ctx.answerCbQuery();
});

// 3. Tasdiqlash va Bazani tozalash
bot.action("confirm_full_restart", async (ctx) => {
    // 1. Admin ekanligini tekshirish
    if (ctx.from.id !== ADMIN_ID) return ctx.answerCbQuery("Ruxsat yo'q!");
    
    try {
        // 2. Faylni tozalash (Volume /data/ ichidagi)
        const emptyDb = { 
            users: {}, 
            settings: { isMaintenance: false, turboMode: false } 
        };
        saveDb(emptyDb); 
        
        // 3. Admin xabarini yangilash
        await ctx.editMessageText("✅ Barcha foydalanuvchilar va reyting tozalandi!");

        // 4. 🔥 ENG MUHIMI: Foydalanuvchiga xabar yuborib, tugmalarni yopish
        // Bu buyruq foydalanuvchi ekranidagi "Orqaga" va boshqa hamma tugmalarni o'chirib tashlaydi
        await ctx.reply(
            "🔄 Tizim admin tomonidan yangilandi.\n\n" +
            "✨ Davom etish uchun ism va familiyangizni yozib yuboring:", 
            Markup.removeKeyboard() 
        );
        
    } catch (err) {
        console.error("Restart xatosi:", err);
        await ctx.reply("❌ Faylni tozalashda xatolik yuz berdi.");
    }
});

bot.action("cancel_restart", (ctx) => {
    ctx.deleteMessage();
    return ctx.reply("Amal bekor qilindi.");
});

bot.use(async (ctx, next) => {
    const db = getDb();
    const userId = ctx.from?.id;

    // Agar bot "Maintenance" holatida bo'lsa va yozayotgan odam Admin bo'lmasa
    if (db.settings?.isMaintenance && userId !== ADMIN_ID) {
        return ctx.reply("⚠️ Botda texnik ishlar olib borilmoqda. Tez orada qaytamiz!");
    }

    return next();
});


// 2. Inline tugmalar javobi


bot.hears('🗑 Botni Restart qilish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    return ctx.reply("⚠️ **DIQQAT!**\n\nSiz rostdan ham barcha foydalanuvchilar ma'lumotlarini o'chirib, botni restart qilmoqchimisiz? Bu amalni ortga qaytarib bo'lmaydi!", 
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Ha, tasdiqlash", "confirm_full_restart")],
            [Markup.button.callback("❌ Yo'q, rad etish", "cancel_restart")]
        ]));
});


bot.hears(["🚀 Turbo (Yoqish)", "🚀 Turbo (O'chirish)"], async (ctx) => {
  const db = getDb();
    if (ctx.from.id !== ADMIN_ID) return;
    if (!db.settings) db.settings = {};

    const isTurningOn = ctx.message.text.includes("Yoqish");
    db.settings.turboMode = isTurningOn;
    saveDb(db);

    const msg = isTurningOn ? "🚀 TURBO REJIM YOQILDI!" : "🚀 Turbo rejim o'chirildi.";
    
    // Xabar yuboramiz va avtomatik Admin panelni qayta chiqaramiz
    await ctx.reply(msg);
    
    // Bu yerda admin panel funksiyasini qayta chaqiramiz (o'zingizni kodingizdagi admin menyusi)
    const statusEmoji = db.settings?.isMaintenance ? "🟢 Botni Yoqish" : "🛑 Botni To'xtatish";
    const turboEmoji = db.settings?.turboMode ? "🚀 Turbo (O'chirish)" : "🚀 Turbo (Yoqish)";
    
    return ctx.reply(`🛠 **Admin Panel** qaytadan yuklandi`, 
        Markup.keyboard([
            ['💰 Pullik versiya', '🆓 Bepul versiya'],
            [statusEmoji, turboEmoji],
            ['🏆 Musobaqa boshqarish', '➕ Yangi fan qoshish'],
            ['⏱ Vaqtni o\'zgartirish', '📊 Statistika'],
            ['📣 Xabar tarqatish', '⬅️ Orqaga (Fanlar)']
        ]).resize());
});

// To'xtatish tugmasi bosilganda
// Botni to'xtatish (Mantiqiy qismi)
bot.hears(["🛑 Botni To'xtatish", "🟢 Botni Yoqish"], async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const db = getDb(); // Fayldan bazani oqish
    if (!db.settings) db.settings = {};

    const isStopping = ctx.message.text === "🛑 Botni To'xtatish";
    db.settings.isMaintenance = isStopping;
    
    saveDb(db); // Bazaga saqlash

    const text = isStopping ? "🔴 Bot hamma uchun to'xtatildi!" : "🟢 Bot qayta yoqildi!";
    const buttonText = isStopping ? "🟢 Botni Yoqish" : "🛑 Botni To'xtatish";

    return ctx.reply(text, Markup.keyboard([
        ['🏆 Musobaqa boshqarish', buttonText],
        ['➕ Yangi fan qoshish', '📊 Statistika'],
        ['⬅️ Orqaga (Fanlar)']
    ]).resize());
});

// Sozlamalar menyusini ko'rsatish
bot.hears("⚙️ Sozlamalar", (ctx) => {
    return ctx.reply("Sozlamalar bo'limi. Nimalarni o'zgartirmoqchisiz?", 
        Markup.keyboard([
            ["📝 Ismni o'zgartirish"],
            ["🎓 Yo'nalishni qayta tanlash"],
            ["⬅️ Orqaga (Fanlar)"]
        ]).resize());
});

// 1. Ismni o'zgartirishni boshlash
bot.hears("📝 Ismni o'zgartirish", (ctx) => {
    const db = getDb();
    db.users[ctx.from.id].step = 'edit_name'; // Maxsus step qo'yamiz
    saveDb(db);
    return ctx.reply("Yangi ismingizni kiriting:");
});

// 2. Yo'nalishni (va OTM, Kursni) qayta boshlash
bot.hears("🎓 Yo'nalishni qayta tanlash", (ctx) => {
    const db = getDb();
    const user = db.users[ctx.from.id];
    
    // Foydalanuvchini ro'yxatdan o'tmagan holatga qaytaramiz
    user.isRegistered = false; 
    user.step = 'wait_univ'; // Ism qoladi, universitetdan boshlaydi
    saveDb(db);

    return ctx.reply("OTMni qayta tanlang:", 
        Markup.keyboard([
            ["Alfraganus Universiteti", "Perfect Universiteti"],
            ["TATU", "TDPU"]
        ]).oneTime().resize());
});








bot.hears("👤 Profil", async (ctx) => {
    return showProfile(ctx);
});

// 1. Musobaqa boshqaruv menyusini ochish
bot.hears('🏆 Musobaqa boshqarish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    // Hozirgi holatni aniqlash
    const status = tournament.isActive ? "✅ YOQILGAN" : "❌ O'CHIRILGAN";
   
    return ctx.reply(`🏆 Musobaqa boshqaruv paneli\nHozirgi holat: ${status}`, 
        Markup.keyboard([
            ['🟢 Yoqish', '🔴 O\'chirish'],
            ['📢 Boshlash haqida xabar', '📊 Natijalar'],
            ['⬅️ Orqaga (Admin)']
        ]).resize());
        
});

// 2. Musobaqani yoqish mantiqi
bot.hears('🟢 Yoqish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    tournament.isActive = true;
    tournament.results = {}; // Yangi musobaqa uchun natijalarni nolga tushiramiz
    
    // Ma'lumotni faylga saqlash (Bot o'chib yonsa ham o'zgarmaydi)
    fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(tournament));
    
    return ctx.reply("✅ Musobaqa rejimi yoqildi! Foydalanuvchilar endi musobaqa testiga kira oladilar.");
});

// 3. Musobaqani o'chirish mantiqi
bot.hears('🔴 O\'chirish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    tournament.isActive = false;
    fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(tournament));
    
    return ctx.reply("🛑 Musobaqa rejimi o'chirildi. Foydalanuvchilar endi testga kira olmaydi.");
});



bot.hears('➕ Yangi fan qoshish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.waitingForSubjectName = true;
    return ctx.reply("Yangi fan nomini kiriting (Masalan: Fizika):", 
        Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

// Statistika tugmasini eshitish (Admin uchun)
bot.hears('📊 Statistika', async (ctx) => {
    const db = getDb();
    if (ctx.from.id !== ADMIN_ID) return;

    const usersEntries = Object.entries(db.users || {});
    const totalUsers = usersEntries.length;
    
    await ctx.replyWithHTML(`📊 <b>BOT STATISTIKASI</b>\n\n👥 Jami foydalanuvchilar: <b>${totalUsers} ta</b>`);

    let report = `🆔 <b>Foydalanuvchilar ro'yxati:</b>\n`;
    
    for (let i = 0; i < usersEntries.length; i++) {
        const [id, data] = usersEntries[i];
        let userLine = `${i + 1}. 👤 ${data.name || 'Ismsiz'} | ID: <code>${id}</code>\n`;
        
        // Agar bitta xabar limiti (4000 belgi) to'lib qolsa, uni yuboramiz va yangisini boshlaymiz
        if ((report + userLine).length > 4000) {
            await ctx.replyWithHTML(report);
            report = ""; // Yangi xabar uchun bo'shatamiz
        }
        report += userLine;
    }

    // Oxirgi qolgan xabarni yuboramiz
    const adminKeyboard = Markup.keyboard([
        ["🗑 Foydalanuvchini o'chirish"],
        ["⬅️ Orqaga"] // Bu orqaga tugmasi 'bot.hears' bilan tutib olinishi kerak
    ]).resize();

    return ctx.replyWithHTML(report, adminKeyboard);
});
// Musobaqa menyusidan Admin paneliga qaytish
// Ikkala turdagi "Orqaga" tugmasini ham taniydigan qilamiz
bot.hears(['⬅️ Orqaga (Admin)', '⬅️ Orqaga'], (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    
    return ctx.reply("Admin paneli:", Markup.keyboard([
        ['💰 Pullik versiya', '🆓 Bepul versiya'],
        ['🏆 Musobaqa boshqarish', '➕ Yangi fan qoshish'],
        ['⏱ Vaqtni o\'zgartirish', '📊 Statistika'],
        ['📣 Xabar tarqatish', '⬅️ Orqaga (Fanlar)']
    ]).resize());
});

// 1. Admin xabar yuborish tugmasini bosganda
bot.hears('📣 Xabar tarqatish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.waitingForForward = true; // Xabar kutish holatiga o'tamiz
    return ctx.reply("Yubormoqchi bo'lgan xabaringizni (matn, rasm, video) yuboring yoki forward qiling:", 
        Markup.keyboard([['🚫 Bekor qilish']]).resize());
});

// 1. Pullik versiyani yoqish
bot.hears('💰 Pullik versiya', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    isBotPaidMode = true; // Botni pullik rejimga o'tkazamiz
    return ctx.reply("✅ Bot PULLIK REJIMGA o'tkazildi. Endi faqat VIP foydalanuvchilar test topshira oladi.");
});

// 2. Bepul versiyani yoqish
bot.hears('🆓 Bepul versiya', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    isBotPaidMode = false; // Botni bepul rejimga o'tkazamiz
    return ctx.reply("✅ Bot BEPUL REJIMGA o'tkazildi. Hamma test topshirishi mumkin.");
});

// 1. Tugma bosilganda
bot.hears("🗑 Foydalanuvchini o'chirish", (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.adminStep = 'wait_delete_id';
    return ctx.reply("🗑 O'chirmoqchi bo'lgan foydalanuvchining ID raqamini kiriting:");
});


// 1. Tugma bosilganda so'rash
bot.hears("🧹 Reytingni tozalash", (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    return ctx.reply("⚠️ Siz rostdan ham barcha foydalanuvchilar ballarini va reytingni butunlay tozalamoqchimisiz?", 
        Markup.inlineKeyboard([
            [Markup.button.callback("✅ Ha, tozalash", "confirm_clear_rank")],
            [Markup.button.callback("❌ Yo'q, bekor qilish", "cancel_clear")]
        ]));
});

bot.action("cancel_clear", (ctx) => ctx.deleteMessage());

// 2. ID raqami yozilganda ishlaydigan logika
bot.on('text', async (ctx, next) => {
    const s = ctx.session;
    const db = getDb(); // Railway Volume (/data/ranking_db.json) dan o'qiydi
    const userId = ctx.from.id;
    const user = db.users[userId];
    const text = ctx.message.text.trim();

    // 🛡 0. KOMANDA FILTRI
    if (text.startsWith('/')) return next();

    // ==========================================
    // 🛡 1. ADMIN QISMI (Xabar yuborish)
    // ==========================================
    if (ctx.from.id === ADMIN_ID) {
        if (s.adminStep === 'wait_broadcast_text') {
            const users = Object.keys(db.users);
            let count = 0;
            for (const id of users) {
                try { await ctx.telegram.sendMessage(id, text); count++; } catch (e) {}
            }
            s.adminStep = null;
            return ctx.reply(`✅ Xabar ${count} ta foydalanuvchiga yuborildi!`);
        }
    }

    // ==========================================
    // 📝 2. RO'YXATDAN O'TISH (HIMOYA VA RESTARTDAN KEYINGI HOLAT)
    // ==========================================
    
    // Foydalanuvchi bazada yo'q bo'lsa (Restartdan keyin) yoki ro'yxatdan o'tmagan bo'lsa
    if (!user || !user.isRegistered) {
        
        // Yangi user yaratish (Restart bo'lgan bo'lsa ham shu yerga tushadi)
        if (!user) {
            db.users[userId] = { 
                id: userId, 
                step: 'wait_name', 
                isRegistered: false,
                score: 0 // Ballarni nolga tushiramiz
            };
            saveDb(db);
        }
        
        const currentUser = db.users[userId];

        // --- ISM KIRITISH BOSQICHI ---
        if (currentUser.step === 'wait_name') {
    // 🛡 Barcha turdagi menyu tugmalari (Admin + Foydalanuvchi)
    const forbidden = [
        "📝 Akademik yozuv", "📜 Tarix", "➕ Matematika", 
        "💻 Dasturlash 1", "🧲 Fizika", "🇬🇧 Perfect English", 
        "📊 Reyting", "👤 Profil", "⚙️ Sozlamalar",
        "⬅️ Orqaga (Fanlar)", "📊 Statistika", "🗑 Botni Restart qilish",
        "💰 Pullik versiya", "🆓 Bepul versiya", "🧹 Reytingni tozalash"
    ];
    
    // 1. ISMNI TEKSHIRISH: Taqiqilangan tugma yoki juda qisqa matn
    if (forbidden.includes(text) || text.length < 3) {
        return ctx.reply(
            "❌ Xato! Iltimos, menyu tugmalaridan foydalanmang.\n\n" +
            "👤 Ism va familiyangizni matn ko'rinishida yozib yuboring (kamida 3 ta harf):", 
            Markup.removeKeyboard() // Ekrandagi tugmalarni majburan yopamiz
        );
    }

    // 2. To'g'ri bo'lsa, saqlaymiz
    currentUser.name = text;
    currentUser.step = 'wait_univ';
    saveDb(db);

    return ctx.reply(
        `✅ Rahmat, ${text}!\n\nEndi o'qish joyingizni tanlang:`, 
        Markup.keyboard([
            ["Alfraganus Universiteti", "Perfect Universiteti"], 
            ["TATU", "TDPU"]
        ]).oneTime().resize()
    );
}

        // Universitet saqlash
        if (currentUser.step === 'wait_univ') {
            const univs = ["Alfraganus Universiteti", "Perfect Universiteti", "TATU", "TDPU"];
            if (!univs.includes(text)) return ctx.reply("⚠️ Universitetni tugma orqali tanlang:");
            currentUser.univ = text;
            currentUser.step = 'wait_kurs';
            saveDb(db);
            return ctx.reply("Nechanchi kursda o'qiysiz?", 
                Markup.keyboard([["1-kurs", "2-kurs"], ["3-kurs", "4-kurs"]]).oneTime().resize());
        }

        // Kurs saqlash
        if (currentUser.step === 'wait_kurs') {
            const kurslar = ["1-kurs", "2-kurs", "3-kurs", "4-kurs"];
            if (!kurslar.includes(text)) return ctx.reply("⚠️ Kursni tugma orqali tanlang:");
            currentUser.kurs = text;
            currentUser.step = 'wait_yonalish';
            saveDb(db);
            let buttons = text === "1-kurs" ? [["Dasturiy Injiniring", "Kiberxavfsizlik"], ["Sun'iy intelekt"]] : [["Magistratura", "Boshqa"]];
            return ctx.reply(`Yo'nalishingizni tanlang:`, Markup.keyboard(buttons).oneTime().resize());
        }

        // Yo'nalish saqlash
        if (currentUser.step === 'wait_yonalish') {
            currentUser.yonalish = text;
            currentUser.step = 'wait_semester';
            saveDb(db);
            return ctx.reply("Endi o'qiyotgan semestringizni tanlang:", Markup.keyboard([["1-semestr", "2-semestr"]]).oneTime().resize());
        }

        // Semestr saqlash va YAKUNLASH
        if (currentUser.step === 'wait_semester') {
            if (text === "2-semestr") {
                return ctx.reply("❌ Hozircha faqat 1-semestr testlari mavjud. Iltimos, 1-semestrni tanlang.");
            }
            if (text === "1-semestr") {
                currentUser.semester = text;
                currentUser.isRegistered = true;
                currentUser.step = 'completed';
                saveDb(db);
                await ctx.reply(`✅ Ma'lumotlar saqlandi! Xush kelibsiz.`);
                return showSubjectMenu(ctx);
            }
            return ctx.reply("⚠️ Iltimos, semestrni tugma orqali tanlang:");
        }
        
        // Ism kiritilmaguncha hamma narsani shu yerda to'xtatamiz
        return ctx.reply("⚠️ Davom etish uchun avval ismingizni kiriting!");
    }

    // ==========================================
    // ⚙️ 3. SOZLAMALAR: TAHRIRLASH MANTIQI
    // ==========================================
    if (user.step === 'edit_name') {
        if (text.length < 3) return ctx.reply("❌ Ism juda qisqa. Qaytadan kiriting:");
        user.name = text;
        user.step = 'completed';
        saveDb(db);
        await ctx.reply(`✅ Ismingiz muvaffaqiyatli o'zgartirildi: ${text}`);
        return showSubjectMenu(ctx);
    }

    return next();
});

bot.on(['text', 'photo', 'video', 'animation', 'document'], async (ctx, next) => {
    // Agar matn bo'lsa matnni, rasm ostida yozilgan bo'lsa captionni oladi
    const text = ctx.message.text || ctx.message.caption; 
    const userId = ctx.from.id;
    const username = ctx.from.username || "Lichka yopiq";

    // Komandalar bo'lsa o'tkazib yuboramiz
    if (text && text.startsWith('/')) return next();

    // 1. HAR QANDAY HOLATDA BEKOR QILISH (ENG TEPADA TURISHI SHART)
    if (text === '🚫 Bekor qilish') {
        ctx.session.waitingForForward = false;
        ctx.session.waitingForTime = false;
        ctx.session.waitingForSubjectName = false;
        ctx.session.waitingForSubjectQuestions = false;
        ctx.session.waitingForName = false;
        return showSubjectMenu(ctx);
    }

    
    if (ctx.session.waitingForReceipt && ctx.message.photo) {
        ctx.session.waitingForReceipt = false;
        const userId = ctx.from.id;
        
        await ctx.telegram.sendPhoto(ADMIN_ID, ctx.message.photo[0].file_id, {
            caption: `🔔 <b>Yangi to'lov!</b>\n👤 Foydalanuvchi: ${ctx.from.first_name}\n🆔 ID: <code>${userId}</code>`,
            parse_mode: 'HTML',
            ...Markup.inlineKeyboard([
                [Markup.button.callback("✅ Tasdiqlash", `approve_${userId}`)],
                [Markup.button.callback("❌ Rad etish", `reject_${userId}`)]
            ])
        });
        return ctx.reply("✅ Chekingiz adminga yuborildi. Tasdiqlangach sizga xabar boradi.");
    }

    // 2. ADMIN: Xabar tarqatish (Media va Matn uchun)
    if (userId === ADMIN_ID && ctx.session.waitingForForward) {
        ctx.session.waitingForForward = false;
        const db = getDb();
        const users = Object.keys(db.users || {});
        let successCount = 0;

        await ctx.reply(`📣 Xabar ${users.length} kishiga yuborilmoqda...`);

        for (const uId of users) {
            try {
                // copyMessage — har qanday formatni (rasm, video, text) aslidek yuboradi
                await ctx.telegram.copyMessage(uId, ctx.chat.id, ctx.message.message_id);
                successCount++;
                if (successCount % 25 === 0) await new Promise(r => setTimeout(r, 500)); 
            } catch (e) {
                console.log(`Bloklangan foydalanuvchi: ${uId}`);
            }
        }
        await ctx.reply(`✅ Xabar yakunlandi!\n\nJami: ${users.length}\nYuborildi: ${successCount}`);
        return showSubjectMenu(ctx);
    }

    // 3. ADMIN: Vaqtni o'zgartirish
    if (userId === ADMIN_ID && ctx.session.waitingForTime) {
        const newTime = parseInt(text);
        if (isNaN(newTime) || newTime < 5) return ctx.reply("❌ Xato raqam! Kamida 5 kiriting:");
        botSettings.timeLimit = newTime;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(botSettings));
        ctx.session.waitingForTime = false;
        await ctx.reply(`✅ Savol vaqti ${newTime} soniyaga yangilandi.`);
        return showSubjectMenu(ctx);
    }

    // 4. ADMIN: Yangi fan qo'shish (Ismi)
    if (userId === ADMIN_ID && ctx.session.waitingForSubjectName) {
        ctx.session.newSubName = text;
        ctx.session.waitingForSubjectName = false;
        ctx.session.waitingForSubjectQuestions = true;
        return ctx.reply(`"${text}" fani uchun savollarni JSON formatida yuboring:`, 
            Markup.keyboard([['🚫 Bekor qilish']]).resize());
    }

    // 5. ADMIN: Fan savollari (JSON)
    if (userId === ADMIN_ID && ctx.session.waitingForSubjectQuestions) {
        try {
            const qs = JSON.parse(text);
            const key = ctx.session.newSubName.toLowerCase().replace(/ /g, '_');
            SUBJECTS[key] = { title: ctx.session.newSubName, questions: qs };
            ctx.session.waitingForSubjectQuestions = false;
            await ctx.reply("✅ Yangi fan muvaffaqiyatli qo'shildi!");
            return showSubjectMenu(ctx);
        } catch (e) {
            return ctx.reply("❌ JSON xatosi! Formatni tekshirib qaytadan yuboring:");
        }
    }

    
    // 6. FOYDALANUVCHI: Ism kiritish (TO'G'IRLANGAN VARIANT)
    if (ctx.session.waitingForName) {
        const input = text.trim();

        // Ism o'rniga menyu tugmalarini bosishdan himoya
        const menuButtons = [
            "📝 Akademik yozuv", "📜 Tarix", "➕ Matematika", 
            "💻 Dasturlash 1", "🧲 Fizika", "🇬🇧 English",
            "📊 Reyting", "👤 Profil", "🚀 TURBO YODLASH (16:30)"
        ];

        if (menuButtons.includes(input)) {
            return ctx.reply("⚠️ Iltimoss, ism o'rniga fan tugmalarini bosmang!\nAvval ismingizni yozib yuboring:");
        }

        if (!input || input.length < 3) {
            return ctx.reply("❌ Ism juda qisqa! Kamida 3 ta harfdan iborat ism yozing:");
        }

        ctx.session.userName = input;
        ctx.session.waitingForName = false;
        
        let db = getDb();
        if(!db.users) db.users = {};

        // Foydalanuvchi ma'lumotlarini yangilaymiz (eski ma'lumotlarni ochirmasdan)
        db.users[userId] = { 
            ...db.users[userId], // Eskidan bor ma'lumotlar (score, isVip va h.k.)
            name: input, 
            username: username !== "Lichka yopiq" ? `@${username}` : username,
            date: new Date().toISOString() 
        };

        saveDb(db); // Bazaga saqlaymiz
        await ctx.reply(`✅ Rahmat, ${input}! Ismingiz muvaffaqiyatli saqlandi.`);
        return showSubjectMenu(ctx);
    }

    return next();
});


// bot.on('text', async (ctx, next) => {
//     const s = ctx.session;
//     const db = getDb();
//     const userId = ctx.from.id;
//     const user = db.users[userId];

//     // 1. AGAR BOT ISM KUTAYOTGAN BO'LSA VA FOYDALANUVCHI ISM YOZSA
//     if (s.waitingForName) {
//         const inputName = ctx.message.text.trim();
        
//         if (inputName.length < 3) {
//             return ctx.reply("Ism juda qisqa. Iltimos, ismingizni kiriting:");
//         }

//         // Bazada foydalanuvchi bormi?
//         if (db.users[userId]) {
//             db.users[userId].name = inputName; // Faqat ismni yangilaymiz
//         } else {
//             db.users[userId] = { 
//                 id: userId, 
//                 name: inputName, 
//                 score: 0, 
//                 isVip: false 
//             };
//         }

//         saveDb(db); // Faylga saqlaymiz
//         s.waitingForName = false; // Ism kutishni to'xtatamiz
//         s.userName = inputName;

//         await ctx.reply(`Rahmat, ${inputName}! Endi testlarni yechishingiz mumkin. ✅`);
//         return showSubjectMenu(ctx);
//     }

//     // 2. MUHIM QISMI: AGAR FOYDALANUVCHI ISMI BAZADA BO'LSA, UNGA TUGMALARNI ISHLATISHGA RUXSAT BERISH
//     if (user && user.name) {
//         s.waitingForName = false; // Xavfsizlik uchun sessiyani ham to'g'irlab qo'yamiz
//         return next(); // Keyingi tugma buyruqlariga o'tkazib yuboramiz
//     }

//     // 3. AGAR ISMI YO'Q BO'LSA, FAQAT SHUNDA ISM SO'RAYMIZ
//     s.waitingForName = true;
//     return ctx.reply("Davom etish uchun avval ismingizni kiriting:");
// });






// 2. Kelgan xabarni hamma foydalanuvchilarga tarqatish

bot.hears('⏱ Vaqtni o\'zgartirish', (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;
    ctx.session.waitingForTime = true;
    return ctx.reply("Vaqtni soniyalarda kiriting:", Markup.keyboard([['🚫 Bekor qilish']]).resize());
});


// --- TEST BOSHLASH ---
bot.hears(["📝 Akademik yozuv", "📜 Tarix", "➕ Matematika", "💻 Dasturlash 1", "🧲 Fizika", "🇬🇧 Perfect English"], async (ctx) => {
    const text = ctx.message.text;
    const s = ctx.session;
    const db = getDb();
    const user = db.users[ctx.from.id];

    // 1. Ro'yxatdan o'tganini tekshirish
    if (!user || !user.isRegistered) {
        return ctx.reply("⚠️ Iltimos, avval ro'yxatdan o'ting.");
    }

    // 2. Yo'nalish kalitini yasash (Dasturiy Injiniring -> dasturiy_injiniring)
let yonalishKey = user.yonalish
        .toLowerCase()
        .trim()
        .replace(/'/g, '')  // "Sun'iy" -> "suniy" bo'ladi
        .replace(/ /g, '_');


    // 3. Fan qismini aniqlash
    let subjectPart = "";
    if (text.includes("Akademik")) subjectPart = "academic";
    else if (text.includes("Tarix")) subjectPart = "history";
    else if (text.includes("Matematika")) subjectPart = "math";
    else if (text.includes("Dasturlash")) subjectPart = "dasturlash";
    else if (text.includes("Fizika")) subjectPart = "physics";
    else if (text.includes("English")) subjectPart = "english";

    // 4. Yakuniy kalit (Masalan: dasturiy_injiniring_math)
    const finalKey = `${yonalishKey}_${subjectPart}`;

    // 5. SUBJECTS obyektida shu fan borligini tekshiramiz
    // (Bu SUBJECTS yuqorida JSON dan yuklangan bo'lishi kerak)
    if (SUBJECTS[finalKey] && SUBJECTS[finalKey].questions) {
        s.currentSubject = finalKey; // Sessiyaga saqlaymiz
        
        // Agar Turbo rejim yoqilgan bo'lsa
        if (s.isTurbo) {
            const questions = SUBJECTS[finalKey].questions;
            if (questions.length === 0) return ctx.reply("Bu fanda savollar yo'q.");
            
            s.activeList = shuffle([...questions]); 
            s.index = 0;
            s.score = 0;
            s.wrongs = [];
            return sendQuestion(ctx, true);
        }

        // Blitz yoki To'liq test tanlash menyusi
        return ctx.reply(`Tayyormisiz? (${text})`, Markup.keyboard([
            ["⚡️ Blitz (25)", "📝 To'liq test"], 
            ["⬅️ Orqaga (Fanlar)"]
        ]).resize());
    } else {
        // Agar JSON faylda bu kalit topilmasa
        console.log("Xato: Kalit topilmadi ->", finalKey);
        return ctx.reply(`⚠️ Kechirasiz, ${user.yonalish} uchun "${text}" fani savollari hali yuklanmagan.`);
    }
});

bot.hears(["⚡️ Blitz (25)", "📝 To'liq test"], async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;

    // 🚀 MUHIM: Oddiy test boshlanganda Turbo rejimni o'chiramiz
    s.isTurbo = false;

    // 1. PULLIK REJIM TEKSHIRUVI
    if (isBotPaidMode && !vipUsers.includes(userId) && userId !== ADMIN_ID) {
        return ctx.reply(
            "⚠️ Kechirasiz, bot hozirda pullik rejimda.\nTest topshirish uchun VIP statusini sotib olishingiz kerak.", 
            Markup.inlineKeyboard([
                [Markup.button.callback("💎 VIP sotib olish", "buy_vip")]
            ])
        );
    }

    // 2. FAN VA SAVOLLAR TEKSHIRUVI
    if (!s.currentSubject || !SUBJECTS[s.currentSubject]) return showSubjectMenu(ctx);
    
    const questions = SUBJECTS[s.currentSubject].questions;
    if (!questions || questions.length === 0) return ctx.reply("Bu fanda savollar yo'q.");
    
    // 3. TESTNI BOSHLASH
    s.activeList = ctx.message.text.includes("25") ? shuffle(questions).slice(0, 25) : shuffle(questions);
    s.index = 0; 
    s.score = 0; 
    s.wrongs = [];
    
    // Savol berishni boshlash (isTurbo false bo'lgani uchun oddiy variantlar chiqadi)
    sendQuestion(ctx, true);
});
bot.hears("📊 Reyting", async (ctx) => {
    const db = getDb(); // Fayldan yangi ma'lumotlarni o'qish
    const users = Object.values(db.users);

    // Ballar bo'yicha saralash va 0 balli odamlarni chiqarmaslik (ixtiyoriy)
    const sortedUsers = users
        .filter(u => u.score > 0) 
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    if (sortedUsers.length === 0) {
        return ctx.reply("Hozircha reyting bo'sh. Birinchi bo'lib test yeching!");
    }

    let report = "🏆 <b>TOP 10 REYTING</b>\n\n";
    sortedUsers.forEach((user, index) => {
        report += `${index + 1}. ${user.name} — <b>${user.score}</b> ball\n`;
    });

    return ctx.replyWithHTML(report);
});
bot.hears("⬅️ Orqaga (Fanlar)", (ctx) => showSubjectMenu(ctx));

bot.start(async (ctx) => {
    const db = getDb();
    const userId = ctx.from.id;
    const user = db.users[userId];

    // 1. Agar foydalanuvchi allaqachon ro'yxatdan o'tgan bo'lsa
    if (user && user.isRegistered) {
        await ctx.reply(`Xush kelibsiz, ${user.name}! 😊`);
        return showSubjectMenu(ctx); 
    }

    // 2. Agar foydalanuvchi ism kiritib bo'lgan bo'lsa (Lekin hali to'liq tugatmagan)
    if (user && user.step !== 'wait_name') {
        // Ism yozib bo'lingan, shunchaki keyingi qadamni eslatamiz
        return ctx.reply(`Siz ism kiritib bo'lgansiz: ${user.name} ✅\n\nIltimos, ro'yxatdan o'tishni davom ettiring (OTM, Kurs yoki Yo'nalishni tanlang).`);
    }

    // 3. Agar mutlaqo yangi bo'lsa yoki ism kiritmagan bo'lsa
    if (!user) {
        db.users[userId] = {
            id: userId,
            username: ctx.from.username || "Noma'lum",
            name: "",
            univ: "",
            kurs: "",
            yonalish: "",
            score: 0, 
            totalTests: 0,
            step: 'wait_name',
            isRegistered: false
        };
        saveDb(db);
    }

    return ctx.replyWithHTML(
        `✨ <b>Assalomu alaykum! Botga xush kelibsiz.</b>\n\n` +
        `Ro'yxatdan o'tish uchun ismingiz va familiyangizni kiriting:`,
        Markup.removeKeyboard()
    );
});
// --- CALLBACKLAR ---
bot.action(/^ans_(\d+)$/, async (ctx) => {
    const s = ctx.session;
    const userId = ctx.from.id;

    if (!s || !s.activeList || s.index === undefined || !s.activeList[s.index]) {
        if (timers[userId]) clearTimeout(timers[userId]);
        await ctx.answerCbQuery("⚠️ Sessiya muddati tugagan.").catch(() => {});
        return ctx.reply("⚠️ Sessiya muddati tugagan. Iltimos, /start bosing.");
    }

    if (timers[userId]) clearTimeout(timers[userId]);

    const selIdx = parseInt(ctx.match[1]);
    const currentQ = s.activeList[s.index];
    const labels = ['A', 'B', 'C', 'D']; 

    try {
        const userAnswer = s.currentOptions[selIdx]; // User tanlagan variant matni

        if (userAnswer === currentQ.a) {
            s.score++;
            await ctx.answerCbQuery("✅ To'g'ri!");
        } else {
            // ❌ Xatolar massiviga user tanlagan javobni ham qo'shib saqlaymiz
            s.wrongs.push({
                ...currentQ,
                userAnswer: userAnswer // Tahlil uchun kerak
            });
            
            const correctIdx = s.currentOptions.indexOf(currentQ.a);
            const correctLetter = labels[correctIdx] || "";

            await ctx.answerCbQuery(`❌ Noto'g'ri!\nTo'g'ri javob: ${correctLetter}) ${currentQ.a}`, { show_alert: true });
        }

        s.index++;
        
        // Keyingi savolga yoki natijaga o'tish
        return sendQuestion(ctx, false);

    } catch (error) {
        console.error("Action error:", error);
        await ctx.answerCbQuery("Xatolik yuz berdi.").catch(() => {});
        return ctx.reply("⚠️ Xatolik yuz berdi. Qaytadan /start bosing.");
    }
});

bot.action('stop_test', (ctx) => {
    if (timers[ctx.from.id]) clearTimeout(timers[ctx.from.id]);
    ctx.session.index = 999;
    showSubjectMenu(ctx);
});

bot.action('buy_vip', (ctx) => {
    ctx.session.waitingForReceipt = true; // Bot chek kutish rejimiga o'tadi
    return ctx.replyWithHTML(
        `💎 <b>VIP STATUS SOTIB OLISH</b>\n\n` +
        `💳 Kart"a": <code>4073420058363577</code>\n` +
        `👤 Egasi: M.M\n` +
        `💰 Summ"a": 6,000 so'm\n\n` +
        `📸 To'lovni amalga oshirgach, <b>chekni (rasm ko'rinishida)</b> shu yerga yuboring.`
    );
});



// Admin "Tasdiqlash" tugmasini bosganda
bot.action(/^approve_(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]);
    const db = getDb(); // Asosiy bazani olamiz

    // 1. Asosiy bazada (db.json) VIP statusini yoqamiz
    if (db.users[targetId]) {
        db.users[targetId].isVip = true;
        saveDb(db); // Bazani faylga saqlaymiz
    }

    // 2. VIP ro'yxatiga (alohida fayl bo'lsa) qo'shish
    if (typeof vipUsers !== 'undefined' && !vipUsers.includes(targetId)) {
        vipUsers.push(targetId);
        fs.writeFileSync(VIP_FILE, JSON.stringify(vipUsers));
    }
    
    // 3. MUSOBAQA ro'yxatiga qo'shish
    if (typeof tournament !== 'undefined' && !tournament.participants.includes(targetId)) {
        tournament.participants.push(targetId);
        fs.writeFileSync(TOURNAMENT_FILE, JSON.stringify(tournament));
    }
    
    // 4. Foydalanuvchiga bildirishnoma yuborish
    try {
        await ctx.telegram.sendMessage(targetId, 
            "🎉 <b>Xushxabar!</b>\n\nTo'lovingiz tasdiqlandi! Endi barcha testlarning 💡 <b>tushuntirishlarini</b> ko'rishingiz va 🏆 <b>Musobaqada</b> qatnashishingiz mumkin.", 
            { parse_mode: 'HTML' }
        );
    } catch (e) {
        console.log("Foydalanuvchiga xabar yuborishda xatolik.");
    }

    // 5. Admin xabarini yangilash
    return ctx.editMessageCaption("✅ <b>Tasdiqlandi:</b> Foydalanuvchi VIP bo'ldi va Musobaqaga qo'shildi.", { parse_mode: 'HTML' });
});
// Admin "Rad etish" tugmasini bosganda
bot.action(/^reject_(\d+)$/, async (ctx) => {
    const targetId = parseInt(ctx.match[1]);
    await ctx.telegram.sendMessage(targetId, "❌ Kechirasiz, siz yuborgan chek tasdiqlanmadi. Muammo bo'lsa adminga yozing.");
    return ctx.editMessageCaption("❌ To'lov rad etildi.");
});

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running...');
}).listen(PORT, '0.0.0.0', () => {
    console.log(`Server is listening on port ${PORT}`);
});

bot.catch((err, ctx) => {
    const errorCode = err.response?.error_code;
    const description = err.response?.description;

    // Agar foydalanuvchi botni bloklagan bo'lsa, logda ko'rsatib, o'tkazib yuboramiz
    if (errorCode === 403) {
        console.log(`🚫 Foydalanuvchi (${ctx.from?.id}) botni bloklagan. Xabar yuborilmadi.`);
        return; 
    }

    console.error(`🔴 Kutilmagan xatolik:`, err);
});

bot.launch()
    .then(() => console.log("✅ Bot successfully started in Telegram!"))
    .catch((err) => console.error("❌ Bot launch error:", err));

    // Botni to'g'ri to'xtatish uchun (Graceful stop)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, function(m) {
        return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m];
    });
}

