// Migração: remove a trava de "só 1 ponto de atividade INTERNA por dia"
// (UNIQUE KEY uniq_ponto_professor_interno_data, criada em
// migrate-add-tipos-ponto-interno.js). Ela impedia exatamente o que foi
// pedido: bater a mesma atividade interna (ex.: "Planejamento") mais de uma
// vez no mesmo dia — de manhã, encerra, e um novo "Planejamento" à tarde
// (ou no mesmo turno, independente) — mesmo já tendo encerrado a sessão
// anterior direito. Turma continua 1x/dia (uniq_ponto_professor_turma_data
// não muda — uma turma só acontece uma vez no horário fixo dela naquele dia).
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

    const [indice] = await db.query("SHOW INDEX FROM pontos WHERE Key_name = 'uniq_ponto_professor_interno_data'");
    if (indice.length > 0) {
      await db.query('ALTER TABLE pontos DROP INDEX uniq_ponto_professor_interno_data');
      console.log('Índice uniq_ponto_professor_interno_data removido.');
    } else {
      console.log('Índice uniq_ponto_professor_interno_data já não existia.');
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
