// Migração: adiciona `detalhes` (JSON) em `notificacoes` — guarda o "de/para"
// estruturado da alteração que gerou a notificação (turma antiga x nova,
// status antigo x novo, etc.), pra tela poder mostrar o que mudou de fato em
// vez de só o texto solto de `mensagem`. NULL = notificação antiga, criada
// antes dessa migração, ou de um tipo que não tem essa estrutura (aviso de
// sistema manual).
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

    const [coluna] = await db.query("SHOW COLUMNS FROM notificacoes LIKE 'detalhes'");
    if (coluna.length === 0) {
      await db.query('ALTER TABLE notificacoes ADD COLUMN detalhes JSON NULL AFTER id_aluno');
      console.log('Coluna notificacoes.detalhes criada.');
    } else {
      console.log('notificacoes.detalhes já existia.');
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
