// Pool de conexões MySQL compartilhado por toda a API. Todos os módulos de rota
// importam este mesmo pool (não criam conexões próprias).
const mysql = require('mysql2/promise');
require('dotenv').config();

// Em produção este backend roda como função serverless na Vercel (ver _server.js /
// api/index.js / vercel.json) — cada invocação é um processo curto e isolado, então
// manter um pool grande de conexões "quentes" não ajuda e ainda esgota o limite de
// conexões do MySQL quando várias invocações rodam em paralelo. `isVercel` detecta
// esse ambiente para usar uma única conexão por execução; localmente (`npm start`,
// processo de longa duração) o pool de 20 conexões volta a fazer sentido.
const isVercel = process.env.VERCEL === '1' || process.env.VERCEL_ENV !== undefined;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT || 3306,
  waitForConnections: true, // enfileira requisições em vez de rejeitar quando o pool está cheio
  connectionLimit: isVercel ? 1 : 20,
  queueLimit: 0,
  enableKeepAlive: !isVercel, // keep-alive não faz sentido numa conexão que só vive 1 execução
  keepAliveInitialDelay: 0,
  connectTimeout: 60000
});

module.exports = pool;
