import TelegramBot from 'node-telegram-bot-api';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

class TelegramService {
  constructor() {
    this.bot = new TelegramBot(config.telegram.botToken, { polling: true });
    this.channelId = config.telegram.channelId;
    this.signalCallbacks = [];

    this.setupMessageHandler();
  }

  /**
   * Налаштовує обробник повідомлень
   */
  setupMessageHandler() {
    this.bot.on('channel_post', (msg) => {
      if (msg.chat.id.toString() === this.channelId.toString()) {
        this.handleChannelMessage(msg);
      }
    });

    this.bot.on('polling_error', (error) => {
      logger.error(`[TELEGRAM] Polling error: ${error.message}`);
    });

    logger.info('[TELEGRAM] ✅ Bot initialized and listening for channel posts');
  }

  /**
   * Обробляє повідомлення з каналу
   */
  async handleChannelMessage(msg) {
    try {
      const text = msg.text || msg.caption || '';

      if (this.isSignalMessage(text)) {
        const signal = this.parseSignal(text);

        if (signal) {
          logger.info(`[TELEGRAM] Signal received: type=${signal.type} symbol=${signal.symbol} direction=${signal.direction || 'N/A'}`);

          for (const callback of this.signalCallbacks) {
            try {
              await callback(signal);
            } catch (error) {
              logger.error(`[TELEGRAM] Error in signal callback: ${error.message}`);
            }
          }
        }
      }
    } catch (error) {
      logger.error(`[TELEGRAM] Error handling message: ${error.message}`);
    }
  }

  /**
   * Перевіряє чи це сигнальне повідомлення від KuCoin Monitor Bot.
   */
  isSignalMessage(text) {
    if (!text) return false;

    const isEntry = text.includes('🚨 KuCoin') && text.includes('👉') && text.includes('👈');
    const isExit = text.includes('сравнялись') || text.includes('зрівнялись');

    return isEntry || isExit;
  }

  /**
   * Парсить сигнал з повідомлення KuCoin Monitor Bot.
   */
  parseSignal(text) {
    try {
      if (text.includes('сравнялись') || text.includes('зрівнялись')) {
        return this._parseExitSignal(text);
      }

      if (text.includes('🚨 KuCoin')) {
        return this._parseEntrySignal(text);
      }

      return null;
    } catch (error) {
      logger.error(`[TELEGRAM] Error parsing signal: ${error.message}`);
      return null;
    }
  }

  /**
   * Парсить ENTRY сигнал.
   *
   * ПРАВИЛО ЕМОДЗІ (актуальне):
   *   🟢 = LONG
   *   🔴 = SHORT
   */
  _parseEntrySignal(text) {
    // 1. Символ між 👉 та 👈
    const symbolMatch = text.match(/👉([A-Z0-9]+)👈/);
    if (!symbolMatch) {
      logger.warn('[TELEGRAM] ENTRY signal: symbol not found between 👉👈');
      return null;
    }
    const symbol = symbolMatch[1];

    // 2. Spread (опційно)
    const spreadMatch = text.match(/KuCoin\s*-\s*([\d.]+)%/);
    const spread = spreadMatch ? parseFloat(spreadMatch[1]) : null;

    // 3. Last Price — підтримка всіх форматів
    let lastPriceMatch = text.match(/Last:\s*([\d.]+)/i);                           // старий англ
    if (!lastPriceMatch) lastPriceMatch = text.match(/Последняя цена:\s*([\d.]+)/i); // старий рос
    if (!lastPriceMatch) lastPriceMatch = text.match(/💱[^:]+:\s*([\d.]+)/);         // новий (BID/ASK)
    if (!lastPriceMatch) {
      logger.warn('[TELEGRAM] ENTRY signal: Last Price not found');
      return null;
    }
    const lastPrice = parseFloat(lastPriceMatch[1]);

    // 4. Mark Price — підтримка всіх форматів
    let markPriceMatch = text.match(/Mark:\s*([\d.]+)/i);                           // старий англ
    if (!markPriceMatch) markPriceMatch = text.match(/Справедливая:\s*([\d.]+)/i);  // старий рос
    if (!markPriceMatch) markPriceMatch = text.match(/Справедлива:\s*([\d.]+)/i);   // новий укр
    if (!markPriceMatch) {
      logger.warn('[TELEGRAM] ENTRY signal: Mark Price not found');
      return null;
    }
    const markPrice = parseFloat(markPriceMatch[1]);

    // 5. Визначаємо напрямок ПО ЕМОДЗІ
    // ПРАВИЛО (актуальне):
    //   🟢 = LONG
    //   🔴 = SHORT
    let direction;
    let emoji = null;

    if (text.includes('🟢')) {
      emoji = '🟢';
      direction = 'LONG';
    } else if (text.includes('🔴')) {
      emoji = '🔴';
      direction = 'SHORT';
    } else {
      logger.warn('[TELEGRAM] ENTRY signal: emoji not found (neither 🟢 nor 🔴), cannot determine direction');
      logger.warn(`[TELEGRAM] ENTRY signal text (first 200 chars): ${text.substring(0, 200)}`);
      return null;
    }

    logger.info(`[TELEGRAM] Direction determined by emoji: ${emoji} → ${direction}`);

    // 6. Час — підтримка всіх форматів
    let timeMatch = text.match(/Обнаружено:\s*([^\n]+)/i);       // старий рос
    if (!timeMatch) timeMatch = text.match(/Виявлено:\s*([^\n]+)/i); // новий укр
    const timestamp = timeMatch ? this._parseKuCoinTime(timeMatch[1]) : Date.now();

    const signal = {
      type: 'OPEN',
      symbol,
      direction,
      lastPrice,
      fairPrice: markPrice,
      spread,
      timestamp,
      emoji
    };

    logger.info(
      `[TELEGRAM] Parsed ENTRY signal: ${symbol} ${direction} | ` +
      `Emoji: ${emoji} | Spread: ${spread}%`
    );

    return signal;
  }

  /**
   * Парсить EXIT сигнал.
   * Підтримує російські та українські варіанти повідомлень.
   */
  _parseExitSignal(text) {
    let symbolMatch;

    // Російські варіанти
    symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s*-\s*Цены\s+сравнялись/i);
    if (!symbolMatch) symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s*-\s*сравнялись/i);
    if (!symbolMatch) symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s+сравнялись/i);

    // Українські варіанти
    if (!symbolMatch) symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s*-\s*Ціни\s+зрівнялись/i);
    if (!symbolMatch) symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s*-\s*зрівнялись/i);
    if (!symbolMatch) symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s+зрівнялись/i);

    // Fallback
    if (!symbolMatch) symbolMatch = text.match(/([A-Z0-9]+).*?(?:сравнялись|зрівнялись)/i);

    if (!symbolMatch) {
      logger.warn('[TELEGRAM] EXIT signal: symbol not found');
      logger.warn(`[TELEGRAM] EXIT signal text: ${text.substring(0, 100)}`);
      return null;
    }

    const symbol = symbolMatch[1];

    const signal = {
      type: 'CLOSE',
      symbol,
      timestamp: Date.now()
    };

    logger.info(`[TELEGRAM] Parsed EXIT signal: ${symbol}`);
    return signal;
  }

  /**
   * Парсить час у форматі KuCoin "16:50:19.198 UTC"
   */
  _parseKuCoinTime(timeStr) {
    try {
      const today = new Date();
      const [time] = timeStr.split(' ');
      const [hours, minutes, seconds] = time.split(':');

      today.setUTCHours(parseInt(hours), parseInt(minutes), parseInt(parseFloat(seconds)), 0);
      return today.getTime();
    } catch (error) {
      logger.warn(`[TELEGRAM] Failed to parse time: ${timeStr}`);
      return Date.now();
    }
  }

  /**
   * Реєструє callback для обробки сигналів
   */
  onSignal(callback) {
    this.signalCallbacks.push(callback);
    logger.info('[TELEGRAM] Signal callback registered');
  }

  /**
   * Відправляє повідомлення в канал або чат
   */
  async sendMessage(chatId, message, options = {}) {
    try {
      const targetChatId = chatId || this.channelId;
      await this.bot.sendMessage(targetChatId, message, {
        parse_mode: 'HTML',
        ...options
      });
      logger.info(`[TELEGRAM] Message sent to ${targetChatId}`);
    } catch (error) {
      logger.error(`[TELEGRAM] Error sending message: ${error.message}`);
      throw error;
    }
  }

  // Повідомлення про відкриття/закриття позиції прибрані навмисно

  /**
   * Форматує повідомлення про ігнорування сигналу
   */
  formatSignalIgnoredMessage(symbol, direction, reason, additionalInfo = {}) {
    let message = `⏰ <b>СИГНАЛ ПРОІГНОРОВАНО</b>\n\n<b>Символ:</b> ${symbol}\n<b>Напрямок:</b> ${direction || 'N/A'}\n<b>Причина:</b> ${reason}`;

    if (additionalInfo.currentSpread) message += `\n\n<b>Поточний spread:</b> ${additionalInfo.currentSpread}`;
    if (additionalInfo.minRequired)   message += `\n<b>Мінімум потрібно:</b> ${additionalInfo.minRequired}`;
    if (additionalInfo.currentTime)   message += `\n\n<b>Поточний час:</b> ${additionalInfo.currentTime} UTC`;
    if (additionalInfo.tradingHours)  message += `\n<b>Торгові години:</b> ${additionalInfo.tradingHours}`;
    if (additionalInfo.nextTrading)   message += `\n<b>Наступна торгівля:</b> через ${additionalInfo.nextTrading}`;

    return message;
  }

  /**
   * Форматує щоденний звіт
   */
  formatDailyReport(report) {
    const winRate = report.totalTrades > 0
      ? ((report.winTrades / report.totalTrades) * 100).toFixed(1)
      : '0.0';

    const pnlEmoji = report.totalPnl >= 0 ? '💰' : '📉';
    const roiEmoji = report.roi >= 0 ? '📈' : '📉';

    return `📊 <b>ЩОДЕННИЙ ЗВІТ</b>

<b>Дата:</b> ${report.date}
<b>Торгові години:</b> ${report.tradingHours.startHour}:00-${report.tradingHours.endHour}:00 UTC
<b>Всього сигналів:</b> ${report.totalSignals}
<b>Проігноровано (поза годинами):</b> ${report.signalsIgnored}
<b>Всього угод:</b> ${report.totalTrades}
✅ <b>Виграшних:</b> ${report.winTrades} (${winRate}%)
❌ <b>Програшних:</b> ${report.loseTrades} (${(100 - parseFloat(winRate)).toFixed(1)}%)
${pnlEmoji} <b>Загальний P&L:</b> ${report.totalPnl >= 0 ? '+' : ''}$${report.totalPnl.toFixed(2)}
${roiEmoji} <b>ROI:</b> ${report.roi >= 0 ? '+' : ''}${report.roi.toFixed(2)}%

<b>Баланс:</b> $${report.startBalance.toFixed(2)} → $${report.currentBalance.toFixed(2)}`;
  }
}

// Експортуємо singleton
const telegramService = new TelegramService();
export default telegramService;
