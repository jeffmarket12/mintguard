'use strict';
/** GET /api/health -> { ok: true } */

module.exports = async (req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify({ ok: true }));
};
