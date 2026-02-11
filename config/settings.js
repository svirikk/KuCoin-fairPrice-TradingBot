import dotenv from 'dotenv';

dotenv.config();

// Валідація обов'язкових змінних
const requiredEnvVars = [
  'KUCOIN_API_KEY',
  'KUCOIN_API_SECRET',
  'KUCOIN_API_PASSPHRASE',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

export const config = {
  // KuCoin Futures API
  kucoin: {
    apiKey: process.env.KUCOIN_API_KEY,
    apiSecret: process.env.KUCOIN_API_SECRET,
    apiPassphrase: process.env.KUCOIN_API_PASSPHRASE,
    baseURL: 'https://api-futures.kucoin.com',
    // KuCoin не має testnet для futures, тільки mainnet
    testnet: false
  },

  // Telegram
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    channelId: process.env.TELEGRAM_CHANNEL_ID
  },

  // Risk Management
  // TP/SL більше не використовуються — позиція закривається по EXIT-сигналу
  risk: {
    leverage: parseInt(process.env.LEVERAGE || '10'),
    positionSizePercent: parseFloat(process.env.POSITION_SIZE_PERCENT || '5')
    // POSITION_SIZE_PERCENT — відсоток від futures-балансу на одну угоду
  },

  // Trading Settings
  trading: {
    allowedSymbols: (process.env.ALLOWED_SYMBOLS || 'XBTUSDTM,ETHUSDTM').split(',').map(s => s.trim()),
    maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20'),
    maxOpenPositions: parseInt(process.env.MAX_OPEN_POSITIONS || '3'),
    dryRun: process.env.DRY_RUN === 'true'
  },

  // Trading Hours (UTC)
  tradingHours: {
    enabled: process.env.TRADING_HOURS_ENABLED === 'true',
    startHour: parseInt(process.env.TRADING_START_HOUR || '0'),
    endHour: parseInt(process.env.TRADING_END_HOUR || '23'),
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
