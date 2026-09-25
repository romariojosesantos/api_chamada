// Eventos da Agenda institucional — institucional/área/atividade. Separado de
// dias_sem_aula (feriados/recessos, ver dias-sem-aula.js) de propósito: aquela
// tabela é lógica sensível (bloqueia chamada, exclui do cálculo de frequência
// em presenca.js/relatorios.js), já testada em produção. Um evento daqui é só
// informativo — nunca afeta chamada nem frequência. A tela de Agenda
// (frontend/src/DiasSemAula.js) busca as duas fontes e mostra tudo junto no
// mesmo calendário, mas por baixo continuam sendo dados independentes.
//
// Permissão por área: mesma regra de backend/pontos.js e
// backend/tiposPontoInterno.js (ver escopoDeAcesso em escopoPonto.js) — evento
// 'institucional' só master/coordenador geral; 'area'/'atividade' também
// libera o coordenador DAQUELA área. Leitura (GET) é livre pra instituição
// inteira, sem filtro de escopo — área aqui é só cor/organização, não
// controle de quem PODE VER.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware } = require('./auth');
const { escopoDeAcesso } = require('./escopoPonto');
const { exigirRecurso } = require('./permissoes-middleware');
const { AREAS_VALIDAS } = require('./areas');
const { gerarRelatorioAgendaAnualPDF } = require('./relatorio-agenda-anual-pdf');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(authMiddleware);
// Reaproveita a permissão já existente da tela "/dias-sem-aula" (ver
// comentário no plano/PR: evita re-configurar permissoes_perfil de novo em
// todas as instituições só porque a tela ganhou um nome/recursos novos).
const exigir = (recurso) => exigirRecurso('/dias-sem-aula', recurso);

function validarTipoEArea(tipo, area) {
  if (!['institucional', 'area', 'atividade'].includes(tipo)) {
    return 'Tipo inválido — use institucional, area ou atividade.';
  }
  if (tipo !== 'institucional' && !AREAS_VALIDAS.includes(area)) {
    return 'Informe uma área válida para esse tipo de evento.';
  }
  return null;
}

// Quem pode agir sobre um evento de uma área (criar/editar/excluir): master ou
// coordenador geral (escopo '') sempre; coordenador de área só na PRÓPRIA área
// (escopo === area do evento); evento institucional exige escopo '' sempre.
function podeAgirNoEvento(req, tipo, area) {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) return false;
  if (escopo === '') return true;
  return tipo !== 'institucional' && area === escopo;
}

// Lista eventos não excluídos da instituição — sem filtro de escopo (ver
// comentário no topo do arquivo). Filtro opcional por período, mesmo padrão
// de GET /api/dias-sem-aula.
router.get('/', asyncHandler(async (req, res) => {
  const { data_inicio, data_fim } = req.query;

  let sql = `
    SELECT ae.id, ae.tipo, ae.titulo, ae.descricao, ae.area, ae.id_atividade,
           ae.data_inicio, ae.data_fim, ae.criado_em, atv.nome AS nome_atividade
    FROM agenda_eventos ae
    LEFT JOIN atividades atv ON atv.idatividades = ae.id_atividade
    WHERE ae.id_instituicao = ? AND ae.excluido_em IS NULL
  `;
  const params = [req.id_instituicao];

  if (data_inicio && data_fim) {
    sql += ' AND ae.data_inicio <= ? AND ae.data_fim >= ?';
    params.push(data_fim, data_inicio);
  }

  sql += ' ORDER BY ae.data_inicio ASC';

  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

// Cria um evento. `tipo='atividade'` copia a área da turma escolhida (nunca
// aceita a área do body pra esse tipo — evita divergência entre a área
// gravada no evento e a área real da turma).
router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const { tipo, titulo, descricao, area, id_atividade, data_inicio, data_fim } = req.body;

  if (!titulo || !String(titulo).trim()) return res.status(400).json({ error: 'Título é obrigatório.' });
  if (!data_inicio) return res.status(400).json({ error: 'Data início é obrigatória.' });
  const dataFimFinal = data_fim || data_inicio;
  if (dataFimFinal < data_inicio) return res.status(400).json({ error: 'Data fim não pode ser anterior à data início.' });

  let areaFinal = tipo === 'institucional' ? null : area;

  if (tipo === 'atividade') {
    if (!id_atividade) return res.status(400).json({ error: 'Selecione a turma/atividade do evento.' });
    const [[turma]] = await pool.query(
      'SELECT area FROM atividades WHERE idatividades = ? AND id_instituicao = ?',
      [id_atividade, req.id_instituicao]
    );
    if (!turma) return res.status(404).json({ error: 'Turma não encontrada.' });
    areaFinal = turma.area;
  }

  const erroValidacao = validarTipoEArea(tipo, areaFinal);
  if (erroValidacao) return res.status(400).json({ error: erroValidacao });

  if (!podeAgirNoEvento(req, tipo, areaFinal)) {
    return res.status(403).json({ error: 'Você não pode criar evento nessa área.' });
  }

  const [result] = await pool.query(
    `INSERT INTO agenda_eventos (id_instituicao, tipo, titulo, descricao, area, id_atividade, data_inicio, data_fim, criado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.id_instituicao, tipo, String(titulo).trim(), descricao || null, areaFinal, tipo === 'atividade' ? id_atividade : null, data_inicio, dataFimFinal, req.user?.id]
  );
  res.status(201).json({ id: result.insertId, message: 'Evento criado com sucesso.' });
}));

// Edição não permite trocar o `tipo` nem a turma vinculada (mudaria a área
// "dona" do evento no meio do caminho) — pra isso, apagar e criar de novo.
router.put('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { titulo, descricao, data_inicio, data_fim } = req.body;

  const [[evento]] = await pool.query(
    'SELECT tipo, area FROM agenda_eventos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, req.id_instituicao]
  );
  if (!evento) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!podeAgirNoEvento(req, evento.tipo, evento.area)) {
    return res.status(403).json({ error: 'Você não pode editar esse evento.' });
  }

  if (!titulo || !String(titulo).trim()) return res.status(400).json({ error: 'Título é obrigatório.' });
  if (!data_inicio) return res.status(400).json({ error: 'Data início é obrigatória.' });
  const dataFimFinal = data_fim || data_inicio;
  if (dataFimFinal < data_inicio) return res.status(400).json({ error: 'Data fim não pode ser anterior à data início.' });

  await pool.query(
    'UPDATE agenda_eventos SET titulo = ?, descricao = ?, data_inicio = ?, data_fim = ? WHERE id = ?',
    [String(titulo).trim(), descricao || null, data_inicio, dataFimFinal, id]
  );
  res.json({ message: 'Evento atualizado com sucesso.' });
}));

router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[evento]] = await pool.query(
    'SELECT tipo, area FROM agenda_eventos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [id, req.id_instituicao]
  );
  if (!evento) return res.status(404).json({ error: 'Evento não encontrado.' });
  if (!podeAgirNoEvento(req, evento.tipo, evento.area)) {
    return res.status(403).json({ error: 'Você não pode excluir esse evento.' });
  }

  await pool.query('UPDATE agenda_eventos SET excluido_em = NOW() WHERE id = ?', [id]);
  res.json({ message: 'Evento removido com sucesso.' });
}));

// PDF do calendário anual — junta dias_sem_aula + agenda_eventos do ano
// inteiro (ver relatorio-agenda-anual-pdf.js). Sem filtro de escopo (mesmo
// motivo do GET / acima): o PDF é do calendário inteiro da instituição.
router.get('/relatorio-anual-pdf', exigir('exportar'), asyncHandler(async (req, res) => {
  const ano = parseInt(req.query.ano, 10) || new Date().getFullYear();
  const dataInicio = `${ano}-01-01`;
  const dataFim = `${ano}-12-31`;

  const [diasSemAula] = await pool.query(
    'SELECT data, motivo FROM dias_sem_aula WHERE id_instituicao = ? AND data BETWEEN ? AND ? ORDER BY data ASC',
    [req.id_instituicao, dataInicio, dataFim]
  );
  const [eventos] = await pool.query(
    `SELECT ae.tipo, ae.titulo, ae.area, ae.data_inicio, ae.data_fim, atv.nome AS nome_atividade
     FROM agenda_eventos ae
     LEFT JOIN atividades atv ON atv.idatividades = ae.id_atividade
     WHERE ae.id_instituicao = ? AND ae.excluido_em IS NULL AND ae.data_inicio <= ? AND ae.data_fim >= ?
     ORDER BY ae.data_inicio ASC`,
    [req.id_instituicao, dataFim, dataInicio]
  );
  const [[instituicao]] = await pool.query('SELECT nome FROM instituicoes WHERE id = ?', [req.id_instituicao]);

  const nomeArquivo = `Calendario_${ano}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);

  gerarRelatorioAgendaAnualPDF({
    res,
    instituicaoNome: instituicao?.nome || '',
    ano,
    diasSemAula,
    eventos,
  });
}));

module.exports = router;
