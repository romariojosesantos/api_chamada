// Migração: adiciona `area_coordenacao` em `usuarios` — só tem sentido pra
// perfil 'coordenador'. NULL = coordenador GERAL (vê/edita todas as áreas,
// comportamento de hoje). Preenchido com uma área (educacional/esportivo/
// cultural/tecnologico/capelania) = coordenador DAQUELA área só — usado em
// backend/pontos.js pra restringir quem corrige ponto de qual educador.
//
// Substitui a ideia anterior (professores.area_responsavel, ver
// migrate-add-area-responsavel.js) — não existe "educador responsável pela
// área", quem corrige ponto é sempre um COORDENADOR (geral ou de área), não
// um educador comum. Essa coluna antiga fica removida abaixo.
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

    const [colunaNova] = await db.query("SHOW COLUMNS FROM usuarios LIKE 'area_coordenacao'");
    if (colunaNova.length === 0) {
      await db.query('ALTER TABLE usuarios ADD COLUMN area_coordenacao VARCHAR(20) NULL');
      console.log('Coluna usuarios.area_coordenacao criada.');
    } else {
      console.log('usuarios.area_coordenacao já existia.');
    }

    const [colunaAntiga] = await db.query("SHOW COLUMNS FROM professores LIKE 'area_responsavel'");
    if (colunaAntiga.length > 0) {
      await db.query('ALTER TABLE professores DROP INDEX uniq_area_responsavel');
      await db.query('ALTER TABLE professores DROP COLUMN area_responsavel');
      console.log('Coluna professores.area_responsavel (desenho anterior) removida.');
    } else {
      console.log('professores.area_responsavel já não existia.');
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
