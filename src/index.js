import TelegramBot from 'node-telegram-bot-api';
import { HfInference } from '@huggingface/inference';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ── Config ──────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HF_TOKEN = process.env.HF_API_TOKEN;
const VIDEO_MODEL = process.env.VIDEO_MODEL || 'ali-vilab/text-to-video-ms-1.7b';
const DATA_DIR = process.env.DATA_DIR || './data';

if (!TELEGRAM_TOKEN || !HF_TOKEN) {
  console.error('❌ Faltan variables de entorno: TELEGRAM_BOT_TOKEN y/o HF_API_TOKEN');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const hf = new HfInference(HF_TOKEN);

// ── Rate-limit tracking ─────────────────────────────────────────────────────
// Guardamos cuándo se nos denegó por rate-limit para no machacar la API
let rateLimitedUntil = 0;          // timestamp ms
let activeRequests = 0;
const MAX_CONCURRENT = 1;          // HF free tier: 1 a la vez como mucho
const COOLDOWN_DEFAULT_MS = 60_000;

function isRateLimited() {
  return Date.now() < rateLimitedUntil;
}

function formatWait() {
  const secs = Math.ceil((rateLimitedUntil - Date.now()) / 1000);
  if (secs <= 60) return `${secs}s`;
  return `${Math.ceil(secs / 60)} min`;
}

// ── /start ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🌙 *Somnia* — generador de vídeos con IA\n\n' +
    'Envíame una descripción y crearé un vídeo corto para ti.\n\n' +
    '• `/video <descripción>` — genera un vídeo\n' +
    '• `/status` — estado del servicio\n' +
    '• `/help` — ayuda\n\n' +
    '_Uso gratuito gracias a Hugging Face. La generación puede tardar 1-3 minutos._',
    { parse_mode: 'Markdown' }
  );
});

// ── /help ───────────────────────────────────────────────────────────────────
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '🎬 *Cómo usar Somnia*\n\n' +
    '1\\. Escribe `/video` seguido de lo que quieres ver:\n' +
    '   `/video un gato astronauta flotando en el espacio`\n\n' +
    '2\\. Espera \\~1\\-3 minutos \\(free tier de HF\\)\\.\\n\n' +
    '3\\. Recibirás el vídeo directamente aquí\\.\n\n' +
    '⚠️ *Límites:*\n' +
    '• El servicio gratuito tiene cuota\\. Si se agota, hay que esperar\\.\n' +
    '• Solo un vídeo a la vez\\.\n' +
    '• Descripciones en inglés dan mejores resultados\\.',
    { parse_mode: 'MarkdownV2' }
  );
});

// ── /status ─────────────────────────────────────────────────────────────────
bot.onText(/\/status/, (msg) => {
  const parts = [];
  parts.push(`🤖 Modelo: \`${VIDEO_MODEL}\``);
  parts.push(`📊 Peticiones activas: ${activeRequests}/${MAX_CONCURRENT}`);
  if (isRateLimited()) {
    parts.push(`⏳ Rate-limited — disponible en ~${formatWait()}`);
  } else {
    parts.push('✅ Disponible');
  }
  bot.sendMessage(msg.chat.id, parts.join('\n'), { parse_mode: 'Markdown' });
});

// ── /video <prompt> ─────────────────────────────────────────────────────────
bot.onText(/\/video(?:@\w+)?\s+(.+)/s, async (msg, match) => {
  const chatId = msg.chat.id;
  const prompt = match[1].trim();

  if (!prompt) {
    return bot.sendMessage(chatId, '✏️ Escribe una descripción después de /video');
  }

  // ── Rate-limit check ──
  if (isRateLimited()) {
    return bot.sendMessage(chatId,
      `⏳ El servicio gratuito está en pausa por cuota.\n` +
      `Disponible en ~${formatWait()}.\n\n` +
      `_Hay que respetar los límites para mantener el servicio gratis._`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Concurrency check ──
  if (activeRequests >= MAX_CONCURRENT) {
    return bot.sendMessage(chatId,
      '⏳ Ya hay un vídeo generándose. Espera a que termine e inténtalo de nuevo.'
    );
  }

  activeRequests++;
  const statusMsg = await bot.sendMessage(chatId,
    `🎬 Generando vídeo…\n\n_"${prompt}"_\n\nEsto puede tardar 1-3 minutos.`,
    { parse_mode: 'Markdown' }
  );

  const tmpFile = join(DATA_DIR, `video_${chatId}_${Date.now()}.mp4`);

  try {
    // ── Call HF Inference API ──
    const response = await hf.textToVideo({
      model: VIDEO_MODEL,
      inputs: prompt,
    });

    // response es un Blob — convertir a Buffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.length < 1000) {
      // Respuesta demasiado pequeña → probablemente un error JSON
      const text = buffer.toString('utf-8');
      throw new Error(`Respuesta inesperada de HF: ${text.slice(0, 200)}`);
    }

    // Guardar temporalmente y enviar
    await writeFile(tmpFile, buffer);

    await bot.sendVideo(chatId, tmpFile, {
      caption: `🌙 _${prompt}_`,
      parse_mode: 'Markdown',
      supports_streaming: true,
    });

    // Borrar mensaje de "generando…"
    await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});

  } catch (err) {
    console.error('Error generando vídeo:', err);

    // ── Handle rate-limit (HTTP 429) ──
    if (err.message?.includes('429') || err.message?.toLowerCase().includes('rate limit') || err.statusCode === 429) {
      // Intentar leer retry-after del error
      const retryMatch = err.message?.match(/retry.after[:\s]*(\d+)/i);
      const waitMs = retryMatch ? parseInt(retryMatch[1]) * 1000 : COOLDOWN_DEFAULT_MS;
      rateLimitedUntil = Date.now() + waitMs;

      await bot.editMessageText(
        `⚠️ *Cuota de HF agotada*\n\n` +
        `El servicio gratuito tiene un límite de peticiones por hora.\n` +
        `Vuelve a intentarlo en ~${formatWait()}.\n\n` +
        `_Hay que respetar estos límites para mantener que sea gratis._`,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});

    } else if (err.message?.includes('503') || err.message?.toLowerCase().includes('loading')) {
      // Modelo cargándose (cold start)
      await bot.editMessageText(
        '⏳ El modelo se está cargando en los servidores de HF (cold start).\n' +
        'Vuelve a intentarlo en 1-2 minutos.',
        { chat_id: chatId, message_id: statusMsg.message_id }
      ).catch(() => {});

    } else {
      await bot.editMessageText(
        `❌ Error generando el vídeo.\n\n\`${err.message?.slice(0, 200) || 'Error desconocido'}\``,
        { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'Markdown' }
      ).catch(() => {});
    }
  } finally {
    activeRequests--;
    // Limpiar archivo temporal
    unlink(tmpFile).catch(() => {});
  }
});

// ── /video sin prompt ───────────────────────────────────────────────────────
bot.onText(/^\/video(?:@\w+)?$/, (msg) => {
  bot.sendMessage(msg.chat.id,
    '✏️ Añade una descripción:\n`/video un bosque mágico al amanecer`',
    { parse_mode: 'Markdown' }
  );
});

// ── Arranque ────────────────────────────────────────────────────────────────
console.log('🌙 Somnia bot arrancado');
console.log(`   Modelo: ${VIDEO_MODEL}`);
console.log('   Esperando mensajes…');
