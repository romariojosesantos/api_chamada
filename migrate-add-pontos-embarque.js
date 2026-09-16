// Migração: tabela `pontos_embarque` — lista de pontos de embarque/entrega
// (campo "Ponto" do cadastro do aluno) que cada instituição mantém a sua
// própria, em vez de digitar texto livre repetido. UNIQUE (id_instituicao,
// nome) evita duplicar o mesmo ponto duas vezes na mesma instituição.
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'pontos_embarque'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE pontos_embarque (
          id INT PRIMARY KEY AUTO_INCREMENT,
          id_instituicao INT NOT NULL,
          nome VARCHAR(150) NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_ponto_por_instituicao (id_instituicao, nome),
          FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela pontos_embarque criada.');
    } else {
      console.log('Tabela pontos_embarque já existia.');
    }

    // Popular com os valores já usados em alunos.ponto, por instituição, pra
    // quem já tinha dado digitado não perder nada ao trocar pra dropdown.
    const [existentes] = await db.query(
      `SELECT DISTINCT id_instituicao, TRIM(ponto) AS ponto
       FROM alunos
       WHERE ponto IS NOT NULL AND TRIM(ponto) != '' AND excluido_em IS NULL`
    );
    let inseridos = 0;
    for (const row of existentes) {
      const [result] = await db.query(
        'INSERT IGNORE INTO pontos_embarque (id_instituicao, nome) VALUES (?, ?)',
        [row.id_instituicao, row.ponto]
      );
      inseridos += result.affectedRows;
    }
    console.log(`${inseridos} ponto(s) importado(s) a partir do cadastro existente de alunos.`);

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
