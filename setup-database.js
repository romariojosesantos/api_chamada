const sqlite3 = require('sqlite3').verbose();

// Cria ou abre o arquivo do banco de dados
const db = new sqlite3.Database('./database.db', (err) => {
  if (err) {
    console.error('Erro ao abrir o banco de dados', err.message);
    
  } else {
    console.log('Conectado ao banco de dados SQLite.');
    createTables();
  }
});

function createTables() {
  // O método serialize garante que os comandos sejam executados em ordem
  db.serialize(() => {
    // 1. Cria a tabela de alunos
    db.run(`CREATE TABLE IF NOT EXISTS alunos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT,
      turno TEXT,
      transporte TEXT
    )`, (err) => err ? console.error(err.message) : console.log('Tabela "alunos" pronta.'));

    // 2. Insere os dados iniciais dos alunos
    const alunos = [
      { id: 1, nome: 'Ana Silva', telefone: '123456789', turno: 'Manhã', transporte: 'Onibus Branco' },
      { id: 2, nome: 'Bruno Costa', telefone: '987654321', turno: 'Tarde', transporte: 'Onibus Amarelo'},
      { id: 3, nome: 'Carlos de Souza', telefone: '555555555', turno: 'Manhã', transporte: 'Onibus Branco'},
      { id: 4, nome: 'Daniela Martins', telefone: '111111111', turno: 'Tarde', transporte: 'Onibus Amarelo'},
      { id: 5, nome: 'Eduardo Ferreira', telefone: '999999999', turno: 'Manhã', transporte: 'Onibus Amarelo'},
      { id: 6, nome: 'Fernanda Lima', telefone: '777777777', turno: 'Tarde', transporte: 'Onibus Branco'},
      { id: 7, nome: 'Gabriel Ribeiro', telefone: '333333333', turno: 'Manhã', transporte: 'Onibus Branco'},
    ];
    const stmtAlunos = db.prepare("INSERT INTO alunos (id, nome, telefone, turno, transporte) VALUES (?, ?, ?, ?, ?)");
    alunos.forEach(aluno => stmtAlunos.run(aluno.id, aluno.nome, aluno.telefone, aluno.turno, aluno.transporte));
    stmtAlunos.finalize((err) => err ? console.error(err.message) : console.log(`${alunos.length} alunos inseridos.`));

    // 3. Cria a tabela de presença
    db.run(`CREATE TABLE IF NOT EXISTS presenca (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aluno_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (aluno_id) REFERENCES alunos (id)
    )`, (err) => err ? console.error(err.message) : console.log('Tabela "presenca" pronta.'));
  });

  // 4. Fecha o banco de dados APÓS todas as operações serem concluídas
  db.close((err) => {
    if (err) {
      return console.error('Erro ao fechar o banco de dados', err.message);
    }
    console.log('Banco de dados fechado com sucesso.');
  });
}