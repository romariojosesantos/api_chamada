// Migração: tabela `permissoes_perfil` — controla quais telas cada perfil
// (monitor/professor/coordenador) pode acessar, editável pelo master na tela
// nova "Permissões" (ver backend/permissoes.js). `master` nunca entra nessa
// tabela — tem acesso total sempre, fixo no código (ver carregarTelasPermitidas
// em backend/auth.js), pra não haver risco de o próprio master se trancar fora
// do sistema mudando isso na tela.
//
// O INSERT inicial replica EXATAMENTE o que já estava hardcoded em
// frontend/src/App.js (PerfilRoute) e frontend/src/Components/Layout.jsx
// (menuItemsBase) antes desta migração — zero mudança de comportamento até o
// master editar algo pela tela nova.
const mysql = require('mysql2/promise');
require('dotenv').config();

const SEED = {
  monitor: ['/', '/relatorio-diario', '/gerenciar-matriculas'],
  professor: ['/', '/notificacoes', '/grade', '/carater', '/notas', '/pontos'],
  coordenador: [
    '/', '/notificacoes', '/relatorio-diario', '/grade', '/ajuste-grade', '/grade-turmas',
    '/turmas', '/professores', '/gerenciar-matriculas', '/dias-sem-aula', '/meritocracia',
    '/carater', '/notas', '/pontos', '/vincular-professor'
  ]
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'permissoes_perfil'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE permissoes_perfil (
          perfil VARCHAR(20) NOT NULL,
          tela VARCHAR(60) NOT NULL,
          PRIMARY KEY (perfil, tela)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela permissoes_perfil criada.');

      const values = [];
      for (const [perfil, telas] of Object.entries(SEED)) {
        for (const tela of telas) values.push([perfil, tela]);
      }
      await db.query('INSERT INTO permissoes_perfil (perfil, tela) VALUES ?', [values]);
      console.log(`Seed inicial inserido: ${values.length} linha(s).`);
    } else {
      console.log('Tabela permissoes_perfil já existia — seed não repetido.');
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
