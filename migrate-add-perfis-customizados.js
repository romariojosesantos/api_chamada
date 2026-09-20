// Migração: tabela `perfis_customizados` — perfis novos que o master cria
// direto pela tela de Permissões (ex.: "Secretaria", "Financeiro"), além dos
// 4 fixos no código (master/coordenador/professor/monitor). Um perfil
// customizado é "genérico": só ganha acesso a tela/recurso pelo que o master
// marcar pra ele na tela de Permissões — nunca herda o vínculo com
// professores (bater ponto, lançar nota por turma) nem o escopo por área de
// coordenador, porque essas duas coisas checam o texto exato "professor"/
// "coordenador" em vários lugares do código (ver resolverIdProfessor/
// resolverAreaCoordenacao em auth.js), não uma lista dinâmica.
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

    const [tabela] = await db.query("SHOW TABLES LIKE 'perfis_customizados'");
    if (tabela.length === 0) {
      await db.query(`
        CREATE TABLE perfis_customizados (
          chave VARCHAR(30) PRIMARY KEY,
          nome VARCHAR(50) NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          criado_por INT NULL
        ) ENGINE=InnoDB
      `);
      console.log('Tabela perfis_customizados criada.');
    } else {
      console.log('Tabela perfis_customizados já existia.');
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
