// Migração: coluna `alunos.motivo_desistencia` — motivo registrado quando o
// aluno desiste (ex.: "Escola Integral", "Desinteresse - aluno"), preenchida
// junto com `inativado_em` ao registrar uma desistência retroativa.
const mysql = require('mysql2/promise');
require('dotenv').config();

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306
  });

  try {
    console.log('Conectado ao banco.');

    const [colunas] = await db.query("SHOW COLUMNS FROM alunos LIKE 'motivo_desistencia'");
    if (colunas.length === 0) {
      await db.query("ALTER TABLE alunos ADD COLUMN motivo_desistencia VARCHAR(255) NULL AFTER inativado_em");
      console.log('Coluna alunos.motivo_desistencia criada.');
    } else {
      console.log('Coluna alunos.motivo_desistencia já existia.');
    }

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
