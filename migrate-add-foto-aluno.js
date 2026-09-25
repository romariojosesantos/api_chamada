// Migração: adiciona `alunos.foto_url` — guarda só a URL pública do arquivo
// (a imagem em si fica no bucket R2, nunca no banco, ver backend/storage.js).
// Nulo até o aluno tirar/enviar a foto pela primeira vez.
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
    const [colunas] = await db.query("SHOW COLUMNS FROM alunos LIKE 'foto_url'");
    if (colunas.length > 0) {
      console.log('Migração já aplicada (alunos.foto_url já existe). Nada a fazer.');
      return;
    }

    await db.query('ALTER TABLE alunos ADD COLUMN foto_url VARCHAR(500) NULL');
    console.log('Coluna alunos.foto_url criada.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
