// PM2: `pm2 start ecosystem.config.js` (después de `npm run build`).
// Las variables (PORT, DATABASE_URL, JWT_*, CORS_ORIGINS…) se leen del archivo .env de esta carpeta.
module.exports = {
  apps: [
    {
      name: 'posi-api',
      script: 'dist/main.js',
      cwd: __dirname,
      instances: 1, // una sola instancia: Socket.IO guarda las salas en memoria
      autorestart: true,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
      time: true, // fecha y hora en los logs de `pm2 logs`
    },
  ],
};
