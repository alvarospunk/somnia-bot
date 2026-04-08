import TelegramBot from 'node-telegram-bot-api';
import Groq from 'groq-sdk';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const DATA_DIR       = process.env.DATA_DIR || './data';
const DATA_FILE      = join(DATA_DIR, 'dreams.json');
// Timezone offset in hours (Spain: UTC+2 summer / UTC+1 winter)
const TZ_OFFSET      = parseInt(process.env.TZ_OFFSET ?? '2');
const MORNING_HOUR   = 7; // local hour to ask the morning question
const COLLECT_HOURS  = 2; // how long to collect replies after the morning question

if (!TELEGRAM_TOKEN || !GROQ_API_KEY) {
  console.error('❌ Faltan variables de entorno: TELEGRAM_BOT_TOKEN y/o GROQ_API_KEY');
  process.exit(1);
}

const bot  = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });

// ── DB ────────────────────────────────────────────────────────────────────────
// Structure:
// {
//   activeChats: { "chatId": { lastMorningQuestion: "YYYY-MM-DD", collectingUntil: ms } }
//   users:       { "userId": { name, username, bio, dreams: [{ date, text, tags, interpretation }] } }
// }
let db = { activeChats: {}, users: {} };

async function loadDb() {
  try {
    if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
    if (existsSync(DATA_FILE)) {
      db = JSON.parse(await readFile(DATA_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('Error loading db:', e.message);
  }
}

async function saveDb() {
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2));
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function localNow() {
  const now = new Date();
  // Shift by TZ_OFFSET to get local time
  return new Date(now.getTime() + TZ_OFFSET * 3600 * 1000);
}

function today() {
  return localNow().toISOString().slice(0, 10);
}

function localHour() {
  return localNow().getUTCHours();
}

// ── User helpers ──────────────────────────────────────────────────────────────
function getUser(userId, name, username) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = { userId, name: name || 'Desconocido', username: username || '', bio: '', dreams: [] };
  } else {
    if (name)     db.users[key].name     = name;
    if (username) db.users[key].username = username;
  }
  return db.users[key];
}

// ── Morning question ──────────────────────────────────────────────────────────
function isCollecting(chatId) {
  const chat = db.activeChats[String(chatId)];
  return chat && chat.collectingUntil && Date.now() < chat.collectingUntil;
}

async function sendMorningQuestion(chatId) {
  const key = String(chatId);
  db.activeChats[key].lastMorningQuestion = today();
  db.activeChats[key].collectingUntil     = Date.now() + COLLECT_HOURS * 3600 * 1000;
  await saveDb();

  await bot.sendMessage(chatId,
    '🌙 *¡Buenos días!* ☀️\n\n' +
    '¿Qué tal dormisteis? ¿Qué habéis soñado esta noche?\n\n' +
    '_Contadme vuestros sueños y os los interpreta Somnia_ 🔮\n' +
    `_(Tenéis ${COLLECT_HOURS}h para contarme. También podéis usar /soñe en cualquier momento)_`,
    { parse_mode: 'Markdown' }
  );
}

async function checkMorningTrigger() {
  const t    = today();
  const hour = localHour();

  for (const [chatId, chat] of Object.entries(db.activeChats)) {
    if (chat.lastMorningQuestion === t) continue; // already asked today
    if (hour < MORNING_HOUR) continue;            // too early
    await sendMorningQuestion(chatId);
  }
}

// ── Groq interpretation ───────────────────────────────────────────────────────
async function interpretDream(user, dreamText) {
  const recentDreams = (user.dreams || []).slice(-10).map(d =>
    `- [${d.date}] "${d.text}" (temas: ${(d.tags || []).join(', ') || 'sin clasificar'})`
  ).join('\n');

  const userContext = [
    `Nombre: ${user.name}`,
    user.bio            ? `Contexto personal: ${user.bio}` : '',
    recentDreams        ? `Historial de sueños recientes:\n${recentDreams}` : '',
  ].filter(Boolean).join('\n');

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      {
        role: 'system',
        content:
          'Eres Somnia, intérprete experta en sueños. Combinas psicología jungiana, ' +
          'simbolismo onírico y análisis narrativo. Interpretas de forma profunda y personalizada, ' +
          'teniendo en cuenta la personalidad y el historial de la persona. ' +
          'Si detectas patrones recurrentes, los mencionas. ' +
          'Responde siempre en español, tono cálido pero analítico. Máximo 220 palabras.\n\n' +
          'Formato obligatorio (sin cambiar las etiquetas):\n' +
          '[Tu interpretación aquí]\n\n' +
          '🏷️ Etiquetas: tag1, tag2, tag3',
      },
      {
        role: 'user',
        content: `Contexto de la persona:\n${userContext}\n\nSueño de hoy:\n"${dreamText}"`,
      },
    ],
    max_tokens: 450,
    temperature: 0.75,
  });

  const content = completion.choices[0]?.message?.content || 'No pude interpretar el sueño.';

  // Extract tags
  const tagsLine = content.match(/🏷️\s*Etiquetas?:?\s*([^\n]+)/i);
  const tags     = tagsLine
    ? tagsLine[1].split(/[,，]/).map(t => t.trim().replace(/[*_`]/g, '')).filter(Boolean)
    : [];

  return { interpretation: content, tags };
}

// ── Process a dream ───────────────────────────────────────────────────────────
async function processDream(msg, dreamText) {
  const chatId = msg.chat.id;
  const from   = msg.from;
  const user   = getUser(from.id, from.first_name, from.username);

  const thinkingMsg = await bot.sendMessage(chatId,
    `🔮 Interpretando el sueño de *${user.name}*…`,
    { parse_mode: 'Markdown' }
  );

  try {
    const { interpretation, tags } = await interpretDream(user, dreamText);

    user.dreams.push({ date: today(), text: dreamText, tags, interpretation });
    await saveDb();

    await bot.editMessageText(
      `🌙 *Sueño de ${user.name}*\n\n${interpretation}`,
      { chat_id: chatId, message_id: thinkingMsg.message_id, parse_mode: 'Markdown' }
    );
  } catch (err) {
    console.error('Error interpretando:', err.message);
    const errTxt = err.message?.toLowerCase().includes('rate') || err.status === 429
      ? '⏳ Límite de peticiones alcanzado. Inténtalo en un minuto.'
      : `❌ Error al interpretar. \`${err.message?.slice(0, 120)}\``;
    await bot.editMessageText(errTxt,
      { chat_id: chatId, message_id: thinkingMsg.message_id, parse_mode: 'Markdown' }
    ).catch(() => {});
  }
}

// ── /start ────────────────────────────────────────────────────────────────────
bot.onText(/\/start/, async (msg) => {
  const key = String(msg.chat.id);
  if (!db.activeChats[key]) {
    db.activeChats[key] = { lastMorningQuestion: null, collectingUntil: 0 };
    await saveDb();
  }
  bot.sendMessage(msg.chat.id,
    '🌙 *Somnia — Intérprete de sueños*\n\n' +
    'Cada mañana a las 7:00 os preguntaré qué habéis soñado y lo interpretaré.\n\n' +
    '• `/soñe <descripción>` — cuenta un sueño en cualquier momento\n' +
    '• `/misuenos` — ver tus últimos sueños\n' +
    '• `/sobre_mi <info>` — añade contexto sobre ti para mejor interpretación\n' +
    '• `/perfil` — ver tu perfil y temas recurrentes\n' +
    '• `/stats` — estadísticas del grupo',
    { parse_mode: 'Markdown' }
  );
});

// ── /soñe ─────────────────────────────────────────────────────────────────────
bot.onText(/\/son[eé](?:@\w+)?\s+(.+)/si, async (msg, match) => {
  await processDream(msg, match[1].trim());
});

bot.onText(/^\/son[eé](?:@\w+)?$/i, (msg) => {
  bot.sendMessage(msg.chat.id,
    '✏️ Cuéntame el sueño después del comando:\n`/soñe estaba volando sobre una ciudad…`',
    { parse_mode: 'Markdown' }
  );
});

// ── /sobre_mi ─────────────────────────────────────────────────────────────────
bot.onText(/\/sobre_mi\s+(.+)/si, async (msg, match) => {
  const user = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  user.bio   = match[1].trim();
  await saveDb();
  bot.sendMessage(msg.chat.id,
    `✅ Perfil actualizado, *${user.name}*. Usaré esta información para interpretarte mejor.`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/sobre_mi$/i, (msg) => {
  bot.sendMessage(msg.chat.id,
    '✏️ Añade información sobre ti:\n`/sobre_mi tengo 28 años, soy ansioso, me gusta el ajedrez`',
    { parse_mode: 'Markdown' }
  );
});

// ── /misuenos ─────────────────────────────────────────────────────────────────
bot.onText(/\/misuenos/, async (msg) => {
  const user   = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const dreams = user.dreams || [];

  if (dreams.length === 0) {
    return bot.sendMessage(msg.chat.id, `${user.name}, aún no tienes sueños registrados.`);
  }

  const lines = dreams.slice(-5).reverse().map(d =>
    `📅 *${d.date}*\n_${d.text.slice(0, 90)}${d.text.length > 90 ? '…' : ''}_\n🏷️ ${(d.tags || []).join(', ') || '—'}`
  ).join('\n\n');

  bot.sendMessage(msg.chat.id,
    `🌙 *Últimos sueños de ${user.name}*\n\n${lines}`,
    { parse_mode: 'Markdown' }
  );
});

// ── /perfil ───────────────────────────────────────────────────────────────────
bot.onText(/\/perfil/, async (msg) => {
  const user   = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const dreams = user.dreams || [];

  const tagCount = {};
  dreams.flatMap(d => d.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
  const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([t]) => t);

  const text = [
    `👤 *${user.name}*`,
    user.bio ? `📝 ${user.bio}` : '_Sin contexto personal — usa /sobre\\_mi para añadir_',
    `🌙 Sueños registrados: ${dreams.length}`,
    topTags.length ? `🔁 Temas recurrentes: ${topTags.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

// ── /stats ────────────────────────────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const users = Object.values(db.users).filter(u => (u.dreams || []).length > 0);
  if (!users.length) return bot.sendMessage(msg.chat.id, 'Aún no hay sueños registrados.');

  const lines = users
    .sort((a, b) => (b.dreams?.length || 0) - (a.dreams?.length || 0))
    .map(u => `• *${u.name}*: ${u.dreams.length} sueños`);

  bot.sendMessage(msg.chat.id,
    `📊 *Sueños registrados en el grupo*\n\n${lines.join('\n')}`,
    { parse_mode: 'Markdown' }
  );
});

// ── Collect free-text during morning window ───────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isCollecting(msg.chat.id)) return;
  if (msg.text.length < 15) return; // ignore one-word replies
  await processDream(msg, msg.text);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
await loadDb();
await checkMorningTrigger(); // startup catch-up

// Check every minute; fire morning question at MORNING_HOUR:00 local time
setInterval(async () => {
  const t = localNow();
  if (t.getUTCHours() === MORNING_HOUR && t.getUTCMinutes() === 0) {
    await checkMorningTrigger();
  }
}, 60_000);

console.log('🌙 Somnia bot arrancado');
console.log(`   Pregunta matutina: ${MORNING_HOUR}:00 (TZ offset +${TZ_OFFSET}h)`);
console.log('   Modo: intérprete de sueños con Groq');
console.log('   Esperando mensajes…');

