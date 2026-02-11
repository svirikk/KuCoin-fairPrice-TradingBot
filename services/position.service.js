import kucoinService from './kucoin.service.js';
import telegramService from './telegram.service.js';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';
import { calculatePnL, calculatePnLPercent, formatDuration } from '../utils/helpers.js';

class PositionService {
  constructor() {
    this.openPositions = new Map(); // symbol -> position data
    this.closedPositions = [];
    this.monitoringInterval = null;
  }

  /**
   * Додає відкриту позицію до моніторингу.
   * TP/SL більше не зберігаються — позиція закривається по CLOSE сигналу.
   * 
   * ВАЖЛИВО: KuCoin не має positionIdx (немає hedge mode),
   * тому цей параметр видалено порівняно з Bybit версією.
   */
  addOpenPosition(positionData) {
    const {
      symbol,
      direction,
      entryPrice,
      quantity,
      orderId,
      timestamp,
      positionSizeUSDT
    } = positionData;

    this.openPositions.set(symbol, {
      symbol,
      direction,
      entryPrice,
      quantity,              // lots (цілі числа)
      orderId,
      timestamp: timestamp || Date.now(),
      positionSizeUSDT: positionSizeUSDT || 0
    });

    logger.info(`[POSITION] Added position to monitoring: ${symbol} ${direction} (${quantity} lots)`);
  }

  /**
   * Видаляє позицію з моніторингу (коли закрита)
   */
  removeOpenPosition(symbol) {
    const position = this.openPositions.get(symbol);
    if (position) {
      this.openPositions.delete(symbol);
      logger.info(`[POSITION] Removed position from monitoring: ${symbol}`);
      return position;
    }
    return null;
  }

  /**
   * Додає закриту позицію до історії
   */
  addClosedPosition(positionData) {
    this.closedPositions.push({
      ...positionData,
      closedAt: Date.now()
    });

    logger.info(`[POSITION] Position closed: ${positionData.symbol}, P&L: ${positionData.pnl.toFixed(2)} USDT`);
  }

  /**
   * Перевіряє чи є відкрита позиція по символу
   */
  hasOpenPosition(symbol) {
    return this.openPositions.has(symbol);
  }

  /**
   * Отримує відкриту позицію
   */
  getOpenPosition(symbol) {
    return this.openPositions.get(symbol);
  }

  /**
   * Отримує всі відкриті позиції
   */
  getAllOpenPositions() {
    return Array.from(this.openPositions.values());
  }

  /**
   * Отримує кількість відкритих позицій
   */
  getOpenPositionsCount() {
    return this.openPositions.size;
  }

  /**
   * Запускає моніторинг позицій
   */
  startMonitoring(intervalMs = 30000) { // 30 секунд за замовчуванням
    if (this.monitoringInterval) {
      logger.warn('[POSITION] Monitoring already running');
      return;
    }

    logger.info('[POSITION] Starting position monitoring...');

    this.monitoringInterval = setInterval(async () => {
      await this.checkPositions();
    }, intervalMs);
  }

  /**
   * Зупиняє моніторинг позицій
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
      logger.info('[POSITION] Position monitoring stopped');
    }
  }

  /**
   * Перевіряє статус всіх відкритих позицій
   */
  async checkPositions() {
    try {
      if (this.openPositions.size === 0) {
        return;
      }

      // Перевіряємо КОЖЕН символ окремо (надійніше)
      for (const [symbol, trackedPosition] of this.openPositions.entries()) {
        try {
          const exchangePositions = await kucoinService.getOpenPositions(symbol);
          const exchangePosition = exchangePositions.find(pos => pos.symbol === symbol);

          if (!exchangePosition || parseFloat(exchangePosition.size) === 0) {
            // Позиція закрита на біржі
            await this.handlePositionClosed(symbol, trackedPosition);
          } else {
            // Позиція все ще відкрита, оновлюємо дані
            await this.updatePositionData(symbol, exchangePosition);
          }
        } catch (error) {
          logger.error(`[POSITION] Error checking position ${symbol}: ${error.message}`);
          continue;
        }
      }
    } catch (error) {
      logger.error(`[POSITION] Error in checkPositions: ${error.message}`);
    }
  }

  /**
   * Обробляє закриття позиції
   */
  async handlePositionClosed(symbol, trackedPosition) {
    try {
      // Отримуємо останню угоду для визначення ціни закриття
      const trades = await kucoinService.getTradeHistory(symbol);
      const closeTrade = trades.find(t =>
        t.symbol === symbol &&
        (t.side === 'sell' && trackedPosition.direction === 'LONG' ||
         t.side === 'buy' && trackedPosition.direction === 'SHORT')
      );

      const exitPrice = closeTrade ? parseFloat(closeTrade.price || closeTrade.execPrice) : trackedPosition.entryPrice;
      const duration = Math.floor((Date.now() - trackedPosition.timestamp) / 1000);

      // Розраховуємо P&L
      // ВАЖЛИВО: для KuCoin треба враховувати multiplier
      const pnl = calculatePnL(
        trackedPosition.entryPrice,
        exitPrice,
        trackedPosition.quantity,
        trackedPosition.direction
      );

      const pnlPercent = calculatePnLPercent(
        trackedPosition.entryPrice,
        exitPrice,
        trackedPosition.direction
      );

      const closedPositionData = {
        ...trackedPosition,
        exitPrice,
        pnl,
        pnlPercent,
        duration: formatDuration(duration)
      };

      // Додаємо до історії
      this.addClosedPosition(closedPositionData);

      // Видаляємо з відкритих
      this.removeOpenPosition(symbol);

      // Відправляємо повідомлення в Telegram
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          telegramService.formatPositionClosedMessage(closedPositionData)
        );
      }

      logger.info(`[POSITION] Position closed: ${symbol}, P&L: ${pnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`);
    } catch (error) {
      logger.error(`[POSITION] Error handling closed position: ${error.message}`);
    }
  }

  /**
   * Оновлює дані позиції
   */
  async updatePositionData(symbol, exchangePosition) {
    const trackedPosition = this.openPositions.get(symbol);
    if (!trackedPosition) return;

    // Оновлюємо unrealised P&L
    const unrealisedPnl = parseFloat(exchangePosition.unrealisedPnl || '0');

    logger.debug(`[POSITION] ${symbol}: Unrealised P&L: ${unrealisedPnl.toFixed(2)} USDT`);
  }

  /**
   * Отримує статистику
   */
  getStatistics() {
    const totalTrades = this.closedPositions.length;
    const winTrades = this.closedPositions.filter(p => p.pnl >= 0).length;
    const loseTrades = totalTrades - winTrades;
    const totalPnl = this.closedPositions.reduce((sum, p) => sum + p.pnl, 0);

    return {
      totalTrades,
      winTrades,
      loseTrades,
      totalPnl,
      openPositions: this.openPositions.size,
      closedPositions: totalTrades
    };
  }

  /**
   * Очищає статистику (для нового дня)
   */
  resetDailyStatistics() {
    this.closedPositions = [];
    logger.info('[POSITION] Daily statistics reset');
  }
}

// Експортуємо singleton
const positionService = new PositionService();
export default positionService;
