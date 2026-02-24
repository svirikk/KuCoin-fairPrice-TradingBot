import dotenv from 'dotenv';

// 🔹 Завантажуємо .env ТІЛЬКИ локально
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

import { config } from './config/settings.js';
import logger from './utils/logger.js';
import kucoinService from './services/kucoin.service.js';
import telegramService from './services/telegram.service.js';
import positionService from './services/position.service.js';
import riskService from './services/risk.service.js';
import { isTradingHoursActive, getTradingHoursInfo } from './services/time.service.js';
import { isSymbolBlocked, getCurrentDate } from './utils/helpers.js';


// Статистика
const statistics = {
  totalTrades: 0,
  winTrades: 0,
  loseTrades: 0,
  totalProfit: 0,
  startBalance: 0,
  currentBalance: 0,
  dailyTrades: 0,
  signalsIgnored: 0,
  totalSignals: 0,
  lastResetDate: getCurrentDate()
};

/**
 * Ініціалізація бота
 */
async function initialize() {
  try {
    logger.info('='.repeat(50));
    logger.info('Starting KuCoin Futures Trading Bot...');
    logger.info('='.repeat(50));

    // Підключення до KuCoin
    await kucoinService.connect();

    // Отримуємо початковий баланс
    statistics.startBalance = await kucoinService.getUSDTBalance();
    statistics.currentBalance = statistics.startBalance;

    logger.info(`[INIT] Starting balance: ${statistics.startBalance} USDT`);
    logger.info(`[INIT] Dry Run mode: ${config.trading.dryRun ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`[INIT] Blocked symbols: ${config.trading.blockedSymbols.length > 0 ? config.trading.blockedSymbols.join(', ') : 'NONE (all symbols allowed)'}`);
    logger.info(`[INIT] Position size: ${config.risk.positionSizePercent}%, Leverage: ${config.risk.leverage}x`);
    logger.info(`[INIT] Min spread filter: ${config.risk.minSpreadPercent > 0 ? config.risk.minSpreadPercent + '%' : 'DISABLED'}`);
    logger.info(`[INIT] Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`);

    // Реєструємо обробник сигналів
    telegramService.onSignal(handleSignal);

    // Запускаємо моніторинг позицій
    positionService.startMonitoring(30000);

    // Відправляємо повідомлення про запуск
    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `🤖 <b>TRADING BOT ЗАПУЩЕНО</b>\n\n` +
        `Баланс: ${statistics.startBalance.toFixed(2)} USDT\n` +
        `Режим: ${config.trading.dryRun ? 'DRY RUN' : 'LIVE TRADING'}\n` +
        `Розмір позиції: ${config.risk.positionSizePercent}% | Плече: ${config.risk.leverage}x\n` +
        `Торгові години: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`
      );
    }

    logger.info('[INIT] ✅ Bot initialized and ready to trade');

    // Запускаємо щоденний звіт
    scheduleDailyReport();

  } catch (error) {
    logger.error(`[INIT] Initialization failed: ${error.message}`);
    process.exit(1);
  }
}

/**
 * Обробка торговельного сигналу від KuCoin Monitor Bot.
 */
async function handleSignal(signal) {
  try {
    statistics.totalSignals++;

    const { type, symbol, direction, timestamp } = signal;

    logger.info(`[SIGNAL] Processing: type=${type} symbol=${symbol} direction=${direction || 'N/A'}`);

    // --- OPEN сигнал ---
    if (type === 'OPEN') {
      const validation = await validateSignal(signal);

      if (!validation.valid) {
        logger.warn(`[SIGNAL] Validation failed: ${validation.reason}`);

        try {
          if (!config.trading.dryRun) {
            await telegramService.sendMessage(
              config.telegram.channelId,
              telegramService.formatSignalIgnoredMessage(
                symbol,
                direction,
                validation.reason,
                validation.info
              )
            );
          }
        } catch (telegramError) {
          logger.error(`[SIGNAL] Error sending ignored message: ${telegramError.message}`);
        }

        if (validation.reason.includes('trading hours')) {
          statistics.signalsIgnored++;
        }

        return;
      }

      await openPosition(signal);
    }

    // --- CLOSE сигнал ---
    else if (type === 'CLOSE') {
      await closePosition(signal);
    }

    else {
      logger.warn(`[SIGNAL] Unknown signal type: ${type}`);
    }

  } catch (error) {
    logger.error(`[SIGNAL] Error handling signal: ${error.message}`);
    logger.error(`[SIGNAL] Stack trace: ${error.stack}`);

    try {
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          `❌ <b>ПОМИЛКА ОБРОБКИ СИГНАЛУ</b>\n\n` +
          `Тип: ${signal.type || 'UNKNOWN'}\n` +
          `Символ: ${signal.symbol || 'UNKNOWN'}\n` +
          `Напрямок: ${signal.direction || 'UNKNOWN'}\n` +
          `Помилка: ${error.message}`
        );
      }
    } catch (telegramError) {
      logger.error(`[SIGNAL] Error sending error message: ${telegramError.message}`);
    }
  }
}

/**
 * Валідація сигналу перед відкриттям позиції
 */
async function validateSignal(signal) {
  const { symbol, direction, spread } = signal;

  // 1. Перевірка мінімального spread
  if (config.risk.minSpreadPercent > 0) {
    if (!spread || spread < config.risk.minSpreadPercent) {
      return {
        valid: false,
        reason: `Spread ${spread ? spread.toFixed(2) : 'N/A'}% < minimum ${config.risk.minSpreadPercent}%`,
        info: {
          currentSpread: spread ? spread.toFixed(2) + '%' : 'N/A',
          minRequired: config.risk.minSpreadPercent + '%'
        }
      };
    }
  }

  // 2. Перевірка чорного списку
  if (isSymbolBlocked(symbol, config.trading.blockedSymbols.join(','))) {
    return {
      valid: false,
      reason: `Symbol ${symbol} is in blocked list`,
      info: {}
    };
  }

  // 3. Перевірка напрямку
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return {
      valid: false,
      reason: `Invalid direction: ${direction}`,
      info: {}
    };
  }

  // 4. Перевірка торговельних годин
  if (!isTradingHoursActive()) {
    const hoursInfo = getTradingHoursInfo();
    return {
      valid: false,
      reason: 'Outside trading hours',
      info: {
        currentTime: `${hoursInfo.currentHour}:${String(hoursInfo.currentMinute).padStart(2, '0')}`,
        tradingHours: `${hoursInfo.startHour}:00-${hoursInfo.endHour}:00`,
        nextTrading: hoursInfo.nextTradingIn
      }
    };
  }

  // 5. Перевірка відкритих позицій
  if (positionService.hasOpenPosition(symbol)) {
    return {
      valid: false,
      reason: `Open position already exists for ${symbol}`,
      info: {}
    };
  }

  // 6. Перевірка максимальної кількості відкритих позицій
  if (positionService.getOpenPositionsCount() >= config.trading.maxOpenPositions) {
    return {
      valid: false,
      reason: `Maximum open positions (${config.trading.maxOpenPositions}) reached`,
      info: {}
    };
  }

  // 7. Перевірка максимальної кількості угод на день
  if (statistics.dailyTrades >= config.trading.maxDailyTrades) {
    return {
      valid: false,
      reason: `Maximum daily trades (${config.trading.maxDailyTrades}) reached`,
      info: {}
    };
  }

  // 8. Перевірка балансу
  try {
    const balance = await kucoinService.getUSDTBalance();
    statistics.currentBalance = balance;

    if (balance <= 0) {
      return {
        valid: false,
        reason: 'Insufficient balance',
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Error checking balance: ${error.message}`,
      info: {}
    };
  }

  // 9. Перевірка що символ існує та торгується
  try {
    const symbolInfo = await kucoinService.getSymbolInfo(symbol);
    if (symbolInfo.status !== 'Open') {
      return {
        valid: false,
        reason: `Symbol ${symbol} is not trading`,
        info: {}
      };
    }
  } catch (error) {
    return {
      valid: false,
      reason: `Symbol ${symbol} not found or error: ${error.message}`,
      info: {}
    };
  }

  return { valid: true };
}

/**
 * Відкриття позиції по OPEN сигналу.
 */
async function openPosition(signal) {
  const { symbol, direction, timestamp } = signal;

  try {
    logger.info(`[TRADE] Opening position: ${symbol} ${direction}`);

    const balance = await kucoinService.getUSDTBalance();
    statistics.currentBalance = balance;

    const currentPrice = await kucoinService.getCurrentPrice(symbol);
    const symbolInfo = await kucoinService.getSymbolInfo(symbol);

    const positionParams = riskService.calculatePositionParameters(
      balance,
      currentPrice,
      direction,
      symbolInfo
    );

    if (!riskService.hasSufficientBalance(balance, positionParams.requiredMargin)) {
      throw new Error(
        `Insufficient balance. Required: ${positionParams.requiredMargin.toFixed(4)} USDT, ` +
        `Available: ${balance.toFixed(4)} USDT`
      );
    }

    if (config.trading.dryRun) {
      logger.info('[DRY RUN] Would open position:');
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Entry Price: ${positionParams.entryPrice}`);
      logger.info(`  Quantity: ${positionParams.quantity} lots`);
      logger.info(`  Position Size: ${positionParams.positionSizeUSDT} USDT`);
      logger.info(`  Required Margin: ${positionParams.requiredMargin} USDT`);

      positionService.addOpenPosition({
        symbol,
        direction,
        entryPrice: positionParams.entryPrice,
        quantity: positionParams.quantity,
        orderId: 'DRY_RUN_' + Date.now(),
        timestamp,
        positionSizeUSDT: positionParams.positionSizeUSDT
      });

      statistics.totalTrades++;
      statistics.dailyTrades++;

      return;
    }

    // Реальна торгівля
    await kucoinService.setLeverage(symbol, config.risk.leverage);

    const side = direction === 'LONG' ? 'buy' : 'sell';
    const orderResult = await kucoinService.openMarketOrder(
      symbol,
      side,
      positionParams.quantity,
      config.risk.leverage,
      config.risk.marginMode
    );

    positionService.addOpenPosition({
      symbol,
      direction,
      entryPrice: positionParams.entryPrice,
      quantity: positionParams.quantity,
      orderId: orderResult.orderId,
      timestamp,
      positionSizeUSDT: positionParams.positionSizeUSDT
    });

    statistics.totalTrades++;
    statistics.dailyTrades++;

    // ── Повідомлення про відкриття позиції прибрано навмисно ──

    logger.info(`[TRADE] ✅ Position opened successfully: ${symbol} ${direction}`);

  } catch (error) {
    logger.error(`[TRADE] Error opening position: ${error.message}`);
    throw error;
  }
}

/**
 * Закриття позиції по CLOSE сигналу.
 */
async function closePosition(signal) {
  const { symbol } = signal;

  try {
    logger.info(`[TRADE] Received CLOSE signal: ${symbol}`);

    if (!positionService.hasOpenPosition(symbol)) {
      logger.warn(`[TRADE] No open position found for ${symbol} — ignoring CLOSE signal`);
      return;
    }

    const trackedPosition = positionService.getOpenPosition(symbol);

    if (config.trading.dryRun) {
      logger.info('[DRY RUN] Would close position:');
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Direction: ${trackedPosition.direction}`);
      logger.info(`  Entry Price: ${trackedPosition.entryPrice}`);
      logger.info(`  Quantity: ${trackedPosition.quantity} lots`);

      positionService.removeOpenPosition(symbol);

      logger.info(`[TRADE] ✅ [DRY RUN] Position closed: ${symbol}`);
      return;
    }

    const closeSide = trackedPosition.direction === 'LONG' ? 'sell' : 'buy';

    const closeResult = await kucoinService.closeMarketOrder(
      symbol,
      closeSide,
      trackedPosition.quantity,
      config.risk.leverage,
      config.risk.marginMode
    );

    logger.info(`[TRADE] Close order executed: Order ID ${closeResult.orderId}`);
    logger.info(`[TRADE] ✅ Position close order submitted: ${symbol}`);

  } catch (error) {
    logger.error(`[TRADE] Error closing position ${symbol}: ${error.message}`);

    try {
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          `❌ <b>ПОМИЛКА ЗАКРИТТЯ ПОЗИЦІЇ</b>\n\n` +
          `Символ: ${symbol}\n` +
          `Помилка: ${error.message}`
        );
      }
    } catch (telegramError) {
      logger.error(`[TRADE] Error sending close error message: ${telegramError.message}`);
    }

    throw error;
  }
}

/**
 * Планує щоденний звіт
 */
function scheduleDailyReport() {
  const now = new Date();
  const reportTime = new Date();
  reportTime.setUTCHours(23, 0, 0, 0);

  if (reportTime <= now) {
    reportTime.setUTCDate(reportTime.getUTCDate() + 1);
  }

  const msUntilReport = reportTime - now;

  setTimeout(() => {
    sendDailyReport();
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000);
  }, msUntilReport);

  logger.info(`[REPORT] Daily report scheduled for ${reportTime.toISOString()}`);
}

/**
 * Відправляє щоденний звіт
 */
async function sendDailyReport() {
  try {
    const currentDate = getCurrentDate();

    if (currentDate !== statistics.lastResetDate) {
      statistics.dailyTrades = 0;
      statistics.signalsIgnored = 0;
      statistics.lastResetDate = currentDate;
      positionService.resetDailyStatistics();
    }

    const posStats = positionService.getStatistics();
    const currentBalance = await kucoinService.getUSDTBalance();
    const startBalance = statistics.startBalance;
    const totalPnl = currentBalance - startBalance;
    const roi = startBalance > 0 ? (totalPnl / startBalance) * 100 : 0;

    const report = {
      date: currentDate,
      tradingHours: {
        start: config.tradingHours.startHour,
        end: config.tradingHours.endHour
      },
      totalSignals: statistics.totalSignals,
      signalsIgnored: statistics.signalsIgnored,
      totalTrades: posStats.totalTrades,
      winTrades: posStats.winTrades,
      loseTrades: posStats.loseTrades,
      totalPnl: totalPnl,
      roi: roi,
      startBalance: startBalance,
      currentBalance: currentBalance
    };

    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        telegramService.formatDailyReport(report)
      );
    }

    logger.info('[REPORT] Daily report sent');
  } catch (error) {
    logger.error(`[REPORT] Error sending daily report: ${error.message}`);
  }
}

/**
 * Обробка завершення програми
 */
process.on('SIGINT', async () => {
  logger.info('\n[SHUTDOWN] Received SIGINT, shutting down gracefully...');

  positionService.stopMonitoring();

  if (!config.trading.dryRun) {
    await telegramService.sendMessage(
      config.telegram.channelId,
      `🛑 <b>TRADING BOT ЗУПИНЕНО</b>\n\n` +
      `Відкриті позиції: ${positionService.getOpenPositionsCount()}\n` +
      `Всього угод сьогодні: ${statistics.dailyTrades}`
    );
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('\n[SHUTDOWN] Received SIGTERM, shutting down gracefully...');

  positionService.stopMonitoring();
  process.exit(0);
});

// Запускаємо бота
initialize().catch(error => {
  logger.error(`[FATAL] Failed to start bot: ${error.message}`);
  process.exit(1);
});
