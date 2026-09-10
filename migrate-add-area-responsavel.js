// Migração: adiciona `area_responsavel` em `professores` — marca qual
// educador é o responsável por uma área (educacional/esportivo/cultural/
// tecnologico/capelania). Só esse educador (ou master/coordenador) pode
// corrigir ponto de qualquer educador daquela área (ver backend/pontos.js).
// UNIQUE (id_instituicao, area_responsavel) garante só um responsável por
// área POR instituição — evita duas instituições disputarem a mesma coluna
// única global, e evita dois educadores responsáveis pela mesma área na
// mesma instituição.
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
    console.log('Conectado ao banco. Adicionando area_responsavel em professores...');

    const [colunas] = await db.query("SHOW COLUMNS FROM professores LIKE 'area_responsavel'");
    if (colunas.length === 0) {
      await db.query('ALTER TABLE professores ADD COLUMN area_responsavel VARCHAR(20) NULL');
      await db.query('ALTER TABLE professores ADD UNIQUE KEY uniq_area_responsavel (id_instituicao, area_responsavel)');
      console.log('Coluna e índice único criados.');
    } else {
      console.log('Coluna já existia — nada a fazer.');
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
