'use strict';
// the owner's web session for tests that create projects (the assistant's token may only PROPOSE a project)
const auth = require('../../lib/auth');
const PW = 'owner pass for tests';
module.exports = function attachOwner(app, db, pw) {
  const PW_ = pw || PW; if (!pw) auth.setPassword(db, PW_);
  app.ownerH = async () => { const r = await app.inject({ method: 'POST', url: '/api/login', payload: { password: PW_ } }); return { cookie: `mesimot_session=${r.cookies[0].value}`, 'x-mesimot': '1' }; };
  return app;
};
