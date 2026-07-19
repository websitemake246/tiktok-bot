const { initSession, processCommand } = require('./bot.js');
(async () => {
  await initSession();
  console.log('=== PROFILE ===');
  console.log(await processCommand('.profile tiktok'));
  console.log('');
  console.log('=== SEARCH ===');
  console.log(await processCommand('.search cats'));
  console.log('');
  console.log('=== TRENDING ===');
  console.log(await processCommand('.trending'));
  console.log('DONE');
  process.exit();
})();
