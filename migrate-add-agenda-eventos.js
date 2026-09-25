// Migração: cria a tabela `agenda_eventos` — eventos informativos da Agenda
// (institucional/área/atividade), separados de `dias_sem_aula` de propósito
// (ver comentário no topo de backend/agenda-eventos.js): nunca bloqueiam
// chamada nem entram no cálculo de frequência/faltas, só aparecem no
// calendário como marcação visual.
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
    console.log('Conectado ao banco. Criando tabela agenda_eventos...');

    await db.query(`
      CREATE TABLE IF NOT EXISTS agenda_eventos (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        tipo ENUM('institucional','area','atividade') NOT NULL,
        titulo VARCHAR(150) NOT NULL,
        descricao TEXT NULL,
        area VARCHAR(20) NULL,
        id_atividade INT NULL,
        data_inicio DATE NOT NULL,
        data_fim DATE NOT NULL,
        criado_por INT NULL,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        excluido_em TIMESTAMP NULL,
        INDEX idx_agenda_periodo (id_instituicao, data_inicio, data_fim),
        FOREIGN KEY (id_atividade) REFERENCES atividades(idatividades) ON DELETE SET NULL
      )
    `);
    console.log('Tabela agenda_eventos criada (ou já existia).');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
