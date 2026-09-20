// Migração: tabela `permissoes_perfil_recurso` — além de controlar quais
// telas cada perfil acessa (permissoes_perfil), agora também controla quais
// AÇÕES (recursos) dentro de cada tela esse perfil pode fazer (ver RECURSOS
// em backend/telas.js e a tela nova em frontend/src/Permissoes.js).
//
// Sem seed inicial: até o master configurar algo aqui, a tabela fica vazia —
// isso é só a estrutura de armazenamento, ainda não há nenhum ponto do
// sistema bloqueando um botão de Criar/Editar/Excluir/Exportar com base
// nela (só o bloqueio de tela inteira, via permissoes_perfil, já existe).
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'permissoes_perfil_recurso'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE permissoes_perfil_recurso (
          perfil VARCHAR(20) NOT NULL,
          tela VARCHAR(60) NOT NULL,
          recurso VARCHAR(30) NOT NULL,
          PRIMARY KEY (perfil, tela, recurso)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela permissoes_perfil_recurso criada.');
    } else {
      console.log('Tabela permissoes_perfil_recurso já existia.');
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
