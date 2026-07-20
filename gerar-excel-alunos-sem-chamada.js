const pool = require('./db');
const XLSX = require('xlsx');
const path = require('path');

async function gerarExcelAlunosSemChamada() {
  try {
    console.log('Buscando alunos ativos sem chamada...');
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
      return;
    }

    // Preparar dados para Excel
    const dadosExcel = rows.map((aluno, index) => ({
      'Nº': index + 1,
      'ID Aluno': aluno.id,
      'Nome': aluno.nome,
      'Turno': aluno.turno || 'SEM TURNO',
      'ID Instituição': aluno.id_instituicao,
      'Instituição': aluno.nome_instituicao
    }));

    // Criar workbook e worksheet
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(dadosExcel);

    // Ajustar largura das colunas
    const colWidths = [
      { wch: 5 },  // Nº
      { wch: 10 }, // ID Aluno
      { wch: 50 }, // Nome
      { wch: 15 }, // Turno
      { wch: 15 }, // ID Instituição
      { wch: 25 }  // Instituição
    ];
    ws['!cols'] = colWidths;

    // Adicionar worksheet ao workbook
    XLSX.utils.book_append_sheet(wb, ws, 'Alunos Sem Chamada');

    // Gerar nome do arquivo com data/hora
    const agora = new Date();
    const timestamp = agora.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const nomeArquivo = `alunos-sem-chamada-${timestamp}.xlsx`;
    const caminhoArquivo = path.join(__dirname, nomeArquivo);

    // Salvar arquivo
    XLSX.writeFile(wb, caminhoArquivo);

    console.log(`\n✅ Arquivo Excel gerado com sucesso!`);
    console.log(`📁 Arquivo: ${caminhoArquivo}`);
    console.log(`📊 Total de alunos: ${rows.length}`);
    
    // Resumo por turno
    const porTurno = {};
    rows.forEach(aluno => {
      const turno = aluno.turno || 'SEM TURNO';
      if (!porTurno[turno]) porTurno[turno] = 0;
      porTurno[turno]++;
    });

    console.log('\n--- Resumo por turno ---');
    Object.entries(porTurno).forEach(([turno, count]) => {
      console.log(`${turno}: ${count} aluno(s)`);
    });

  } catch (err) {
    console.error('Erro ao gerar Excel:', err);
  } finally {
    await pool.end();
  }
}

gerarExcelAlunosSemChamada();
