// Migração: tabelas `termos`/`termo_assinaturas` — termos de responsabilidade
// que os pais assinam (ex.: "Corajosamente Éticos", "Animais Peçonhentos"),
// cada instituição cria/apaga os seus próprios. Também libera a tela pra
// "coordenador" na tabela de permissões (master já tem tudo, fixo em
// backend/auth.js — não precisa de linha na tabela).
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

    const [tabelaTermos] = await db.query("SHOW TABLES LIKE 'termos'");
    if (tabelaTermos.length === 0) {
      await db.query(`
        CREATE TABLE termos (
          id INT PRIMARY KEY AUTO_INCREMENT,
          id_instituicao INT NOT NULL,
          nome VARCHAR(150) NOT NULL,
          criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (id_instituicao) REFERENCES instituicoes(id)
        ) ENGINE=InnoDB
      `);
      console.log('Tabela termos criada.');
    } else {
      console.log('Tabela termos já existia.');
    }

    const [tabelaAssinaturas] = await db.query("SHOW TABLES LIKE 'termo_assinaturas'");
    if (tabelaAssinaturas.length === 0) {
      await db.query(`
        CREATE TABLE termo_assinaturas (
          id_termo INT NOT NULL,
          id_aluno INT NOT NULL,
          assinado_em DATE NOT NULL,
          PRIMARY KEY (id_termo, id_aluno),
          FOREIGN KEY (id_termo) REFERENCES termos(id) ON DELETE CASCADE,
          FOREIGN KEY (id_aluno) REFERENCES alunos(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);
      console.log('Tabela termo_assinaturas criada.');
    } else {
      console.log('Tabela termo_assinaturas já existia.');
    }

    const [jaTemPermissao] = await db.query(
      "SELECT 1 FROM permissoes_perfil WHERE perfil = 'coordenador' AND tela = '/termos'"
    );
    if (jaTemPermissao.length === 0) {
      await db.query("INSERT INTO permissoes_perfil (perfil, tela) VALUES ('coordenador', '/termos')");
      console.log('Permissão de coordenador pra /termos inserida.');
    } else {
      console.log('Permissão de coordenador pra /termos já existia.');
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
