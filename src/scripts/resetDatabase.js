#!/usr/bin/env node

/**
 * FolioTrack Database Financial Reset CLI Tool
 * Completely resets all financial data (portfolios, transactions, assets, quotes)
 * starting completely empty, with automatic pre-reset safety backup.
 *
 * Usage:
 *   node src/scripts/resetDatabase.js
 *   node src/scripts/resetDatabase.js --force
 */

require('dotenv').config();
const readline = require('readline');
const { initDb, resetFinancialDatabase, closeDb } = require('../db');

async function main() {
  const isForce = process.argv.includes('--force') || process.argv.includes('-y');

  console.log('\n======================================================');
  console.log('🗑️  FOLIOTRACK - RESET DATABASE FINANZIARIO');
  console.log('======================================================');
  console.log('Questo strumento azzera completamente:');
  console.log('  • Tutti i movimenti (transazioni)');
  console.log('  • Tutti i portafogli e associazioni utente');
  console.log('  • Tutti i titoli (asset) e le quotazioni storiche');
  console.log('  • Snapshot storici NAV e proiezioni dividendi');
  console.log('\nGli account utente e le impostazioni di sistema VENGONO PRESERVATI.');
  console.log('Verrà generato un backup di sicurezza ZIP preventivo in data/backups/.\n');

  if (!isForce) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const answer = await new Promise((resolve) => {
      rl.question("Per confermare l'azzeramento definitivo, digita 'RESET': ", (ans) => {
        rl.close();
        resolve(ans.trim());
      });
    });

    if (answer.toUpperCase() !== 'RESET') {
      console.log('\n❌ Operazione annullata. Nessuna modifica apportata al database.\n');
      process.exit(0);
    }
  }

  try {
    initDb();
    console.log('\n⏳ Creazione backup di sicurezza e azzeramento tabelle in corso...');

    const result = await resetFinancialDatabase({ createSafetyBackup: true });

    console.log('\n✅ DATABASE FINANZIARIO AZZERATO CON SUCCESSO!');
    if (result.backup) {
      console.log(`📦 Backup preventivo salvato: ${result.backup.filename} (${result.backup.sizeFormatted})`);
    }
    console.log('\nRiepilogo record eliminati:');
    console.log(`  • Movimenti (transazioni): ${result.deleted.transactions}`);
    console.log(`  • Portafogli:              ${result.deleted.portfolios}`);
    console.log(`  • Titoli (assets):         ${result.deleted.assets}`);
    console.log(`  • Quotazioni storiche:     ${result.deleted.asset_quotes}`);
    console.log(`  • Storico NAV (history):   ${result.deleted.portfolio_history}`);
    console.log(`  • Proiezioni dividendi:    ${result.deleted.dividend_projections}`);
    console.log(`  • Minusvalenze fiscali:    ${result.deleted.portfolio_losses}`);
    console.log('\nIl database è ora pronto e completamente vuoto per nuovi inserimenti o importazioni CSV.\n');

    closeDb();
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Errore durante il reset del database:', err.message);
    closeDb();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };

