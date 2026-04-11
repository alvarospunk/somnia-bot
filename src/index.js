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
const MORNING_HOUR   = 7;        // local hour to ask the morning question
const COLLECT_HOURS  = 2;        // how long to collect replies after the morning question
const ADMIN_PASSWORD = 'morfeo'; // password required for /admin commands

const HELP_TEXT =
  '🌙✨ Somnia — Guardiana de los sueños\n\n' +
  'Cada noche el inconsciente habla. Yo lo descifro.\n\n' +
  'Cada mañana a las 7:00 os preguntaré qué habéis soñado y lo interpretaré 🌕\n\n' +
  '🌙 /nuevo_suenio <descripción> — relata tu sueño nocturno\n' +
  '💤 /nueva_siesta <descripción> — relata un sueño de siesta\n' +
  '📜 /mis_suenios — consulta tus últimos sueños\n' +
  '📅 /mis_suenios YYYY-MM-DD — sueños de un día concreto\n' +
  '🪬 /sobre_mi <info> — añade contexto para lecturas más profundas\n' +
  '🔭 /perfil — explora tu perfil onírico\n' +
  '🌌 /stats — estadísticas del grupo\n' +
  '🌕 /suenios_grupo — inconsciente colectivo del grupo\n' +
  '🌑 /desactivar_buenosdias — silencia el mensaje matutino\n' +
  '🌙 /activar_buenosdias — reactiva el mensaje matutino';

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

// Send a message with Markdown; if Telegram rejects the markup, retry as plain text.
function safeMd(chatId, text, extra = {}) {
  return bot.sendMessage(chatId, text, { ...extra, parse_mode: 'Markdown' })
    .catch(() => bot.sendMessage(chatId, text, extra));
}

// Edit a message with Markdown; if Telegram rejects the markup, retry as plain text.
function safeEditMd(chatId, messageId, text) {
  return bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'Markdown' })
    .catch(() => bot.editMessageText(text, { chat_id: chatId, message_id: messageId }));
}

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
  console.error('❌ Missing environment variables: TELEGRAM_BOT_TOKEN and/or GROQ_API_KEY');
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

// Returns true if the given userId is a member of any active group chat.
// Used to avoid sending private morning messages to users already in a group.
function isUserInAnyGroup(userId) {
  return Object.entries(db.activeChats).some(([chatId, chat]) =>
    Number(chatId) < 0 && !chat.morningDisabled && (chat.members || []).includes(Number(userId))
  );
}

// Records a user as a member of a group chat (called whenever they interact in a group).
function trackGroupMember(chatId, userId) {
  if (Number(chatId) >= 0) return; // only track group chats
  const chat = db.activeChats[String(chatId)];
  if (!chat) return;
  if (!chat.members) chat.members = [];
  if (!chat.members.includes(Number(userId))) {
    chat.members.push(Number(userId));
  }
}

async function sendMorningQuestion(chatId) {
  const key = String(chatId);
  db.activeChats[key].collectingUntil = Date.now() + COLLECT_HOURS * 3600 * 1000;

  const isGroup = Number(chatId) < 0;
  const optOutNote = isGroup
    ? `Tenéis ${COLLECT_HOURS}h para contarme. También podéis usar /nuevo_suenio en cualquier momento.`
    : `Tienes ${COLLECT_HOURS}h para contarme. También puedes usar /nuevo_suenio en cualquier momento.\nUsa /desactivar_buenosdias si prefieres no recibir este mensaje en privado.`;

  await bot.sendMessage(chatId,
    '🌙 ¡Buenos días, viajeros del sueño! ☀️\n\n' +
    '¿Qué tal dormisteis? ¿Qué mundos visitasteis esta noche? 🌌\n\n' +
    'Contadme vuestros sueños y Somnia os revelará lo que el inconsciente quiso decir 🔮✨\n' +
    optOutNote
  );

  // Mark as sent only after successful delivery so a failed send can be retried on restart
  db.activeChats[key].lastMorningQuestion = today();
  await saveDb();
}

async function checkMorningTrigger() {
  const t    = today();
  const hour = localHour();

  for (const [chatId, chat] of Object.entries(db.activeChats)) {
    if (chat.lastMorningQuestion === t) continue; // already asked today
    if (hour < MORNING_HOUR) continue;            // too early
    if (chat.morningDisabled) continue;           // explicitly disabled for this chat
    // Skip private chats if the user is already a member of an active group
    if (Number(chatId) > 0 && isUserInAnyGroup(Number(chatId))) continue;
    await sendMorningQuestion(chatId);
  }
}

// ── Groq interpretation ───────────────────────────────────────────────────────
async function interpretDream(user, dreamText, isNap = false) {
  const recentDreams = (user.dreams || []).slice(-10).map(d =>
    `- [${d.date}${d.isNap ? ' (siesta)' : ''}] "${d.text}" (temas: ${(d.tags || []).join(', ') || 'sin clasificar'})`
  ).join('\n');

  const userContext = [
    `Nombre: ${user.name}`,
    user.bio       ? `Contexto personal: ${user.bio}` : '',
    recentDreams   ? `Historial de sueños recientes:\n${recentDreams}` : '',
  ].filter(Boolean).join('\n');

  // Nap dreams occur in light/early-REM sleep — shorter, more literal, less archetypal
  const systemPrompt = isNap
    ? 'Eres Somnia, intérprete experta en sueños. Este sueño fue durante una siesta, ' +
      'por lo que suele ser más corto, fragmentado y literal, ocurriendo en sueño ligero (NREM) ' +
      'o REM temprano. Centra el análisis en el estado emocional inmediato y preocupaciones recientes. ' +
      'Evita arquetipos profundos. Tono cálido y ligero. Máximo 150 palabras.\n\n' +
      'Formato obligatorio (sin cambiar las etiquetas):\n' +
      '[Tu interpretación aquí]\n\n' +
      '🏷️ Etiquetas: tag1, tag2, tag3'
    : 'Eres Somnia, intérprete experta en sueños. Combinas psicología jungiana, ' +
      'simbolismo onírico y análisis narrativo. Interpretas de forma profunda y personalizada, ' +
      'teniendo en cuenta la personalidad y el historial de la persona. ' +
      'Si detectas patrones recurrentes, los mencionas. ' +
      'Responde siempre en español, tono cálido pero analítico. Máximo 220 palabras.\n\n' +
      'Formato obligatorio (sin cambiar las etiquetas):\n' +
      '[Tu interpretación aquí]\n\n' +
      '🏷️ Etiquetas: tag1, tag2, tag3';

  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Contexto de la persona:\n${userContext}\n\n${isNap ? 'Sueño de siesta' : 'Sueño de esta noche'}:\n"${dreamText}"`,
      },
    ],
    max_tokens: isNap ? 300 : 450,
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
async function processDream(msg, dreamText, isNap = false) {
  const chatId = msg.chat.id;
  const from   = msg.from;
  const user   = getUser(from.id, from.first_name, from.username);

  // Track group membership so the morning question is not sent privately to users already in a group
  trackGroupMember(chatId, from.id);

  // Prevent recording a second night dream on the same day — suggest /nueva_siesta instead
  if (!isNap && (user.dreams || []).some(d => d.date === today() && !d.isNap)) {
    return bot.sendMessage(chatId,
      `🌙 ${user.name}, ya has registrado tu sueño nocturno de hoy. ¿Querías añadir una siesta? Usa /nueva_siesta 💤✨`
    );
  }

  const thinkingMsg = await bot.sendMessage(chatId,
    `🌒✨ ${isNap ? `Leyendo los ecos de tu siesta, ${user.name}…` : `Adentrándome en tu sueño, ${user.name}…`}`
  );

  try {
    const { interpretation, tags } = await interpretDream(user, dreamText, isNap);

    user.dreams.push({ date: today(), text: dreamText, tags, interpretation, ...(isNap && { isNap: true }) });
    await saveDb();

    // Classify this dream immediately so the category is shown right after registration
    const dreamCounts  = classifyDreams([{ tags }]);
    const topCategory  = Object.entries(dreamCounts).sort((a, b) => b[1] - a[1])[0];
    const categoryLine = topCategory
      ? `\n\n🗂️ *Categoría:* ${topCategory[0]}`
      : '';

    const header = isNap ? `💤 Siesta de ${user.name}` : `🌙 Sueño de ${user.name}`;

    const replyText = `${header}\n\n${interpretation}${categoryLine}`;

    // Try with Markdown first; if it fails (e.g. unmatched underscores from Groq) fall back to plain text
    await safeEditMd(chatId, thinkingMsg.message_id, replyText);
  } catch (err) {
    console.error('Error interpreting dream:', err.message);
    const errTxt = err.message?.toLowerCase().includes('rate') || err.status === 429
      ? '🌫️ Los astros están saturados… inténtalo en un minuto.'
      : `❌ Error al interpretar: ${err.message?.slice(0, 120)}`;
    await bot.editMessageText(errTxt,
      { chat_id: chatId, message_id: thinkingMsg.message_id }
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
  bot.sendMessage(msg.chat.id, HELP_TEXT);
});

// ── /help ────────────────────────────────────────────────────────────────────
bot.onText(/\/help(?:@\w+)?/, (msg) => {
  bot.sendMessage(msg.chat.id, HELP_TEXT);
});

// ── /nuevo_suenio ────────────────────────────────────────────────────────────
bot.onText(/\/nuevo_suenio(?:@\w+)?\s+(.+)/si, async (msg, match) => {
  await processDream(msg, match[1].trim());
});

bot.onText(/^\/nuevo_suenio(?:@\w+)?$/i, (msg) => {
  safeMd(msg.chat.id,
    '🌙 Cuéntame lo que viste en sueños después del comando:\n`/nuevo_suenio estaba volando sobre una ciudad…`'
  );
});

// ── /nueva_siesta ────────────────────────────────────────────────────────────
bot.onText(/\/nueva_siesta(?:@\w+)?\s+(.+)/si, async (msg, match) => {
  await processDream(msg, match[1].trim(), true);
});

bot.onText(/^\/nueva_siesta(?:@\w+)?$/i, (msg) => {
  safeMd(msg.chat.id,
    '💤🌫️ Cuéntame los fragmentos de tu siesta después del comando:\n`/nueva_siesta soñé con el trabajo un momento`'
  );
});

// ── /sobre_mi ─────────────────────────────────────────────────────────────────
bot.onText(/\/sobre_mi\s+(.+)/si, async (msg, match) => {
  const user = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  user.bio   = match[1].trim();
  await saveDb();
  safeMd(msg.chat.id,
    `🪬✨ Guardado, *${user.name}*. Los astros toman nota — tus próximas lecturas serán más certeras.`
  );
});

bot.onText(/^\/sobre_mi$/i, (msg) => {
  safeMd(msg.chat.id,
    '🪬 Comparte algo sobre ti para que Somnia te conozca mejor:\n`/sobre_mi tengo 28 años, soy ansioso, me gusta el ajedrez`'
  );
});

// ── /mis_suenios ────────────────────────────────────────────────────────────
bot.onText(/\/mis_suenios(?:@\w+)?\s+(\d{4}-\d{2}-\d{2})/, (msg, match) => {
  const user   = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const date   = match[1];
  const onDay  = (user.dreams || []).filter(d => d.date === date);

  if (!onDay.length) {
    return bot.sendMessage(msg.chat.id, `🌑 El registro onírico del ${date} está en blanco… ese día guardaste bien tus secretos.`);
  }

  const sections = onDay.map(dream => [
    dream.isNap ? '💤 *Siesta*' : '🌙 *Sueño nocturno*',
    `💭 ${dream.text}`,
    dream.interpretation ? `🔮 *Análisis:*\n${dream.interpretation}` : '',
    dream.tags?.length ? `🏷️ *Etiquetas:* ${dream.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n─────────────\n\n');

  safeMd(msg.chat.id,
    `📅 *${date}*\n\n${sections}`
  );
});

bot.onText(/\/mis_suenios(?:@\w+)?(?:\s*$)/, async (msg) => {
  const user   = getUser(msg.from.id, msg.from.first_name, msg.from.username);
  const dreams = user.dreams || [];

  if (dreams.length === 0) {
    return safeMd(msg.chat.id, `🌑 *${user.name}*, aún no has compartido ningún sueño conmigo… el libro onírico está en blanco.`);
  }

  // ── Dream list: last 5 entries, grouping same-day night+nap together ──
  // Deduplicate by date so a day with both types appears as one block
  const seenDates  = new Set();
  const lastBlocks = [];
  for (const d of [...dreams].reverse()) {
    if (seenDates.has(d.date)) continue; // already rendered this date
    seenDates.add(d.date);
    lastBlocks.push(d.date);
    if (lastBlocks.length === 5) break;
  }

  const lines = lastBlocks.map(date => {
    const onDay = dreams.filter(d => d.date === date);
    const hasNap   = onDay.some(d => d.isNap);
    const hasNight = onDay.some(d => !d.isNap);
    // Date header badge when both types exist
    const badge = (hasNight && hasNap) ? ' 🌙💤' : hasNap ? ' 💤' : '';
    const entries = onDay.map(d => {
      const label = (hasNight && hasNap) ? (d.isNap ? '_Siesta_ ' : '_Noche_ ') : '';
      return `${label}${d.text.slice(0, 80)}${d.text.length > 80 ? '…' : ''}\n🏷️ ${(d.tags || []).join(', ') || '—'}`;
    }).join('\n');
    return `📅 *${date}*${badge}\n${entries}`;
  }).join('\n\n');

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

  safeMd(msg.chat.id,
    `🌙✨ *El diario onírico de ${user.name}*\n\n${lines}${chartSection}\n\n` +
    '🔍 Para ver el detalle de un día concreto: `/mis_suenios 2026-04-09`'
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
    user.bio ? `📜 _"${user.bio}"_` : '_Sin contexto personal — usa /sobre\_mi para que los astros te conozcan mejor_ 🪬',
    `🌙 Sueños registrados: ${dreams.length}`,
    topTags.length ? `🔁 *Temas recurrentes:* ${topTags.join(' · ')}` : '🌑 _Aún sin patrones detectados…_',
  ].filter(Boolean).join('\n');

  safeMd(msg.chat.id, text);
});

// ── /stats ────────────────────────────────────────────────────────────────────
bot.onText(/\/stats/, async (msg) => {
  const users = Object.values(db.users).filter(u => (u.dreams || []).length > 0);
  if (!users.length) return bot.sendMessage(msg.chat.id, '🌑 El grupo aún no ha compartido sueños con Somnia…');

  const lines = users
    .sort((a, b) => (b.dreams?.length || 0) - (a.dreams?.length || 0))
    .map(u => `🌙 *${u.name}*: ${u.dreams.length} sueño${u.dreams.length === 1 ? '' : 's'}`);

  safeMd(msg.chat.id,
    `🌌 *Archivo onírico del grupo*\n\n${lines.join('\n')}`
  );
});
// ── /suenios_grupo ─────────────────────────────────────────────────────────
bot.onText(/\/suenios_grupo/, async (msg) => {
  const users = Object.values(db.users).filter(u => (u.dreams || []).length > 0);
  if (!users.length) return bot.sendMessage(msg.chat.id, '🌑 El inconsciente colectivo aún está en silencio…');

  const allDreams = users.flatMap(u => u.dreams || []);
  const counts    = classifyDreams(allDreams);
  const total     = Object.values(counts).reduce((a, b) => a + b, 0);

  if (total === 0) {
    return bot.sendMessage(msg.chat.id, '🌫️ Aún no hay suficientes sueños categorizados para leer el inconsciente del grupo…');
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

  safeMd(msg.chat.id,
    `�✨ *El inconsciente colectivo del grupo*\n_Lo que los sueños de todos revelan juntos…_\n\n` +
    `${userLines}\n\n` +
    `*Categorías oníricas del grupo:*\n` +
    `${chartLines}\n\n` +
    `*Personalidad colectiva:*\n` +
    `Juntos, los sueños del grupo revelan ${groupPersonality}\n` +
    `Composición: ${top3text}`
  );
});
// ── /admin ───────────────────────────────────────────────────────────────────
// Usage: /admin <password>
bot.onText(/\/admin(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
  if (match[1] !== ADMIN_PASSWORD) {
    return bot.sendMessage(msg.chat.id, '❌ Wrong password.');
  }
  const users = Object.values(db.users);
  if (!users.length) return bot.sendMessage(msg.chat.id, 'No users registered yet.');

  const lines = users
    .sort((a, b) => (b.dreams?.length || 0) - (a.dreams?.length || 0))
    .map(u => `• *${u.name}* (id: \`${u.userId}\`) — ${u.dreams?.length || 0} dreams`);

  safeMd(msg.chat.id,
    `🔐 *Admin Panel*\n\n${lines.join('\n')}\n\n` +
    '*Subcommands:*\n' +
    '• `/admin_user <password> <userId>` — list all dreams for a user\n' +
    '• `/admin_del <password> <userId> <index>` — delete dream by index (1-based)\n' +
    '• `/admin_list <password>` — list all users, groups and private chats\n' +
    '• `/admin_msg <password> <chatId> <text>` — send a custom message to any chat or user'
  );
});

bot.onText(/^\/admin(?:@\w+)?$/i, (msg) => {
  safeMd(msg.chat.id, '🔐 Usage: `/admin <password>`');
});

// ── /admin_user ───────────────────────────────────────────────────────────────
// Usage: /admin_user <password> <userId>
bot.onText(/\/admin_user(?:@\w+)?\s+(\S+)\s+(\S+)/, async (msg, match) => {
  if (match[1] !== ADMIN_PASSWORD) return bot.sendMessage(msg.chat.id, '❌ Wrong password.');
  const userId = match[2];
  const user   = db.users[userId];
  if (!user) return safeMd(msg.chat.id, `User \`${userId}\` not found.`);

  const dreams = user.dreams || [];
  if (!dreams.length) return bot.sendMessage(msg.chat.id, `${user.name} has no dreams yet.`);

  const lines = dreams.map((d, i) =>
    `*${i + 1}.* [${d.date}${d.isNap ? ' 💤' : ''}] ${d.text.slice(0, 80)}${d.text.length > 80 ? '…' : ''}`
  ).join('\n');

  safeMd(msg.chat.id,
    `🌙 *Dreams of ${user.name}* (${dreams.length} total)\n\n${lines}`
  );
});

// ── /admin_del ────────────────────────────────────────────────────────────────
// Usage: /admin_del <password> <userId> <index>
bot.onText(/\/admin_del(?:@\w+)?\s+(\S+)\s+(\S+)\s+(\d+)/, async (msg, match) => {
  if (match[1] !== ADMIN_PASSWORD) return bot.sendMessage(msg.chat.id, '❌ Wrong password.');
  const userId = match[2];
  const index  = parseInt(match[3]) - 1; // convert 1-based to 0-based
  const user   = db.users[userId];
  if (!user) return safeMd(msg.chat.id, `User \`${userId}\` not found.`);

  const dreams = user.dreams || [];
  if (index < 0 || index >= dreams.length) {
    return bot.sendMessage(msg.chat.id, `Invalid index. ${user.name} has ${dreams.length} dream(s).`);
  }

  const [removed] = dreams.splice(index, 1);
  await saveDb();
  safeMd(msg.chat.id,
    `✅ Deleted dream #${index + 1} of *${user.name}* (${removed.date}${removed.isNap ? ' 💤' : ''}).`
  );
});

// ── /admin_list ───────────────────────────────────────────────────────────────
// Usage: /admin_list <password>
bot.onText(/\/admin_list(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
  if (match[1] !== ADMIN_PASSWORD) return bot.sendMessage(msg.chat.id, '❌ Wrong password.');

  // Users
  const users = Object.values(db.users);
  const userLines = users.length
    ? users
        .sort((a, b) => (b.dreams?.length || 0) - (a.dreams?.length || 0))
        .map(u => `• *${u.name}* (@${u.username || '—'}) id: \`${u.userId}\` — ${u.dreams?.length || 0} dreams`)
        .join('\n')
    : '_No users yet._';

  // Chats
  const chatEntries = Object.entries(db.activeChats);
  const groups  = chatEntries.filter(([id]) => Number(id) < 0);
  const privates = chatEntries.filter(([id]) => Number(id) > 0);

  const groupLines = groups.length
    ? groups.map(([id, c]) => {
        const memberCount = (c.members || []).length;
        const status = c.morningDisabled ? '🌑 off' : '🌙 on';
        return `• id: \`${id}\` — ${memberCount} member(s) — morning: ${status}`;
      }).join('\n')
    : '_No groups._';

  const privateLines = privates.length
    ? privates.map(([id, c]) => {
        const u = db.users[id];
        const label = u ? `${u.name} (@${u.username || '—'})` : `id ${id}`;
        const status = c.morningDisabled ? '🌑 off' : '🌙 on';
        return `• ${label} \`${id}\` — morning: ${status}`;
      }).join('\n')
    : '_No private chats._';

  safeMd(msg.chat.id,
    `🔐 *Admin — Registered chats*\n\n` +
    `👥 *Groups (${groups.length}):*\n${groupLines}\n\n` +
    `💬 *Private chats (${privates.length}):*\n${privateLines}\n\n` +
    `👤 *Users (${users.length}):*\n${userLines}\n\n` +
    `_Use_ \`/admin_msg ${ADMIN_PASSWORD} <chatId> <text>\` _to send a message._`
  );
});

bot.onText(/^\/admin_list(?:@\w+)?$/i, (msg) => {
  safeMd(msg.chat.id, '🔐 Usage: `/admin_list <password>`');
});

// ── /admin_msg ────────────────────────────────────────────────────────────────
// Usage: /admin_msg <password> <chatId> <message text>
bot.onText(/\/admin_msg(?:@\w+)?\s+(\S+)\s+(-?\d+)\s+(.+)/s, async (msg, match) => {
  if (match[1] !== ADMIN_PASSWORD) return bot.sendMessage(msg.chat.id, '❌ Wrong password.');
  const targetChatId = match[2];
  const text = match[3].trim();

  try {
    await bot.sendMessage(targetChatId, text);
    safeMd(msg.chat.id, `✅ Message sent to \`${targetChatId}\`.`);
  } catch (err) {
    safeMd(msg.chat.id, `❌ Failed: ${err.message}`);
  }
});

bot.onText(/^\/admin_msg(?:@\w+)?$/i, (msg) => {
  safeMd(msg.chat.id, '🔐 Usage: `/admin_msg <password> <chatId> <message>`');
});

// ── Collect free-text during morning window ───────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  // Track group membership so we know not to ping this user privately
  if (msg.chat.id < 0) trackGroupMember(msg.chat.id, msg.from.id);
  if (isCollecting(msg.chat.id)) {
    // In groups, ignore very short replies (greetings, reactions, etc.)
    if (msg.chat.type !== 'private' && msg.text.length < 15) return;
    return processDream(msg, msg.text);
  }
  // In private chats outside the collecting window, reply with the help menu
  if (msg.chat.type === 'private') {
    bot.sendMessage(msg.chat.id, HELP_TEXT);
  }
});

// ── /desactivar_buenosdias ───────────────────────────────────────────────────
bot.onText(/\/desactivar_buenosdias(?:@\w+)?/, async (msg) => {
  const key = String(msg.chat.id);
  if (!db.activeChats[key]) {
    return bot.sendMessage(msg.chat.id, '🌑 Este chat no está registrado en Somnia. Usa /start primero.');
  }
  db.activeChats[key].morningDisabled = true;
  await saveDb();
  const scope = msg.chat.type === 'private' ? 'esta conversación privada' : 'este grupo';
  safeMd(msg.chat.id,
    `🌑 *El ritual del amanecer ha sido suspendido para ${scope}.* Somnia guardará silencio por las mañanas aquí. Usa /activar\_buenosdias para retomarlo.`
  );
});

// ── /activar_buenosdias ──────────────────────────────────────────────────────
bot.onText(/\/activar_buenosdias(?:@\w+)?/, async (msg) => {
  const key = String(msg.chat.id);
  if (!db.activeChats[key]) {
    return bot.sendMessage(msg.chat.id, '🌑 Este chat no está registrado. Usa /start primero.');
  }
  db.activeChats[key].morningDisabled = false;
  await saveDb();
  const scope = msg.chat.type === 'private' ? 'esta conversación privada' : 'este grupo';
  safeMd(msg.chat.id,
    `🌙✨ *El ritual del amanecer vuelve a despertar para ${scope}.* Mañana a las 7:00, Somnia volverá a preguntar por vuestros sueños.`
  );
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

// Prevent unhandled promise rejections (e.g. Telegram API errors) from crashing the process
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
  if (err?.stack) console.error(err.stack.split('\n').slice(0, 6).join('\n'));
});

console.log('🌙 Somnia bot started');
console.log(`   Morning question: ${MORNING_HOUR}:00 (TZ offset +${TZ_OFFSET}h)`);
console.log('   Mode: dream interpreter powered by Groq');
console.log('   Waiting for messages…');

