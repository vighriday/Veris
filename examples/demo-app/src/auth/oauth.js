// CommonJS — exercises ts-morph CommonJS extraction.
const { findOrCreateUser } = require('../db/userRepo');
const { issueSession } = require('./session');

async function handleOAuthCallback(code, state) {
  const tokenResp = await fetch('https://oauth.example.com/token', {
    method: 'POST',
    body: JSON.stringify({ code, state })
  });
  const tokens = await tokenResp.json();

  const profile = await fetch('https://oauth.example.com/me', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  }).then(r => r.json());

  const user = await findOrCreateUser(profile.email, profile.name);
  await issueSession(user.id, tokens.access_token);
  return user;
}

module.exports = { handleOAuthCallback };
