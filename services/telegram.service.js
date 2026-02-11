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
    // Слухаємо повідомлення З КАНАЛУ
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
   * Розпізнає два типи:
   *   - "🚨 KuCoin"          — відкриття позиції (ENTRY)
   *   - "Цены сравнялись"   — закриття позиції (EXIT)
   */
  isSignalMessage(text) {
    if (!text) return false;
    
    // ENTRY: "🚨 KuCoin - X.XX%"
    const isEntry = text.includes('🚨 KuCoin') && text.includes('👉') && text.includes('👈');
    
    // EXIT: "✅ ... Цены сравнялись!"
    const isExit = text.includes('Цены сравнялись');
    
    return isEntry || isExit;
  }

  /**
   * Парсить сигнал з повідомлення KuCoin Monitor Bot.
   *
   * Тип 1 — ENTRY (відкриття):
   *   Формат:
   *     🚨 KuCoin - 5.55%
   *     👉BLESSUSDTM👈
   *     🟢 Последняя цена: 0.00559200
   *     ⚖️ Справедливая: 0.00529800
   *     ⏰ Обнаружено: 16:50:19.198 UTC
   *
   *   Повертає: { type: 'OPEN', symbol, direction, lastPrice, fairPrice, spread, timestamp }
   *
   * Тип 2 — EXIT (закриття):
   *   Формат:
   *     ✅ BLESSUSDTM - Цены сравнялись!
   *     ⏱️ Через: 11 сек 850 мс
   *     💰 Последняя цена: 0.00562100
   *
   *   Повертає: { type: 'CLOSE', symbol, timestamp }
   */
  parseSignal(text) {
    try {
      // Спочатку перевіряємо EXIT
      if (text.includes('Цены сравнялись')) {
        return this._parseExitSignal(text);
      }

      // Інакше це ENTRY
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
   * Парсить ENTRY сигнал з динамічним визначенням напрямку.
   *
   * ЛОГІКА НАПРЯМКУ:
   *   Last Price > Fair Price  →  SHORT (ціна завищена, очікуємо падіння)
   *   Last Price < Fair Price  →  LONG  (ціна занижена, очікуємо зростання)
   *
   * Формат:
   *   🚨 KuCoin - 5.55%
   *   👉BLESSUSDTM👈
   *   🟢 Последняя цена: 0.00559200
   *   ⚖️ Справедливая: 0.00529800
   *   ⏰ Обнаружено: 16:50:19.198 UTC
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

    // 3. Последняя цена (Last Price)
    const lastPriceMatch = text.match(/Последняя цена:\s*([\d.]+)/i);
    if (!lastPriceMatch) {
      logger.warn('[TELEGRAM] ENTRY signal: Last Price not found');
      return null;
    }
    const lastPrice = parseFloat(lastPriceMatch[1]);

    // 4. Справедливая (Fair Price)
    const fairPriceMatch = text.match(/Справедливая:\s*([\d.]+)/i);
    if (!fairPriceMatch) {
      logger.warn('[TELEGRAM] ENTRY signal: Fair Price not found');
      return null;
    }
    const fairPrice = parseFloat(fairPriceMatch[1]);

    // 5. Визначаємо напрямок
    let direction;
    if (lastPrice > fairPrice) {
      direction = 'SHORT'; // Ціна завищена → шортимо
    } else {
      direction = 'LONG';  // Ціна занижена → лонгуємо
    }

    // 6. Час (опційно)
    const timeMatch = text.match(/Обнаружено:\s*([^\n]+)/i);
    const timestamp = timeMatch ? this._parseKuCoinTime(timeMatch[1]) : Date.now();

    const signal = {
      type: 'OPEN',
      symbol,
      direction,
      lastPrice,
      fairPrice,
      spread,
      timestamp
    };

    logger.info(
      `[TELEGRAM] Parsed ENTRY signal: ${symbol} ${direction} | ` +
      `Last=${lastPrice} Fair=${fairPrice} (${lastPrice > fairPrice ? 'Over' : 'Under'}valued)`
    );

    return signal;
  }

  /**
   * Парсить EXIT сигнал.
   *
   * Формат:
   *   ✅ BLESSUSDTM - Цены сравнялись!
   *   ⏱️ Через: 11 сек 850 мс
   *   💰 Последняя цена: 0.00562100
   */
  _parseExitSignal(text) {
    // Символ до " - Цены сравнялись"
    const symbolMatch = text.match(/✅\s*([A-Z0-9]+)\s*-\s*Цены сравнялись/i);
    if (!symbolMatch) {
      logger.warn('[TELEGRAM] EXIT signal: symbol not found');
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
      // Формат: "16:50:19.198 UTC"
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

  /**
   * Форматує повідомлення про відкриття позиції
   */
  formatPositionOpenedMessage(positionData) {
    const {
      symbol,
      direction,
      entryPrice,
      quantity,
      leverage,
      positionSizeUSDT,
      balance,
      timestamp
    } = positionData;

    const cleanSymbol = symbol ? symbol.replace('USDTM', '').replace('USDT', '') : 'UNKNOWN';
    const directionEmoji = direction === 'LONG' ? '📈' : '📉';

    return `✅ <b>ПОЗИЦІЯ ВІДКРИТА</b>

<b>Символ:</b> ${symbol}
<b>Напрямок:</b> ${directionEmoji} ${direction}
<b>Ціна входу:</b> $${entryPrice}
<b>Кількість:</b> ${quantity} ${cleanSymbol}
<b>Плече:</b> ${leverage}x
💰 <b>Розмір позиції:</b> $${positionSizeUSDT ? positionSizeUSDT.toFixed(2) : '—'}

Сигнал: ${new Date(timestamp).toLocaleString('uk-UA', { timeZone: 'UTC' })} UTC`;
  }

  /**
   * Форматує повідомлення про закриття позиції
   */
  formatPositionClosedMessage(positionData) {
    const { symbol, direction, entryPrice, exitPrice, pnl, pnlPercent, duration } = positionData;

    const isProfit = pnl >= 0;
    const emoji = isProfit ? '🟢' : '🔴';
    const resultText = isProfit ? 'ПРОФІТ' : 'ЗБИТОК';

    return `${emoji} <b>ПОЗИЦІЯ ЗАКРИТА - ${resultText}</b>

<b>Символ:</b> ${symbol}
<b>Напрямок:</b> ${direction}
<b>Вхід:</b> $${entryPrice}
<b>Вихід:</b> $${exitPrice}
<b>Результат:</b> ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})

<b>Тривалість:</b> ${duration}`;
  }

  /**
   * Форматує повідомлення про ігнорування сигналу
   */
  formatSignalIgnoredMessage(symbol, direction, reason, additionalInfo = {}) {
    let message = `⏰ <b>СИГНАЛ ПРОІГНОРОВАНО</b>

<b>Символ:</b> ${symbol}
<b>Напрямок:</b> ${direction || 'N/A'}
<b>Причина:</b> ${reason}`;

    if (additionalInfo.currentTime) {
      message += `\n\n<b>Поточний час:</b> ${additionalInfo.currentTime} UTC`;
    }
    if (additionalInfo.tradingHours) {
      message += `\n<b>Торгові години:</b> ${additionalInfo.tradingHours}`;
    }
    if (additionalInfo.nextTrading) {
      message += `\n<b>Наступна торгівля:</b> через ${additionalInfo.nextTrading}`;
    }

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
