import { config } from '../config/settings.js';
import { isValidNumber } from '../utils/helpers.js';
import logger from '../utils/logger.js';

/**
 * Розраховує параметри позиції для KuCoin Futures на основі POSITION_SIZE_PERCENT.
 *
 * Відмінності від Bybit:
 *   - KuCoin використовує LOTS (цілі числа контрактів), а не дробові quantity
 *   - Кожен контракт має multiplier (множник), наприклад 0.001 для XBTUSDTM
 *   - Формула: lots = positionSizeUSDT / (price * multiplier)
 *
 * @param {number} balance     — доступний баланс USDT
 * @param {number} entryPrice  — поточна ціна входу
 * @param {string} direction   — 'LONG' або 'SHORT'
 * @param {Object} symbolInfo  — { multiplier, lotSize, minOrderQty, maxOrderQty }
 * @returns {Object} параметри позиції
 */
export function calculatePositionParameters(balance, entryPrice, direction, symbolInfo = {}) {
  try {
    // --- Валідація вхідних даних ---
    if (!isValidNumber(balance) || balance <= 0) {
      throw new Error(`Invalid balance: ${balance}`);
    }

    if (!isValidNumber(entryPrice) || entryPrice <= 0) {
      throw new Error(`Invalid entry price: ${entryPrice}`);
    }

    if (direction !== 'LONG' && direction !== 'SHORT') {
      throw new Error(`Invalid direction: ${direction}. Must be LONG or SHORT`);
    }

    const leverage            = config.risk.leverage;
    const positionSizePercent = config.risk.positionSizePercent;

    // KuCoin специфіка
    const multiplier  = symbolInfo.multiplier || 1;       // Множник контракту
    const lotSize     = symbolInfo.lotSize || 1;          // Мінімальний крок (зазвичай 1)
    const minOrderQty = symbolInfo.minOrderQty || 1;
    const maxOrderQty = symbolInfo.maxOrderQty || 1000000;

    // 1. Розмір позиції в USDT
    const positionSizeUSDT = balance * (positionSizePercent / 100);
    logger.info(
      `[RISK] Balance: ${balance} USDT | ` +
      `Position size: ${positionSizePercent}% = ${positionSizeUSDT.toFixed(4)} USDT`
    );

    // 2. Розрахунок кількості LOTS (контрактів)
    // Формула KuCoin: lots = positionSizeUSDT / (price * multiplier)
    let lots = positionSizeUSDT / (entryPrice * multiplier);
    
    // KuCoin вимагає цілі числа!
    lots = Math.floor(lots);
    
    logger.info(
      `[RISK] Multiplier: ${multiplier} | ` +
      `Raw lots: ${(positionSizeUSDT / (entryPrice * multiplier)).toFixed(2)} → ${lots} lots (floored)`
    );

    // Перевірка мінімального розміру
    if (lots < minOrderQty) {
      logger.warn(
        `[RISK] Calculated lots (${lots}) < minimum (${minOrderQty}). Using minimum.`
      );
      lots = minOrderQty;
    }

    // Перевірка максимального розміру
    if (lots > maxOrderQty) {
      logger.warn(
        `[RISK] Calculated lots (${lots}) > maximum (${maxOrderQty}). Using maximum.`
      );
      lots = maxOrderQty;
    }

    // 3. Необхідна маржа
    // Формула: requiredMargin = (lots * price * multiplier) / leverage
    const requiredMargin = (lots * entryPrice * multiplier) / leverage;
    
    logger.info(
      `[RISK] Leverage: ${leverage}x | Required margin: ${requiredMargin.toFixed(4)} USDT`
    );

    // 4. Фінальна перевірка маржі
    if (requiredMargin > balance) {
      throw new Error(
        `Insufficient balance. Required margin: ${requiredMargin.toFixed(4)} USDT, ` +
        `Available: ${balance.toFixed(4)} USDT`
      );
    }

    const result = {
      entryPrice:       entryPrice,
      quantity:         lots,                  // У KuCoin це lots (цілі числа)
      positionSizeUSDT: lots * entryPrice * multiplier,  // Реальний розмір позиції
      leverage:         leverage,
      requiredMargin:   requiredMargin,
      direction:        direction,
      multiplier:       multiplier
      // takeProfit та stopLoss навмисно відсутні —
      // позиція закривається виключно по CLOSE-сигналу
    };

    logger.info(
      `[RISK] Position params: ${lots} lots ${direction} @ ${entryPrice} | ` +
      `Size: ${result.positionSizeUSDT.toFixed(2)} USDT | Margin: ${requiredMargin.toFixed(4)} USDT`
    );

    return result;
  } catch (error) {
    logger.error(`[RISK] Error calculating position parameters: ${error.message}`);
    throw error;
  }
}

/**
 * Перевіряє чи достатньо балансу для відкриття позиції
 *
 * @param {number} balance        — доступний баланс USDT
 * @param {number} requiredMargin — необхідна маржа USDT
 * @returns {boolean}
 */
export function hasSufficientBalance(balance, requiredMargin) {
  return (
    isValidNumber(balance) &&
    isValidNumber(requiredMargin) &&
    balance >= requiredMargin
  );
}

export default {
  calculatePositionParameters,
  hasSufficientBalance
};
