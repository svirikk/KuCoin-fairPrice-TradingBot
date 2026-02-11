import dotenv from 'dotenv';

dotenv.config();

// Валідація обов'язкових змінних
const requiredEnvVars = [
  'BYBIT_API_KEY',
  'BYBIT_API_SECRET',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  // Bybit API
  bybit: {
    apiKey: process.env.BYBIT_API_KEY,
    apiSecret: process.env.BYBIT_API_SECRET,
    testnet: process.env.BYBIT_TESTNET === 'true',
    // ONE_WAY (positionIdx=0) або HEDGE (LONG idx=1, SHORT idx=2)
    positionMode: (process.env.BYBIT_POSITION_MODE || 'ONE_WAY').toUpperCase(),
    baseURL: process.env.BYBIT_TESTNET === 'true'
      ? 'https://api-testnet.bybit.com'
      : 'https://api.bybit.com'
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID
  },

  // Risk Management
  // TP/SL більше не використовуються — позиція закривається по EXIT-сигналу
  risk: {
    percentage: parseFloat(process.env.RISK_PERCENTAGE || '2.5'),  // залишено для сумісності
    leverage: parseInt(process.env.LEVERAGE || '20'),
    positionSizePercent: parseFloat(process.env.POSITION_SIZE_PERCENT || '5')
    // POSITION_SIZE_PERCENT — відсоток від futures-балансу на одну угоду
    // Наприклад: 5 означає що на одну угоду виділяється 5% балансу
  },

  // Trading Settings
  trading: {
    allowedSymbols: (process.env.ALLOWED_SYMBOLS || 'ADAUSDT,TAOUSDT,UNIUSDT').split(',').map(s => s.trim()),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
    dryRun: process.env.DRY_RUN === 'true'
  },

  // Trading Hours (UTC)
  tradingHours: {
    enabled: process.env.TRADING_HOURS_ENABLED === 'true',
    startHour: parseInt(process.env.TRADING_START_HOUR || '6'),
    endHour: parseInt(process.env.TRADING_END_HOUR || '22'),
    timezone: process.env.TIMEZONE || 'UTC'
  }
};

// Валідація конфігурації
if (config.risk.leverage <= 0 || config.risk.leverage > 100) {
  throw new Error('LEVERAGE must be between 1 and 100');
}

if (config.risk.positionSizePercent <= 0 || config.risk.positionSizePercent > 100) {
  throw new Error('POSITION_SIZE_PERCENT must be between 0 and 100');
}

if (config.trading.maxDailyTrades <= 0) {
  throw new Error('MAX_DAILY_TRADES must be greater than 0');
}

if (config.trading.maxOpenPositions <= 0) {
  throw new Error('MAX_OPEN_POSITIONS must be greater than 0');
}

if (config.tradingHours.startHour < 0 || config.tradingHours.startHour > 23) {
  throw new Error('TRADING_START_HOUR must be between 0 and 23');
}

if (config.tradingHours.endHour < 0 || config.tradingHours.endHour > 23) {
  throw new Error('TRADING_END_HOUR must be between 0 and 23');
}

export default config;
