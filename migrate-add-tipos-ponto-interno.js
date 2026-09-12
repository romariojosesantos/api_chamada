// Migração: cria a tabela `tipos_ponto_interno` (Planejamento, Reuniões,
// Monitorias, Ensaios, Outros, ou qualquer nome que cada coordenador cadastrar
// pra área dele) e ajusta `pontos` pra aceitar um ponto ligado a um desses
// tipos em vez de uma turma — ver backend/tiposPontoInterno.js (CRUD) e
// backend/pontos.js (bater/saida-interno). Uma linha de `pontos` passa a
// representar OU uma aula (id_atividade preenchido, id_tipo_interno NULL) OU
// uma atividade interna (o inverso) — nunca as duas; isso é garantido pelo
// código (cada rota de INSERT preenche só uma das colunas), não por CHECK no
// banco (versão do MySQL/MariaDB em produção não é garantida o bastante pra
// confiar nisso — ver decisão no plano).
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'tipos_ponto_interno'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE tipos_ponto_interno (
          id INT AUTO_INCREMENT PRIMARY KEY,
          id_instituicao INT NOT NULL,
          area VARCHAR(20) NOT NULL,
          nome VARCHAR(60) NOT NULL,
          ativo TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_tipo_interno (id_instituicao, area, nome)
        )
      `);
      console.log('Tabela tipos_ponto_interno criada.');
    } else {
      console.log('Tabela tipos_ponto_interno já existia.');
    }

    const [colunaTipo] = await db.query("SHOW COLUMNS FROM pontos LIKE 'id_tipo_interno'");
    if (colunaTipo.length === 0) {
      await db.query('ALTER TABLE pontos ADD COLUMN id_tipo_interno INT NULL AFTER id_atividade');
      console.log('Coluna pontos.id_tipo_interno criada.');
    } else {
      console.log('pontos.id_tipo_interno já existia.');
    }

    const [colunaAtividade] = await db.query("SHOW COLUMNS FROM pontos LIKE 'id_atividade'");
    if (colunaAtividade[0]?.Null === 'NO') {
      await db.query('ALTER TABLE pontos MODIFY id_atividade INT NULL');
      console.log('pontos.id_atividade agora aceita NULL.');
    } else {
      console.log('pontos.id_atividade já aceitava NULL.');
    }

    const [fk] = await db.query(`
      SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'pontos' AND CONSTRAINT_NAME = 'fk_pontos_tipo_interno'
    `);
    if (fk.length === 0) {
      await db.query(`
        ALTER TABLE pontos
        ADD CONSTRAINT fk_pontos_tipo_interno FOREIGN KEY (id_tipo_interno) REFERENCES tipos_ponto_interno(id)
      `);
      console.log('FK fk_pontos_tipo_interno criada.');
    } else {
      console.log('FK fk_pontos_tipo_interno já existia.');
    }

    const [indice] = await db.query("SHOW INDEX FROM pontos WHERE Key_name = 'uniq_ponto_professor_interno_data'");
    if (indice.length === 0) {
      await db.query('ALTER TABLE pontos ADD UNIQUE KEY uniq_ponto_professor_interno_data (id_professor, id_tipo_interno, data)');
      console.log('Índice uniq_ponto_professor_interno_data criado.');
    } else {
      console.log('Índice uniq_ponto_professor_interno_data já existia.');
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
