// Migração: cria as duas tabelas do lançamento de notas por período
// (bimestre/trimestre) — ver Notas.js/notas.js. Idempotente (CREATE TABLE IF
// NOT EXISTS), mesmo padrão de migrate-add-indexes.js — pode rodar de novo
// sem duplicar nada.
//
// `periodos_avaliativos.nome` é texto livre (não um enum "bimestre"/
// "trimestre") de propósito: cada instituição usa seu próprio esquema, e o
// sistema só precisa de um nome + intervalo de datas pra calcular a
// frequência do período — não de saber se é bimestre ou trimestre.
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
    console.log('Conectado ao banco. Criando tabelas de notas...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS periodos_avaliativos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        nome VARCHAR(100) NOT NULL,
        data_inicio DATE NOT NULL,
        data_fim DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_periodos_instituicao (id_instituicao)
      )
    `);
    console.log('Tabela periodos_avaliativos OK.');

    await db.query(`
      CREATE TABLE IF NOT EXISTS notas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        id_periodo INT NOT NULL,
        id_aluno INT NOT NULL,
        id_atividade INT NOT NULL,
        nota_prova DECIMAL(4,1) NULL,
        nota_pratica DECIMAL(4,1) NULL,
        lancado_por INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_nota_periodo_aluno_turma (id_periodo, id_aluno, id_atividade),
        INDEX idx_notas_periodo_atividade (id_periodo, id_atividade),
        FOREIGN KEY (id_periodo) REFERENCES periodos_avaliativos(id) ON DELETE CASCADE,
        FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE,
        FOREIGN KEY (id_atividade) REFERENCES atividades(idatividades) ON DELETE CASCADE
      )
    `);
    console.log('Tabela notas OK.');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
