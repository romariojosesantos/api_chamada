const { hojeBrasil } = require('../../data-brasil');

// Data de "hoje" no fuso de Brasília segundo o servidor — nunca o relógio do
// aparelho (ver data-brasil.js).
function hoje(req, res) {
  res.json({ hoje: hojeBrasil() });
}

module.exports = { hoje };
