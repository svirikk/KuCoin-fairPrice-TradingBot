import dotenv from 'dotenv';
import kucoinService from '../services/kucoin.service.js';
import logger from '../utils/logger.js';

dotenv.config();

async function checkPositions() {
  try {
    logger.info('Checking open positions on KuCoin Futures...');
    
    await kucoinService.connect();
    const positions = await kucoinService.getOpenPositions();
    
    console.log('\n' + '='.repeat(50));
    
    if (positions.length === 0) {
      console.log('📊 Немає відкритих позицій');
    } else {
      console.log(`📊 Відкриті позиції: ${positions.length}\n`);
      
      positions.forEach((pos, index) => {
        console.log(`Позиція ${index + 1}:`);
        console.log(`  Символ: ${pos.symbol}`);
        console.log(`  Напрямок: ${pos.side}`);
        console.log(`  Розмір: ${pos.size} lots`);
        console.log(`  Ціна входу: $${pos.entryPrice.toFixed(4)}`);
        console.log(`  Поточна ціна: $${pos.markPrice.toFixed(4)}`);
        console.log(`  Нереалізований P&L: ${pos.unrealisedPnl >= 0 ? '+' : ''}$${pos.unrealisedPnl.toFixed(2)}`);
        console.log(`  Плече: ${pos.leverage}x`);
        console.log('');
      });
    }
    
    console.log('='.repeat(50) + '\n');
    
    process.exit(0);
  } catch (error) {
    logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

checkPositions();
