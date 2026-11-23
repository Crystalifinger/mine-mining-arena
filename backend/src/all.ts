// Single-process mode for free hosting: API + worker loops + bot in one service.
await import('./server.js');
await import('./workers/index.js');
void import('./bot.js'); // long-polling loop, must not block startup
