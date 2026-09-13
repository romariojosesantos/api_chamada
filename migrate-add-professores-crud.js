// Migração: suporte a CRUD de professor (tela nova) + mais de um professor
// por turma (co-docência).
// - professores.ativo: desativar em vez de apagar (professor com histórico
//   nunca pode ser apagado, só marcado como não dando mais aula).
// - atividade_professores: professores ADICIONAIS de uma turma — o principal
//   continua em atividades.idprofessor, sem mudar nada pra quem já lê/escreve
//   essa coluna hoje (pontos.js, notas.js, grade.js, matriculas.js, etc.).
// Puramente aditivo: coluna nova com DEFAULT e tabela nova vazia — não altera
// nenhuma linha de dado existente de nenhuma instituição.
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

    const [colunaAtivo] = await db.query("SHOW COLUMNS FROM professores LIKE 'ativo'");
    if (colunaAtivo.length === 0) {
      await db.query('ALTER TABLE professores ADD COLUMN ativo TINYINT(1) NOT NULL DEFAULT 1');
      console.log('Coluna professores.ativo criada.');
    } else {
      console.log('professores.ativo já existia.');
    }

    const [tabela] = await db.query("SHOW TABLES LIKE 'atividade_professores'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE atividade_professores (
          idatividades INT NOT NULL,
          idprofessor INT NOT NULL,
          id_instituicao INT NOT NULL,
          PRIMARY KEY (idatividades, idprofessor),
          FOREIGN KEY (idatividades) REFERENCES atividades(idatividades) ON DELETE CASCADE,
          FOREIGN KEY (idprofessor) REFERENCES professores(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('Tabela atividade_professores criada.');
    } else {
      console.log('Tabela atividade_professores já existia.');
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
