// Migração: cria a tabela que registra toda vez que alguém precisa buscar e
// adicionar manualmente um aluno na Chamada (ele não apareceu sozinho na
// lista automática de turno/transporte do dia). Isso já gerava um evento de
// auditoria solto (chamada_conexao) e uma notificação avulsa, mas não dava
// pra montar um relatório de "quem tem cadastro provavelmente errado" sem
// parsear texto livre — essa tabela guarda os dados estruturados (turno e
// transporte cadastrados do aluno NAQUELE momento vs. o que estava
// selecionado na tela), pra alimentar esse relatório mensal.
// Idempotente (CREATE TABLE IF NOT EXISTS), mesmo padrão das outras migrações.
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
    console.log('Conectado ao banco. Criando tabela adicoes_manuais_chamada...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS adicoes_manuais_chamada (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        aluno_id INT NOT NULL,
        data DATE NOT NULL,
        turno_selecionado VARCHAR(20) NOT NULL,
        transporte_selecionado VARCHAR(100) NULL,
        aluno_transporte VARCHAR(100) NULL,
        motivo_provavel VARCHAR(20) NOT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_adicoes_manuais_inst_data (id_instituicao, data),
        FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id) ON DELETE CASCADE,
        FOREIGN KEY (aluno_id) REFERENCES alunos(id) ON DELETE CASCADE
      )
    `);
    console.log('Tabela adicoes_manuais_chamada OK.');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
