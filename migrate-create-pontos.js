// Migração: cria a tabela `pontos` — registro de ponto (entrada/saída) do
// educador por turma/dia. Uma linha por (professor, turma, data): bater
// ponto grava hora_entrada; registrar saída completa a mesma linha com
// hora_saida (nunca duas linhas pra mesma aula).
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
    console.log('Conectado ao banco. Criando tabela pontos...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS pontos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        id_professor INT NOT NULL,
        id_atividade INT NOT NULL,
        data DATE NOT NULL,
        hora_entrada DATETIME NULL,
        hora_saida DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_ponto_professor_turma_data (id_professor, id_atividade, data),
        INDEX idx_pontos_instituicao_data (id_instituicao, data),
        FOREIGN KEY (id_professor) REFERENCES professores(id) ON DELETE CASCADE,
        FOREIGN KEY (id_atividade) REFERENCES atividades(idatividades) ON DELETE CASCADE
      )
    `);
    console.log('Tabela pontos criada (ou já existia).');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
