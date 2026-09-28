// Migração: coluna `chamada_conexao.id_usuario` — quem fez a ação registrada no
// log de auditoria. Antes só se sabia o quê, quando e em qual instituição, o que
// não bastou para descobrir quem lançou chamada em dias futuros. Preenchida por
// src/utils/audit.js com o usuário da requisição; NULL nos crons e nos registros
// antigos. Pode rodar antes ou depois do deploy: sem a coluna, audit.js grava sem ela.
const mysql = require('mysql2/promise');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  try {
    console.log('Conectado ao banco.');

    const [colunas] = await db.query("SHOW COLUMNS FROM chamada_conexao LIKE 'id_usuario'");
    if (colunas.length === 0) {
      await db.query(
        'ALTER TABLE chamada_conexao ADD COLUMN id_usuario INT NULL AFTER id_instituicao',
      );
      console.log('Coluna chamada_conexao.id_usuario criada.');
    } else {
      console.log('Coluna chamada_conexao.id_usuario já existia.');
    }

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
