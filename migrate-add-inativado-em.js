// Migração: coluna `alunos.inativado_em` — data em que o aluno foi marcado
// como inativo (tela Gerenciar Matrículas, filtro "Inativos"). Preenchida
// automaticamente quando o status muda pra 'inativo' (ver PATCH /api/alunos/:id
// e PUT /api/historico-aluno/:id), e editável manualmente caso esteja errada
// (mesmo endpoint de campo único, `inativado_em` foi adicionado a
// `colunasPermitidas` em alunos.js).
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

    const [colunas] = await db.query("SHOW COLUMNS FROM alunos LIKE 'inativado_em'");
    if (colunas.length === 0) {
      await db.query("ALTER TABLE alunos ADD COLUMN inativado_em DATE NULL AFTER status");
      console.log('Coluna alunos.inativado_em criada.');
    } else {
      console.log('Coluna alunos.inativado_em já existia.');
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
