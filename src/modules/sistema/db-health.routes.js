// Saúde do pool de conexões MySQL — só master (é infraestrutura, não dado de
// uma instituição). Fica fora do bloco de x-institution-id em src/routes/index.js,
// mesma posição de comparativo.routes.js/permissoes.routes.js.
//
// Existe porque em produção (Vercel) cada invocação serverless abre só 1
// conexão (ver src/config/database.js, `connectionLimit: isVercel ? 1 : 20`) — o
// risco real de sobrecarga não é o pool do Node, é o MySQL atingir seu próprio
// `max_connections` quando muitas invocações concorrentes somam mais conexões
// do que o servidor aceita. Esse endpoint deixa checar isso a qualquer hora
// sem precisar abrir o MySQL na mão; ver também src/jobs/saude-banco.js, que
// roda essa mesma checagem automaticamente 1x por dia.
const express = require('express');
const { medirSaudeBanco } = require('./db-health.service');

const router = express.Router();

router.get('/', async (req, res) => {
  if (req.user.perfil !== 'master') {
    return res.status(403).json({ error: 'Rota restrita a master.' });
  }
  res.json(await medirSaudeBanco());
});

module.exports = router;
