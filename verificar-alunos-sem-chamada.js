const pool = require('./db');

async function verificarAlunosSemChamada() {
  try {
    const [rows] = await pool.query(`
      SELECT DISTINCT a.id, a.nome, a.turno, a.id_instituicao, i.nome AS nome_instituicao
      FROM alunos a
      JOIN instituicoes i ON a.id_instituicao = i.id
      LEFT JOIN matricula m ON a.id = m.idaluno AND m.status = 'matriculado'
      LEFT JOIN presenca p ON a.id = p.aluno_id
      WHERE a.status = 'ativo'
        AND m.idaluno IS NOT NULL
        AND p.aluno_id IS NULL
      ORDER BY a.nome ASC
    `);

    if (rows.length === 0) {
      console.log('Todos os alunos ativos com matrícula possuem pelo menos uma chamada registrada.');
    } else {
      console.log(`\n${rows.length} aluno(s) ativo(s) sem nenhuma chamada registrada:\n`);
      console.table(rows);
      
      // Agrupar por turno
      const porTurno = {};
      rows.forEach(aluno => {
        const turno = aluno.turno || 'SEM TURNO';
        if (!porTurno[turno]) porTurno[turno] = [];
        porTurno[turno].push(aluno.nome);
      });

      console.log('\n--- Resumo por turno ---');
      Object.entries(porTurno).forEach(([turno, nomes]) => {
        console.log(`\n${turno} (${nomes.length}):`);
        nomes.forEach(nome => console.log(`  - ${nome}`));
      });
    }
  } catch (err) {
    console.error('Erro ao verificar alunos sem chamada:', err);
  } finally {
    await pool.end();
  }
}

verificarAlunosSemChamada();
