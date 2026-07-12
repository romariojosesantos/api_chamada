const mysql = require('mysql2/promise');
require('dotenv').config();

async function populateDataInicio() {
  let db;
  try {
    db = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: process.env.DB_PORT || 3306
    });
    console.log('Conectado ao banco de dados para popular data_inicio.');

    // Atualiza todos os registros existentes com data_inicio = 2026-02-01 (fevereiro de 2026)
    // e data_fim = NULL (ativos)
    const [result] = await db.query(`
      UPDATE matricula 
      SET data_inicio = '2026-02-01', data_fim = NULL 
    `);
    
    console.log(`Atualizados ${result.affectedRows} registros de matrícula com data_inicio = 2026-02-01.`);
    console.log('Migração concluída com sucesso!');
  } catch (error) {
    console.error('Erro ao popular data_inicio:', error);
  } finally {
    if (db) {
      await db.end();
      console.log('Conexão com o banco de dados fechada.');
    }
  }
}

populateDataInicio();
