import dotenv from 'dotenv';
import kucoinService from '../services/kucoin.service.js';
import logger from '../utils/logger.js';

dotenv.config();

async function checkBalance() {
  try {
    logger.info('Checking KuCoin Futures balance...');
    
    await kucoinService.connect();
    const balance = await kucoinService.getUSDTBalance();
    
    console.log('\n' + '='.repeat(50));
    console.log(`💰 USDT Balance: ${balance.toFixed(2)} USDT`);
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

checkBalance();
