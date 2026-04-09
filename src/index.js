import TelegramBot from 'node-telegram-bot-api';
import Groq from 'groq-sdk';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { createServer } from 'http';
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

// ── Dream categories ──────────────────────────────────────────────────────────
const CATEGORIES = {
  '⚔️ Conflicto':      ['conflicto', 'lucha', 'pelea', 'batalla', 'enfrentamiento', 'violencia', 'tensión', 'rivalidad'],
  '🦋 Transformación': ['transformación', 'cambio', 'renacimiento', 'renovación', 'metamorfosis', 'evolución', 'crecimiento'],
  '😨 Miedo':          ['miedo', 'terror', 'ansiedad', 'pesadilla', 'amenaza', 'peligro', 'huida', 'inseguridad', 'incertidumbre', 'inestabilidad'],
  '❤️ Amor':           ['amor', 'romance', 'conexión', 'relación', 'intimidad', 'afecto', 'apego', 'ternura'],
  '🗺️ Aventura':       ['aventura', 'exploración', 'viaje', 'descubrimiento', 'libertad', 'vuelo', 'movimiento', 'escalada', 'ascenso'],
  '🥀 Pérdida':        ['pérdida', 'muerte', 'duelo', 'separación', 'abandono', 'vacío', 'ausencia'],
  '👑 Poder':          ['poder', 'control', 'dominación', 'autoridad', 'ambición', 'autonomia', 'autonomía', 'independencia'],
  '✨ Creatividad':    ['creatividad', 'fantasía', 'imaginación', 'arte', 'magia', 'música', 'canción', 'melodía', 'sonido', 'sueño lúccido'],
  '🌌 Espiritualidad': ['espiritualidad', 'trascendencia', 'espiritual', 'místico', 'propósito', 'sentido'],
  '💔 Culpa':          ['arrepentimiento', 'culpa', 'vergüenza', 'remordimiento', 'disculpa'],
  '🌿 Calma':          ['calma', 'paz', 'tranquilidad', 'serenidad', 'descanso', 'bienestar', 'satisfacción', 'alivio'],
  '💔 Emocional':      ['emoción', 'nostalgia', 'melancolía', 'alegría', 'euforia', 'ternura', 'tristeza'],
};

const PERSONALITY_MAP = {
  '⚔️ Conflicto':      'una mente que procesa activamente sus tensiones internas. Tiendes a confrontar tus sombras en lugar de ignorarlas.',
  '🦋 Transformación': 'un espíritu en constante evolución. Tu yo nunca deja de crecer y reinventarse.',
  '😨 Miedo':          'una psique muy sensible al entorno. Procesas ansiedades profundas que en la vigilia quizás reprimes.',
  '❤️ Amor':           'una personalidad orientada a los vínculos. La conexión emocional es el centro de tu mundo interior.',
  '🗺️ Aventura':       'un espíritu libre y explorador. Tu inconsciente busca constantemente nuevas experiencias.',
  '🥀 Pérdida':        'alguien que siente profundamente los cambios y las despedidas. Tu inconsciente trabaja activamente el duelo.',
  '👑 Poder':          'una personalidad con gran impulso de logro. Tus sueños reflejan ambición y necesidad de control.',
  '✨ Creatividad':    'una mente visualmente rica e imaginativa. Tienes un acceso especial al mundo que construyes desde dentro.',
  '🌌 Espiritualidad': 'un buscador de sentido. Tus sueños trascienden lo cotidiano hacia preguntas más profundas.',
  '💔 Culpa':          'una conciencia muy desarrollada. Procesas tus errores con honestidad, buscando reparación y aprendizaje.',
  '🌿 Calma':          'una personalidad que busca el equilibrio. Tu inconsciente trabaja para encontrar paz y estabilidad.',
  '💔 Emocional':      'una persona de gran profundidad emocional. Tu mundo interior es intenso y rico en matices.',
};

function cleanInterpretation(raw) {
  return (raw || '')
    .replace(/^\[Tu interpretación aquí\]\n?/i, '')
    .replace(/\n*🏷️\s*Etiquetas?:?.*$/is, '')
    .trim();
}

function classifyDreams(dreams) {
  const counts = {};
  for (const dream of dreams) {
    for (const tag of (dream.tags || [])) {
      const lower = tag.toLowerCase();
      for (const [cat, keywords] of Object.entries(CATEGORIES)) {
        if (keywords.some(k => lower.includes(k))) {
          counts[cat] = (counts[cat] || 0) + 1;
          break;
        }
      }
    }
  }
  return counts;
}

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
      // Migrate: strip template prefix + tags line from stored interpretations
      let migrated = false;
      for (const user of Object.values(db.users || {})) {
        for (const dream of (user.dreams || [])) {
          const cleaned = cleanInterpretation(dream.interpretation);
          if (cleaned !== (dream.interpretation || '')) {
            dream.interpretation = cleaned;
            migrated = true;
          }
        }
      }
      if (migrated) await saveDb();
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
    `_(Tenéis ${COLLECT_HOURS}h para contarme. También podéis usar /nuevo_suenio en cualquier momento)_`,
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

  return { interpretation: cleanInterpretation(content), tags };
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
    '• `/nuevo_suenio <descripción>` — cuenta un sueño en cualquier momento\n' +
    '• `/mis_suenios` — ver tus últimos sueños\n' +
    '• `/sobre_mi <info>` — añade contexto sobre ti para mejor interpretación\n' +
    '• `/perfil` — ver tu perfil y temas recurrentes\n' +
    '• `/stats` — estadísticas del grupo',
    { parse_mode: 'Markdown' }
  );
});

// ── /nuevo_suenio ────────────────────────────────────────────────────────────
bot.onText(/\/nuevo_suenio(?:@\w+)?\s+(.+)/si, async (msg, match) => {
  await processDream(msg, match[1].trim());
});

bot.onText(/^\/nuevo_suenio(?:@\w+)?$/i, (msg) => {
  bot.sendMessage(msg.chat.id,
    '✏️ Cuéntame el sueño después del comando:\n`/nuevo_suenio estaba volando sobre una ciudad…`',
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

// ── /mis_suenios ────────────────────────────────────────────────────────────
bot.onText(/\/mis_suenios(?:@\w+)?\s+(\d{4}-\d{2}-\d{2})/, (msg, match) => {
  const user  = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const date  = match[1];
  const dream = (user.dreams || []).find(d => d.date === date);

  if (!dream) {
    return bot.sendMessage(msg.chat.id, `No encuentro ningún sueño tuyo del ${date}.`);
  }

  const text = [
    `📅 *${dream.date}*`,
    `\n💭 *Sueño:*\n${dream.text}`,
    dream.interpretation ? `\n🔮 *Análisis:*\n${dream.interpretation}` : '',
    dream.tags?.length ? `\n🏷️ *Etiquetas:* ${dream.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/mis_suenios(?:@\w+)?(?:\s*$)/, async (msg) => {
  const user   = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const dreams = user.dreams || [];

  if (dreams.length === 0) {
    return bot.sendMessage(msg.chat.id, `${user.name}, aún no tienes sueños registrados.`);
  }

  // ── Dream list (last 5) ──
  const lines = dreams.slice(-5).reverse().map(d =>
    `📅 *${d.date}*\n${d.text.slice(0, 90)}${d.text.length > 90 ? '…' : ''}\n🏷️ ${(d.tags || []).join(', ') || '—'}`
  ).join('\n\n');

  // ── Category chart ──
  const counts = classifyDreams(dreams);
  const total  = Object.values(counts).reduce((a, b) => a + b, 0);
  let chartSection = '';
  if (total > 0) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const chartLines = sorted.map(([cat, n]) => {
      const pct    = Math.round((n / total) * 100);
      const filled = Math.round((pct / 100) * 8);
      return `${cat} ${'█'.repeat(filled)}${'░'.repeat(8 - filled)} ${pct}%`;
    }).join('\n');

    const [topCat]  = sorted[0];
    const top2text  = sorted.slice(0, 2).map(([cat, n]) => `${Math.round((n / total) * 100)}% ${cat}`).join(' · ');
    const personality = PERSONALITY_MAP[topCat] || 'una personalidad compleja y multifacética.';

    chartSection =
      '\n\n*Categorías de tus sueños:*\n' +
      chartLines +
      '\n\n*Tu perfil onírico:*\n' +
      `Tus sueños revelan ${personality}\n` +
      `Composición: ${top2text}`;
  }

  bot.sendMessage(msg.chat.id,
    `🌙 *Últimos sueños de ${user.name}*\n\n${lines}${chartSection}\n\n` +
    'Para ver el detalle de uno: `/mis_suenios 2026-04-09`',
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
// ── /suenios_grupo ─────────────────────────────────────────────────────────
bot.onText(/\/suenios_grupo/, async (msg) => {
  const users = Object.values(db.users).filter(u => (u.dreams || []).length > 0);
  if (!users.length) return bot.sendMessage(msg.chat.id, 'Aún no hay sueños registrados en el grupo.');

  const allDreams = users.flatMap(u => u.dreams || []);
  const counts    = classifyDreams(allDreams);
  const total     = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total === 0) {
    return bot.sendMessage(msg.chat.id, 'Aún no hay suficientes categorías para analizar el grupo.');
  }

  // Per-user summary
  const userLines = users
    .sort((a, b) => (b.dreams?.length || 0) - (a.dreams?.length || 0))
    .map(u => {
      const uc  = classifyDreams(u.dreams || []);
      const tot = Object.values(uc).reduce((a, b) => a + b, 0);
      if (tot === 0) return `• *${u.name}*: ${u.dreams.length} sueños (sin categoría aún)`;
      const top = Object.entries(uc).sort((a, b) => b[1] - a[1])[0];
      return `• *${u.name}*: ${u.dreams.length} sueños — ${top[0]}`;
    }).join('\n');

  // Group chart
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const chartLines = sorted.map(([cat, n]) => {
    const pct    = Math.round((n / total) * 100);
    const filled = Math.round((pct / 100) * 8);
    return `${cat} ${'\u2588'.repeat(filled)}${'\u2591'.repeat(8 - filled)} ${pct}%`;
  }).join('\n');

  // Collective personality
  const [topCat] = sorted[0];
  const top3text = sorted.slice(0, 3).map(([c, n]) => `${Math.round((n / total) * 100)}% ${c}`).join(' · ');
  const groupPersonality = PERSONALITY_MAP[topCat] || 'una personalidad colectiva compleja y multifacética.';

  bot.sendMessage(msg.chat.id,
    `🌙 *El inconsciente colectivo del grupo*\n\n` +
    `${userLines}\n\n` +
    `*Categorías oníricas del grupo:*\n` +
    `${chartLines}\n\n` +
    `*Personalidad colectiva:*\n` +
    `Juntos, los sueños del grupo revelan ${groupPersonality}\n` +
    `Composición: ${top3text}`,
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
  if (t.getUTCHours() === MORNING_HOUR) {
    await checkMorningTrigger();
  }
}, 60_000);

// ── Health server (K8s readiness probe) ──────────────────────────────────────
let isReady = true;
const healthServer = createServer((req, res) => {
  if (req.url === '/healthz' && isReady) {
    res.writeHead(200).end('ok');
  } else {
    res.writeHead(503).end('not ready');
  }
});
healthServer.listen(3000);

// Graceful shutdown: mark not-ready before stopping polling
process.on('SIGTERM', () => {
  isReady = false;
  healthServer.close();
  bot.stopPolling().finally(() => process.exit(0));
});

console.log('🌙 Somnia bot arrancado');
console.log(`   Pregunta matutina: ${MORNING_HOUR}:00 (TZ offset +${TZ_OFFSET}h)`);
console.log('   Modo: intérprete de sueños con Groq');
console.log('   Esperando mensajes…');

