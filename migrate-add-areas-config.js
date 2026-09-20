// Migração: tabela `areas_config` — nomes de exibição (label) das áreas de
// coordenação/turma, editáveis pelo master pela tela "Áreas" (ver
// backend/areas-config.js). Os VALORES internos (`educacional`, `esportivo`,
// `cultural`, `tecnologico`, `capelania` — ver backend/areas.js,
// AREAS_VALIDAS) nunca mudam, só o texto mostrado pra cada um; são usados em
// toda coluna `area`/`area_coordenacao` do sistema, então mudar aqui reflete
// em todo lugar sem precisar migrar dado nenhum.
//
// Já entra semeada com os nomes pedidos nesta mudança (Educacional -> Educação
// por Princípios, Esportivo -> Esporte, Cultural -> Arte e Cultura,
// Tecnologico -> Educação Profissional, Capelania sem alteração).
const mysql = require('mysql2/promise');
require('dotenv').config();

const LABELS_INICIAIS = {
  educacional: 'Educação por Princípios',
  esportivo: 'Esporte',
  cultural: 'Arte e Cultura',
  tecnologico: 'Educação Profissional',
  capelania: 'Capelania',
};

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

    const [tabela] = await db.query("SHOW TABLES LIKE 'areas_config'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE areas_config (
          area VARCHAR(20) PRIMARY KEY,
          label VARCHAR(50) NOT NULL,
          atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);
      console.log('Tabela areas_config criada.');
    } else {
      console.log('Tabela areas_config já existia.');
    }

    for (const [area, label] of Object.entries(LABELS_INICIAIS)) {
      await db.query('INSERT IGNORE INTO areas_config (area, label) VALUES (?, ?)', [area, label]);
    }
    console.log('Labels iniciais semeados (INSERT IGNORE — não sobrescreve se já existirem).');

    console.log('Migração concluída com sucesso.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
