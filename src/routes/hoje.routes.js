const express = require('express');
const controller = require('../controllers/hoje.controller');

const router = express.Router();
router.get('/', controller.hoje);

module.exports = router;
