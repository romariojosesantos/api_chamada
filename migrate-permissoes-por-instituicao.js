// Migração: permissões por perfil passam a ser POR INSTITUIÇÃO, não mais
// globais. Até aqui, "monitor" tinha o mesmo conjunto de telas/recursos em
// todo o sistema; agora cada instituição configura o seu próprio (ex.:
// monitor da Escola A só vê Chamada, monitor da Escola B vê outras telas).
//
// Estratégia: renomeia as 3 tabelas afetadas para "_pre_instituicao" (backup,
// não apaga nada) e cria as novas já com `id_instituicao`, replicando cada
// linha existente para TODAS as instituições cadastradas — isso preserva
// exatamente o comportamento atual em todo lugar; a partir daqui o master
// pode divergir a configuração por instituição pela tela de Permissões.
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

    const [colunas] = await db.query("SHOW COLUMNS FROM permissoes_perfil LIKE 'id_instituicao'");
    if (colunas.length > 0) {
      console.log('Migração já aplicada (permissoes_perfil já tem id_instituicao). Nada a fazer.');
      return;
    }

    const [instituicoes] = await db.query('SELECT id FROM instituicoes');
    if (instituicoes.length === 0) {
      throw new Error('Nenhuma instituição cadastrada — abortando (não há como replicar as permissões).');
    }
    console.log(`Instituições encontradas: ${instituicoes.map(i => i.id).join(', ')}`);

    // --- permissoes_perfil ---
    await db.query('RENAME TABLE permissoes_perfil TO permissoes_perfil_pre_instituicao');
    await db.query(`
      CREATE TABLE permissoes_perfil (
        id_instituicao INT NOT NULL,
        perfil VARCHAR(20) NOT NULL,
        tela VARCHAR(60) NOT NULL,
        PRIMARY KEY (id_instituicao, perfil, tela)
      ) ENGINE=InnoDB
    `);
    const [ppInsert] = await db.query(`
      INSERT INTO permissoes_perfil (id_instituicao, perfil, tela)
      SELECT i.id, o.perfil, o.tela FROM permissoes_perfil_pre_instituicao o CROSS JOIN instituicoes i
    `);
    console.log(`permissoes_perfil: ${ppInsert.affectedRows} linha(s) criada(s) (replicadas por instituição).`);

    // --- permissoes_perfil_recurso ---
    await db.query('RENAME TABLE permissoes_perfil_recurso TO permissoes_perfil_recurso_pre_instituicao');
    await db.query(`
      CREATE TABLE permissoes_perfil_recurso (
        id_instituicao INT NOT NULL,
        perfil VARCHAR(20) NOT NULL,
        tela VARCHAR(60) NOT NULL,
        recurso VARCHAR(30) NOT NULL,
        PRIMARY KEY (id_instituicao, perfil, tela, recurso)
      ) ENGINE=InnoDB
    `);
    const [pprInsert] = await db.query(`
      INSERT INTO permissoes_perfil_recurso (id_instituicao, perfil, tela, recurso)
      SELECT i.id, o.perfil, o.tela, o.recurso FROM permissoes_perfil_recurso_pre_instituicao o CROSS JOIN instituicoes i
    `);
    console.log(`permissoes_perfil_recurso: ${pprInsert.affectedRows} linha(s) criada(s) (replicadas por instituição).`);

    // --- perfis_customizados ---
    await db.query('RENAME TABLE perfis_customizados TO perfis_customizados_pre_instituicao');
    await db.query(`
      CREATE TABLE perfis_customizados (
        id_instituicao INT NOT NULL,
        chave VARCHAR(30) NOT NULL,
        nome VARCHAR(50) NOT NULL,
        criado_em TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
        criado_por INT NULL,
        PRIMARY KEY (id_instituicao, chave)
      ) ENGINE=InnoDB
    `);
    const [pcInsert] = await db.query(`
      INSERT INTO perfis_customizados (id_instituicao, chave, nome, criado_em, criado_por)
      SELECT i.id, o.chave, o.nome, o.criado_em, o.criado_por FROM perfis_customizados_pre_instituicao o CROSS JOIN instituicoes i
    `);
    console.log(`perfis_customizados: ${pcInsert.affectedRows} linha(s) criada(s) (replicadas por instituição).`);

    console.log('Migração concluída com sucesso. As tabelas antigas ficaram guardadas como "*_pre_instituicao" — pode apagá-las manualmente depois de confirmar que está tudo certo.');
  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('Erro na migração:', err);
  process.exit(1);
});
