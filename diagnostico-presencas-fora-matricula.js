const mysql = require('mysql2/promise');

const dbConfig = {
  host: '31.97.83.209',
  port: 3306,
  user: 'romario_novo',
  password: 'RomarioSantos2025',
  database: 'chamada_conexao',
  timezone: 'America/Sao_Paulo'
};

async function diagnosticarPresencasForaMatricula() {
  let pool;
  try {
    pool = mysql.createPool(dbConfig);

    const data = '2026-07-17';
    const dias = ['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
    const diaDaSemana = dias[new Date(`${data}T12:00:00`).getDay()];

    console.log(`Verificando presenças de ${data} (${diaDaSemana})`);
    console.log('='.repeat(80));

    // Buscar todas as presenças do dia com info do aluno
    const [presencas] = await pool.query(
      `SELECT p.id, p.aluno_id, a.nome, a.status as status_aluno, p.status, p.observacao
       FROM presenca p
       JOIN alunos a ON p.aluno_id = a.id
       WHERE DATE(p.data) = ?
       ORDER BY a.nome ASC`,
      [data]
    );

    console.log(`\nTotal de presenças registradas no dia: ${presencas.length}`);

    // Para cada presença, verificar se tem matrícula ativa para o dia da semana
    const resultado = [];
    for (const presenca of presencas) {
      const [matriculas] = await pool.query(
        `SELECT m.idmatricula, m.dia_semana, m.status, m.data_fim, m.turno
         FROM matricula m
         WHERE m.idaluno = ?
           AND m.status = 'matriculado'
           AND m.data_fim IS NULL
           AND TRIM(m.dia_semana) = ?`,
        [presenca.aluno_id, diaDaSemana]
      );

      const dentroMatricula = matriculas.length > 0;
      const turnoMatricula = dentroMatricula ? matriculas[0].turno : null;

      resultado.push({
        id_presenca: presenca.id,
        aluno_id: presenca.aluno_id,
        nome: presenca.nome,
        status_aluno: presenca.status_aluno,
        status_presenca: presenca.status,
        observacao: presenca.observacao,
        dentro_matricula: dentroMatricula ? 'Sim' : 'Não',
        turno_matricula: turnoMatricula || '—',
        motivo: dentroMatricula 
          ? 'Matrícula ativa para ' + diaDaSemana 
          : 'NÃO deveria ter vindo: sem matrícula ativa para ' + diaDaSemana
      });
    }

    // Separar os que estão dentro e fora da matrícula
    const dentro = resultado.filter(r => r.dentro_matricula === 'Sim');
    const fora = resultado.filter(r => r.dentro_matricula === 'Não');

    console.log(`\n✅ Presenças corretas (com matrícula para ${diaDaSemana}): ${dentro.length}`);
    console.log(`⚠️ Presenças FORA da matrícula (não deveriam ter vindo): ${fora.length}`);

    if (fora.length > 0) {
      console.log(`\nLista de alunos que NÃO deveriam ter vindo no dia ${data}:`);
      console.table(fora.map(r => ({
        ID: r.aluno_id,
        Nome: r.nome,
        Status: r.status_presenca,
        Turno_Matricula: r.turno_matricula,
        Observacao: r.observacao
      })));

      // Agrupar por status da presença
      const porStatus = {};
      fora.forEach(r => {
        porStatus[r.status_presenca] = (porStatus[r.status_presenca] || 0) + 1;
      });
      console.log('\nResumo por status das presenças fora da matrícula:');
      console.table(porStatus);

      // Ver se algum tem observação de busca manual
      const buscaManual = fora.filter(r => r.observacao && r.observacao.includes('busca manual'));
      console.log(`\nPresenças marcadas como "busca manual": ${buscaManual.length}`);
    }

    // Listar também os que estão dentro, para conferência
    console.log(`\n✅ Total que deveria ter vindo: ${dentro.length}`);
    console.log(`⚠️ Total que NÃO deveria ter vindo: ${fora.length}`);
    console.log(`📊 Total geral registrado: ${presencas.length}`);

  } catch (err) {
    console.error('Erro no diagnóstico:', err);
  } finally {
    if (pool) await pool.end();
  }
}

diagnosticarPresencasForaMatricula();
