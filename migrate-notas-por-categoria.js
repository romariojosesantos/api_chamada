// Migração: recria `notas` por CATEGORIA pedagógica (educacional/esportivo/
// cul_teoria/cul_pratica/danca) em vez de por turma exata — ver
// backend/categorias-avaliativas.js. A tabela anterior só tinha dado de
// teste (nenhuma nota real lançada ainda), então é seguro dropar e recriar
// em vez de migrar dado — mais simples e sem risco de arrastar o desenho
// antigo (id_atividade + nota_prova/nota_pratica) pra um formato que não
// existe mais.
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
    console.log('Conectado ao banco. Recriando tabela notas (por categoria)...');

    await db.query('DROP TABLE IF EXISTS notas');
    console.log('Tabela notas antiga removida.');

    await db.query(`
      CREATE TABLE notas (
        id INT AUTO_INCREMENT PRIMARY KEY,
        id_instituicao INT NOT NULL,
        id_periodo INT NOT NULL,
        id_aluno INT NOT NULL,
        categoria VARCHAR(20) NOT NULL,
        nota DECIMAL(4,1) NULL,
        lancado_por INT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_nota_periodo_aluno_categoria (id_periodo, id_aluno, categoria),
        INDEX idx_notas_periodo (id_periodo),
        FOREIGN KEY (id_periodo) REFERENCES periodos_avaliativos(id) ON DELETE CASCADE,
        FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE
      )
    `);
    console.log('Tabela notas (por categoria) criada.');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
