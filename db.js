const mysql = require('mysql2/promise');
require('dotenv').config();

const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV !== undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  // Em serverless (Vercel), usar apenas 1 conexão por execução
  connectionLimit: isVercel ? 1 : 20,
  queueLimit: 0,
  enableKeepAlive: !isVercel,
  keepAliveInitialDelay: 0,
  connectTimeout: 60000,
  acquireTimeout: 60000,
  timeout: 60000
});

module.exports = pool;