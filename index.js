import dotenv from 'dotenv';

// 🔹 Завантажуємо .env ТІЛЬКИ локально
if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}

import { config } from './config/settings.js';
import logger from './utils/logger.js';
import bybitService from './services/bybit.service.js';
import telegramService from './services/telegram.service.js';
import positionService from './services/position.service.js';
import riskService from './services/risk.service.js';
import { isTradingHoursActive, getTradingHoursInfo } from './services/time.service.js';
import { isSymbolAllowed, getCurrentDate } from './utils/helpers.js';


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
    logger.info('Starting Bybit Futures Trading Bot...');
    logger.info('='.repeat(50));

    // Підключення до Bybit
    await bybitService.connect();

    // Отримуємо початковий баланс
    statistics.startBalance = await bybitService.getUSDTBalance();
    statistics.currentBalance = statistics.startBalance;

    logger.info(`[INIT] Starting balance: ${statistics.startBalance} USDT`);
    logger.info(`[INIT] Dry Run mode: ${config.trading.dryRun ? 'ENABLED' : 'DISABLED'}`);
    logger.info(`[INIT] Allowed symbols: ${config.trading.allowedSymbols.join(', ')}`);
    logger.info(`[INIT] Position size: ${config.risk.positionSizePercent}%, Leverage: ${config.risk.leverage}x`);
    logger.info(`[INIT] Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`);

    // Реєструємо обробник сигналів
    telegramService.onSignal(handleSignal);

    // Запускаємо моніторинг позицій
    positionService.startMonitoring(30000); // Перевірка кожні 30 секунд

    // Відправляємо повідомлення про запуск
    if (!config.trading.dryRun) {
      await telegramService.sendMessage(
        config.telegram.channelId,
        `🤖 <b>TRADING BOT STARTED</b>\n\n` +
        `Balance: ${statistics.startBalance.toFixed(2)} USDT\n` +
        `Mode: ${config.trading.dryRun ? 'DRY RUN' : 'LIVE TRADING'}\n` +
        `Position size: ${config.risk.positionSizePercent}% | Leverage: ${config.risk.leverage}x\n` +
        `Trading hours: ${config.tradingHours.startHour}:00-${config.tradingHours.endHour}:00 UTC`
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
 * Обробка торговельного сигналу від Spread Monitor Bot.
 *
 * Розгалуження:
 *   - signal.type === 'OPEN'  → openPosition()
 *   - signal.type === 'CLOSE' → closePosition()
 */
async function handleSignal(signal) {
  try {
    statistics.totalSignals++;

    const { type, symbol, direction, timestamp } = signal;

    logger.info(`[SIGNAL] Processing: type=${type} symbol=${symbol} direction=${direction}`);

    // --- OPEN сигнал ---
    if (type === 'OPEN') {
      // Валідація сигналу
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

      // Відкриваємо позицію
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
          `❌ <b>ERROR PROCESSING SIGNAL</b>\n\n` +
          `Type: ${signal.type || 'UNKNOWN'}\n` +
          `Symbol: ${signal.symbol || 'UNKNOWN'}\n` +
          `Direction: ${signal.direction || 'UNKNOWN'}\n` +
          `Error: ${error.message}`
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
  const { symbol, direction } = signal;

  // 1. Перевірка символу
  if (!isSymbolAllowed(symbol, config.trading.allowedSymbols.join(','))) {
    return {
      valid: false,
      reason: `Symbol ${symbol} not in allowed list`,
      info: {}
    };
  }

  // 2. Перевірка напрямку
  if (direction !== 'LONG' && direction !== 'SHORT') {
    return {
      valid: false,
      reason: `Invalid direction: ${direction}`,
      info: {}
    };
  }

  // 3. Перевірка торговельних годин
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

  // 4. Перевірка відкритих позицій
  if (positionService.hasOpenPosition(symbol)) {
    return {
      valid: false,
      reason: `Open position already exists for ${symbol}`,
      info: {}
    };
  }

  // 5. Перевірка максимальної кількості відкритих позицій
  if (positionService.getOpenPositionsCount() >= config.trading.maxOpenPositions) {
    return {
      valid: false,
      reason: `Maximum open positions (${config.trading.maxOpenPositions}) reached`,
      info: {}
    };
  }

  // 6. Перевірка максимальної кількості угод на день
  if (statistics.dailyTrades >= config.trading.maxDailyTrades) {
    return {
      valid: false,
      reason: `Maximum daily trades (${config.trading.maxDailyTrades}) reached`,
      info: {}
    };
  }

  // 7. Перевірка балансу
  try {
    const balance = await bybitService.getUSDTBalance();
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

  // 8. Перевірка що символ існує та торгується
  try {
    const symbolInfo = await bybitService.getSymbolInfo(symbol);
    if (symbolInfo.status !== 'Trading') {
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
 * TP/SL НЕ встановлюються — позиція закривається виключно по CLOSE сигналу.
 */
async function openPosition(signal) {
  const { symbol, direction, timestamp } = signal;

  try {
    logger.info(`[TRADE] Opening position: ${symbol} ${direction}`);

    // Отримуємо поточний баланс
    const balance = await bybitService.getUSDTBalance();
    statistics.currentBalance = balance;

    // Отримуємо поточну ціну
    const currentPrice = await bybitService.getCurrentPrice(symbol);

    // Отримуємо інформацію про символ
    const symbolInfo = await bybitService.getSymbolInfo(symbol);

    // Розраховуємо параметри позиції (БЕЗ TP/SL)
    const positionParams = riskService.calculatePositionParameters(
      balance,
      currentPrice,
      direction,
      symbolInfo
    );

    // Перевірка достатності балансу
    if (!riskService.hasSufficientBalance(balance, positionParams.requiredMargin)) {
      throw new Error(
        `Insufficient balance. Required: ${positionParams.requiredMargin.toFixed(4)} USDT, ` +
        `Available: ${balance.toFixed(4)} USDT`
      );
    }

    if (config.trading.dryRun) {
      // DRY RUN режим - тільки логування
      logger.info('[DRY RUN] Would open position:');
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Entry Price: ${positionParams.entryPrice}`);
      logger.info(`  Quantity: ${positionParams.quantity}`);
      logger.info(`  Position Size: ${positionParams.positionSizeUSDT} USDT`);
      logger.info(`  Required Margin: ${positionParams.requiredMargin} USDT`);

      // Симулюємо успішне відкриття
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
    // 1. Встановлюємо плече
    await bybitService.setLeverage(symbol, config.risk.leverage);

    // 2. Відкриваємо Market ордер
    const side = direction === 'LONG' ? 'Buy' : 'Sell';
    const positionIdx = bybitService.getPositionIdx(direction);
    const orderResult = await bybitService.openMarketOrder(
      symbol,
      side,
      positionParams.quantity,
      positionIdx
    );

    // 3. TP/SL НЕ встановлюються — позиція закривається по CLOSE сигналу

    // 4. Додаємо позицію до моніторингу
    positionService.addOpenPosition({
      symbol,
      direction,
      entryPrice: positionParams.entryPrice,
      quantity: positionParams.quantity,
      orderId: orderResult.orderId,
      timestamp,
      positionIdx: positionIdx,
      positionSizeUSDT: positionParams.positionSizeUSDT
    });

    // 5. Оновлюємо статистику
    statistics.totalTrades++;
    statistics.dailyTrades++;

    // 6. Відправляємо повідомлення в Telegram
    await telegramService.sendMessage(
      config.telegram.channelId,
      telegramService.formatPositionOpenedMessage({
        ...positionParams,
        balance,
        timestamp
      })
    );

    logger.info(`[TRADE] ✅ Position opened successfully: ${symbol} ${direction}`);

  } catch (error) {
    logger.error(`[TRADE] Error opening position: ${error.message}`);
    throw error;
  }
}

/**
 * Закриття позиції по CLOSE сигналу від Spread Monitor Bot.
 *
 * Логіка:
 *   1. Перевіряє наявність відкритої позиції через positionService
 *   2. Якщо є — закриває Market ордером з reduceOnly: true
 *   3. Відправляє повідомлення в Telegram
 *   4. Видаляє позицію з positionService
 */
async function closePosition(signal) {
  const { symbol, direction } = signal;

  try {
    logger.info(`[TRADE] Received CLOSE signal: ${symbol} ${direction}`);

    // 1. Перевіряємо наявність відкритої позиції
    if (!positionService.hasOpenPosition(symbol)) {
      logger.warn(`[TRADE] No open position found for ${symbol} — ignoring CLOSE signal`);
      return;
    }

    const trackedPosition = positionService.getOpenPosition(symbol);

    // Перевіряємо співпадіння напрямку (опціонально - для надійності)
    if (trackedPosition.direction !== direction) {
      logger.warn(
        `[TRADE] Direction mismatch: tracked=${trackedPosition.direction}, signal=${direction} — ignoring CLOSE signal`
      );
      return;
    }

    if (config.trading.dryRun) {
      // DRY RUN — симулюємо закриття
      logger.info('[DRY RUN] Would close position:');
      logger.info(`  Symbol: ${symbol}`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Entry Price: ${trackedPosition.entryPrice}`);
      logger.info(`  Quantity: ${trackedPosition.quantity}`);

      // Видаляємо з positionService
      positionService.removeOpenPosition(symbol);

      logger.info(`[TRADE] ✅ [DRY RUN] Position closed: ${symbol}`);
      return;
    }

    // 2. Реальна торгівля - закриваємо на біржі
    // Визначаємо closeSide: LONG → Sell, SHORT → Buy
    const closeSide = direction === 'LONG' ? 'Sell' : 'Buy';
    const positionIdx = trackedPosition.positionIdx || bybitService.getPositionIdx(direction);

    const closeResult = await bybitService.closeMarketOrder(
      symbol,
      closeSide,
      trackedPosition.quantity,
      positionIdx
    );

    logger.info(`[TRADE] Close order executed: Order ID ${closeResult.orderId}`);

    // 3. positionService.checkPositions() виявить закриття та відправить повідомлення
    // Альтернативно можна одразу видалити позицію тут:
    // positionService.removeOpenPosition(symbol);

    logger.info(`[TRADE] ✅ Position close order submitted: ${symbol} ${direction}`);

  } catch (error) {
    logger.error(`[TRADE] Error closing position ${symbol}: ${error.message}`);

    // Відправляємо повідомлення про помилку
    try {
      if (!config.trading.dryRun) {
        await telegramService.sendMessage(
          config.telegram.channelId,
          `❌ <b>ERROR CLOSING POSITION</b>\n\n` +
          `Symbol: ${symbol}\n` +
          `Direction: ${direction}\n` +
          `Error: ${error.message}`
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
    setInterval(sendDailyReport, 24 * 60 * 60 * 1000); // Кожні 24 години
  }, msUntilReport);

  logger.info(`[REPORT] Daily report scheduled for ${reportTime.toISOString()}`);
}

/**
 * Відправляє щоденний звіт
 */
async function sendDailyReport() {
  try {
    const currentDate = getCurrentDate();

    // Скидаємо щоденну статистику якщо новий день
    if (currentDate !== statistics.lastResetDate) {
      statistics.dailyTrades = 0;
      statistics.signalsIgnored = 0;
      statistics.lastResetDate = currentDate;
      positionService.resetDailyStatistics();
    }

    const posStats = positionService.getStatistics();
    const currentBalance = await bybitService.getUSDTBalance();
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
      `🛑 <b>TRADING BOT STOPPED</b>\n\n` +
      `Open positions: ${positionService.getOpenPositionsCount()}\n` +
      `Total trades today: ${statistics.dailyTrades}`
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
