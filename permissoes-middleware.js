// Enforcement de verdade (server-side) das ações por tela configuradas na
// tela de Permissões — até agora (ver frontend/src/usePermissao.js) só o
// FRONT escondia botão de Criar/Editar/Excluir/Exportar; isso não impedia
// ninguém de chamar a API direto. Este middleware bloqueia a rota de fato.
//
// Sempre consulta o banco na hora (não confia em req.user, que vem do TOKEN
// assinado no login — token dura 7 dias, então uma mudança feita agora na
// tela de Permissões só valeria daqui a até 7 dias se a checagem usasse o
// token). Duas queries pequenas e indexadas por chamada — aceitável mesmo em
// rotas quentes; nenhuma delas cacheia entre requisições de propósito.
//
// master nunca passa por aqui de verdade: sempre libera, igual ao resto do
// sistema (telas_permitidas/recursos_permitidos hardcoded pra ele).
//
// Permissões são POR INSTITUIÇÃO (ver migrate-permissoes-por-instituicao.js):
// "monitor" na instituição 1 pode ter telas/recursos diferentes de "monitor"
// na instituição 2. A checagem usa req.id_instituicao, populado pelo
// middleware global de x-institution-id (ver _server.js) — como este
// middleware roda nas rotas de negócio, montadas DEPOIS dessa cadeia,
// req.id_instituicao já está disponível na prática em todo lugar que usa
// exigirRecurso. Única exceção conhecida: PUT /vincular-professor/usuarios/:id
// em auth.js, montado ANTES do bloco de x-institution-id (esse endpoint age
// sobre várias instituições do coordenador de uma vez, sem uma "ativa"), por
// isso o fallback abaixo usa req.user.instituicoes inteiro — libera se
// QUALQUER uma delas permitir, já que não dá pra saber qual está em jogo.
//
// IMPORTANTE — endpoints compartilhados entre telas: quando o mesmo endpoint
// atende mais de uma tela do front (ex.: POST /api/presenca é usado tanto
// pela Chamada quanto pelo marcador rápido da Grade), a checagem usa a tela
// "dona" do endpoint (aqui, Chamada "/"). Bloquear "editar" nessa tela também
// bloqueia o marcador rápido da Grade mesmo que "/grade" esteja liberado —
// limitação aceita: não dá pra saber por qual tela do front a chamada veio.
const pool = require('./db');

function exigirRecurso(tela, recurso) {
  return async (req, res, next) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
      if (req.user.perfil === 'master') return next();

      const idsInstituicao = req.id_instituicao != null
        ? [req.id_instituicao]
        : (Array.isArray(req.user.instituicoes) ? req.user.instituicoes : []);
      if (idsInstituicao.length === 0) {
        return res.status(403).json({ error: `Seu perfil não tem acesso à tela "${tela}".` });
      }

      const [telaRows] = await pool.query(
        'SELECT DISTINCT id_instituicao FROM permissoes_perfil WHERE id_instituicao IN (?) AND perfil = ? AND tela = ?',
        [idsInstituicao, req.user.perfil, tela]
      );
      if (telaRows.length === 0) {
        return res.status(403).json({ error: `Seu perfil não tem acesso à tela "${tela}".` });
      }
      const idsComTela = telaRows.map(r => r.id_instituicao);

      const [bloqueioRows] = await pool.query(
        'SELECT DISTINCT id_instituicao FROM permissoes_perfil_recurso WHERE id_instituicao IN (?) AND perfil = ? AND tela = ? AND recurso = ?',
        [idsComTela, req.user.perfil, tela, recurso]
      );
      // Só bloqueia se TODAS as instituições com acesso à tela também bloquearem
      // o recurso — no caso comum (uma só instituição ativa) isso é só "está
      // bloqueado nela?".
      if (bloqueioRows.length >= idsComTela.length) {
        return res.status(403).json({ error: `Seu perfil não pode "${recurso}" em "${tela}".` });
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { exigirRecurso };
