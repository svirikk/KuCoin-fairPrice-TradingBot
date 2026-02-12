import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config/settings.js';
import logger from '../utils/logger.js';

class KuCoinService {
  constructor() {
    this.apiKey = config.kucoin.apiKey;
    this.apiSecret = config.kucoin.apiSecret;
    this.apiPassphrase = config.kucoin.apiPassphrase;
    this.baseURL = config.kucoin.baseURL;
    this.isConnected = false;
  }

  /**
   * Генерує підпис для KuCoin API V1
   * 
   * Формула: base64(hmac-sha256(timestamp + method + requestPath + body, secretKey))
   */
  _generateSignature(timestamp, method, requestPath, body = '') {
    const strToSign = timestamp + method.toUpperCase() + requestPath + body;
    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(strToSign)
      .digest('base64');
    return signature;
  }

  /**
   * Генерує зашифрований passphrase для KuCoin API V2
   * 
   * Формула: base64(hmac-sha256(passphrase, secretKey))
   */
  _generatePassphrase() {
    return crypto
      .createHmac('sha256', this.apiSecret)
      .update(this.apiPassphrase)
      .digest('base64');
  }

  /**
   * Створює заголовки для KuCoin API запиту
   */
  _getHeaders(method, requestPath, body = '') {
    const timestamp = Date.now().toString();
    const signature = this._generateSignature(timestamp, method, requestPath, body);
    const passphrase = this._generatePassphrase();

    return {
      'KC-API-KEY': this.apiKey,
      'KC-API-SIGN': signature,
      'KC-API-TIMESTAMP': timestamp,
      'KC-API-PASSPHRASE': passphrase,
      'KC-API-KEY-VERSION': '2',
      'Content-Type': 'application/json'
    };
  }

  /**
   * Виконує GET запит до KuCoin API
   */
  async _get(endpoint, params = {}) {
    try {
      const queryString = new URLSearchParams(params).toString();
      const requestPath = queryString ? `${endpoint}?${queryString}` : endpoint;
      
      const headers = this._getHeaders('GET', requestPath);
      
      const response = await axios.get(`${this.baseURL}${requestPath}`, { headers });
      
      if (response.data.code !== '200000') {
        throw new Error(`KuCoin API Error: ${response.data.msg || 'Unknown error'}`);
      }
      
      return response.data.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`KuCoin API Error: ${error.response.data?.msg || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Виконує POST запит до KuCoin API
   */
  async _post(endpoint, data = {}) {
    try {
      const body = JSON.stringify(data);
      const headers = this._getHeaders('POST', endpoint, body);
      
      const response = await axios.post(`${this.baseURL}${endpoint}`, data, { headers });
      
      if (response.data.code !== '200000') {
        throw new Error(`KuCoin API Error: ${response.data.msg || 'Unknown error'}`);
      }
      
      return response.data.data;
    } catch (error) {
      if (error.response) {
        throw new Error(`KuCoin API Error: ${error.response.data?.msg || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Перевіряє з'єднання з API
   */
  async connect() {
    try {
      logger.info('[KUCOIN] Connecting to KuCoin Futures API...');
      
      // Перевіряємо підключення через отримання балансу
      await this.getUSDTBalance();
      
      this.isConnected = true;
      logger.info('[KUCOIN] ✅ Connected to KuCoin Futures MAINNET');
      return true;
    } catch (error) {
      logger.error(`[KUCOIN] Connection failed: ${error.message}`);
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Отримує баланс USDT на Futures акаунті
   * 
   * Endpoint: GET /api/v1/account-overview?currency=USDT
   */
  async getUSDTBalance() {
    try {
      const data = await this._get('/api/v1/account-overview', { currency: 'USDT' });
      
      const availableBalance = parseFloat(data.availableBalance || '0');
      logger.info(`[KUCOIN] USDT Balance: ${availableBalance} USDT`);
      
      return availableBalance;
    } catch (error) {
      logger.error(`[KUCOIN] Error getting balance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує інформацію про контракт
   * 
   * Endpoint: GET /api/v1/contracts/active
   */
  async getSymbolInfo(symbol) {
    try {
      const contracts = await this._get('/api/v1/contracts/active');
      
      const contract = contracts.find(c => c.symbol === symbol);
      if (!contract) {
        throw new Error(`Contract ${symbol} not found`);
      }

      return {
        symbol: contract.symbol,
        baseCurrency: contract.baseCurrency,
        quoteCurrency: contract.quoteCurrency,
        tickSize: parseFloat(contract.tickSize),           // Мінімальний крок ціни
        lotSize: parseFloat(contract.lotSize),             // Мінімальний крок кількості
        multiplier: parseFloat(contract.multiplier),       // Множник контракту
        minOrderQty: parseFloat(contract.minOrderQty || 1),
        maxOrderQty: parseFloat(contract.maxOrderQty || 1000000),
        status: contract.status,
        maxLeverage: parseFloat(contract.maxLeverage || 100)
      };
    } catch (error) {
      logger.error(`[KUCOIN] Error getting symbol info for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує поточну ціну контракту
   * 
   * Endpoint: GET /api/v1/ticker?symbol={symbol}
   */
  async getCurrentPrice(symbol) {
    try {
      const ticker = await this._get('/api/v1/ticker', { symbol });
      
      const lastPrice = parseFloat(ticker.price);
      logger.info(`[KUCOIN] Current price for ${symbol}: ${lastPrice}`);
      
      return lastPrice;
    } catch (error) {
      logger.error(`[KUCOIN] Error getting current price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Встановлює плече для контракту
   * 
   * На KuCoin плече встановлюється автоматично при відкритті позиції,
   * але можна змінити через position risk limit.
   * 
   * Для простоти — логуємо і повертаємо true (плече буде в ордері).
   */
  async setLeverage(symbol, leverage) {
    try {
      logger.info(`[KUCOIN] Leverage ${leverage}x will be set for ${symbol} in order`);
      
      // KuCoin не має окремого endpoint для зміни плеча як Bybit
      // Плече вказується безпосередньо в ордері через параметр 'leverage'
      // Або встановлюється через Position Risk Limit, але це складніше
      
      // Для нашого випадку — просто логуємо
      logger.info(`[KUCOIN] ✅ Leverage ${leverage}x prepared for ${symbol}`);
      return true;
    } catch (error) {
      logger.error(`[KUCOIN] Error setting leverage: ${error.message}`);
      throw error;
    }
  }

  /**
   * Відкриває Market ордер
   * 
   * Endpoint: POST /api/v1/orders
   * 
   * @param {string} symbol - Символ контракту (наприклад, 'XBTUSDTM')
   * @param {string} side - 'buy' або 'sell'
   * @param {number} quantity - Кількість контрактів (цілі числа!)
   * @param {number} leverage - Плече (1-100)
   * @param {string} marginMode - 'CROSS' або 'ISOLATED' (за замовчуванням CROSS)
   */
  async openMarketOrder(symbol, side, quantity, leverage, marginMode = 'CROSS') {
    try {
      logger.info(`[KUCOIN] Opening ${side} market order: ${quantity} lots ${symbol} (${marginMode})...`);
      
      // KuCoin вимагає clientOid (унікальний ID)
      const clientOid = uuidv4();
      
      const orderData = {
        clientOid: clientOid,
        side: side.toLowerCase(),        // 'buy' або 'sell'
        symbol: symbol,
        type: 'market',
        leverage: leverage.toString(),
        size: Math.floor(quantity),      // KuCoin вимагає цілі числа для lots!
        marginMode: marginMode           // CROSS або ISOLATED
      };
      
      const result = await this._post('/api/v1/orders', orderData);
      
      const orderId = result.orderId;
      logger.info(`[KUCOIN] ✅ Market order opened: Order ID ${orderId}`);
      
      return {
        orderId: orderId,
        clientOid: clientOid,
        symbol: symbol,
        side: side,
        quantity: quantity
      };
    } catch (error) {
      logger.error(`[KUCOIN] Error opening market order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Закриває позицію Market ордером
   * 
   * На KuCoin є параметр 'closeOrder: true' або можна використати
   * протилежний side з такою ж кількістю.
   * 
   * Використовуємо closeOrder: true для гарантії.
   */
  async closeMarketOrder(symbol, closeSide, quantity, leverage, marginMode = 'CROSS') {
    try {
      logger.info(`[KUCOIN] Closing position: ${closeSide} ${quantity} lots ${symbol} (${marginMode})...`);
      
      const clientOid = uuidv4();
      
      const orderData = {
        clientOid: clientOid,
        side: closeSide.toLowerCase(),   // 'buy' для SHORT, 'sell' для LONG
        symbol: symbol,
        type: 'market',
        leverage: leverage.toString(),
        size: Math.floor(quantity),
        closeOrder: true,                // Параметр для закриття позиції
        marginMode: marginMode           // CROSS або ISOLATED
      };
      
      const result = await this._post('/api/v1/orders', orderData);
      
      const orderId = result.orderId;
      logger.info(`[KUCOIN] ✅ Close order submitted: Order ID ${orderId}`);
      
      return {
        orderId: orderId,
        clientOid: clientOid,
        symbol: symbol,
        side: closeSide,
        quantity: quantity
      };
    } catch (error) {
      logger.error(`[KUCOIN] Error closing position for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Отримує відкриті позиції
   * 
   * Endpoint: GET /api/v1/positions
   */
  async getOpenPositions(symbol = null) {
    try {
      const positions = await this._get('/api/v1/positions');
      
      let filtered = positions.filter(pos => parseFloat(pos.currentQty || '0') !== 0);
      
      if (symbol) {
        filtered = filtered.filter(pos => pos.symbol === symbol);
      }
      
      return filtered.map(pos => ({
        symbol: pos.symbol,
        side: parseFloat(pos.currentQty) > 0 ? 'Buy' : 'Sell',
        size: Math.abs(parseFloat(pos.currentQty || '0')),
        entryPrice: parseFloat(pos.avgEntryPrice || '0'),
        markPrice: parseFloat(pos.markPrice || '0'),
        unrealisedPnl: parseFloat(pos.unrealisedPnl || '0'),
        leverage: parseFloat(pos.realLeverage || '1')
      }));
    } catch (error) {
      logger.error(`[KUCOIN] Error getting open positions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Перевіряє чи є відкрита позиція по символу
   */
  async hasOpenPosition(symbol) {
    const positions = await this.getOpenPositions(symbol);
    return positions.length > 0;
  }

  /**
   * Отримує історію угод
   * 
   * Endpoint: GET /api/v1/recentDoneOrders
   */
  async getTradeHistory(symbol = null) {
    try {
      const orders = await this._get('/api/v1/recentDoneOrders');
      
      if (symbol) {
        return orders.filter(order => order.symbol === symbol);
      }
      
      return orders;
    } catch (error) {
      logger.error(`[KUCOIN] Error getting trade history: ${error.message}`);
      throw error;
    }
  }
}

// Експортуємо singleton
const kucoinService = new KuCoinService();
export default kucoinService;
