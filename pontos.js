// Ponto do educador — registro de entrada/saída por AULA (turma + data) OU
// por ATIVIDADE INTERNA (Planejamento, Reuniões, Monitorias, Ensaios, Outros
// — tipos cadastrados por coordenador em backend/tiposPontoInterno.js, nunca
// em `atividades`, de propósito: assim nunca aparecem em relatório/grade/
// roster de turma). Uma linha de `pontos` representa OU uma aula
// (id_atividade preenchido, id_tipo_interno NULL) OU uma atividade interna
// (o inverso) — nunca as duas; bater ponto grava hora_entrada, "Registrar
// saída" completa a mesma linha.
//
// Quem corrige um ponto (de turma OU interno): só coordenador (geral ou da
// ÁREA daquela turma/tipo) ou master. Não existe "educador responsável" — o
// educador comum nunca corrige nem o próprio ponto. Um usuário perfil
// 'coordenador' tem `usuarios.area_coordenacao`: null = coordenador GERAL
// (vê/edita todas as áreas); preenchida = só aquela área (ex.: "Coordenador
// Educacional" só corrige ponto de turmas/tipos da área educacional) — ver
// escopoPonto.js (escopoDeAcesso, compartilhado com tiposPontoInterno.js),
// auth.js (resolverAreaCoordenacao) e AdminUsuarios.js pra como isso é
// configurado.
//
// Atividade interna não tem horário fixo (diferente de turma) — o educador
// só vê e bate ponto nos tipos das áreas onde ele já deu aula alguma vez
// (nunca a lista completa da instituição).
//
// Bater ponto só vale pro dia de hoje (em Brasília) — não dá pra registrar
// entrada/saída de outro dia, seja passado ou futuro; isso trava tanto no
// backend (calcula "hoje" no servidor, ignora qualquer data do cliente)
// quanto no front (sem seletor de data pro educador).
//
// Isso é um controle interno complementar, não o ponto oficial de CLT (que
// exigiria certificação REP-P/Portaria 671) — não tem esse peso de
// compliance aqui de propósito.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { escopoDeAcesso } = require('./escopoPonto');
const { exigirRecurso } = require('./permissoes-middleware');
const { gerarRelatorioPontoPDF } = require('./relatorio-ponto-pdf');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/pontos', recurso);

const DIAS_SEMANA_POR_INDICE = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

// Dia da semana de uma data "YYYY-MM-DD", sem depender do fuso horário do
// processo — Date.UTC + getUTCDay é sempre a mesma resposta, servidor rodando
// onde for (mesmo cuidado documentado em db.js sobre `dateStrings`).
function diaSemanaDaData(dataStr) {
  const partes = String(dataStr || '').split('-').map(Number);
  if (partes.length !== 3 || partes.some(Number.isNaN)) return null;
  const [ano, mes, dia] = partes;
  return DIAS_SEMANA_POR_INDICE[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
}

// Horário de Brasília calculado no próprio Node (Intl, sem depender do fuso
// do processo nem do servidor MySQL) — usado no lugar de NOW() porque NOW()
// roda no fuso configurado do SERVIDOR do banco (frequentemente UTC em VPS),
// então "bater ponto às 23:39" ficava salvo como "02:39" (+3h). Gravando essa
// string diretamente (sem passar por conversão do driver), o valor salvo já
// É a hora de Brasília, igual ao que uma correção manual (PUT /:id) já grava.
function agoraBrasilia() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const valor = (tipo) => partes.find(p => p.type === tipo).value;
  return `${valor('year')}-${valor('month')}-${valor('day')} ${valor('hour')}:${valor('minute')}:${valor('second')}`;
}

// "Hoje" em Brasília, YYYY-MM-DD — usado pra travar bater ponto/registrar
// saída no dia de verdade, ignorando qualquer data que o cliente mande.
function hojeBrasilia() {
  return agoraBrasilia().split(' ')[0];
}

// Um professor só pode ter UM ponto em aberto por vez, turma ou atividade
// interna — precisa registrar a saída antes de bater outro (igual um ponto
// de trabalho de verdade: a pessoa está fisicamente num lugar só por vez).
// Usado tanto em /bater quanto em /bater-interno, antes de abrir uma entrada
// nova. Não conflita com a checagem de "já bateu entrada NESSA aula hoje"
// que já existe em cada rota: se o ponto aberto encontrado aqui fosse da
// MESMA turma/tipo, aquela checagem já teria barrado antes de chegar aqui.
async function buscarPontoAberto(idProfessor, data, idInstituicao) {
  const [[aberto]] = await pool.query(
    `SELECT pt.id, COALESCE(atv.nome, tpi.nome) AS nome
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_professor = ? AND pt.data = ? AND pt.id_instituicao = ?
       AND pt.hora_entrada IS NOT NULL AND pt.hora_saida IS NULL`,
    [idProfessor, data, idInstituicao]
  );
  return aberto || null;
}

function exigirProfessor(req, res) {
  if (req.user.perfil !== 'professor') {
    res.status(403).json({ error: 'Só educadores batem ponto pela própria conta.' });
    return null;
  }
  if (!req.user.id_professor) {
    res.status(403).json({ error: 'Sua conta não está vinculada a um cadastro de educador.' });
    return null;
  }
  return req.user.id_professor;
}

// Quem pode corrigir/apagar UM ponto específico — turma ou atividade
// interna, cada uma com sua própria tabela de área (atividades /
// tipos_ponto_interno), mas a mesma regra de escopo (ver escopoPonto.js).
async function podeEditarPonto(req, ponto) {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) return false;
  if (escopo === '') return true; // master ou coordenador geral
  if (ponto.id_atividade) {
    const [[turma]] = await pool.query('SELECT area FROM atividades WHERE idatividades = ?', [ponto.id_atividade]);
    return turma?.area === escopo;
  }
  const [[tipo]] = await pool.query('SELECT area FROM tipos_ponto_interno WHERE id = ?', [ponto.id_tipo_interno]);
  return tipo?.area === escopo;
}

// Turmas do educador logado — sempre pra HOJE (Brasília), nunca outro dia
// (ver comentário no topo do arquivo). Só as que caem no dia da semana de
// hoje, com o status do ponto de hoje já embutido (null = ainda não bateu).
router.get('/turmas', asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const data = hojeBrasilia();
  const diaSemana = diaSemanaDaData(data);

  // "É do professor" = principal (idprofessor) OU co-professor (ver
  // atividade_professores, co-docência) — mesma regra repetida em todo lugar
  // deste arquivo que decide o que um professor pode ver/bater.
  const ehDoProfessor = 'atv.idprofessor = ? OR atv.idatividades IN (SELECT idatividades FROM atividade_professores WHERE idprofessor = ?)';

  const [turmas] = await pool.query(
    `SELECT atv.idatividades AS id_atividade, atv.nome, atv.horario, atv.turno,
            pt.id AS id_ponto,
            DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada,
            DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida
     FROM atividades atv
     LEFT JOIN pontos pt ON pt.id_atividade = atv.idatividades AND pt.id_professor = ? AND pt.data = ?
     WHERE atv.id_instituicao = ? AND (${ehDoProfessor}) AND atv.dia_semana = ? AND atv.data_fim IS NULL
     ORDER BY atv.horario ASC, atv.nome ASC`,
    [idProfessor, data, req.id_instituicao, idProfessor, idProfessor, diaSemana]
  );

  // Atividades internas (Planejamento, Reuniões, ...) — sem horário fixo, só
  // das áreas onde esse educador dá aula ATUALMENTE (qualquer dia da semana,
  // não só hoje — por isso sem filtro de dia_semana aqui, diferente da
  // consulta de turmas acima). `atv.data_fim IS NULL` é essencial: sem isso,
  // um educador que já deu aula em outra área no passado (turma já encerrada)
  // continuava vendo os tipos internos daquela área pra sempre, mesmo depois
  // de não dar mais aula lá — bug real, reproduzido e confirmado nesta sessão
  // (um educador só de "Arte e Cultura" enxergava tipo de "Educação por
  // Princípios" por causa de uma turma antiga já encerrada). Ao contrário de
  // turma (1x por dia), uma atividade interna pode ser batida VÁRIAS vezes no
  // mesmo dia (ex.: Planejamento de manhã, encerra, novo Planejamento à
  // tarde) — por isso o join só traz a sessão em ABERTO de hoje
  // (`hora_saida IS NULL`), se existir alguma; sessões já encerradas hoje não
  // aparecem aqui (ficam só no histórico), pra sempre poder abrir uma nova em
  // vez de mostrar a última como "concluída" e travada.
  const [tipos] = await pool.query(
    `SELECT t.id AS id_tipo_interno, t.nome, t.area, pt.id AS id_ponto,
            DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada,
            DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida
     FROM tipos_ponto_interno t
     LEFT JOIN pontos pt ON pt.id_tipo_interno = t.id AND pt.id_professor = ? AND pt.data = ? AND pt.hora_saida IS NULL
     WHERE t.id_instituicao = ? AND t.ativo = 1
       AND t.area IN (SELECT DISTINCT area FROM atividades atv WHERE (${ehDoProfessor}) AND atv.data_fim IS NULL AND id_instituicao = ?)
     ORDER BY t.area ASC, t.nome ASC`,
    [idProfessor, data, req.id_instituicao, idProfessor, idProfessor, req.id_instituicao]
  );

  res.json({ data, dia_semana: diaSemana, turmas, atividades_internas: tipos });
}));

// Histórico do próprio educador (o "espelho de ponto" dele) — só consulta,
// não tem botão de corrigir (ver comentário no topo do arquivo).
//
// Ordena por `pt.hora_entrada DESC` dentro do dia (mais recente primeiro,
// mesmo sentido de `pt.data DESC`) — NUNCA por `atv.horario`, que só existe
// pra turma (é o horário FIXO da aula, tipo "HR 1"); pra atividade interna
// ele vem sempre NULL, então com múltiplas sessões da MESMA atividade no
// mesmo dia (ver /bater-interno, que agora permite isso) a ordem entre elas
// ficava indefinida. `hora_entrada` é o horário REAL de cada sessão, então
// ordena certo pros dois casos (turma e interno) sem precisar de dois
// critérios diferentes.
router.get('/meu-historico', asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const dataInicio = String(req.query.data_inicio || '').trim();
  const dataFim = String(req.query.data_fim || '').trim();
  if (!dataInicio || !dataFim) return res.status(400).json({ error: 'Informe data_inicio e data_fim.' });

  const [rows] = await pool.query(
    `SELECT pt.id, pt.data,
            DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada,
            DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida,
            COALESCE(atv.nome, tpi.nome) AS nome_turma,
            COALESCE(atv.area, tpi.area) AS area,
            atv.dia_semana, atv.horario, atv.turno
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_professor = ? AND pt.id_instituicao = ? AND pt.data BETWEEN ? AND ?
     ORDER BY pt.data DESC, pt.hora_entrada DESC`,
    [idProfessor, req.id_instituicao, dataInicio, dataFim]
  );
  res.json(rows);
}));

// Visão agregada: master e coordenador geral veem tudo; coordenador de área
// só vê (e só edita) a área dele — o filtro de área é forçado, nunca aceita
// ver outra.
router.get('/', asyncHandler(async (req, res) => {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) {
    return res.status(403).json({ error: 'Sem acesso à visão geral de registros.' });
  }

  const dataInicio = String(req.query.data_inicio || '').trim();
  const dataFim = String(req.query.data_fim || '').trim();
  if (!dataInicio || !dataFim) return res.status(400).json({ error: 'Informe data_inicio e data_fim.' });

  const params = [req.id_instituicao, dataInicio, dataFim];
  let filtros = '';
  if (req.query.id_professor) {
    filtros += ' AND pt.id_professor = ?';
    params.push(req.query.id_professor);
  }
  if (escopo) {
    filtros += ' AND COALESCE(atv.area, tpi.area) = ?';
    params.push(escopo);
  }

  const [rows] = await pool.query(
    `SELECT pt.id, pt.id_atividade, pt.data,
            DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada,
            DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida,
            pt.id_professor, p.nome AS nome_professor,
            COALESCE(atv.nome, tpi.nome) AS nome_turma,
            COALESCE(atv.area, tpi.area) AS area,
            atv.dia_semana, atv.horario, atv.turno
     FROM pontos pt
     JOIN professores p ON p.id = pt.id_professor
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ? AND pt.data BETWEEN ? AND ?${filtros}
     ORDER BY pt.data DESC, p.nome ASC, pt.hora_entrada DESC`,
    params
  );
  res.json(rows);
}));

// Popula o filtro por educador na visão agregada — mesma regra de acesso.
router.get('/educadores', asyncHandler(async (req, res) => {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) {
    return res.status(403).json({ error: 'Sem acesso à visão geral de registros.' });
  }

  const params = [req.id_instituicao];
  let filtroArea = '';
  if (escopo) {
    filtroArea = ' AND COALESCE(atv.area, tpi.area) = ?';
    params.push(escopo);
  }

  const [rows] = await pool.query(
    `SELECT DISTINCT p.id, p.nome
     FROM pontos pt
     JOIN professores p ON p.id = pt.id_professor
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ?${filtroArea}
     ORDER BY p.nome ASC`,
    params
  );
  res.json(rows);
}));

// Relatório de Ponto em PDF, no papel timbrado do Instituto — substitui a
// planilha Excel que a tela de Pontos dos Educadores gerava antes (ver
// SecaoGestor em frontend/src/Pontos.js). Sempre de UM educador por vez —
// diferente de GET / (lista tudo, mistura educadores), aqui `id_professor` é
// obrigatório porque o relatório é montado como uma folha de ponto individual
// (cabeçalho com nome/e-mail do prestador, subtotal por dia, assinatura no
// final) — não faz sentido misturar duas pessoas num único documento desses.
router.get('/relatorio-pdf', exigir('exportar'), asyncHandler(async (req, res) => {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) {
    return res.status(403).json({ error: 'Sem acesso à visão geral de registros.' });
  }

  const dataInicio = String(req.query.data_inicio || '').trim();
  const dataFim = String(req.query.data_fim || '').trim();
  const idProfessor = String(req.query.id_professor || '').trim();
  if (!dataInicio || !dataFim) return res.status(400).json({ error: 'Informe data_inicio e data_fim.' });
  if (!idProfessor) return res.status(400).json({ error: 'Selecione um educador — o relatório em PDF é sempre individual.' });

  const params = [req.id_instituicao, dataInicio, dataFim, idProfessor];
  let filtroArea = '';
  if (escopo) {
    filtroArea = ' AND COALESCE(atv.area, tpi.area) = ?';
    params.push(escopo);
  }

  const [rows] = await pool.query(
    `SELECT pt.data,
            DATE_FORMAT(pt.hora_entrada, '%Y-%m-%dT%H:%i:%s') AS hora_entrada,
            DATE_FORMAT(pt.hora_saida, '%Y-%m-%dT%H:%i:%s') AS hora_saida,
            COALESCE(atv.nome, tpi.nome) AS nome_turma
     FROM pontos pt
     LEFT JOIN atividades atv ON atv.idatividades = pt.id_atividade
     LEFT JOIN tipos_ponto_interno tpi ON tpi.id = pt.id_tipo_interno
     WHERE pt.id_instituicao = ? AND pt.data BETWEEN ? AND ? AND pt.id_professor = ?${filtroArea}
     ORDER BY pt.data ASC, pt.hora_entrada ASC`,
    params
  );

  const [[professor]] = await pool.query(
    'SELECT nome, nome_completo FROM professores WHERE id = ? AND id_instituicao = ?',
    [idProfessor, req.id_instituicao]
  );
  if (!professor) return res.status(404).json({ error: 'Educador não encontrado.' });
  // Relatório formal usa o nome COMPLETO quando cadastrado (ver
  // professores.js e migrate-add-professor-nome-completo.js) — o `nome` curto
  // continua sendo só o de exibição casual no resto do sistema.
  const nomeRelatorio = professor.nome_completo || professor.nome;

  // E-mail vem do login vinculado (professores não tem coluna de e-mail
  // própria) — nem todo educador tem uma conta de usuário, então fica em
  // branco nesse caso (o relatório trata isso como "—").
  const [[usuario]] = await pool.query(
    "SELECT email FROM usuarios WHERE id_professor = ? AND perfil = 'professor' LIMIT 1",
    [idProfessor]
  );
  const [[instituicao]] = await pool.query('SELECT nome FROM instituicoes WHERE id = ?', [req.id_instituicao]);

  const nomeArquivo = `RegistroAtividades_${professor.nome.replace(/[^a-zA-Z0-9]+/g, '_')}_${dataInicio}_a_${dataFim}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);

  gerarRelatorioPontoPDF({
    res,
    instituicaoNome: instituicao?.nome || '',
    professorNome: nomeRelatorio,
    professorEmail: usuario?.email || '',
    dataInicio,
    dataFim,
    rows,
  });
}));

// Bater ponto de entrada numa turma — só vale pra HOJE (Brasília); cria a
// linha se não existir, ou marca a entrada se a linha já existia sem entrada.
router.post('/bater', exigir('criar'), asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const { id_atividade } = req.body;
  if (!id_atividade) return res.status(400).json({ error: 'Informe id_atividade.' });

  const data = hojeBrasilia();
  const diaSemana = diaSemanaDaData(data);

  const [[turma]] = await pool.query(
    'SELECT idatividades, dia_semana, idprofessor FROM atividades WHERE idatividades = ? AND id_instituicao = ? AND data_fim IS NULL',
    [id_atividade, req.id_instituicao]
  );
  if (!turma) return res.status(404).json({ error: 'Turma não encontrada.' });
  if (turma.idprofessor !== idProfessor) {
    const [[ehCoProfessor]] = await pool.query(
      'SELECT 1 FROM atividade_professores WHERE idatividades = ? AND idprofessor = ?',
      [id_atividade, idProfessor]
    );
    if (!ehCoProfessor) return res.status(403).json({ error: 'Essa turma não é sua.' });
  }
  if (turma.dia_semana !== diaSemana) {
    return res.status(400).json({ error: `Essa turma acontece na(o) ${turma.dia_semana}, não hoje (${diaSemana}).` });
  }

  const [[existente]] = await pool.query(
    'SELECT id, hora_entrada FROM pontos WHERE id_professor = ? AND id_atividade = ? AND data = ?',
    [idProfessor, id_atividade, data]
  );
  if (existente?.hora_entrada) {
    return res.status(409).json({ error: 'Você já bateu ponto de entrada nessa aula hoje.' });
  }

  const pontoAberto = await buscarPontoAberto(idProfessor, data, req.id_instituicao);
  if (pontoAberto) {
    return res.status(409).json({ error: `Você já tem um registro em aberto em "${pontoAberto.nome}" — registre a saída antes de bater outro.` });
  }

  const agora = agoraBrasilia();
  if (existente) {
    await pool.query('UPDATE pontos SET hora_entrada = ? WHERE id = ?', [agora, existente.id]);
    return res.json({ message: 'Entrada registrada.', id: existente.id });
  }
  const [result] = await pool.query(
    'INSERT INTO pontos (id_instituicao, id_professor, id_atividade, data, hora_entrada) VALUES (?, ?, ?, ?, ?)',
    [req.id_instituicao, idProfessor, id_atividade, data, agora]
  );
  res.status(201).json({ message: 'Entrada registrada.', id: result.insertId });
}));

// Registrar saída — a linha já precisa existir (hoje) com entrada e sem saída.
router.post('/saida', exigir('editar'), asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const { id_atividade } = req.body;
  if (!id_atividade) return res.status(400).json({ error: 'Informe id_atividade.' });

  const data = hojeBrasilia();
  const [[ponto]] = await pool.query(
    'SELECT id, hora_entrada, hora_saida FROM pontos WHERE id_professor = ? AND id_atividade = ? AND data = ? AND id_instituicao = ?',
    [idProfessor, id_atividade, data, req.id_instituicao]
  );
  if (!ponto || !ponto.hora_entrada) return res.status(400).json({ error: 'Registre a entrada primeiro.' });
  if (ponto.hora_saida) return res.status(409).json({ error: 'Você já registrou a saída dessa aula.' });

  await pool.query('UPDATE pontos SET hora_saida = ? WHERE id = ?', [agoraBrasilia(), ponto.id]);
  res.json({ message: 'Saída registrada.', id: ponto.id });
}));

// Bater ponto de entrada numa atividade INTERNA (Planejamento, Reuniões,
// Monitorias, Ensaios, Outros — cadastradas por coordenador em
// backend/tiposPontoInterno.js) — sem turma nem horário fixo: vale a
// qualquer hora do dia de hoje (Brasília), sem checagem de dia_semana. Só
// aceita um tipo de uma área onde esse professor já deu aula alguma vez
// (mesmo filtro de GET /turmas). Grava só id_tipo_interno (id_atividade fica
// NULL) — nunca as duas colunas preenchidas.
router.post('/bater-interno', exigir('criar'), asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const { id_tipo_interno } = req.body;
  if (!id_tipo_interno) return res.status(400).json({ error: 'Informe id_tipo_interno.' });

  const [[tipo]] = await pool.query(
    `SELECT t.id FROM tipos_ponto_interno t
     WHERE t.id = ? AND t.id_instituicao = ? AND t.ativo = 1
       AND t.area IN (
         SELECT DISTINCT area FROM atividades atv
         WHERE id_instituicao = ? AND (atv.idprofessor = ? OR atv.idatividades IN (SELECT idatividades FROM atividade_professores WHERE idprofessor = ?))
       )`,
    [id_tipo_interno, req.id_instituicao, req.id_instituicao, idProfessor, idProfessor]
  );
  if (!tipo) return res.status(403).json({ error: 'Você não tem acesso a esse tipo de atividade.' });

  const data = hojeBrasilia();

  const pontoAberto = await buscarPontoAberto(idProfessor, data, req.id_instituicao);
  if (pontoAberto) {
    return res.status(409).json({ error: `Você já tem um registro em aberto em "${pontoAberto.nome}" — registre a saída antes de bater outro.` });
  }

  // Sempre cria uma linha NOVA (ao contrário de turma) — atividade interna
  // pode ser batida várias vezes no mesmo dia (manhã e tarde, por exemplo),
  // então reaproveitar uma linha já encerrada hoje apagaria aquela sessão
  // anterior. Só é seguro porque a checagem de ponto aberto acima já garante
  // que não existe nenhuma sessão pendurada (dessa ou de outra atividade) na
  // hora de abrir uma nova.
  const [result] = await pool.query(
    'INSERT INTO pontos (id_instituicao, id_professor, id_tipo_interno, data, hora_entrada) VALUES (?, ?, ?, ?, ?)',
    [req.id_instituicao, idProfessor, id_tipo_interno, data, agoraBrasilia()]
  );
  res.status(201).json({ message: 'Entrada registrada.', id: result.insertId });
}));

// Registrar saída de atividade interna — pega a sessão em ABERTO de hoje
// (pode haver outras já encerradas mais cedo no mesmo dia, ver /bater-interno
// acima — por isso o filtro `hora_saida IS NULL` é essencial aqui, não é só
// estilo: sem ele a busca poderia pegar uma sessão antiga já fechada em vez
// da que está rodando agora).
router.post('/saida-interno', exigir('editar'), asyncHandler(async (req, res) => {
  const idProfessor = exigirProfessor(req, res);
  if (!idProfessor) return;

  const { id_tipo_interno } = req.body;
  if (!id_tipo_interno) return res.status(400).json({ error: 'Informe id_tipo_interno.' });

  const data = hojeBrasilia();
  const [[ponto]] = await pool.query(
    'SELECT id FROM pontos WHERE id_professor = ? AND id_tipo_interno = ? AND data = ? AND id_instituicao = ? AND hora_entrada IS NOT NULL AND hora_saida IS NULL ORDER BY hora_entrada DESC LIMIT 1',
    [idProfessor, id_tipo_interno, data, req.id_instituicao]
  );
  if (!ponto) return res.status(400).json({ error: 'Registre a entrada primeiro.' });

  await pool.query('UPDATE pontos SET hora_saida = ? WHERE id = ?', [agoraBrasilia(), ponto.id]);
  res.json({ message: 'Saída registrada.', id: ponto.id });
}));

// Corrigir horários manualmente — só coordenador (geral ou da área dessa
// turma) ou master (ver podeEditarPonto).
router.put('/:id', exigir('editar'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[ponto]] = await pool.query('SELECT id, id_professor, id_atividade, id_tipo_interno FROM pontos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!ponto) return res.status(404).json({ error: 'Registro não encontrado.' });

  if (!(await podeEditarPonto(req, ponto))) {
    return res.status(403).json({ error: 'Só o coordenador da área dessa turma (ou master) pode corrigir esse registro.' });
  }

  const { hora_entrada, hora_saida } = req.body;
  await pool.query('UPDATE pontos SET hora_entrada = ?, hora_saida = ? WHERE id = ?', [hora_entrada || null, hora_saida || null, id]);
  res.json({ message: 'Registro atualizado.' });
}));

// Apagar um registro equivocado (mesma regra de posse do PUT).
router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[ponto]] = await pool.query('SELECT id, id_professor, id_atividade, id_tipo_interno FROM pontos WHERE id = ? AND id_instituicao = ?', [id, req.id_instituicao]);
  if (!ponto) return res.status(404).json({ error: 'Registro não encontrado.' });

  if (!(await podeEditarPonto(req, ponto))) {
    return res.status(403).json({ error: 'Só o coordenador da área dessa turma (ou master) pode apagar esse registro.' });
  }

  await pool.query('DELETE FROM pontos WHERE id = ?', [id]);
  res.json({ message: 'Registro removido.' });
}));

module.exports = router;
